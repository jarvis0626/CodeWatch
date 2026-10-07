"""Generate copyable client configuration without editing an IDE's settings."""

import json
from typing import Literal


DETAILED_INSTRUCTIONS = """Use CodeWatch to make your work visible in the user's live project map.
Call codewatch_watch_project with the absolute project path and your agent name before starting.
Keep the returned session.runId and pass it as run_id to every report for this task.
Before each meaningful step, call codewatch_progress with a short, plain-language action,
the stage, and the relative paths you will work on. Explain what the change connects or enables.
Stages: PLANNING, EXPLORING, IMPLEMENTING, RUNNING, TESTING, DEBUGGING, VALIDATING, COMPLETE.
After performing work, report the actual result. Report commands and test results with
codewatch_command and codewatch_test; these tools record results and do not execute anything.
Report each command as running before its completed/failed result; reuse its command_id
and include the real exit_code (0 for completed, nonzero for failed). Report a test retry with
an increased attempt. Do not claim a command ran or a test passed without observing it.
Use codewatch_relationship when you know how two project files connect: source and target
are project-relative paths, label is a short verb such as calls, renders, stores, or tests,
and description explains the connection for someone following along.
Call codewatch_complete only when the requested task is finished; describe the outcome
and any limitations. The watcher continues to observe files after completion.
If a report rejects your run_id, the user may have switched projects. Use codewatch_status
to check; do not attach your task to a different project or reuse its run_id automatically.
Never send secrets, full environment variables, credentials, or hidden reasoning.
Report actions, evidence, and concise explanations. CodeWatch cannot inspect private reasoning.
File changes are observed automatically, even when your tools are unavailable. If reporting
is unavailable, tell the user once and continue the underlying task without inventing telemetry.
"""


ReportingMode = Literal["light", "detailed"]
LIGHT_INSTRUCTIONS = """Use CodeWatch in Light reporting mode.
Call codewatch_watch_project once before starting; keep session.runId as run_id for reports.
Use codewatch_progress once per meaningful task/component or major phase, with a short
plain-language summary (aim for 1-2 sentences) and only the relevant relative paths.
Report important failures or blockers; avoid narrating every edit, read, command, or retry.
Do not routinely call codewatch_command, codewatch_test, or codewatch_relationship.
Reporting tools do not execute anything. Do not copy terminal output into reports. File changes and supported imports are automatic.
Always call codewatch_complete when the requested task is actually finished, with a concise
outcome and limitations, so completion notifications can fire. Do not mark blocked work complete.
For a new task in the same session, send a progress report before completion to rearm alerts.
Stages: PLANNING, EXPLORING, IMPLEMENTING, RUNNING, TESTING, DEBUGGING, VALIDATING, COMPLETE.
Report only observed outcomes; never invent commands, test results, or relationships.
If run_id is rejected, use codewatch_status; never switch to another project automatically.
Never send secrets, credentials, full environment variables, or hidden reasoning.
If reporting is unavailable, tell the user once and continue the underlying task.
"""
# MCP supplies guidance automatically; the desktop app owns the active mode.
AGENT_INSTRUCTIONS = """Use CodeWatch to report progress automatically; no pasted instructions are needed.
Before each task call codewatch_watch_project (or codewatch_status for the attached project).
Keep session.runId as run_id. Follow reportingInstructions in tool responses; the latest
response overrides earlier reporting guidance, including old environment settings.
The user chooses Light or Detailed in CodeWatch. Light is the default until discovered.
Use short major-milestone updates in Light; Detailed includes step, command and test reports.
Always report actual task completion with codewatch_complete. Begin a new task with progress.
Optional codewatch_relationship reports describe known file connections.
Reporting tools do not execute anything. Never invent results or expose secrets or reasoning.
File changes are automatic. If disconnected, continue the task and mention it once.
"""


def reporting_instructions(mode: ReportingMode = "light") -> str:
    if mode not in {"light", "detailed"}:
        raise ValueError("Reporting mode must be light or detailed")
    return LIGHT_INSTRUCTIONS if mode == "light" else DETAILED_INSTRUCTIONS


def integration_config(
    server_url: str, python_executable: str, bridge_path: str, *, discovery_path: str | None = None,
    reporting_mode: ReportingMode = "light",
) -> dict:
    """Return portable snippets. Absolute paths allow launching from any project."""
    instructions = reporting_instructions(reporting_mode)
    endpoint = server_url.rstrip("/")
    args = (["mcp", "--discovery", discovery_path] if discovery_path
            else [str(bridge_path), "--server-url", endpoint])
    command = str(python_executable)
    # JSON basic strings are valid TOML basic strings, including Windows backslashes.
    codex_config = (
        "[mcp_servers.codewatch]\n"
        f"command = {json.dumps(command, ensure_ascii=False)}\n"
        f"args = {json.dumps(args, ensure_ascii=False)}\n"
        "startup_timeout_sec = 20\n"
        "tool_timeout_sec = 30\n"

    )
    return {
        "mcpConfig": {"mcpServers": {"codewatch": {"command": command, "args": args}}},
        "codexConfig": codex_config,
        "instructions": instructions,
        "reportingMode": reporting_mode,
        "endpoint": endpoint,
    }
