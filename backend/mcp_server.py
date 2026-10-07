"""Official MCP stdio server forwarding agent reports to a local CodeWatch instance.

Run with an absolute script path from any IDE/project. Stdout is reserved for MCP;
the SDK owns JSON-RPC, initialization, tool discovery, validation, and shutdown.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
from typing import Annotated, Any, Literal

# Script entry points are launched with the IDE's project as cwd, not this repo.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from backend.integrations.client import (
    DEFAULT_SERVER_URL as DEFAULT_SERVER_URL,
    BridgeError as BridgeError,
    CodeWatchClient as CodeWatchClient,
    NoRedirects as NoRedirects,
)
from backend.integrations.config import reporting_instructions
from backend.models.events import Stage


RunId = Annotated[str, Field(min_length=1, max_length=200)]
AgentName = Annotated[str, Field(min_length=1, max_length=100)]
Message = Annotated[str, Field(min_length=1, max_length=4000)]
RelativePath = Annotated[str, Field(min_length=1, max_length=1024)]
REPORT_ANNOTATIONS = ToolAnnotations(
    readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False
)


def create_mcp(server_url: str = DEFAULT_SERVER_URL, *, discovery_path: str | None = None) -> FastMCP:
    client = CodeWatchClient(server_url, discovery_path=discovery_path)
    instructions = reporting_instructions(os.environ.get("CODEWATCH_REPORTING_MODE", "light"))
    server = FastMCP("CodeWatch", instructions=instructions, log_level="WARNING")

    @server.tool(annotations=REPORT_ANNOTATIONS)
    def codewatch_watch_project(
        path: Annotated[str, Field(min_length=1, max_length=4096)],
        agent_name: AgentName = "AI agent",
    ) -> dict[str, Any]:
        """Watch an absolute project directory before work; save session.runId for every later report.

        The same already-watched directory reuses its session. Choosing a different directory
        switches the dashboard's active project. The watcher reads files without modifying them.
        """
        return {"session": client.request("POST", "/api/watch", {"path": path, "agentName": agent_name})}

    @server.tool(annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    def codewatch_status() -> dict[str, Any]:
        """Read the active watched project, run ID, agent name, and watcher connection status."""
        return client.request("GET", "/api/session")

    @server.tool(annotations=REPORT_ANNOTATIONS)
    def codewatch_progress(
        run_id: RunId,
        stage: Stage,
        message: Message,
        paths: Annotated[list[RelativePath], Field(max_length=50)] | None = None,
        agent_name: AgentName = "AI agent",
    ) -> dict[str, Any]:
        """Show what you are doing now and highlight affected project-relative file paths.

        Follow the configured reporting mode: Light uses major milestones only;
        Detailed reports meaningful steps and their outcomes.
        Describe concrete actions and connections, not hidden reasoning or unverified results.
        """
        return client.request(
            "POST",
            "/api/agent/progress",
            {
                "runId": run_id,
                "agentName": agent_name,
                "stage": stage,
                "message": message,
                "paths": paths or [],
            },
        )

    @server.tool(annotations=REPORT_ANNOTATIONS)
    def codewatch_relationship(
        run_id: RunId,
        source: RelativePath,
        target: RelativePath,
        label: Annotated[str, Field(min_length=1, max_length=120)],
        description: Annotated[str, Field(max_length=2000)] | None = None,
        agent_name: AgentName = "AI agent",
    ) -> dict[str, Any]:
        """Explain a known connection between two project-relative files in the live map.

        For example source='ui/Login.tsx', target='api/login.py', label='calls'.
        Only report connections supported by the code or the implementation you are building.
        """
        payload = {
            "runId": run_id,
            "agentName": agent_name,
            "source": source,
            "target": target,
            "label": label,
        }
        if description is not None:
            payload["description"] = description
        return client.request("POST", "/api/agent/relationship", payload)

    @server.tool(annotations=REPORT_ANNOTATIONS)
    def codewatch_test(
        run_id: RunId,
        name: Annotated[str, Field(min_length=1, max_length=200)],
        status: Literal["running", "passed", "failed"],
        attempt: Annotated[int, Field(ge=1)] = 1,
        path: RelativePath | None = None,
        details: Annotated[str, Field(max_length=4000)] | None = None,
        agent_name: AgentName = "AI agent",
    ) -> dict[str, Any]:
        """Record an actual test start/result; this tool does not run tests.

        Use the same name per test and increase attempt for retries. Include the relative
        test file path when known and a concise failure or success summary in details.
        """
        payload = {
            "runId": run_id,
            "agentName": agent_name,
            "name": name,
            "status": status,
            "attempt": attempt,
        }
        if path is not None:
            payload["path"] = path
        if details is not None:
            payload["details"] = details
        return client.request("POST", "/api/agent/test", payload)

    @server.tool(annotations=REPORT_ANNOTATIONS)
    def codewatch_command(
        run_id: RunId,
        command_id: Annotated[str, Field(min_length=1, max_length=100)],
        command: Annotated[str, Field(min_length=1, max_length=2000)],
        status: Literal["running", "completed", "failed"],
        output: Annotated[str, Field(max_length=16000)] | None = None,
        exit_code: int | None = None,
        agent_name: AgentName = "AI agent",
    ) -> dict[str, Any]:
        """Record a command's observed status and safe output; NEVER executes the command.

        Report running first, then execute through your IDE's normal tools. Reuse
        command_id for finish and send the actual exit_code/result (0 for completed,
        nonzero for failed). Remove secrets from output before reporting.
        """
        payload = {
            "runId": run_id,
            "agentName": agent_name,
            "commandId": command_id,
            "command": command,
            "status": status,
        }
        if output is not None:
            payload["output"] = output
        if exit_code is not None:
            payload["exitCode"] = exit_code
        return client.request("POST", "/api/agent/command", payload)

    @server.tool(annotations=REPORT_ANNOTATIONS)
    def codewatch_complete(
        run_id: RunId, message: Message, agent_name: AgentName = "AI agent"
    ) -> dict[str, Any]:
        """Mark your requested task complete with an evidence-based summary; file watching continues."""
        return client.request(
            "POST",
            "/api/agent/complete",
            {
                "runId": run_id,
                "agentName": agent_name,
                "message": message,
            },
        )

    @server.resource("codewatch://instructions")
    def reporting_guide() -> str:
        """How to make an AI development task visible in CodeWatch."""
        return instructions

    @server.prompt()
    def watch_my_work() -> str:
        """Keep the CodeWatch project map and activity timeline updated while working."""
        return instructions

    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="CodeWatch MCP bridge (stdio)")
    parser.add_argument(
        "--server-url",
        default=os.environ.get("CODEWATCH_SERVER_URL", DEFAULT_SERVER_URL),
        help="Local CodeWatch HTTP origin (default: http://127.0.0.1:8000)",
    )
    args = parser.parse_args()
    try:
        server = create_mcp(args.server_url)
    except ValueError as exc:
        parser.error(str(exc))
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
