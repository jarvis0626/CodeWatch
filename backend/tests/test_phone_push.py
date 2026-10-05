"""Real Web Push encryption and completion delivery with a captured provider transport."""

import asyncio
import base64
import json
from time import monotonic

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
import http_ece
import httpx
import jwt
import pytest

from backend.observer.manager import WatchManager
from backend.observer.session import ProjectSession
from backend.phone import COOKIE, PhoneShare
from backend.phone_push import _send, subscription


PUBLIC = "https://codewatch-push-test.trycloudflare.com"
PUSH = "https://fcm.googleapis.com/fcm/send/" + "PRIVATE-SUBSCRIPTION-" * 3


def browser():
    private = ec.generate_private_key(ec.SECP256R1())
    auth = b"browser-auth-key"  # Exactly 16 bytes.
    public = private.public_key().public_bytes(serialization.Encoding.X962,
                                                serialization.PublicFormat.UncompressedPoint)
    def b64(value):
        return base64.urlsafe_b64encode(value).rstrip(b"=").decode()
    return {"endpoint": PUSH, "expirationTime": None,
            "keys": {"p256dh": b64(public), "auth": b64(auth)}}, private, auth


def complete(manager, *, source="agent", status="completed", stage=True):
    if stage:
        return manager.current.emit("agent_stage", status, event_source=source,
                                    stage="COMPLETE", message="PRIVATE report: path/credentials")
    return manager.current.emit("build_complete", status, event_source=source, filesTouched=3,
                                testsPassed=2, testsTotal=2, message="PRIVATE completion report")


def progress(manager):
    manager.current.emit("agent_stage", "running", event_source="agent",
                         stage="IMPLEMENTING", message="A new task")


async def connected(tmp_path, sender):
    manager = WatchManager()
    manager.current = ProjectSession(tmp_path / "Example project", "Coding assistant", manager.publish)
    share = PhoneShare(manager, push_sender=sender)
    started = await share.start()
    await share.activate(started["shareId"], PUBLIC)
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=share.viewer_app()), base_url=PUBLIC)
    paired = await client.post("/api/pair", json={"token": started["pairToken"]}, headers={"Origin": PUBLIC})
    assert paired.status_code == 200
    return manager, share, started, client


async def enabled(client, value):
    response = await client.post("/api/push/subscribe", json=value, headers={"Origin": PUBLIC})
    assert response.status_code == 200, response.text
    assert response.json() == {"enabled": True}


def test_push_is_encrypted_signed_minimal_and_deduplicates_completion_until_next_task(tmp_path):
    async def scenario():
        captured = asyncio.Queue()

        async def sender(endpoint, headers, body):
            captured.put_nowait((endpoint, headers, body))
            return 201

        manager, share, _, client = await connected(tmp_path, sender)
        try:
            value, private, auth = browser()
            status = (await client.get("/api/push/status")).json()
            assert status["enabled"] is False
            assert len(status["publicKey"]) == 87
            await enabled(client, value)
            event = complete(manager)
            complete(manager, stage=False)
            complete(manager)
            endpoint, headers, body = await asyncio.wait_for(captured.get(), 2)
            assert endpoint == PUSH
            assert headers["Content-Encoding"] == "aes128gcm"
            assert headers["Content-Type"] == "application/octet-stream"
            assert 1 <= int(headers["TTL"]) <= 300
            assert b"PRIVATE" not in body
            payload = json.loads(http_ece.decrypt(body, private_key=private, auth_secret=auth, version="aes128gcm"))
            assert payload == {
                "eventId": event["eventId"], "runId": manager.current.run_id,
                "title": "Work reported complete",
                "body": "Example project: Your coding agent reported completion.", "url": "/phone",
                "tag": f"codewatch:{manager.current.run_id}:{event['eventId']}",
            }
            token, public = headers["Authorization"].removeprefix("vapid t=").split(",k=")
            assert public == status["publicKey"]
            verified = jwt.decode(token, share._push._vapid.public_key, algorithms=["ES256"],
                                  audience="https://fcm.googleapis.com")
            assert verified["sub"] == PUBLIC + "/phone"
            await asyncio.sleep(0.05)
            assert captured.empty()
            progress(manager)
            next_event = complete(manager, stage=False)
            _, _, next_body = await asyncio.wait_for(captured.get(), 2)
            next_payload = json.loads(http_ece.decrypt(next_body, private_key=private, auth_secret=auth,
                                                       version="aes128gcm"))
            assert next_payload["eventId"] == next_event["eventId"]
            assert next_payload["tag"] != payload["tag"]
            assert (await client.get("/api/push/status")).json()["enabled"] is True
        finally:
            await client.aclose()
            await share.close()
        assert not manager.subscribers
    asyncio.run(scenario())


