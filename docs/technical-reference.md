# CodeWatch technical reference

[Back to the overview](../README.md) · [Windows packaging](windows-packaging.md) · [Integrations](integrations.md)

## Start locally

Requirements: **Python 3.12+**, **Node 22.12+**. No model API key or database server is required. Install dependencies once while online; the dashboard and project watcher run locally.

### Windows (PowerShell)

Clone the project and install its dependencies:

```powershell
git clone https://github.com/jarvis0626/CodeWatch.git
cd CodeWatch
python -m venv backend/.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend run build
.\backend\.venv\Scripts\python.exe -m backend.cli serve
```

Open **http://127.0.0.1:8000**, enter the absolute path of the project you want to observe, and click **Watch project**. Keep your usual AI/editor working in that folder. CodeWatch updates as files change.

Or launch directly with a project:

```powershell
.\backend\.venv\Scripts\python.exe -m backend.cli watch 'D:\Projects\YourApp'
```

### macOS / Linux

Use Python 3.12 or newer:

```bash
git clone https://github.com/jarvis0626/CodeWatch.git
cd CodeWatch
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
npm --prefix frontend ci
npm --prefix frontend run build
backend/.venv/bin/python -m backend.cli serve
```

Open **http://127.0.0.1:8000**. The project you watch can be a different repository anywhere on your machine; enter its absolute folder path in the dashboard.

### Start it again later

Return to the CodeWatch folder and run the final `serve` command for your platform. Dependency installation and the frontend build are only needed on first setup or after relevant updates. Keep that terminal running; press **Ctrl+C** to stop the server. Sessions are held in memory, so reconnect the project after restarting.

### Optional short commands

From the repository root, install the editable Python package into your environment:

```powershell
.\backend\.venv\Scripts\python.exe -m pip install -e .
.\backend\.venv\Scripts\codewatch.exe watch 'D:\Projects\YourApp'
```

With that virtual environment activated, the commands are `codewatch` and `codewatch-mcp`. This is a local source installation, not a published marketplace package; keep this checkout and its built `frontend/dist/` in place.

### During frontend development

Run these in separate terminals:

```powershell
.\backend\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload --port 8000
npm.cmd --prefix frontend run dev
```

Use **http://localhost:5173** for Vite development. `/api`, `/ws`, `/health`, and `/events/schema` proxy to the backend. The backend also serves the last built dashboard on port 8000. Rebuild frontend assets before using that single-process version after UI changes.

## Connect your AI / IDE

Click **Connect your AI** in the dashboard to copy a machine-specific configuration and the reporting instructions. It generates absolute paths to this installation; it does not change your IDE settings automatically.

1. Run CodeWatch locally and watch your project.
2. Add the generated CodeWatch MCP server to your tool's MCP configuration.
3. Enable the server/tools in that tool.
4. Give the agent the provided reporting instructions with your task.
5. Keep CodeWatch visible beside the editor, or in the editor's browser panel if it has one.

**[Full integration guide: Antigravity, ChatGPT/Codex, and other MCP clients](integrations.md)**

Local MCP clients can launch the bridge through stdio. Agent activity appears when the agent actually calls the reporting tools; installing an MCP server alone does not intercept every internal action. Folder watching works even without MCP and does not attribute changes to a particular AI.

ChatGPT in a browser requires an additional supported connection, such as a configured Secure MCP Tunnel; it cannot launch this local stdio process directly. That remote setup is not provisioned by this project. See the integration guide's current official references and limitations.

