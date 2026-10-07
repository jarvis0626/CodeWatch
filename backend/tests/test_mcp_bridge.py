"""Exercise the public MCP protocol and backend forwarding, including stale runs."""

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
from threading import Thread
import tomllib

from fastapi.testclient import TestClient
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.shared.memory import create_connected_server_and_client_session
import pytest

from backend.integrations.config import AGENT_INSTRUCTIONS, integration_config
from backend.main import create_app
from backend.mcp_server import BridgeError, CodeWatchClient, create_mcp


@pytest.fixture
def reporting_backend():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            requests.append(("GET", self.path, None))
            self.respond({"session": {"runId": "run-1", "projectPath": "D:/sample", "watching": True}})

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(("POST", self.path, payload))
            if self.path == "/api/watch":
                self.respond({"runId": "run-1", "projectPath": payload["path"]})
            elif payload.get("runId") != "run-1":
                self.respond({"detail": "This run is no longer active"}, status=409)
            else:
                self.respond({"accepted": True, "runId": "run-1", "eventIds": ["event-1"]})

        def respond(self, payload, status=200):
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}", requests
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)


def test_mcp_stdio_handshake_discovery_reporting_and_stale_run(reporting_backend, tmp_path):
    """Use the SDK client against the real subprocess, launched from an unrelated cwd."""
    endpoint, requests = reporting_backend
    script = Path(__file__).resolve().parents[1] / "mcp_server.py"

    async def exercise():
        params = StdioServerParameters(
            command=sys.executable,
            args=[str(script), "--server-url", endpoint],
            cwd=tmp_path,
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                initialized = await session.initialize()
                assert initialized.serverInfo.name == "CodeWatch"
                assert "run_id" in initialized.instructions
                tools = {tool.name: tool for tool in (await session.list_tools()).tools}
                assert set(tools) == {
                    "codewatch_watch_project",
                    "codewatch_status",
                    "codewatch_progress",
                    "codewatch_relationship",
                    "codewatch_test",
                    "codewatch_command",
                    "codewatch_complete",
                }
                for name in set(tools) - {"codewatch_watch_project", "codewatch_status"}:
                    assert "run_id" in tools[name].inputSchema["required"]
                assert tools["codewatch_status"].annotations.readOnlyHint is True
                assert tools["codewatch_command"].annotations.readOnlyHint is False

                watched = await session.call_tool(
                    "codewatch_watch_project",
                    {
                        "path": "D:/sample",
                        "agent_name": "Antigravity",
                    },
                )
                assert not watched.isError
                assert watched.structuredContent["session"]["runId"] == "run-1"
                status = await session.call_tool("codewatch_status")
                assert status.structuredContent["session"]["watching"] is True

                examples = [
                    (
                        "codewatch_progress",
                        {
                            "stage": "IMPLEMENTING",
                            "message": "Connecting the login form to the API",
                            "paths": ["ui/Login.tsx", "api/login.py"],
                        },
                    ),
                    (
                        "codewatch_relationship",
                        {
                            "source": "ui/Login.tsx",
                            "target": "api/login.py",
                            "label": "calls",
                            "description": "The form posts credentials to the login endpoint.",
                        },
                    ),
                    (
                        "codewatch_test",
                        {
                            "name": "login rejects invalid credentials",
                            "status": "failed",
                            "attempt": 2,
                            "path": "tests/test_login.py",
                            "details": "Expected 401; received 500",
                        },
                    ),
                    (
                        "codewatch_command",
                        {
                            "command_id": "pytest-1",
                            "command": "pytest tests/test_login.py",
                            "status": "running",
                        },
                    ),
                    (
                        "codewatch_command",
                        {
                            "command_id": "pytest-1",
                            "command": "pytest tests/test_login.py",
                            "status": "failed",
                            "output": "1 failed",
                            "exit_code": 1,
                        },
                    ),
                    (
                        "codewatch_complete",
                        {"message": "Login flow implemented; failure remains documented."},
                    ),
                ]
                for name, arguments in examples:
                    result = await session.call_tool(
                        name,
                        {
                            "run_id": "run-1",
                            "agent_name": "Antigravity",
                            **arguments,
                        },
                    )
                    assert not result.isError
                    assert result.structuredContent["accepted"] is True

                request_count = len(requests)
                missing = await session.call_tool(
                    "codewatch_progress",
                    {
                        "stage": "TESTING",
                        "message": "Running tests",
                    },
                )
                assert missing.isError
                assert len(requests) == request_count  # Invalid reports never reach the backend.
                invalid = await session.call_tool(
                    "codewatch_test",
                    {
                        "run_id": "run-1",
                        "name": "login",
                        "status": "passed",
                        "attempt": 0,
                    },
                )
                assert invalid.isError
                assert len(requests) == request_count
                invalid_stage = await session.call_tool(
                    "codewatch_progress",
                    {
                        "run_id": "run-1",
                        "stage": "invented",
                        "message": "Doing work",
                    },
                )
                assert invalid_stage.isError
                assert len(requests) == request_count
                stale = await session.call_tool(
                    "codewatch_complete",
                    {
                        "run_id": "old-run",
                        "message": "Finished",
                    },
                )
                assert stale.isError
                assert "no longer active" in stale.content[0].text
                assert "codewatch_status" in stale.content[0].text

                resource = await session.read_resource("codewatch://instructions")
                assert "codewatch_relationship" in resource.contents[0].text
                prompt = await session.get_prompt("watch_my_work")
                assert "do not execute anything" in prompt.messages[0].content.text

    asyncio.run(asyncio.wait_for(exercise(), timeout=30))
    assert requests[0] == ("POST", "/api/watch", {"path": "D:/sample", "agentName": "Antigravity"})
    reports = {path: payload for method, path, payload in requests if method == "POST" and path.startswith("/api/agent/") and payload.get("runId") == "run-1"}
    assert reports["/api/agent/progress"]["paths"] == ["ui/Login.tsx", "api/login.py"]
    assert reports["/api/agent/relationship"]["description"].startswith("The form")
    assert reports["/api/agent/test"]["attempt"] == 2
    assert reports["/api/agent/command"]["commandId"] == "pytest-1"
    assert reports["/api/agent/command"]["exitCode"] == 1
    assert all(payload["agentName"] == "Antigravity" for payload in reports.values())
    assert all(payload["runId"] == "run-1" for payload in reports.values())


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://example.com",
        "file:///etc/passwd",
        "http://127.0.0.1:8000/api",
        "http://user:password@localhost:8000",
        "http://localhost:8000?target=elsewhere",
    ],
)
def test_bridge_rejects_remote_or_ambiguous_backend_origins(endpoint):
    with pytest.raises(ValueError, match="loopback"):
        CodeWatchClient(endpoint)