def test_push_never_replays_history_or_announces_filesystem_simulator_failed_or_repeat_results(tmp_path):
    async def scenario():
        captured = []

        async def sender(*args):
            captured.append(args)
            return 201

        manager, share, _, client = await connected(tmp_path, sender)
        try:
            complete(manager)
            value, _, _ = browser()
            await enabled(client, value)
            complete(manager, stage=False)
            complete(manager)
            progress(manager)
            complete(manager, source="filesystem")
            complete(manager, source="simulator")
            complete(manager, status="failed")
            complete(manager, status="running")
            await asyncio.sleep(0.06)
            assert captured == []
            complete(manager)
            for _ in range(100):
                if captured:
                    break
                await asyncio.sleep(0.01)
            assert len(captured) == 1
        finally:
            await client.aclose()
            await share.close()
    asyncio.run(scenario())


def test_push_api_needs_cookie_exact_origin_bounded_json_and_restores_per_browser_state(tmp_path):
    async def scenario():
        async def sender(*args):
            return 201

        _, share, _, client = await connected(tmp_path, sender)
        try:
            value, _, _ = browser()
            client.cookies.clear()
            assert (await client.get("/api/push/status")).status_code == 403
            assert (await client.post("/api/push/subscribe", json=value, headers={"Origin": PUBLIC})).status_code == 403
            share._sessions["test-credential"] = share._deadline
            client.cookies.set(COOKIE, "test-credential", domain="codewatch-push-test.trycloudflare.com")
            assert (await client.post("/api/push/subscribe", json=value)).status_code == 403
            assert (await client.post("/api/push/unsubscribe", json={})).status_code == 403
            assert (await client.post("/api/push/subscribe", json=value,
                                      headers={"Origin": "https://attacker.example"})).status_code == 403
            headers = {"Origin": PUBLIC, "Content-Type": "application/json"}
            assert (await client.post("/api/push/subscribe", content=b"x" * 5000, headers=headers)).status_code == 413

            async def chunks():
                yield b"x" * 2000
                yield b"x" * 3000
            assert (await client.post("/api/push/subscribe", content=chunks(), headers=headers)).status_code == 413
            assert (await client.post("/api/push/subscribe", content=b"[", headers=headers)).status_code == 422
            assert (await client.post("/api/push/subscribe", content="{}", headers={"Origin": PUBLIC})).status_code == 415
            await enabled(client, value)
            state = await client.get("/api/push/status")
            assert state.json()["enabled"] is True
            assert PUSH not in state.text
            assert value["keys"]["auth"] not in state.text
            assert (await client.post("/api/push/unsubscribe", json={"other": True},
                                      headers={"Origin": PUBLIC})).status_code == 422
            assert (await client.post("/api/push/unsubscribe", json={}, headers={"Origin": PUBLIC})).json() == {
                "enabled": False}
            assert (await client.get("/api/push/status")).json()["enabled"] is False
        finally:
            await client.aclose()
            await share.close()
    asyncio.run(scenario())


@pytest.mark.parametrize("endpoint", [
    "http://fcm.googleapis.com/fcm/send/" + "a" * 30,
    "https://127.0.0.1/private", "https://192.168.1.10/private", "https://attacker.example/private",
    "https://fcm.googleapis.com.attacker.example/fcm/send/" + "a" * 30,
    "https://fcm.googleapis.com:443/fcm/send/" + "a" * 30,
    "https://user@fcm.googleapis.com/fcm/send/" + "a" * 30,
    "https://fcm.googleapis.com/fcm/send/" + "a" * 30 + "?forward=private",
    "https://fcm.googleapis.com/fcm/send/" + "a" * 30 + "#fragment",
    "https://fcm.googleapis.com/arbitrary-path", "https://web.push.apple.com.attacker.example/" + "a" * 30,
    "https://apple.com/" + "a" * 30, "https://push.apple.com/" + "a" * 30,
    "https://updates.push.services.mozilla.com/arbitrary", "https://fcm.googleapis.com/fcm/send/../../private",
    "https://fcm.googleapis.com/fcm/send/" + "a" * 30 + "\n",
    "https://[broken",
])
def test_push_endpoint_cannot_target_desktop_lan_arbitrary_paths_credentials_or_redirect_hosts(endpoint):
    value, _, _ = browser()
    value["endpoint"] = endpoint
    with pytest.raises(ValueError):
        subscription(value)


