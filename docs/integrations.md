# Connect an AI coding tool to CodeWatch

CodeWatch observes a project while your existing AI and IDE do the work. Connect the
AI through **MCP (Model Context Protocol)** so it can describe its current action,
highlight the files involved, explain connections, and report commands and tests.
The AI model can come from any provider; the host application needs to support
local MCP tools or send events to CodeWatch's HTTP API.

The filesystem watcher also works by itself: choose a project and changes appear
as files are saved. Stage names, explanations, terminal results, and intent require
the agent to report them. An import connection inferred from source code is useful
evidence, but does not prove a particular runtime call happened. CodeWatch does not
read an AI's private reasoning or intercept arbitrary IDE conversations.

## 1. Start CodeWatch

From the CodeWatch checkout, install dependencies as described in the [README](../README.md).
After building the frontend, start the dashboard and backend together:

```powershell
.\backend\.venv\Scripts\python.exe -m backend.cli serve
```

Open the dashboard at <http://127.0.0.1:8000>. Connect the project folder you want
to observe, which can be outside the CodeWatch checkout. Keep the backend running
while using the integration. One backend watches one active project at a time.

## 2. Add the MCP server to your coding tool

Open **Connect your AI** in the dashboard for configuration with paths for your local installation. The
examples below use `D:/Projects/CodeWatch`; replace that directory if yours differs.
Use **absolute paths** for both Python and the script, including paths containing
spaces. On macOS/Linux, the Python path is typically
`/absolute/path/CodeWatch/backend/.venv/bin/python`.

The MCP process is started by your IDE. It communicates over stdio and forwards
reports to the already-running CodeWatch backend over loopback HTTP. The backend's
`http://127.0.0.1:8000` URL is an application API, **not an HTTP MCP endpoint**.

### Antigravity IDE

