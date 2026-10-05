"""Desktop trust boundary, protected endpoint discovery, and helper lifecycle."""

import asyncio
import base64
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from queue import Queue
import subprocess
import sys
from threading import Thread
import tomllib

from fastapi.testclient import TestClient
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
import pytest
from starlette.websockets import WebSocketDisconnect

from backend.desktop_security import DesktopBoundary, MAX_BODY_BYTES
from backend.integrations import discovery
from backend.integrations.client import BridgeError, CodeWatchClient
from backend.integrations.config import integration_config
from backend.main import create_app


ENDPOINT = "http://127.0.0.1:43187"
TOKEN = "desktop-test-credential-32-characters-minimum"


@pytest.fixture
def desktop_client():
    with TestClient(create_app(server_url=ENDPOINT, desktop_token=TOKEN), base_url=ENDPOINT) as client:
        yield client


@pytest.mark.parametrize("credential", ["bearer", "cookie"])
def test_desktop_http_authorizes_its_window_and_agent(desktop_client, credential):
    headers = ({"Authorization": f"Bearer {TOKEN}"} if credential == "bearer"
               else {"Cookie": f"codewatch_auth={TOKEN}"})
    response = desktop_client.get("/health", headers={"Origin": ENDPOINT, **headers})
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert desktop_client.get("/api/session", headers=headers).status_code == 200


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer wrong"},
        {"Authorization": f"Basic {TOKEN}"},
        {"Authorization": f"Bearer {TOKEN}", "Host": "attacker.example:43187"},
        {"Authorization": f"Bearer {TOKEN}", "Host": "localhost:43187"},
        {"Authorization": f"Bearer {TOKEN}", "Origin": "https://attacker.example"},
        {"Authorization": f"Bearer {TOKEN}", "Origin": "null"},
        {"Cookie": f"codewatch_auth={TOKEN}", "Origin": "http://localhost:5173"},
        # A supplied invalid bearer must not fall back to an otherwise valid window cookie.
        {"Authorization": "Bearer wrong", "Cookie": f"codewatch_auth={TOKEN}"},
    ],
)
def test_desktop_http_denies_foreign_hosts_origins_and_credentials(desktop_client, headers):
    response = desktop_client.get("/health", headers=headers)
    assert response.status_code == 403
    assert response.json() == {"detail": "Desktop connection denied"}


@pytest.mark.parametrize("credential", ["bearer", "cookie"])
def test_desktop_websocket_authorizes_its_window_and_agent(desktop_client, credential):
    headers = ({"Authorization": f"Bearer {TOKEN}"} if credential == "bearer"
               else {"Cookie": f"codewatch_auth={TOKEN}"})
    with desktop_client.websocket_connect(
        ENDPOINT.replace("http:", "ws:") + "/ws/live", headers={"Origin": ENDPOINT, **headers}
    ) as websocket:
        assert websocket.receive_json()["kind"] == "snapshot"


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer wrong"},
        {"Authorization": f"Bearer {TOKEN}", "Host": "attacker.example:43187"},
        {"Authorization": f"Bearer {TOKEN}", "Origin": "https://attacker.example"},
        {"Authorization": f"Bearer {TOKEN}", "Origin": "null"},
    ],
)
def test_desktop_websocket_denies_foreign_connections(desktop_client, headers):
    with pytest.raises(WebSocketDisconnect) as denied:
        with desktop_client.websocket_connect(ENDPOINT.replace("http:", "ws:") + "/ws/live", headers=headers):
            pytest.fail("The desktop trust boundary accepted a foreign connection")
    assert denied.value.code == 1008


def test_desktop_authorized_mutations_still_require_json(desktop_client):
    response = desktop_client.post(
        "/api/watch", headers={"Authorization": f"Bearer {TOKEN}"}, data={"path": "D:/project"}
    )
    assert response.status_code == 415


@pytest.mark.parametrize("content_length", ["2000001", "-1", "invalid", "9" * 5000])
def test_desktop_rejects_oversized_or_malformed_content_length(desktop_client, content_length):
    response = desktop_client.get(
        "/health", headers={"Authorization": f"Bearer {TOKEN}", "Content-Length": content_length}
    )
    assert response.status_code == 413


def test_desktop_rejects_non_ascii_credentials_without_crashing():
    async def exercise():
        async def unreachable_app(*args):
            pytest.fail("Invalid credentials reached the application")

        sent = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        scope = {
            "type": "http",
            "headers": [(b"host", b"127.0.0.1:43187"), (b"authorization", b"Bearer \xff")],
        }
        await DesktopBoundary(unreachable_app, TOKEN, ENDPOINT)(scope, receive, send)
        assert sent[0]["status"] == 403

    asyncio.run(exercise())


