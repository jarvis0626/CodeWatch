"""Verify the frozen helper with the official MCP SDK, without Python on its PATH.

This is developer verification of the packaged protocol; it does not launch Codex,
Claude, or another vendor's app. Run with the repository's development interpreter.
"""

import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
from queue import Queue
import secrets
import subprocess
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.request import ProxyHandler, Request, build_opener

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def verify_protocol(helper: Path, discovery_path: Path, project: Path, environment: dict, errlog) -> dict:
    parameters = StdioServerParameters(
        command=str(helper),
        args=["mcp", "--discovery", str(discovery_path)],
        env=environment,
        cwd=project,
    )
    async with stdio_client(parameters, errlog=errlog) as (read, write):
        async with ClientSession(read, write) as client:
            initialized = await client.initialize()
            assert initialized.serverInfo.name == "CodeWatch"
            tools = {tool.name for tool in (await client.list_tools()).tools}
            assert tools == {
                "codewatch_watch_project", "codewatch_status", "codewatch_progress",
                "codewatch_relationship", "codewatch_test", "codewatch_command", "codewatch_complete",
            }
            watched = await client.call_tool(
                "codewatch_watch_project", {"path": str(project), "agent_name": "Packaged MCP verification"}
            )
            assert not watched.isError, watched.content
            session = watched.structuredContent["session"]
            assert Path(session["projectPath"]).resolve() == project.resolve()
            run_id = session["runId"]
            assert run_id
            progress = await client.call_tool(
                "codewatch_progress", {
                    "run_id": run_id, "stage": "VALIDATING", "paths": ["fixture.py"],
                    "message": "Verifying reports from the packaged MCP helper",
                }
            )
            assert not progress.isError, progress.content
            assert progress.structuredContent["accepted"] is True
            assert progress.structuredContent["eventIds"]
            current = await client.call_tool("codewatch_status")
            assert current.structuredContent["session"]["runId"] == run_id
            complete = await client.call_tool(
                "codewatch_complete", {"run_id": run_id, "message": "Packaged MCP protocol verified"}
            )
            assert not complete.isError, complete.content
            assert complete.structuredContent["accepted"] is True
            assert complete.structuredContent["eventIds"]
            return {"server": initialized.serverInfo.name, "tools": len(tools), "reportsAccepted": True}


def verify(helper: Path) -> dict:
    if os.name != "nt":
        raise RuntimeError("This verification requires the Windows packaged executable and native DPAPI")
    helper = helper.resolve(strict=True)
    with TemporaryDirectory(prefix="codewatch-packaged-mcp-") as temporary:
        directory = Path(temporary)
        project = directory / "project with spaces"
        project.mkdir()
        (project / "fixture.py").write_text("value = 1\n", encoding="utf-8")
        discovery_path = directory / "desktop-connection.json"
        token = secrets.token_urlsafe(32)
        environment = os.environ.copy()
        environment["PATH"] = str(Path(environment.get("SystemRoot", "C:/Windows")) / "System32")
        for name in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "CODEWATCH_DESKTOP_TOKEN"):
            environment.pop(name, None)
        service_environment = {**environment, "CODEWATCH_DESKTOP_TOKEN": token}
        process = subprocess.Popen(
            [str(helper), "serve", "--discovery", str(discovery_path)],
            cwd=project, env=service_environment, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        lines = Queue()
        Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True).start()
        try:
            ready = json.loads(lines.get(timeout=45))
            assert ready["kind"] == "ready"
            endpoint = ready["url"]
            request = Request(endpoint + "/health", headers={"Authorization": f"Bearer {token}"})
            with build_opener(ProxyHandler({})).open(request, timeout=10) as response:
                assert json.load(response) == {"status": "ok"}
            raw = discovery_path.read_text(encoding="utf-8")
            record = json.loads(raw)
            assert record["protection"] == "dpapi"
            assert token not in raw
            assert base64.b64decode(record["credential"]) != token.encode()
            log_path = directory / "mcp-stderr.log"
            with log_path.open("w", encoding="utf-8") as errlog:
                result = asyncio.run(asyncio.wait_for(
                    verify_protocol(helper, discovery_path, project, environment, errlog), timeout=60
                ))
            mcp_errors = log_path.read_text(encoding="utf-8")
            assert "Traceback" not in mcp_errors, mcp_errors
            process.stdin.close()
            assert process.wait(timeout=8) == 0
            assert not discovery_path.exists()
            assert process.stdout.read() == ""
            assert "Traceback" not in process.stderr.read()
            return {
                "ok": True, "helper": str(helper), "systemOnlyPath": True,
                "healthReady": True, "credentialProtection": "dpapi", "cleanShutdown": True,
                "mcp": result, "client": "Official MCP Python SDK; vendor apps were not tested",
            }
        finally:
            if process.poll() is None:
                if process.stdin and not process.stdin.closed:
                    process.stdin.close()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    # The frozen one-file launcher has a worker child; terminate
                    # the whole tree if orderly parent-pipe shutdown fails.
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, check=False,
                    )
                    process.wait(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream and not stream.closed:
                    stream.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--helper", type=Path,
        default=Path(__file__).resolve().parents[1] / "build/sidecar/codewatch-helper.exe",
    )
    parser.add_argument("--report", type=Path)
    arguments = parser.parse_args()
    result = verify(arguments.helper)
    if arguments.report:
        arguments.report.parent.mkdir(parents=True, exist_ok=True)
        arguments.report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
