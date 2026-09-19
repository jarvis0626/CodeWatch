import asyncio
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.main import create_app
from backend.models.events import event_adapter
from backend.observer.scanner import ProjectSnapshot


@pytest.fixture
def client():
    with TestClient(create_app(watch_interval=0.03)) as connection:
        yield connection


def write(root: Path, path: str, contents: str = "") -> Path:
    file = root / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(contents, encoding="utf-8")
    return file


def attach(client, root: Path) -> dict:
    response = client.post("/api/watch", json={"path": str(root)})
    assert response.status_code == 200, response.text
    return response.json()


def frame(ws, timeout: float = 4) -> dict:
    # TestClient's public receive_json has no timeout. Bound its underlying receive
    # so a broken producer fails this test instead of hanging the full suite.
    async def receive():
        async with asyncio.timeout(timeout):
            return await ws._send_rx.receive()

    message = ws.portal.call(receive)
    assert message["type"] == "websocket.send", message
    return json.loads(message["text"])


def until(ws, predicate, timeout: float = 4) -> list[dict]:
    deadline = time.monotonic() + timeout
    received = []
    while time.monotonic() < deadline:
        try:
            value = frame(ws, max(0.01, deadline - time.monotonic()))
        except TimeoutError:
            pytest.fail(f"Timed out waiting for live frame; last frames: {received[-5:]!r}", pytrace=False)
        received.append(value)
        if value.get("kind") == "event":
            event_adapter.validate_python(value["event"])
        if predicate(value):
            return received
    pytest.fail(f"Expected live frame not received; got {received!r}")


def event_is(kind: str, path: str | None = None):
    return lambda value: (
        value.get("kind") == "event"
        and value["event"]["type"] == kind
        and (path is None or value["event"]["data"].get("path") == path)
    )


def snapshot(client) -> dict:
    with client.websocket_connect("/ws/live") as ws:
        state = frame(ws)
    assert state["kind"] == "snapshot"
    for event in state["events"]:
        event_adapter.validate_python(event)
    return state


def post(client, endpoint: str, run_id: str, **data):
    return client.post(f"/api/agent/{endpoint}", json={"runId": run_id, "agentName": "Test agent", **data})


def test_live_attach_file_changes_import_edges_deletion_and_reconnect(client, tmp_path):
    write(tmp_path, "main.py", "import service\n")
    service = write(tmp_path, "service.py", "value = 1\n")
    with client.websocket_connect("/ws/live") as ws:
        assert frame(ws)["session"] is None
        session = attach(client, tmp_path)
        initial = until(
            ws, lambda value: value.get("kind") == "session" and value["session"]["trackedFiles"] == 2
        )
        events = [value["event"] for value in initial if value["kind"] == "event"]
        assert any(
            event["type"] == "graph_edge_added" and event["data"]["evidence"] == "import" for event in events
        )
        assert not any(event["type"].startswith("file_") for event in events)
        assert not any(event["type"] == "agent_stage" for event in events)
        assert {event["source"] for event in events} <= {"filesystem", "system"}
        service.write_text("value = 2\n", encoding="utf-8")
        changed = until(ws, event_is("file_modified", "service.py"))[-1]["event"]
        assert changed["source"] == "filesystem"
        helper = write(tmp_path, "helper.py", "import service\n")
        until(ws, event_is("file_created", "helper.py"))
        until(
            ws,
            lambda value: (
                value.get("kind") == "event"
                and value["event"]["type"] == "graph_edge_added"
                and value["event"]["data"]["source"] == "file:helper.py"
            ),
        )
        helper.write_text("value = 3\n", encoding="utf-8")
        until(ws, event_is("graph_edge_removed"))
        service.unlink()
        removed = until(ws, event_is("graph_node_removed"))
        assert any(event_is("file_deleted", "service.py")(value) for value in removed)
    state = snapshot(client)
    assert state["session"]["runId"] == session["runId"]
    assert {node["id"] for node in state["graph"]["nodes"]} == {"agent", "file:main.py", "file:helper.py"}
    assert state["graph"]["edges"] == []
    sequences = [event["sequence"] for event in state["events"]]
    assert sequences == sorted(set(sequences))
    assert len({event["eventId"] for event in state["events"]}) == len(sequences)