@pytest.mark.parametrize("endpoint", [
    "https://fcm.googleapis.com/fcm/send/" + "a" * 30,
    "https://fcm.googleapis.com/wp/" + "a" * 30,
    "https://updates.push.services.mozilla.com/wpush/v2/" + "a" * 30,
    "https://updates.push.services.mozilla.com/push/v1/" + "a" * 30,
    "https://web.push.apple.com/" + "a" * 30,
])
def test_standard_mobile_browser_push_endpoints_are_supported(endpoint):
    value, _, _ = browser()
    value["endpoint"] = endpoint
    assert subscription(value)["endpoint"] == endpoint


@pytest.mark.parametrize("key,value", [("auth", "bad"), ("p256dh", "bad"), ("auth", "!" * 22),
                                      ("p256dh", base64.urlsafe_b64encode(b"x" * 65).decode()),
                                      ("auth", None)])
def test_invalid_browser_encryption_keys_are_rejected(key, value):
    info, _, _ = browser()
    info["keys"][key] = value
    with pytest.raises(ValueError):
        subscription(info)


@pytest.mark.parametrize("outcome", [410, 503, "network"])
def test_dead_subscriptions_are_removed_and_provider_failures_remain_safe_nonfatal(tmp_path, outcome):
    async def scenario():
        delivered = asyncio.Event()

        async def sender(*args):
            delivered.set()
            if outcome == "network":
                raise OSError("PRIVATE-ENDPOINT and PRIVATE-KEY network exception")
            return outcome

        manager, share, _, client = await connected(tmp_path, sender)
        try:
            value, _, _ = browser()
            await enabled(client, value)
            complete(manager)
            await asyncio.wait_for(delivered.wait(), 2)
            await asyncio.sleep(0.04)
            response = await client.get("/api/push/status")
            assert response.status_code == 200
            assert "PRIVATE" not in response.text
            state = response.json()
            if outcome == 410:
                assert state["enabled"] is False
            else:
                assert state["enabled"] is True
                assert state["error"]
            assert share.status()["active"] is True
        finally:
            await client.aclose()
            await share.close()
    asyncio.run(scenario())


@pytest.mark.parametrize("revocation", ["stop", "unsubscribe", "project", "expiry"])
def test_revocation_cancels_inflight_push_and_no_later_completion_can_send(tmp_path, revocation):
    async def scenario():
        pending = asyncio.Event()
        cancelled = asyncio.Event()
        calls = 0

        async def sender(*args):
            nonlocal calls
            calls += 1
            pending.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise

        manager, share, _, client = await connected(tmp_path, sender)
        try:
            value, _, _ = browser()
            await enabled(client, value)
            complete(manager)
            await asyncio.wait_for(pending.wait(), 2)
            if revocation == "stop":
                await share.stop()
            elif revocation == "unsubscribe":
                assert (await client.post("/api/push/unsubscribe", json={},
                                          headers={"Origin": PUBLIC})).status_code == 200
            elif revocation == "project":
                manager.current = ProjectSession(tmp_path / "Different", "Other agent", manager.publish)
                assert share.status()["active"] is False
            else:
                share._deadline = monotonic() - 1
                assert share.status()["active"] is False
            await asyncio.wait_for(cancelled.wait(), 2)
            progress(manager)
            complete(manager)
            await asyncio.sleep(0.03)
            assert calls == 1
        finally:
            await client.aclose()
            await share.close()
    asyncio.run(scenario())