Light reporting is now the default: major milestones, important blockers, and final
completion. Choose **Detailed** in **Connect your AI** for command/test and finer
step reports. Copy the selected configuration and instructions, then reload your
agent's MCP connection. File watching and completion alerts work in both modes.
[Reporting mode setup](integrations.md#light-and-detailed-reporting).

### MCP tools

- `codewatch_watch_project`: attach a local project and return its session/run ID.
- `codewatch_status`: discover the current session.
- `codewatch_progress`: report stage, concise action, and affected paths.
- `codewatch_relationship`: describe a connection between two project files.
- `codewatch_test`: report a test attempt and its outcome.
- `codewatch_command`: report command start and finish with the same invocation ID.
- `codewatch_complete`: report that the agent's task is complete; watching continues.

Each report requires the current `run_id`. Old reports cannot accidentally update a different watched project. Names/identities are provided by the client; CodeWatch does not authenticate which model made a change.

## Capture actual terminal commands

The dashboard and MCP bridge never execute arbitrary project commands. Run the explicit wrapper yourself when you want real command output in the dashboard:

```powershell
.\backend\.venv\Scripts\python.exe -m backend.cli run -- python -m pytest
```

The command runs in the **watched project directory**, forwards output to your terminal, reports its exit code, and returns that exit code. Arguments are passed directly without an implicit shell. On Windows, use an executable such as `python.exe` or explicitly invoke your intended shell when shell syntax is needed.

To capture individual test cases, ask your test runner to produce JUnit XML:

```powershell
.\backend\.venv\Scripts\python.exe -m backend.cli run --junit .local/results.xml --attempt 1 -- python -m pytest --junitxml=.local/results.xml
```

Create the report's parent folder in your project if the test runner requires it. Use `--attempt 2` on the next run. Only a new/changed report inside the project is read; skipped cases are omitted. Output retained in the dashboard is capped at 16,000 characters, and JUnit input at 2 MB / 500 tests. Command output and names you send can contain sensitive text, so choose what you report to the local dashboard.

Other CLI commands:

```powershell
.\backend\.venv\Scripts\python.exe -m backend.cli status
.\backend\.venv\Scripts\python.exe -m backend.cli attach 'D:\Projects\OtherApp' --agent 'My coding agent'
.\backend\.venv\Scripts\python.exe -m backend.cli config
.\backend\.venv\Scripts\python.exe -m backend.cli stop
```

For a custom port: `serve --port 8010`, and put `--server-url http://127.0.0.1:8010` before `status`, `attach`, `config`, `stop`, or `run`.

## What the real dashboard shows

- A connected work flow with selectable steps, latest report and agent-reported working file. Its arrows show report order; step details show actual known file connections.
- A compact pinned companion that keeps the flow visible beside your editor, with full-app controls for the complete dashboard.
- A project map of actual folders, recent changes, file search, and readable **Uses code from** / **Used by** lists. A small diagram is optional, and the map can be collapsed.
- Solid import relationships and separately identified agent-reported relationships.
- The current reported task and active files, without inventing a stage from filesystem activity.
- Actual reported stage visits, including repeated testing/debugging cycles.
- Newest file changes first, including deletion, and source-labeled tests and commands.
- Bounded chronological event history and NDJSON download.
- Session identity, path, tracked files, changed files, counters, scan warnings, and connection status.
- Automatic reconnect with a complete graph snapshot and retained test/command/stage results.
- Stop/reconnect project controls. Closing a dashboard tab does not stop the watcher or other viewers.

One project is active per CodeWatch server process. Selecting another project switches the shared session for all connected viewers. To observe projects independently, run separate servers on different ports. Runs are kept in memory until the server stops; persistent historical replay is not implemented.

## Scanner coverage and limits

The watcher polls approximately every 750 ms and reads source files without executing them or modifying the watched repository.

- **Python:** AST-based local absolute/relative imports, package initializers and common `src/` layout.
- **JavaScript / TypeScript / JSX / TSX:** best-effort local relative static imports/exports, literal `require()`/`import()`, directory indexes, and TypeScript source behind `.js` imports.
- Other supported source/config languages appear as file nodes. Their dependencies are not fabricated.
- Package aliases, `tsconfig` path mappings, computed imports, remote APIs, database usage and runtime calls are not automatically resolved. Agents can explicitly report higher-level relationships.
- Folder/name-based roles such as frontend, API, service, repository and database are inferred labels, not semantic verification.
- Root `.gitignore` and `.codewatchignore` are respected. Dependency folders, generated output, common secrets/key files, binary files, symlinks and junctions are skipped. Nested ignore files are not interpreted.
- Default limits: 500 tracked files, 512 KB per file, with additional traversal/depth/total-byte caps. Warnings disclose incomplete scans. Watch a smaller subfolder for large repositories.
- Folder cards summarize the full indexed project. File lists show up to 100 entries; search narrows longer lists. The optional diagram shows the selected file and up to three neighbors on each side, while its connection lists retain all known direct links.
- File state settles after a short highlight. Test failures stay failed until subsequent test reports resolve them.

A short-lived file created and removed between polls can be missed. Rapid changes can be coalesced into one observed update. Deleted or ignored files are removed from the graph; newly ignored files are not falsely reported as deleted on disk.

## Event and transport architecture

```text
Any editor / coding agent                MCP-capable agent
          |                                     |
          v                                     v
    Local project files                 CodeWatch stdio bridge
          |                                     |
          v                                     | HTTP reports
  Read-only scanner ----> Universal Events <----+
                                ^
                                | Explicit CLI command / JUnit capture
                                |
                          FastAPI session
                                |
                                | /ws/live (snapshot + events + heartbeat)
                                v
                        React Flow dashboard
```

Pydantic models validate producer data; matching Zod schemas validate the browser boundary. Each event has `schemaVersion`, unique `runId` / `eventId`, UTC timestamp, monotonic sequence, event type/status, `source`, optional `agentName`, and typed `data`.

Sources are `filesystem`, `agent`, `command`, `system`, and `simulator`. A source is provenance supplied by the local integration, not a cryptographic guarantee. The server assigns IDs/order. Agent reports describe actions and outcomes, not private reasoning.

`GET /events/schema` exposes the full contract. The live API is:

| Route | Purpose |
| --- | --- |
| `GET /health` | Health check |
| `GET /api/session` | Current watched session |
| `POST /api/watch` | Attach `{path, agentName?}` |
| `POST /api/watch/stop` | Stop `{runId}` |
| `GET /api/integrations` | Generated local MCP setup |
| `POST /api/agent/progress` | `{runId, agentName, stage, message, paths}` |
| `POST /api/agent/relationship` | `{runId, agentName, source, target, label, description?}` |
| `POST /api/agent/test` | `{runId, agentName, name, status, attempt, path?, details?}` |
| `POST /api/agent/command` | `{runId, agentName, commandId, command, status, output?, exitCode?}` |
| `POST /api/agent/complete` | `{runId, agentName, message}` |
| `WS /ws/live` | Shared session snapshots, events and heartbeats |
| `WS /ws/build` | Isolated simulated demo |

The live stream sends an initial `snapshot` containing session metadata, the last 500 events, up to 2,000 activity events for step evidence, retained outcomes/stage visits, and canonical nodes/edges; then `event` and `session` frames. Heartbeats arrive during quiet periods. Slow subscribers receive a fresh snapshot. History remains bounded and in memory.

For direct local scripts, report HTTP JSON using the same routes. Producers must use current run IDs and project-relative paths; traversal, linked paths and common secret paths are rejected. Command outcomes must follow a started invocation, and older test attempts are rejected.

The desktop API and MCP service bind to loopback. Browser origins are checked, including WebSockets; mutating HTTP calls require JSON. Optional phone sharing uses a separate, paired read-only viewer through a temporary tunnel; it does not publish the desktop API. `CODEWATCH_ALLOWED_ORIGINS` can extend the frontend origin list. `CODEWATCH_SERVER_URL` configures bridge/CLI clients; MCP configuration uses the backend's configured server URL. Do not expose the local observer as an unauthenticated public service.

## Demo mode

The original 36-second Todo simulation remains in the **Demo** tab. It emits 73 events, including a test failure, debugging, and a passing rerun. It is explicitly simulated and never writes the example files or runs those example commands. Use it to explore the UI without selecting a real project.

## Development and verification

The v0.5.0 verification recorded **176 backend tests, 45 frontend unit tests, 42 native-window/tunnel/notification tests and 20 browser tests**, plus lint and a production build. The actual portable EXE passed native Windows completion notifications, embedded icons and public phone pairing. Details are recorded in [Windows packaging](windows-packaging.md). These checks do not mean every vendor's IDE or physical phone was manually tested.

```powershell
.\backend\.venv\Scripts\python.exe -m pip install -r backend/requirements-dev.txt
.\backend\.venv\Scripts\python.exe -m pytest -q
.\backend\.venv\Scripts\python.exe -m ruff check backend
npm.cmd --prefix frontend test
node --test desktop/main.test.cjs desktop/phone-tunnel.test.cjs desktop/completion-notifications.test.cjs desktop/windows-notifications.test.cjs
npm.cmd --prefix frontend run build
npm.cmd --prefix frontend run test:e2e
```

Browser tests use installed Google Chrome and start/reuse ports 8000 and 5173. Close your interactive session before running them: the real-project test switches the watched project to a temporary fixture. If Chrome is unavailable, install Playwright Chromium and remove the `channel: 'chrome'` setting. Tests cover real file changes, reconnects, reports, stale runs, boundaries, MCP protocol/forwarding, command capture, and the simulated flow.

## Important files

```text
backend/
  main.py                   HTTP/WebSockets, local origins, built dashboard hosting
  cli.py                    Single-process launcher and local CLI
  command_capture.py        Explicit process output / JUnit capture
  observer/
    scanner.py              Bounded read-only source/import analysis
    manager.py              Watch lifecycle, diffs and subscribers
    session.py              Event history and canonical graph state
    reports.py              Agent activity, relationships, commands and tests
    requests.py, routes.py  Producer API
  mcp_server.py             Official-SDK stdio integration
  integrations/             Shared loopback client, generated config/instructions
  models/events.py          Universal event schema
  agent/                    Optional deterministic demo
frontend/src/
  hooks/useLiveEvents.ts     Persistent real-project connection
  state/build.ts            Shared event reducer
  types/events.ts           Runtime contract
  components/               Project map, demo graph, project setup, source-aware panels
  App.tsx, styles/           Dashboard and styling
```

## What is not automatic yet

Native IDE-specific tool-call hooks, packaged marketplace extensions, intercepting every agent action, remote/cloud workspace observation, symbol-level control flow, runtime tracing, advanced language/alias resolution, multi-project tabs, durable session history, and permanent hosted dashboards. MCP and the event API are the extension points for adding those capabilities without coupling the graph to a particular model.
