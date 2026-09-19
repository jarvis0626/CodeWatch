"""An explicitly invoked local command wrapper; never launched by the dashboard/MCP tools."""

import codecs
from pathlib import Path
import shlex
import subprocess
import sys
from uuid import uuid4
import xml.etree.ElementTree as ET

from backend.integrations.client import BridgeError, CodeWatchClient


def read_junit(path: Path) -> list[dict]:
    with path.open("rb") as stream:
        raw = stream.read(2_000_001)
    if len(raw) > 2_000_000 or b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ValueError("JUnit report exceeds 2 MB or contains unsupported XML declarations")
    root = ET.fromstring(raw)
    results = []
    for case in root.iter("testcase"):
        if len(results) >= 500:
            raise ValueError("JUnit report exceeds the 500-test limit")
        if case.find("skipped") is not None:
            continue
        failure = case.find("failure")
        if failure is None:
            failure = case.find("error")
        name = "::".join(part for part in (case.get("classname"), case.get("name")) if part)
        if not name:
            continue
        results.append(
            {
                "name": name[:200],
                "status": "failed" if failure is not None else "passed",
                "details": (
                    (failure.get("message", "") + "\n" + (failure.text or ""))[:4000]
                    if failure is not None
                    else None
                ),
            }
        )
    return results


def run_command(
    client: CodeWatchClient,
    arguments: list[str],
    agent_name: str = "Terminal wrapper",
    junit: str | None = None,
    attempt: int = 1,
) -> int:
    if not arguments:
        raise ValueError("Provide a command after --, for example: -- python -m pytest")
    session = client.request("GET", "/api/session").get("session")
    if not session or not session["watching"]:
        raise ValueError("Connect a project before capturing commands.")
    project = Path(session["projectPath"]).resolve(strict=True)
    report_path = None
    before = None
    if junit:
        report_path = (project / junit).resolve()
        try:
            report_path.relative_to(project)
        except ValueError as exc:
            raise ValueError("The JUnit report must be inside the watched project") from exc
        if report_path.exists():
            before = (report_path.stat().st_mtime_ns, report_path.stat().st_size)
    identifier = f"cmd_{uuid4().hex}"
    common = {"runId": session["runId"], "agentName": agent_name, "capture": "wrapper"}
    command = {**common, "commandId": identifier, "command": shlex.join(arguments)}
    client.request("POST", "/api/agent/command", {**command, "status": "running"})
    output = ""
    process = None
    exit_code = 1
    try:
        process = subprocess.Popen(
            arguments, cwd=project, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, shell=False
        )
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while chunk := process.stdout.read1(4096):
            text = decoder.decode(chunk)
            print(text, end="", flush=True)
            output = (output + text)[-16000:]
        final = decoder.decode(b"", final=True)
        print(final, end="", flush=True)
        output = (output + final)[-16000:]
        exit_code = process.wait()
    except OSError as exc:
        output = str(exc)
        print(output, file=sys.stderr)
    except KeyboardInterrupt:
        if process:
            process.terminate()
            process.wait(timeout=5)
        exit_code = 130
        output = (output + "\nCommand interrupted.")[-16000:]
    finally:
        if process and process.stdout:
            process.stdout.close()
    try:
        client.request(
            "POST",
            "/api/agent/command",
            {
                **command,
                "status": "completed" if exit_code == 0 else "failed",
                "exitCode": exit_code,
                "output": output,
            },
        )
        if report_path:
            if (
                not report_path.exists()
                or (report_path.stat().st_mtime_ns, report_path.stat().st_size) == before
            ):
                print("No fresh JUnit report was produced; test results were not inferred.", file=sys.stderr)
            else:
                # Recheck after execution in case the command replaced the report with a link.
                report_path.resolve(strict=True).relative_to(project)
                for result in read_junit(report_path):
                    client.request("POST", "/api/agent/test", {**common, **result, "attempt": attempt})
    except (BridgeError, OSError, ValueError, ET.ParseError) as exc:
        print(f"Command finished, but CodeWatch reporting failed: {exc}", file=sys.stderr)
    return exit_code