def test_agent_progress_relationships_and_completion_are_reported_evidence(client, tmp_path):
    write(tmp_path, "ui.tsx")
    write(tmp_path, "api.py")
    session = attach(client, tmp_path)
    run_id = session["runId"]
    with client.websocket_connect("/ws/live") as ws:
        frame(ws)
        response = post(
            client,
            "progress",
            run_id,
            stage="IMPLEMENTING",
            message="Connecting the UI to the API",
            paths=["ui.tsx"],
        )
        assert response.status_code == 200 and response.json()["eventIds"]
        events = until(ws, event_is("agent_stage"))
        stage = events[-1]["event"]
        assert stage["source"] == "agent" and stage["agentName"] == "Test agent"
        assert stage["data"]["stage"] == "IMPLEMENTING"
        response = post(
            client,
            "relationship",
            run_id,
            source="ui.tsx",
            target="api.py",
            label="requests",
            description="UI calls the API",
        )
        assert response.status_code == 200, response.text
        until(ws, event_is("graph_edge_added"))
        assert post(client, "complete", run_id, message="Connected the files").status_code == 200
        until(ws, event_is("build_complete"))
    state = snapshot(client)
    assert state["session"]["watching"] is True
    assert state["session"]["agentName"] == "Test agent"
    edges = state["graph"]["edges"]
    assert len(edges) == 1
    assert (edges[0]["source"], edges[0]["target"], edges[0]["evidence"]) == (
        "file:ui.tsx",
        "file:api.py",
        "reported",
    )
    assert not any(event["type"].startswith("file_") for event in state["events"])


def test_failed_tests_remain_failed_when_agent_moves_or_finishes_then_pass_on_retry(client, tmp_path):
    write(tmp_path, "tests/test_api.py")
    run_id = attach(client, tmp_path)["runId"]
    common = {"name": "API returns data", "path": "tests/test_api.py"}
    assert (
        post(
            client, "progress", run_id, stage="TESTING", message="Checking the API", paths=[common["path"]]
        ).status_code
        == 200
    )
    assert post(client, "test", run_id, **common, status="running").status_code == 200
    assert (
        post(client, "test", run_id, **common, status="failed", details="Expected 200, got 500").status_code
        == 200
    )
    assert (
        post(
            client, "progress", run_id, stage="DEBUGGING", message="Investigating the API", paths=["api.py"]
        ).status_code
        == 200
    )
    failed = snapshot(client)
    assert (
        next(node for node in failed["graph"]["nodes"] if node["id"] == "file:tests/test_api.py")["state"]
        == "failed"
    )
    assert (
        post(
            client, "progress", run_id, stage="TESTING", message="Checking again", paths=[common["path"]]
        ).status_code
        == 200
    )
    assert post(client, "test", run_id, **common, status="failed", attempt=2).status_code == 200
    assert (
        post(client, "complete", run_id, message="Investigation finished; test still fails").status_code
        == 200
    )
    failed_complete = snapshot(client)
    assert (
        next(node for node in failed_complete["graph"]["nodes"] if node["id"] == "file:tests/test_api.py")[
            "state"
        ]
        == "failed"
    )
    assert post(client, "test", run_id, **common, status="running", attempt=3).status_code == 200
    assert post(client, "test", run_id, **common, status="passed", attempt=3).status_code == 200
    assert post(client, "test", run_id, **common, status="failed", attempt=2).status_code == 422
    passed = snapshot(client)
    assert (
        next(node for node in passed["graph"]["nodes"] if node["id"] == "file:tests/test_api.py")["state"]
        == "completed"
    )
    assert [event["type"] for event in passed["events"] if event["type"].startswith("test_")] == [
        "test_started",
        "test_failed",
        "test_failed",
        "test_started",
        "test_passed",
    ]


