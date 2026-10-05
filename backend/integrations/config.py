"""Generate copyable client configuration without editing an IDE's settings."""

import json


AGENT_INSTRUCTIONS = """Use CodeWatch to make your work visible in the user's live project map.
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


def integration_config(
    server_url: str, python_executable: str, bridge_path: str, *, discovery_path: str | None = None
) -> dict:
    """Return portable snippets. Absolute paths allow launching from any project."""
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
        "instructions": AGENT_INSTRUCTIONS,
        "endpoint": endpoint,
    }
