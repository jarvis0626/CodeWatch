import asyncio
from time import monotonic

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.websockets import WebSocketDisconnect

from backend.agent.simulator import simulate_build
from backend.main import create_app
from backend.models.events import event_adapter


@pytest.fixture
def client():
    with TestClient(create_app(event_interval=0)) as test_client:
        yield test_client


def read_run(ws):
    ws.send_json({"action": "start", "prompt": "An arbitrary display-only prompt"})
    events = []
    while True:
        event = ws.receive_json()
        events.append(event)
        event_adapter.validate_python(event)
        if event["type"] == "build_complete":
            return events


def test_health_schema_and_local_cors(client):
    assert client.get("/health").json() == {"status": "ok"}
    response = client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    schema = client.get("/events/schema").json()
    assert schema["discriminator"]["propertyName"] == "type"
    assert "graph_node_updated" in schema["discriminator"]["mapping"]


def test_complete_workflow_failure_recovery_and_graph_integrity(client):
    with client.websocket_connect("/ws/build", headers={"Origin": "http://localhost:5173"}) as ws:
        events = read_run(ws)
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == 1000
    assert len({e["runId"] for e in events}) == 1
    assert len({e["eventId"] for e in events}) == len(events)
    assert [e["sequence"] for e in events] == list(range(1, len(events) + 1))
    stages = [e["data"]["stage"] for e in events if e["type"] == "agent_stage"]
    assert stages == [
        "PLANNING",
        "EXPLORING",
        "IMPLEMENTING",
        "RUNNING",
        "TESTING",
        "DEBUGGING",
        "TESTING",
        "VALIDATING",
        "COMPLETE",
    ]
    nodes, tests, commands, paths = {"agent": "planned"}, {}, {}, set()
    for event in events:
        kind, data = event["type"], event["data"]
        if kind == "graph_node_added":
            assert data["id"] not in nodes
            nodes[data["id"]] = data["state"]
        if kind == "graph_node_updated":
            assert data["nodeId"] in nodes
            nodes[data["nodeId"]] = data["state"]
        if kind == "graph_edge_added":
            assert data["source"] in nodes and data["target"] in nodes
        if kind in ("file_created", "file_modified"):
            if kind == "file_modified":
                assert data["path"] in paths
            paths.add(data["path"])
        if kind in ("test_passed", "test_failed"):
            tests[data["name"]] = kind
        if kind == "command_started":
            assert data["commandId"] not in commands
            commands[data["commandId"]] = event["status"]
        if kind == "command_finished":
            assert commands[data["commandId"]] == "running"
            commands[data["commandId"]] = event["status"]
    assert len(nodes) == 7 and set(nodes.values()) == {"completed"}
    assert len(paths) == 8
    assert len(tests) == 3 and set(tests.values()) == {"test_passed"}
    assert len(commands) == 4 and "running" not in commands.values()
    failed = next(i for i, e in enumerate(events) if e["type"] == "test_failed")
    debug = next(
        i for i, e in enumerate(events) if e["type"] == "agent_stage" and e["data"]["stage"] == "DEBUGGING"
    )
    fix = next(i for i, e in enumerate(events) if e["type"] == "file_modified")
    assert failed < debug < fix
    assert events[-1]["data"]["filesTouched"] == len(paths)


def test_runs_are_isolated_and_can_restart_after_disconnect(client):
    with client.websocket_connect("/ws/build") as first:
        first.send_json({"action": "start"})
        first_id = first.receive_json()["runId"]
        with client.websocket_connect("/ws/build") as second:
            second_events = read_run(second)
    with client.websocket_connect("/ws/build") as third:
        third_events = read_run(third)
    assert len({first_id, second_events[0]["runId"], third_events[0]["runId"]}) == 3
    assert third_events[0]["sequence"] == 1


@pytest.mark.parametrize("message", ["not-json", '{"action":"stop"}', '{"action":"start","prompt":3}'])
def test_invalid_start_closes_with_policy_error(client, message):
    with client.websocket_connect("/ws/build") as ws:
        ws.send_text(message)
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == 1008


def test_untrusted_browser_origin_is_rejected(client):
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/ws/build", headers={"Origin": "https://example.com"}):
            pass
    assert closed.value.code == 1008


def test_events_are_paced_and_iterator_can_be_canceled():
    async def observe():
        stream = simulate_build(interval=0.04)
        first = await anext(stream)
        start = monotonic()
        second = await anext(stream)
        elapsed = monotonic() - start
        await stream.aclose()
        return first, second, elapsed

    first, second, elapsed = asyncio.run(observe())
    assert first.runId == second.runId
    assert second.sequence == first.sequence + 1
    assert elapsed >= 0.03


def test_schema_rejects_mismatched_payload():
    with pytest.raises(ValidationError):
        event_adapter.validate_python(
            {
                "schemaVersion": 1,
                "runId": "r",
                "eventId": "e",
                "sequence": 1,
                "timestamp": "2026-09-15T12:00:00Z",
                "status": "running",
                "type": "file_created",
                "data": {"message": "Missing path and node"},
            }
        )