def test_command_lifecycle_captures_output_without_executing_reported_text(client, tmp_path):
    run_id = attach(client, tmp_path)["runId"]
    command = "echo reported text only"
    assert (
        post(
            client, "command", run_id, commandId="one", command=command, status="completed", exitCode=0
        ).status_code
        == 422
    )
    assert (
        post(client, "command", run_id, commandId="one", command=command, status="running").status_code == 200
    )
    assert (
        post(
            client, "command", run_id, commandId="one", command=command, status="completed", exitCode=1
        ).status_code
        == 422
    )
    assert (
        post(
            client,
            "command",
            run_id,
            commandId="one",
            command=command,
            status="failed",
            exitCode=2,
            output="failure details",
        ).status_code
        == 200
    )
    assert (
        post(client, "command", run_id, commandId="one", command=command, status="running").status_code == 422
    )
    assert (
        post(
            client, "command", run_id, commandId="two", command=command, status="running", capture="wrapper"
        ).status_code
        == 200
    )
    assert (
        post(
            client,
            "command",
            run_id,
            commandId="two",
            command=command,
            status="completed",
            exitCode=0,
            output="finished",
            capture="wrapper",
        ).status_code
        == 200
    )
    commands = [event for event in snapshot(client)["events"] if event["type"].startswith("command_")]
    assert [event["status"] for event in commands] == ["running", "failed", "running", "completed"]
    assert [event["source"] for event in commands] == ["agent", "agent", "command", "command"]
    assert commands[1]["data"]["output"] == "failure details"
    assert list(tmp_path.iterdir()) == []


def test_stop_restart_same_folder_and_stale_reports(client, tmp_path):
    first = attach(client, tmp_path)
    assert attach(client, tmp_path)["runId"] == first["runId"]
    assert client.post("/api/watch/stop", json={"runId": "old-run"}).status_code == 409
    assert client.post("/api/watch/stop", json={"runId": first["runId"]}).json()["watching"] is False
    assert (
        post(client, "progress", first["runId"], stage="PLANNING", message="Stale report").status_code == 409
    )
    second = attach(client, tmp_path)
    assert second["runId"] != first["runId"] and second["watching"]
    assert post(client, "complete", first["runId"]).status_code == 409
    assert snapshot(client)["session"]["runId"] == second["runId"]


@pytest.mark.parametrize(
    "path",
    [
        "../outside.py",
        "sub/../../outside.py",
        "/absolute.py",
        "C:\\outside.py",
        "C:outside.py",
        "\\\\server\\share\\outside.py",
        ".",
        ".env.local",
        ".git/config",
        "private.pem",
        "secrets.json",
        "secrets/password.py",
        ".ENV.production",
        "NODE_MODULES/library.py",
        "local.credentials.json",
    ],
)
def test_reports_reject_escaping_or_sensitive_paths_without_partial_events(client, tmp_path, path):
    run_id = attach(client, tmp_path)["runId"]
    before = client.get("/api/session").json()["session"]["eventCount"]
    response = post(
        client, "progress", run_id, stage="IMPLEMENTING", message="Invalid paths", paths=["safe.py", path]
    )
    assert response.status_code == 422, response.text
    state = snapshot(client)
    assert state["session"]["eventCount"] == before
    assert {node["id"] for node in state["graph"]["nodes"]} == {"agent"}


