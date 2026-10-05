"""Phone sharing exposes a revocable metadata projection, never the desktop API."""

import asyncio
import json
from time import monotonic

from fastapi import HTTPException
import httpx
import pytest

from backend.models.events import event_adapter
from backend.observer.manager import WatchManager
from backend.observer.session import ProjectSession
from backend.phone import COOKIE, MAX_PAIR_FAILURES, MAX_VIEWERS, PhoneShare, phone_snapshot


def project(tmp_path):
    manager = WatchManager()
    manager.current = ProjectSession(tmp_path, "Coding assistant", manager.publish)
    return manager


def assets(tmp_path):
    directory = tmp_path / "viewer"
    (directory / "assets").mkdir(parents=True)
    (directory / "index.html").write_text('<html><body>Phone viewer</body></html>', encoding="utf-8")
    (directory / "assets" / "viewer.js").write_text('console.log("viewer")', encoding="utf-8")
    return directory


async def pair(client, started, **kwargs):
    return await client.post("/api/pair", json={"token": started["pairToken"]},
                             headers={"Origin": started["endpoint"]}, **kwargs)


def test_projection_preserves_work_flow_but_omits_roots_logs_command_arguments_and_sensitive_files(tmp_path):
    session = project(tmp_path).current
    root = str(tmp_path)
    session.warnings = [f"Cannot read {root}/secret/path"]
    session.emit("graph_node_added", id="file:main.py", path="main.py", label="Main",
                 kind="module", state="active", message=f"Editing {root}/main.py", description="Private details")
    session.emit("graph_node_added", id="file:service.py", path="service.py", label="Service",
                 kind="module", state="completed", message="Indexed service")
    session.emit("graph_node_added", id=f"file:{root}/outside.py", path=f"{root}/outside.py", label=root,
                 kind="module", state="completed", message="Outside file")
    session.emit("graph_edge_added", id="import:main:service", source="file:main.py", target="file:service.py",
                 label="imports", evidence="import", message="Observed import")
    report = session.emit("agent_stage", "running", event_source="agent", stage="IMPLEMENTING",
                          message=f"Connecting the handler in {root}/main.py")
    session.emit("file_modified", path="main.py", nodeId="file:main.py", message="Saved handler")
    session.emit("file_modified", path=".env", nodeId="file:.env", message="Sensitive file")
    session.emit("command_finished", event_source="command", commandId="test-1",
                 command=f'"{root}/python.exe" --api-key PRIVATE-ARGUMENT', output="PRIVATE-OUTPUT",
                 exitCode=0, message=f"{root}/python.exe --api-key PRIVATE-ARGUMENT finished")
    session.emit("test_passed", event_source="agent", name="Login", nodeId="tests", attempt=1,
                 details="PRIVATE-TEST-DETAILS", message="Login passed")
    snapshot = phone_snapshot(session)
    serialized = json.dumps(snapshot)
    assert root not in serialized
    assert "PRIVATE-ARGUMENT" not in serialized
    assert "PRIVATE-OUTPUT" not in serialized
    assert "PRIVATE-TEST-DETAILS" not in serialized
    assert "Private details" not in serialized
    assert '"path": ".env"' not in serialized
    assert snapshot["session"]["projectPath"] == ""
    assert snapshot["session"]["warnings"] == []
    assert {node["path"] for node in snapshot["graph"]["nodes"]} == {"main.py", "service.py"}
    assert snapshot["graph"]["edges"][0]["evidence"] == "import"
    preserved = next(event for event in snapshot["activityEvents"] if event["eventId"] == report["eventId"])
    assert preserved["data"]["message"].startswith("Connecting the handler in [project]")
    assert preserved["source"] == "agent"
    for key in ("events", "retainedEvents", "activityEvents"):
        for event in snapshot[key]:
            event_adapter.validate_python(event)


