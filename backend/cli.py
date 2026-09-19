"""Local CodeWatch launcher and explicit command capture."""

import argparse
import json
import os
from pathlib import Path
import sys

from backend.integrations.client import BridgeError, CodeWatchClient


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(
        prog="codewatch", description="Watch a real project from any editor or agent."
    )
    cli.add_argument("--server-url", default=os.getenv("CODEWATCH_SERVER_URL", "http://127.0.0.1:8000"))
    commands = cli.add_subparsers(dest="action", required=True)
    for name, help_text in (
        ("serve", "Start the local dashboard"),
        ("watch", "Start dashboard and watch a project"),
    ):
        command = commands.add_parser(name, help=help_text)
        if name == "watch":
            command.add_argument("path")
        command.add_argument("--port", type=int, default=8000)
    attach = commands.add_parser("attach", help="Connect a project to a running dashboard")
    attach.add_argument("path")
    attach.add_argument("--agent", default="External agent")
    commands.add_parser("status", help="Show the current watched project")
    commands.add_parser("stop", help="Stop watching without changing project files")
    commands.add_parser("config", help="Print the local MCP integration configuration")
    run = commands.add_parser("run", help="Capture one explicitly requested command and its exit code")
    run.add_argument("--agent", default="Terminal wrapper")
    run.add_argument(
        "--junit", help="Read a fresh JUnit XML report written by this command (project-relative)"
    )
    run.add_argument("--attempt", type=int, default=1)
    run.add_argument("command", nargs=argparse.REMAINDER)
    return cli


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.action in {"serve", "watch"}:
            import uvicorn
            from backend.main import create_app
            from backend.observer.scanner import resolve_root

            if not 1 <= args.port <= 65535:
                raise ValueError("Port must be between 1 and 65535")
            project = str(resolve_root(args.path)) if args.action == "watch" else None
            dashboard = Path(__file__).resolve().parent.parent / "frontend" / "dist" / "index.html"
            if not dashboard.is_file():
                raise ValueError(
                    "Build the dashboard first: npm --prefix frontend install; npm --prefix frontend run build"
                )
            url = f"http://127.0.0.1:{args.port}"
            print(f"CodeWatch: {url}", flush=True)
            uvicorn.run(create_app(project_path=project, server_url=url), host="127.0.0.1", port=args.port)
            return 0
        client = CodeWatchClient(args.server_url)
        if args.action == "run":
            from backend.command_capture import run_command

            if args.attempt < 1:
                raise ValueError("Test attempt must be at least 1")
            command = args.command[1:] if args.command and args.command[0] == "--" else args.command
            return run_command(client, command, args.agent, args.junit, args.attempt)
        if args.action == "attach":
            result = client.request(
                "POST", "/api/watch", {"path": str(Path(args.path).resolve()), "agentName": args.agent}
            )
        elif args.action == "stop":
            session = client.request("GET", "/api/session").get("session")
            if not session:
                raise ValueError("There is no project to stop watching")
            result = client.request("POST", "/api/watch/stop", {"runId": session["runId"]})
        else:
            result = client.request("GET", "/api/integrations" if args.action == "config" else "/api/session")
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    except (BridgeError, ValueError, OSError) as exc:
        print(f"CodeWatch: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