def test_agent_reports_cannot_follow_symlinks_outside_project(client, tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    outside = write(tmp_path, "outside/private.py")
    try:
        (project / "escape").symlink_to(outside.parent, target_is_directory=True)
    except OSError:
        pytest.skip("This Windows account cannot create symlinks")
    run_id = attach(client, project)["runId"]
    response = post(client, "test", run_id, name="fake", status="passed", path="escape/private.py")
    assert response.status_code == 422
    assert {node["id"] for node in snapshot(client)["graph"]["nodes"]} == {"agent"}


def test_partial_scan_preserves_nodes_then_real_deletion_is_detected(client, tmp_path, monkeypatch):
    from backend.observer import manager

    write(tmp_path, "main.py", "import service\n")
    service = write(tmp_path, "service.py")
    attach(client, tmp_path)
    original = manager.scan_project
    phase = {"partial": True}

    def scan(root):
        result = original(root)
        if phase["partial"]:
            return ProjectSnapshot(
                {path: value for path, value in result.files.items() if path != "service.py"},
                [],
                ["Temporary read failure"],
                True,
            )
        return result

    monkeypatch.setattr(manager, "scan_project", scan)
    with client.websocket_connect("/ws/live") as ws:
        frame(ws)
        until(
            ws,
            lambda value: (
                value.get("kind") == "session" and "Temporary read failure" in value["session"]["warnings"]
            ),
        )
        state = snapshot(client)
        assert "file:service.py" in {node["id"] for node in state["graph"]["nodes"]}
        assert any(
            edge["source"] == "file:main.py" and edge["target"] == "file:service.py"
            for edge in state["graph"]["edges"]
        )
        assert not any(event["type"] == "file_deleted" for event in state["events"])
        service.unlink()
        phase["partial"] = False
        until(ws, event_is("file_deleted", "service.py"))
    assert "file:service.py" not in {node["id"] for node in snapshot(client)["graph"]["nodes"]}


def test_syntax_warning_cannot_leave_a_permanent_deleted_file_in_the_graph(client, tmp_path):
    main = write(tmp_path, "main.py", "import service\n")
    service = write(tmp_path, "service.py")
    attach(client, tmp_path)
    with client.websocket_connect("/ws/live") as ws:
        frame(ws)
        main.write_text("def incomplete(\n", encoding="utf-8")
        until(ws, lambda value: value.get("kind") == "session" and bool(value["session"]["warnings"]))
        service.unlink()
        until(ws, event_is("file_deleted", "service.py"))
        main.write_text("value = 1\n", encoding="utf-8")
        until(ws, lambda value: value.get("kind") == "session" and not value["session"]["warnings"])
    assert "file:service.py" not in {node["id"] for node in snapshot(client)["graph"]["nodes"]}


def test_reconnect_retains_test_command_stage_and_graph_after_activity_history_rolls_over(client, tmp_path):
    write(tmp_path, "source.py")
    run_id = attach(client, tmp_path)["runId"]
    assert (
        post(
            client, "progress", run_id, stage="TESTING", message="Checking source", paths=["source.py"]
        ).status_code
        == 200
    )
    assert post(client, "test", run_id, name="retained test", status="passed").status_code == 200
    assert (
        post(
            client,
            "command",
            run_id,
            commandId="retained-command",
            command="python --version",
            status="running",
        ).status_code
        == 200
    )
    assert (
        post(
            client,
            "command",
            run_id,
            commandId="retained-command",
            command="python --version",
            status="completed",
            exitCode=0,
        ).status_code
        == 200
    )

    def fill_history():
        session = client.app.state.watch_manager.current
        for index in range(510):
            session.node_state("file:source.py", "active", f"Observed activity {index}")

    client.portal.call(fill_history)
    state = snapshot(client)
    assert len(state["events"]) == 500
    assert not any(
        event["type"] in {"test_passed", "command_finished", "agent_stage"} for event in state["events"]
    )
    retained_types = {event["type"] for event in state["retainedEvents"]}
    assert {"test_passed", "command_finished", "agent_stage"} <= retained_types
    assert {node["id"] for node in state["graph"]["nodes"]} == {"agent", "file:source.py", "tests"}
    assert state["session"]["eventCount"] > 500


def test_new_ignore_rule_removes_graph_node_without_claiming_file_was_deleted(client, tmp_path):
    source = write(tmp_path, "keep_on_disk.py")
    attach(client, tmp_path)
    with client.websocket_connect("/ws/live") as ws:
        frame(ws)
        write(tmp_path, ".codewatchignore", "keep_on_disk.py\n")
        until(ws, event_is("graph_node_removed"))
    state = snapshot(client)
    assert source.is_file()
    assert not any(event["type"] == "file_deleted" for event in state["events"])
    assert {node["id"] for node in state["graph"]["nodes"]} == {"agent"}


def test_invalid_watch_paths_and_untrusted_browser_origins_are_rejected(client, tmp_path):
    assert client.post("/api/watch", json={"path": str(tmp_path / "missing")}).status_code == 422
    assert client.post("/api/watch", json={"path": tmp_path.anchor}).status_code == 422
    assert (
        client.post(
            "/api/watch", json={"path": str(tmp_path)}, headers={"Origin": "https://untrusted.example"}
        ).status_code
        == 403
    )
    assert client.post("/api/watch", data={"path": str(tmp_path)}).status_code == 415
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/ws/live", headers={"Origin": "https://untrusted.example"}):
            pass
    assert closed.value.code == 1008
    assert client.get("/api/session").json()["session"] is None