def test_pairing_uses_a_viewer_cookie_and_polling_returns_current_sanitized_snapshot(tmp_path):
    async def scenario():
        manager = project(tmp_path)
        share = PhoneShare(manager, frontend_dir=assets(tmp_path))
        started = await share.start()
        try:
            assert len(started["pairToken"]) >= 40
            assert started["runId"] == manager.current.run_id
            assert started == await share.start()
            assert "pairToken" not in share.status()
            async with httpx.AsyncClient(base_url=started["endpoint"], trust_env=False) as client:
                assert (await client.get("/phone")).status_code == 200
                assert (await client.get("/api/snapshot")).status_code == 403
                assert (await client.post("/api/pair?token=" + started["pairToken"], json={},
                                          headers={"Origin": started["endpoint"]})).status_code == 403
                assert (await client.post("/api/pair", json={"token": started["pairToken"]})).status_code == 403
                paired = await pair(client, started)
                assert paired.status_code == 200
                assert "HttpOnly" in paired.headers["set-cookie"]
                assert "SameSite=strict" in paired.headers["set-cookie"]
                assert "Secure" not in paired.headers["set-cookie"]
                assert COOKIE in client.cookies
                assert started["pairToken"] not in paired.headers["set-cookie"]
                response = await client.get("/api/snapshot")
                assert response.status_code == 200
                assert response.json()["session"]["projectPath"] == ""
                assert response.headers["cache-control"] == "no-store"
                assert response.headers["referrer-policy"] == "no-referrer"
                unchanged = await client.get("/api/snapshot", headers={"If-None-Match": response.headers["etag"]})
                assert unchanged.status_code == 304
                manager.current.emit("file_modified", path="main.py", nodeId="file:main.py", message="Saved")
                updated = await client.get("/api/snapshot", headers={"If-None-Match": response.headers["etag"]})
                assert updated.status_code == 200
                assert updated.headers["etag"] != response.headers["etag"]
                assert share.status()["pairedDevices"] == 1
                assert (await pair(client, started)).status_code == 200
                assert share.status()["pairedDevices"] == 1
                assert (await client.get("/api/snapshot", headers={"Origin": "https://attacker.example"})).status_code == 403
                assert (await client.get("/api/snapshot", headers={"Host": "attacker.example"})).status_code == 403
        finally:
            await share.close()
        assert share.status()["active"] is False
        assert share.status()["pairedDevices"] == 0
    asyncio.run(scenario())


def test_public_origin_must_be_activated_exactly_and_https_pairs_use_secure_cookies(tmp_path):
    async def scenario():
        share = PhoneShare(project(tmp_path), frontend_dir=assets(tmp_path))
        started = await share.start()
        public = "https://codewatch-test.trycloudflare.com"
        try:
            transport = httpx.ASGITransport(app=share.viewer_app())
            async with httpx.AsyncClient(transport=transport, base_url=public) as client:
                assert (await client.get("/phone/health")).status_code == 403
                await share.activate(started["shareId"], public)
                health = await client.get("/phone/health")
                assert health.json() == {"shareId": started["shareId"], "active": True}
                assert "pairToken" not in health.text
                assert (await client.post("/api/pair", json={"token": started["pairToken"]},
                                          headers={"Origin": "https://another.trycloudflare.com"})).status_code == 403
                paired = await client.post("/api/pair", json={"token": started["pairToken"]}, headers={"Origin": public})
                assert paired.status_code == 200
                assert "Secure" in paired.headers["set-cookie"]
                assert (await client.get("/api/snapshot")).status_code == 200
                assert (await client.get("/phone/health", headers={"Host": "another.trycloudflare.com"})).status_code == 403
        finally:
            await share.close()
    asyncio.run(scenario())


@pytest.mark.parametrize("origin", [
    "http://codewatch.trycloudflare.com", "https://user@codewatch.trycloudflare.com",
    "https://codewatch.trycloudflare.com:443", "https://codewatch.trycloudflare.com/",
    "https://codewatch.trycloudflare.com?token=secret", "https://codewatch.trycloudflare.com#token=secret",
    "https://codewatch.trycloudflare.com.attacker.example", "https://attacker.example",
    "https://[broken", "https://codewatch.trycloudflare.com\n",
])
def test_activation_refuses_non_exact_generated_origins(tmp_path, origin):
    async def scenario():
        share = PhoneShare(project(tmp_path))
        with pytest.raises(HTTPException) as denied:
            await share.activate("not-active", origin)
        assert denied.value.status_code == 422
    asyncio.run(scenario())


def test_paired_viewer_cannot_access_mutating_or_private_desktop_routes(tmp_path):
    async def scenario():
        manager = project(tmp_path)
        share = PhoneShare(manager, frontend_dir=assets(tmp_path))
        started = await share.start()
        try:
            async with httpx.AsyncClient(base_url=started["endpoint"], trust_env=False) as client:
                assert (await pair(client, started)).status_code == 200
                sequence = manager.current.factory.sequence
                for path in ("/api/session", "/api/integrations", "/api/phone/start", "/api/phone/stop",
                             "/api/watch", "/events/schema", "/docs", "/openapi.json", "/ws/live"):
                    assert (await client.get(path)).status_code == 404
                    assert (await client.post(path, json={})).status_code == 404
                assert (await client.post("/api/agent/progress", json={"stage": "COMPLETE"})).status_code == 404
                assert (await client.post("/api/snapshot", json={})).status_code == 405
                assert (await client.get("/assets/viewer.js")).status_code == 200
                assert (await client.get("/assets/%2e%2e/index.html")).status_code == 404
                assert manager.current.factory.sequence == sequence
                assert manager.current.watching
        finally:
            await share.close()
    asyncio.run(scenario())