def test_push_transport_disables_redirects_has_bounded_timeout_and_ignores_proxy_environment(monkeypatch):
    import aiohttp

    calls = {}

    class Response:
        status = 307

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

    class Session:
        def __init__(self, **kwargs):
            calls["session"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        def post(self, endpoint, **kwargs):
            calls["post"] = (endpoint, kwargs)
            return Response()

    monkeypatch.setattr(aiohttp, "ClientSession", Session)
    assert asyncio.run(_send(PUSH, {"Authorization": "private"}, b"ciphertext")) == 307
    assert calls["session"]["trust_env"] is False
    assert calls["session"]["timeout"].total == 8
    assert calls["post"][1]["allow_redirects"] is False


def test_viewer_serves_only_named_service_worker_manifest_and_icons(tmp_path):
    async def scenario():
        manager = WatchManager()
        manager.current = ProjectSession(tmp_path, "Agent", manager.publish)
        directory = tmp_path / "viewer"
        directory.mkdir()
        for filename in ("phone-sw.js", "phone.webmanifest", "phone-icon-192.png", "phone-icon-512.png"):
            (directory / filename).write_bytes(b"asset")
        share = PhoneShare(manager, frontend_dir=directory)
        started = await share.start()
        try:
            async with httpx.AsyncClient(base_url=started["endpoint"], trust_env=False) as client:
                worker = await client.get("/phone-sw.js")
                assert worker.status_code == 200
                assert worker.headers["service-worker-allowed"] == "/phone"
                assert "worker-src 'self'" in worker.headers["content-security-policy"]
                assert (await client.get("/phone.webmanifest")).headers["content-type"].startswith(
                    "application/manifest+json")
                assert (await client.get("/phone-icon-192.png")).status_code == 200
                assert (await client.get("/phone-icon-512.png")).status_code == 200
                assert (await client.get("/phone-icon-513.png")).status_code == 404
                assert (await client.get("/phone-icon-../main.py.png")).status_code == 404
        finally:
            await share.close()
    asyncio.run(scenario())


def test_new_share_rotates_vapid_and_old_cookie_and_subscriptions_do_not_survive(tmp_path):
    async def scenario():
        calls = []

        async def sender(*args):
            calls.append(args)
            return 201

        manager, share, started, client = await connected(tmp_path, sender)
        try:
            value, _, _ = browser()
            await enabled(client, value)
            old_key = (await client.get("/api/push/status")).json()["publicKey"]
            old_cookie = client.cookies[COOKIE]
            await share.stop(started["shareId"])
            next_share = await share.start()
            await share.activate(next_share["shareId"], PUBLIC)
            assert client.cookies[COOKIE] == old_cookie
            assert (await client.get("/api/push/status")).status_code == 403
            paired = await client.post("/api/pair", json={"token": next_share["pairToken"]},
                                       headers={"Origin": PUBLIC})
            assert paired.status_code == 200
            status = (await client.get("/api/push/status")).json()
            assert status["enabled"] is False
            assert status["publicKey"] != old_key
            progress(manager)
            complete(manager)
            await asyncio.sleep(0.04)
            assert calls == []
        finally:
            await client.aclose()
            await share.close()
    asyncio.run(scenario())


def test_failed_key_setup_is_reported_without_disabling_phone_view_or_leaking_the_error(tmp_path, monkeypatch):
    from py_vapid import Vapid02

    def unavailable(self):
        raise OSError("PRIVATE runtime error")

    monkeypatch.setattr(Vapid02, "generate_keys", unavailable)

    async def scenario():
        async def sender(*args):
            pytest.fail("No unavailable push request may be sent")

        _, share, _, client = await connected(tmp_path, sender)
        try:
            result = (await client.get("/api/push/status")).json()
            assert result == {"enabled": False, "publicKey": None,
                              "error": "Phone notifications are unavailable in this build."}
            value, _, _ = browser()
            response = await client.post("/api/push/subscribe", json=value, headers={"Origin": PUBLIC})
            assert response.status_code == 503
            assert "PRIVATE" not in response.text
            assert (await client.get("/api/snapshot")).status_code == 200
        finally:
            await client.aclose()
            await share.close()
    asyncio.run(scenario())


def test_sharing_revoked_during_subscription_upload_cannot_register_with_a_new_session(tmp_path):
    async def scenario():
        async def sender(*args):
            pytest.fail("No revoked subscription may send")

        _, share, _, client = await connected(tmp_path, sender)
        uploading, release = asyncio.Event(), asyncio.Event()
        value, _, _ = browser()
        encoded = json.dumps(value).encode()

        async def chunks():
            yield encoded[:len(encoded) // 2]
            uploading.set()
            await release.wait()
            yield encoded[len(encoded) // 2:]

        request = asyncio.create_task(client.post("/api/push/subscribe", content=chunks(),
                                                 headers={"Origin": PUBLIC, "Content-Type": "application/json"}))
        try:
            await asyncio.wait_for(uploading.wait(), 2)
            await share.stop()
            restarted = await share.start()
            await share.activate(restarted["shareId"], PUBLIC)
            release.set()
            assert (await request).status_code == 403
            assert not share._push.subscribers
        finally:
            release.set()
            await asyncio.gather(request, return_exceptions=True)
            await client.aclose()
            await share.close()
    asyncio.run(scenario())