def test_bridge_unavailable_backend_has_actionable_error(monkeypatch):
    client = CodeWatchClient()

    def unavailable(*args, **kwargs):
        raise ConnectionRefusedError("offline")

    monkeypatch.setattr(client.opener, "open", unavailable)
    with pytest.raises(BridgeError, match="Start the CodeWatch backend"):
        client.request("GET", "/api/session")


def test_generated_configs_round_trip_windows_paths_with_spaces_and_unicode():
    executable = "C:\\Users\\Test Person\\CodeWatch\\backend\\.venv\\Scripts\\python.exe"
    bridge = "D:\\Projects\\caf\u00e9 project\\backend\\mcp_server.py"
    config = integration_config("http://127.0.0.1:8000/", executable, bridge)
    toml_config = tomllib.loads(config["codexConfig"])["mcp_servers"]["codewatch"]
    json_config = config["mcpConfig"]["mcpServers"]["codewatch"]
    assert toml_config["command"] == json_config["command"] == executable
    assert toml_config["args"] == json_config["args"] == [bridge, "--server-url", "http://127.0.0.1:8000"]
    assert "Light reporting mode" in config["instructions"]
    assert config["endpoint"] == "http://127.0.0.1:8000"


def test_mcp_tools_match_actual_backend_contract(monkeypatch, tmp_path):
    """Catch response-shape and lifecycle drift without touching a running user session."""
    project = tmp_path / "project"
    project.mkdir()
    (project / "app.py").write_text("def hello(): return 'hello'\n", encoding="utf-8")
    app = create_app(watch_interval=60)

    with TestClient(app) as backend:

        def local_request(self, method, path, payload=None):
            response = backend.request(method, path, json=payload)
            if response.is_error:
                raise BridgeError(str(response.json().get("detail")))
            return response.json()

        monkeypatch.setattr(CodeWatchClient, "request", local_request)

        async def exercise():
            async with create_connected_server_and_client_session(create_mcp()) as client:
                watch = await client.call_tool(
                    "codewatch_watch_project",
                    {
                        "path": str(project),
                        "agent_name": "Contract test",
                    },
                )
                assert not watch.isError
                run_id = watch.structuredContent["session"]["runId"]
                attached = await client.call_tool("codewatch_watch_project", {"path": str(project)})
                assert attached.structuredContent["session"]["runId"] == run_id
                current = await client.call_tool("codewatch_status")
                assert current.structuredContent["session"]["runId"] == run_id
                cases = [
                    (
                        "codewatch_progress",
                        {
                            "stage": "TESTING",
                            "message": "Checking the greeting",
                            "paths": ["app.py", "tests/test_app.py"],
                        },
                    ),
                    (
                        "codewatch_relationship",
                        {"source": "tests/test_app.py", "target": "app.py", "label": "tests"},
                    ),
                    (
                        "codewatch_command",
                        {"command_id": "check-1", "command": "pytest", "status": "running"},
                    ),
                    (
                        "codewatch_command",
                        {"command_id": "check-1", "command": "pytest", "status": "completed", "exit_code": 0},
                    ),
                    ("codewatch_test", {"name": "greeting", "status": "passed", "path": "tests/test_app.py"}),
                    ("codewatch_complete", {"message": "Greeting checked"}),
                ]
                for name, arguments in cases:
                    result = await client.call_tool(
                        name,
                        {
                            "run_id": run_id,
                            "agent_name": "Contract test",
                            **arguments,
                        },
                    )
                    assert not result.isError, result.content
                    assert result.structuredContent["accepted"] is True
                    assert result.structuredContent["eventIds"]
                assert backend.get("/api/session").json()["session"]["watching"] is True

        asyncio.run(asyncio.wait_for(exercise(), timeout=15))