def test_stop_revokes_sessions_closes_listener_and_stale_stop_cannot_end_a_new_share(tmp_path):
    async def scenario():
        share = PhoneShare(project(tmp_path))
        first = await share.start()
        client = httpx.AsyncClient(base_url=first["endpoint"], trust_env=False)
        try:
            assert (await pair(client, first)).status_code == 200
            old_cookie = client.cookies[COOKIE]
            assert await share.stop(first["shareId"]) == {"active": False}
            with pytest.raises(httpx.ConnectError):
                await client.get("/api/snapshot")
            second = await share.start()
            assert second["shareId"] != first["shareId"]
            assert second["pairToken"] != first["pairToken"]
            with pytest.raises(HTTPException) as stale:
                await share.stop(first["shareId"])
            assert stale.value.status_code == 409
            assert share.status()["shareId"] == second["shareId"]
            async with httpx.AsyncClient(base_url=second["endpoint"], trust_env=False,
                                         headers={"Cookie": f"{COOKIE}={old_cookie}"}) as next_client:
                assert (await next_client.get("/api/snapshot")).status_code == 403
                assert (await next_client.post("/api/pair", json={"token": first["pairToken"]},
                                               headers={"Origin": second["endpoint"]})).status_code == 403
        finally:
            await client.aclose()
            await share.close()
    asyncio.run(scenario())


def test_project_switch_and_expiry_revoke_access_without_exposing_the_new_project(tmp_path):
    async def scenario():
        manager = project(tmp_path)
        share = PhoneShare(manager)
        started = await share.start()
        try:
            async with httpx.AsyncClient(base_url=started["endpoint"], trust_env=False) as client:
                assert (await pair(client, started)).status_code == 200
                manager.current = ProjectSession(tmp_path / "another", "Other assistant", manager.publish)
                response = await client.get("/api/snapshot")
                assert response.status_code == 410
                assert "another" not in response.text
                assert share.status()["active"] is False
                assert share.status()["pairedDevices"] == 0
            await share.close()
            current = await share.start()
            async with httpx.AsyncClient(base_url=current["endpoint"], trust_env=False) as client:
                assert (await pair(client, current)).status_code == 200
                share._deadline = monotonic() - 1
                assert (await client.get("/api/snapshot")).status_code == 410
                assert share.status()["active"] is False
                assert share.status()["pairedDevices"] == 0
        finally:
            await share.close()
    asyncio.run(scenario())


def test_pairing_limits_body_size_failed_attempts_and_viewer_sessions(tmp_path):
    async def scenario():
        share = PhoneShare(project(tmp_path))
        started = await share.start()
        try:
            async with httpx.AsyncClient(base_url=started["endpoint"], trust_env=False) as client:
                headers = {"Origin": started["endpoint"], "Content-Type": "application/json"}
                assert (await client.post("/api/pair", content="x" * 5000, headers=headers)).status_code == 413

                async def chunks():
                    yield b"x" * 3000
                    yield b"x" * 2000
                assert (await client.post("/api/pair", content=chunks(), headers=headers)).status_code == 413
                assert (await client.post("/api/pair", content=b'{"token":"\\ud800"}', headers=headers)).status_code == 403
                for _ in range(MAX_PAIR_FAILURES - 1):
                    assert (await client.post("/api/pair", json={"token": "incorrect"}, headers=headers)).status_code == 403
                assert (await client.post("/api/pair", json={"token": "incorrect"}, headers=headers)).status_code == 429
                assert len(share._pair_failures) == MAX_PAIR_FAILURES
                await share.stop()
                started = await share.start()
            async with httpx.AsyncClient(base_url=started["endpoint"], trust_env=False) as client:
                for _ in range(MAX_VIEWERS):
                    client.cookies.clear()
                    assert (await pair(client, started)).status_code == 200
                client.cookies.clear()
                assert (await pair(client, started)).status_code == 429
                assert share.status()["pairedDevices"] == MAX_VIEWERS
        finally:
            await share.close()
    asyncio.run(scenario())


def test_start_requires_a_watched_project(tmp_path):
    async def scenario():
        manager = WatchManager()
        share = PhoneShare(manager)
        with pytest.raises(HTTPException) as missing:
            await share.start()
        assert missing.value.status_code == 409
        manager.current = ProjectSession(tmp_path, "Test assistant", manager.publish)
        manager.current.watching = False
        with pytest.raises(HTTPException) as stopped:
            await share.start()
        assert stopped.value.status_code == 409
        assert share.status()["active"] is False
    asyncio.run(scenario())