@pytest.mark.parametrize("size, expected_status", [(MAX_BODY_BYTES, 200), (MAX_BODY_BYTES + 1, 413)])
def test_desktop_bounds_chunked_http_payloads_without_content_length(size, expected_status):
    async def exercise():
        received = []
        sent = []
        chunks = iter([
            {"type": "http.request", "body": b"x" * 1_000_000, "more_body": True},
            {"type": "http.request", "body": b"x" * (size - 1_000_000), "more_body": False},
        ])

        async def receive():
            return next(chunks)

        async def send(message):
            sent.append(message)

        async def app(scope, receive, send):
            message = await receive()
            received.append(message["body"])
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        scope = {
            "type": "http",
            "headers": [(b"host", b"127.0.0.1:43187"), (b"authorization", f"Bearer {TOKEN}".encode())],
        }
        await DesktopBoundary(app, TOKEN, ENDPOINT)(scope, receive, send)
        assert sent[0]["status"] == expected_status
        assert len(received) == int(expected_status == 200)
        if received:
            assert len(received[0]) == size

    asyncio.run(exercise())


def test_desktop_discovery_round_trip_keeps_windows_token_encrypted(tmp_path):
    path = tmp_path / "user data" / "desktop.json"
    discovery.write_discovery(path, ENDPOINT, TOKEN)
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert TOKEN not in path.read_text(encoding="utf-8")
    if os.name == "nt":
        assert payload["protection"] == "dpapi"
        assert base64.b64decode(payload["credential"]) != TOKEN.encode()
    else:
        assert payload["protection"] == "user-file"
        assert path.stat().st_mode & 0o777 == 0o600
    assert discovery.read_discovery(path) == (ENDPOINT, TOKEN)
    assert list(path.parent.iterdir()) == [path]


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows DPAPI")
def test_windows_discovery_encryption_failure_never_writes_plaintext(monkeypatch, tmp_path):
    def unavailable(*args, **kwargs):
        raise OSError("DPAPI unavailable")

    monkeypatch.setattr(discovery, "_dpapi", unavailable)
    path = tmp_path / "desktop.json"
    with pytest.raises(OSError, match="DPAPI unavailable"):
        discovery.write_discovery(path, ENDPOINT, TOKEN)
    assert not path.exists()
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {"version": 999},
        {"version": 1, "serverUrl": ENDPOINT, "credential": 17, "protection": "dpapi"},
        {"version": 1, "serverUrl": None, "credential": "AAAA", "protection": "dpapi"},
        {"version": 1, "serverUrl": ENDPOINT, "credential": "bad base64!", "protection": "dpapi"},
        {"version": 1, "serverUrl": ENDPOINT, "credential": "AAAA", "protection": "unsupported"},
    ],
)
def test_invalid_discovery_has_actionable_bridge_error(tmp_path, payload):
    path = tmp_path / "desktop.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(BridgeError, match="Open the CodeWatch desktop app"):
        CodeWatchClient(discovery_path=str(path)).request("GET", "/api/session")


def test_oversized_discovery_has_actionable_bridge_error(tmp_path):
    path = tmp_path / "desktop.json"
    path.write_bytes(b" " * (discovery.MAX_DISCOVERY_BYTES + 1))
    with pytest.raises(BridgeError, match="Open the CodeWatch desktop app"):
        CodeWatchClient(discovery_path=str(path)).request("GET", "/api/session")


@pytest.mark.skipif(os.name != "nt", reason="Windows must reject unprotected credentials")
def test_windows_discovery_refuses_plaintext_credential_files(tmp_path):
    path = tmp_path / "desktop.json"
    path.write_text(json.dumps({
        "version": 1, "serverUrl": ENDPOINT, "protection": "user-file",
        "credential": base64.b64encode(TOKEN.encode()).decode(),
    }), encoding="utf-8")
    with pytest.raises(ValueError, match="protection is unsupported"):
        discovery.read_discovery(path)


def test_discovered_remote_endpoint_never_receives_a_credential(monkeypatch, tmp_path):
    path = tmp_path / "desktop.json"
    discovery.write_discovery(path, "https://attacker.example", TOKEN)
    client = CodeWatchClient(discovery_path=str(path))

    def no_network(*args, **kwargs):
        pytest.fail("Discovery sent a credential to a non-loopback endpoint")

    monkeypatch.setattr(client.opener, "open", no_network)
    with pytest.raises(BridgeError, match="Open the CodeWatch desktop app"):
        client.request("GET", "/api/session")


def test_packaged_configs_launch_helper_without_python_script_or_credentials():
    executable = "C:\\Users\\Test Person\\CodeWatch\\CodeWatch Backend.exe"
    path = "C:\\Users\\Test Person\\AppData\\Roaming\\caf\u00e9\\desktop.json"
    config = integration_config(ENDPOINT, executable, "unused.py", discovery_path=path)
    toml_config = tomllib.loads(config["codexConfig"])["mcp_servers"]["codewatch"]
    json_config = config["mcpConfig"]["mcpServers"]["codewatch"]
    assert toml_config["command"] == json_config["command"] == executable
    assert toml_config["args"] == json_config["args"] == ["mcp", "--discovery", path]
    assert TOKEN not in json.dumps(config)
    assert "unused.py" not in json.dumps(config)