def test_mode_changes_reach_connected_mcp_without_reconfiguration(monkeypatch, tmp_path):
    from backend.integrations.config import reporting_instructions

    discovery = str(tmp_path / 'profile' / 'desktop-connection.json')
    app = create_app(watch_interval=60, discovery_path=discovery)
    with TestClient(app) as backend:
        def local_request(self, method, path, payload=None):
            response = backend.request(method, path, json=payload)
            response.raise_for_status()
            return response.json()
        monkeypatch.setattr(CodeWatchClient, 'request', local_request)
        monkeypatch.setenv('CODEWATCH_REPORTING_MODE', 'detailed')  # Old config cannot override app.
        initial = backend.get('/api/integrations').json()
        assert initial['reportingMode'] == 'light'
        json_server = initial['mcpConfig']['mcpServers']['codewatch']
        toml_server = tomllib.loads(initial['codexConfig'])['mcp_servers']['codewatch']
        assert 'env' not in json_server and 'env' not in toml_server

        async def check():
            async with create_connected_server_and_client_session(create_mcp()) as client:
                assert (await client.initialize()).instructions == AGENT_INSTRUCTIONS
                first = await client.call_tool('codewatch_status', {})
                first_data = json.loads(first.content[0].text)
                assert first_data['reportingMode'] == 'light'
                assert first_data['reportingInstructions'] == reporting_instructions('light')
                again = await client.call_tool('codewatch_status', {})
                assert 'reportingInstructions' not in json.loads(again.content[0].text)
                assert backend.post('/api/reporting', json={'mode': 'detailed'}).status_code == 200
                changed = await client.call_tool('codewatch_status', {})
                assert json.loads(changed.content[0].text)['reportingInstructions'] == reporting_instructions('detailed')
                resource = await client.read_resource('codewatch://instructions')
                assert resource.contents[0].text == reporting_instructions('detailed')
                prompt = await client.get_prompt('watch_my_work')
                assert prompt.messages[0].content.text == reporting_instructions('detailed')
                assert len((await client.list_tools()).tools) == 7
        asyncio.run(check())
        updated = backend.get('/api/integrations').json()
        assert updated['mcpConfig'] == initial['mcpConfig']
        assert updated['codexConfig'] == initial['codexConfig']
        assert backend.post('/api/reporting', json={'mode': 'invalid'}).status_code == 422
        assert backend.get('/api/reporting').json()['mode'] == 'detailed'
    with TestClient(create_app(watch_interval=60, discovery_path=discovery)) as restarted:
        assert restarted.get('/api/reporting').json()['mode'] == 'detailed'


def test_mode_save_failure_does_not_change_active_mode(monkeypatch, tmp_path):
    discovery = str(tmp_path / 'profile' / 'desktop-connection.json')
    with TestClient(create_app(discovery_path=discovery)) as backend:
        def fail(*args, **kwargs):
            raise OSError('disk unavailable')
        monkeypatch.setattr(Path, 'write_text', fail)
        assert backend.post('/api/reporting', json={'mode': 'detailed'}).status_code == 500
        assert backend.get('/api/reporting').json()['mode'] == 'light'