In the agent panel, open **… → MCP Servers → Manage MCP Servers → View raw config**.
Merge the `codewatch` entry below into the existing `mcpServers` object, save, and
refresh/reconnect the server. Google's documented custom-server format uses
`command` and `args` for local stdio servers.
[Official Antigravity MCP documentation](https://antigravity.google/docs/mcp?tab=ide)

```json
{
  "mcpServers": {
    "codewatch": {
      "command": "D:/Projects/CodeWatch/backend/.venv/Scripts/python.exe",
      "args": [
        "D:/Projects/CodeWatch/backend/mcp_server.py",
        "--server-url",
        "http://127.0.0.1:8000"
      ]
    }
  }
}
```

### Codex CLI / Codex IDE extension / local ChatGPT desktop

Add this section to your Codex host's `~/.codex/config.toml` (or the trusted
project's `.codex/config.toml`), then restart the client:

```toml
[mcp_servers.codewatch]
command = "D:/Projects/CodeWatch/backend/.venv/Scripts/python.exe"
args = ["D:/Projects/CodeWatch/backend/mcp_server.py", "--server-url", "http://127.0.0.1:8000"]
startup_timeout_sec = 20
tool_timeout_sec = 30
```

Alternatively, use the local client's MCP settings to add a **STDIO** server with
the same command and arguments. Local ChatGPT desktop, Codex CLI, and the Codex IDE
extension share MCP configuration for the same Codex host. Codex CLI's `/mcp` view
shows active servers.
[Official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

### Other IDEs and agents

Use your application's **custom MCP server / stdio** settings. Supply the same
executable and argument list; many applications use the JSON `mcpServers` format
above. The exact configuration file and UI vary by client. A plain code editor
without an MCP-capable agent can still use CodeWatch's filesystem watcher.

### ChatGPT in the browser

ChatGPT web does not read local Codex configuration files. The snippets above are
for clients that can start a process on the machine running CodeWatch.
[Official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

For browser access, an additional remote connection is necessary. OpenAI's
**Secure MCP Tunnel** can connect a private stdio server to a ChatGPT developer-mode
app without opening an inbound public port. It requires a registered tunnel, a
runtime API key, suitable tunnel permissions, and developer-mode access. Configure
the tunnel's local MCP command to launch this same Python script, then connect the
tunnel in ChatGPT. Follow the current vendor setup instructions; CodeWatch does
not register, install, or run that tunnel for you.
[Official Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

A tunnel makes reporting tools reachable; it does not give a browser agent local
file-editing or terminal capabilities. CodeWatch's bridge only observes/reports.
Keep the backend bound to loopback. This version does not ship a public authenticated
MCP service, and its local backend should not be published directly to the internet.

## 3. Tell the AI to report its work

The server supplies reporting instructions during MCP initialization, plus a
`watch_my_work` prompt and a `codewatch://instructions` resource. For clients that
do not automatically apply server instructions, copy the dashboard's instructions
into your chat or the project's agent rules. Start with:

```text
Use CodeWatch while you work on this project.
Call codewatch_watch_project with this project's absolute path and your agent name.
Keep session.runId and pass it as run_id on each report.
Before meaningful steps, report the stage, action, and affected relative file paths
with codewatch_progress. Explain how the pieces connect with codewatch_relationship.
After running commands/tests through your normal tools, report their actual results.
Finish with codewatch_complete when this task is done.
```

Use the permissions your IDE provides for these tools. Reporting needs enabled
tool access and a cooperating agent; connecting a server alone does not guarantee
that every model will call it at every step.

### Example: building a login flow

1. The agent calls `codewatch_watch_project(path="D:/Projects/MyApp", agent_name="Antigravity")`.
   The response includes `session.runId`, for example `run-abc`.
2. It reports `codewatch_progress(run_id="run-abc", stage="IMPLEMENTING", message="Connecting the login form to the API", paths=["ui/Login.tsx", "api/login.py"], agent_name="Antigravity")`.
3. It edits through its usual IDE tools. CodeWatch observes the saved files.
4. It calls `codewatch_relationship(run_id="run-abc", source="ui/Login.tsx", target="api/login.py", label="calls", description="The form submits credentials to the login endpoint.", agent_name="Antigravity")`.
5. It runs the real tests, reports the observed results with `codewatch_test`,
   fixes failures if necessary, then calls `codewatch_complete` with a summary.

The UI can now show the current step, the files being worked on, and why they are
connected. Reports carry their origin so an agent explanation and a filesystem
observation can be understood separately.

## Tool reference

| MCP tool | Purpose |
| --- | --- |
| `codewatch_watch_project(path, agent_name)` | Attach a project by absolute path; returns `session.runId`. |
| `codewatch_status()` | Read the active session and watcher status. |
| `codewatch_progress(run_id, stage, message, paths, agent_name)` | Update current activity and highlight project-relative files. |
| `codewatch_relationship(run_id, source, target, label, description, agent_name)` | Explain a connection between two project-relative files. |
| `codewatch_test(run_id, name, status, attempt, path, details, agent_name)` | Report a real test start, pass, or failure. |
| `codewatch_command(run_id, command_id, command, status, output, exit_code, agent_name)` | Record a command's observed progress and result. Does not execute it. |
| `codewatch_complete(run_id, message, agent_name)` | Mark the task complete while file watching continues. |

Stages are `PLANNING`, `EXPLORING`, `IMPLEMENTING`, `RUNNING`, `TESTING`, `DEBUGGING`,
`VALIDATING`, and `COMPLETE`. Test statuses are `running`, `passed`, and `failed`.
Command statuses are `running`, `completed`, and `failed`. Report `running` before
the final command result and reuse its `command_id`. Completed commands require
`exit_code=0`; failed commands require the actual nonzero code. Increase `attempt` for test retries.
Pass your agent name consistently on reports for accurate attribution.

All reporting tools require `run_id`. If the user switches projects, the backend
rejects old reports instead of applying them to the new project. Inspect
`codewatch_status` and finish or reattach only to the intended project. Attaching
the already-watched path reuses the existing session; choosing another path
switches the dashboard.

## HTTP adapters for tools without MCP

Custom agents can send the same observations to the local API:

| Request | Body |
| --- | --- |
| `POST /api/watch` | `{ "path": "D:/Projects/MyApp", "agentName": "My agent" }`; returns the session object directly, including `runId`. |
| `GET /api/session` | No body; returns `{ "session": { ... } }` or `{ "session": null }`. |
| `POST /api/agent/progress` | `{ "runId": "...", "agentName": "My agent", "stage": "IMPLEMENTING", "message": "Connecting login to the API", "paths": ["ui/Login.tsx"] }` |
| `POST /api/agent/relationship` | `{ "runId": "...", "agentName": "My agent", "source": "ui/Login.tsx", "target": "api/login.py", "label": "calls", "description": "Submits credentials" }` |
| `POST /api/agent/test` | `{ "runId": "...", "agentName": "My agent", "name": "login", "status": "passed", "attempt": 1, "path": "tests/test_login.py" }` |
| `POST /api/agent/command` | First `{ "runId": "...", "agentName": "My agent", "commandId": "test-1", "command": "pytest", "status": "running" }`; then the same identifiers with `"status": "completed", "exitCode": 0, "output": "8 passed"`. |
| `POST /api/agent/complete` | `{ "runId": "...", "agentName": "My agent", "message": "Login flow complete; all tests pass" }` |

Use `Content-Type: application/json`. Successful report requests return
`{ "accepted": true, "runId": "...", "eventIds": ["..."] }`. The backend assigns
event IDs, timestamps, and ordering. Invalid inputs return validation errors;
inactive session IDs return a conflict. See <http://127.0.0.1:8000/docs> for the
running backend's complete schema.

## Troubleshooting

- **Server fails to start:** use the Python executable from CodeWatch's virtual
  environment, install `backend/requirements.txt`, and confirm both absolute paths.
  The official `mcp` Python SDK is required.
- **Tools connect but say “Cannot reach CodeWatch”:** start the backend, check its
  port, and update `--server-url`. The bridge only accepts loopback HTTP(S) origins.
- **Map updates but no stage changes:** file watching is working. Enable MCP tools
  in the client and give the AI the reporting instructions above.
- **No activity while the AI is thinking:** the bridge receives explicit action
  reports and filesystem changes; it cannot inspect private reasoning.
- **A report says the run is no longer active:** the project/session changed.
  Do not replace the old run ID with an unrelated project's run ID.
- **An import is missing:** static analysis covers supported import patterns.
  Runtime wiring, dynamic imports, and cross-language calls may need an explicit
  `codewatch_relationship` report.
- **No file appears:** check the watcher status and warnings. Ignored/generated
  directories, secret files, binary files, and scan limits can exclude files.

## Verification and scope

The bridge is tested using the official MCP SDK client against a real subprocess
started from another working directory: initialization, discovery, all reporting
tools, resource/prompt access, input validation, and rejected stale runs. These
protocol tests do not claim a manual end-to-end test inside every vendor's IDE.
The bridge uses the SDK's stdio implementation; vendor-specific hooks are not
required. Connection instructions were checked against official documentation on
2026-09-19.

## Light and Detailed reporting

**Light is the default** for new MCP connections. In **Connect your AI**, choose
**Reporting mode** before copying the JSON/TOML configuration and agent instructions.
The selection is remembered in this browser/app profile.

- **Light:** concise major-task/component milestones, important failures or blockers,
  and final completion. No routine command-by-command reporting or copied terminal output.
- **Detailed:** meaningful step updates, command start/results, test outcomes, and
  agent-reported relationships, as in previous versions.

Both modes retain automatic file/import watching and completion notifications.
Light produces fewer narrated steps; completion still requires the agent to call
`codewatch_complete`. Start a subsequent task with a progress report to rearm alerts.

The copied MCP configuration sets `CODEWATCH_REPORTING_MODE` to `light` or `detailed`.
Unset means Light. After changing modes, replace the client configuration and restart
its MCP connection. Replace old reporting instructions in your project/chat as well;
the selector does not remotely reconfigure an already-running coding agent.
All seven tools remain available in either mode. This is a cooperative reporting policy,
not a hard limit on tool calls. It reduces requested reporting, without guaranteeing
any particular token savings or subscription usage-limit reduction.