def test_desktop_api_generates_packaged_mcp_configuration(tmp_path):
    path = tmp_path / "desktop.json"
    app = create_app(server_url=ENDPOINT, desktop_token=TOKEN, discovery_path=str(path))
    with TestClient(app, base_url=ENDPOINT) as client:
        config = client.get("/api/integrations", headers={"Authorization": f"Bearer {TOKEN}"}).json()
    helper = config["mcpConfig"]["mcpServers"]["codewatch"]
    assert helper["command"] == sys.executable
    assert helper["args"] == ["mcp", "--discovery", str(path)]
    assert TOKEN not in json.dumps(config)


@contextmanager
def protected_reporting_backend(token, run_id):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            authorization = self.headers.get("Authorization")
            requests.append((self.path, authorization))
            assert authorization == f"Bearer {token}"
            data = json.dumps({"session": {"runId": run_id}}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_packaged_mcp_stdio_action_discovers_new_endpoint_and_token_after_restart(tmp_path):
    path = tmp_path / "desktop.json"
    new_token = TOKEN + "-restarted"
    with protected_reporting_backend(TOKEN, "first-run") as first:
        with protected_reporting_backend(new_token, "restarted-run") as restarted:
            discovery.write_discovery(path, first[0], TOKEN)

            async def exercise():
                params = StdioServerParameters(
                    command=sys.executable,
                    args=["-m", "backend.desktop_entry", "mcp", "--discovery", str(path)],
                    cwd=tmp_path,
                )
                async with stdio_client(params) as (read, write):
                    async with ClientSession(read, write) as session:
                        initialized = await session.initialize()
                        assert initialized.serverInfo.name == "CodeWatch"
                        assert len((await session.list_tools()).tools) == 7
                        first_status = await session.call_tool("codewatch_status")
                        assert first_status.structuredContent["session"]["runId"] == "first-run"
                        discovery.write_discovery(path, restarted[0], new_token)
                        restarted_status = await session.call_tool("codewatch_status")
                        assert restarted_status.structuredContent["session"]["runId"] == "restarted-run"
                        path.unlink()
                        unavailable = await session.call_tool("codewatch_status")
                        assert unavailable.isError
                        assert "Open the CodeWatch desktop app" in unavailable.content[0].text

            asyncio.run(asyncio.wait_for(exercise(), timeout=30))
    assert first[1] == [("/api/session", f"Bearer {TOKEN}")]
    assert restarted[1] == [("/api/session", f"Bearer {new_token}")]


def start_service(path, *, stdin=subprocess.PIPE):
    environment = os.environ.copy()
    environment["CODEWATCH_DESKTOP_TOKEN"] = TOKEN
    return subprocess.Popen(
        [sys.executable, "-m", "backend.desktop_entry", "serve", "--discovery", str(path)],
        stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment,
        cwd=path.parent,
    )


def stop_service(process):
    if process.poll() is None:
        process.kill()
        process.wait(timeout=5)
    for stream in (process.stdin, process.stdout, process.stderr):
        if stream and not stream.closed:
            stream.close()


def test_desktop_service_ready_means_health_is_available_and_parent_exit_cleans_up(tmp_path):
    path = tmp_path / "desktop.json"
    process = start_service(path)
    lines = Queue()
    Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True).start()
    try:
        ready = json.loads(lines.get(timeout=15))
        assert ready["kind"] == "ready"
        endpoint, token = discovery.read_discovery(path)
        assert endpoint == ready["url"]
        assert token == TOKEN
        client = CodeWatchClient(discovery_path=str(path))
        assert client.request("GET", "/health") == {"status": "ok"}
        with pytest.raises(BridgeError, match="403"):
            CodeWatchClient(endpoint).request("GET", "/health")
        process.stdin.close()
        # A non-daemon forced-exit timer would incorrectly keep the helper alive for eight seconds.
        assert process.wait(timeout=5) == 0
        assert not path.exists()
        assert process.stdout.read() == ""
    finally:
        stop_service(process)


def test_desktop_service_with_already_closed_parent_pipe_exits_without_publishing_ready(tmp_path):
    path = tmp_path / "desktop.json"
    process = start_service(path, stdin=subprocess.DEVNULL)
    try:
        assert process.wait(timeout=8) == 0
        assert not path.exists()
        assert process.stdout.read() == ""
    finally:
        stop_service(process)


def test_old_service_shutdown_preserves_restarted_service_discovery(tmp_path):
    path = tmp_path / "desktop.json"
    process = start_service(path)
    lines = Queue()
    Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True).start()
    try:
        assert json.loads(lines.get(timeout=15))["kind"] == "ready"
        new_endpoint = "http://127.0.0.1:43189"
        new_token = TOKEN + "-new-owner"
        discovery.write_discovery(path, new_endpoint, new_token)
        process.stdin.close()
        assert process.wait(timeout=5) == 0
        assert discovery.read_discovery(path) == (new_endpoint, new_token)
    finally:
        stop_service(process)


def test_desktop_mcp_clean_stdio_eof_has_no_shutdown_traceback(tmp_path):
    result = subprocess.run(
        [sys.executable, "-m", "backend.desktop_entry", "mcp", "--discovery", str(tmp_path / "desktop.json")],
        cwd=tmp_path, input="", capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0
    assert result.stdout == ""
    assert result.stderr == ""
