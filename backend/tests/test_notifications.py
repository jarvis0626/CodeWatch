"""Native alert feed stays local and retains outcomes through scanner traffic."""

from fastapi.testclient import TestClient

from backend.main import create_app


def test_native_feed_requires_desktop_authentication_and_omits_file_data(tmp_path):
    token = "native-alert-test-secret-at-least-32-characters"
    endpoint = "http://127.0.0.1:43187"
    headers = {"Authorization": f"Bearer {token}"}
    (tmp_path / "data.py").write_text("value = 1\n", encoding="utf-8")
    with TestClient(create_app(server_url=endpoint, desktop_token=token), base_url=endpoint) as client:
        assert client.get("/api/notifications").status_code == 403
        assert client.get("/api/notifications", headers=headers).json() == {
            "session": None, "sequence": 0, "events": [],
        }
        run_id = client.post("/api/watch", headers=headers, json={"path": str(tmp_path)}).json()["runId"]
        assert client.post("/api/agent/progress", headers=headers, json={
            "runId": run_id, "stage": "IMPLEMENTING", "message": "Prepare work", "paths": ["data.py"],
        }).status_code == 200
        assert client.post("/api/agent/complete", headers=headers, json={
            "runId": run_id, "message": "Reported done",
        }).status_code == 200
        response = client.get("/api/notifications", headers=headers)
        frame = response.json()
        assert frame["session"] == {"runId": run_id, "projectName": tmp_path.name, "watching": True}
        assert [event["type"] for event in frame["events"]] == ["agent_stage", "agent_stage", "build_complete"]
        assert frame["events"][-1]["sequence"] <= frame["sequence"]
        assert str(tmp_path) not in response.text
        assert "value = 1" not in response.text
        assert "graph_node_added" not in response.text


def test_native_feed_keeps_completion_after_general_feed_rollover(tmp_path):
    (tmp_path / "data.py").write_text("value = 1\n", encoding="utf-8")
    app = create_app()
    with TestClient(app) as client:
        run_id = client.post("/api/watch", json={"path": str(tmp_path)}).json()["runId"]
        assert client.post("/api/agent/complete", json={"runId": run_id, "message": "Reported done"}).status_code == 200
        session = app.state.watch_manager.current
        def rollover():
            for index in range(600):
                session.emit("graph_node_updated", nodeId="agent", state="active", message=f"Scan {index}")
        client.portal.call(rollover)
        response = client.get("/api/notifications").json()
        assert response["events"][-1]["type"] == "build_complete"
        assert response["events"][-1]["data"]["message"] == "Reported done"
        assert response["sequence"] == session.factory.sequence
        assert client.post("/api/watch/stop", json={"runId": run_id}).status_code == 200
        assert client.get("/api/notifications").json()["session"]["watching"] is False
