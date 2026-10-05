"""Per-share Web Push, encrypted for a paired browser and revoked with its share."""

import asyncio
import base64
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
import json
import math
import re
from time import monotonic, time
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from backend.observer.manager import WatchManager

Send = Callable[[str, dict, bytes], Awaitable[int]]


def _b64(value: str, size: int) -> bytes:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", value):
        raise ValueError("Invalid browser encryption keys")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as exc:
        raise ValueError("Invalid browser encryption keys") from exc
    if len(decoded) != size:
        raise ValueError("Invalid browser encryption keys")
    return decoded


def subscription(value: dict) -> dict:
    """Only browser push providers may receive outbound requests, never arbitrary URLs."""
    if not isinstance(value, dict) or set(value) - {"endpoint", "keys", "expirationTime"}:
        raise ValueError("Use a browser push subscription")
    endpoint = value.get("endpoint")
    if not isinstance(endpoint, str) or not 1 <= len(endpoint) <= 3072:
        raise ValueError("Use a supported browser push service")
    try:
        parsed = urlsplit(endpoint)
    except ValueError as exc:
        raise ValueError("Use a supported browser push service") from exc
    if (parsed.scheme != "https" or parsed.netloc != parsed.hostname or parsed.query or parsed.fragment
            or parsed.username or parsed.password or any(ord(char) <= 32 for char in endpoint)):
        raise ValueError("Use a supported browser push service")
    host, path = parsed.hostname or "", parsed.path
    token = r"[A-Za-z0-9_:-]{16,2048}"
    accepted = (
        host == "fcm.googleapis.com" and re.fullmatch(r"/(?:fcm/send|wp)/" + token, path)
        or host == "updates.push.services.mozilla.com" and re.fullmatch(r"/(?:wpush/v2|push/v1)/" + token, path)
        or re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.push\.apple\.com", host)
        and re.fullmatch(r"/" + token, path)
    )
    if not accepted:
        raise ValueError("This browser push service is not supported")
    keys = value.get("keys")
    if not isinstance(keys, dict) or set(keys) != {"p256dh", "auth"}:
        raise ValueError("Invalid browser encryption keys")
    public = _b64(keys["p256dh"], 65)
    _b64(keys["auth"], 16)
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), public)
    except ValueError as exc:
        raise ValueError("Invalid browser encryption keys") from exc
    expiry = value.get("expirationTime")
    if expiry is not None and (isinstance(expiry, bool) or not isinstance(expiry, (int, float))
                               or not math.isfinite(expiry) or expiry <= 0):
        raise ValueError("Invalid browser subscription expiry")
    return {"endpoint": endpoint, "keys": dict(keys)}


async def _send(endpoint: str, headers: dict, body: bytes) -> int:
    # aiohttp does not log private request URLs by default. Redirects and proxy
    # environment variables stay disabled so an endpoint cannot change destination.
    import aiohttp

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8), trust_env=False) as client:
        async with client.post(endpoint, data=body, headers=headers, allow_redirects=False) as response:
            return response.status


@dataclass
class _Subscriber:
    value: dict
    baseline: int
    error: str | None = None
    jobs: set[asyncio.Task] = field(default_factory=set)


class PhonePush:
    def __init__(self, manager: WatchManager, *, valid: Callable[[], bool], origin: Callable[[], str | None],
                 deadline: float, sender: Send | None = None):
        self.manager = manager
        self.valid = valid
        self.origin = origin
        self.deadline = deadline
        self.sender = sender or _send
        self.run_id = manager.current.run_id
        self.sequence = manager.current.factory.sequence
        self.completed = False
        self.subscribers: dict[str, _Subscriber] = {}
        self._vapid = None
        self._key_error = None
        self._key_lock = asyncio.Lock()
        self._closed = False
        self._queue = manager.subscribe()
        self._jobs: set[asyncio.Task] = set()
        self._monitor_task = asyncio.create_task(self._monitor())
        # Establish completion state without turning history into fresh alerts.
        for event in sorted(manager.current.activity_history, key=lambda item: item["sequence"]):
            self._completion(event)

    def _completion(self, event: dict) -> bool:
        if event.get("source") != "agent" or event.get("runId") != self.run_id:
            return False
        kind = event.get("type")
        if kind == "agent_stage" and event.get("data", {}).get("stage") != "COMPLETE":
            if event.get("status") in {"pending", "running", "completed"}:
                self.completed = False
            return False
        complete = (kind == "build_complete" or kind == "agent_stage"
                    and event.get("data", {}).get("stage") == "COMPLETE")
        if not complete or event.get("status") != "completed" or self.completed:
            return False
        self.completed = True
        return True

    async def public_key(self) -> str | None:
        async with self._key_lock:
            if self._closed or self._key_error:
                return None
            if self._vapid is None:
                try:
                    def generate():
                        from py_vapid import Vapid02
                        # RFC 8292 allows an HTTPS contact URI. The library's
                        # strict mode accepts only mailto; our URI is the already
                        # validated sharing origin, never a browser supplied value.
                        key = Vapid02(conf={"no-strict": True})
                        key.generate_keys()
                        # Verify the encryption library exists before offering setup.
                        from pywebpush import WebPusher
                        assert WebPusher
                        return key
                    key = await asyncio.to_thread(generate)
                    if self._closed:
                        return None
                    self._vapid = key
                except Exception:
                    self._key_error = "Phone notifications are unavailable in this build."
                    return None
            public = self._vapid.public_key.public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
            return base64.urlsafe_b64encode(public).rstrip(b"=").decode()

    async def status(self, credential: str) -> dict:
        key = await self.public_key()
        saved = self.subscribers.get(credential)
        result = {"enabled": saved is not None, "publicKey": key}
        error = self._key_error or (saved.error if saved else None)
        if error:
            result["error"] = error
        return result

    async def subscribe(self, credential: str, value: dict) -> dict:
        clean = subscription(value)
        if not await self.public_key():
            raise RuntimeError("Phone notifications are unavailable in this build.")
        if self._closed or not self.valid():
            raise RuntimeError("Phone sharing has ended")
        # A browser added after completion never receives that old result.
        self.subscribers[credential] = _Subscriber(clean, self.manager.current.factory.sequence)
        return {"enabled": True}

    def unsubscribe(self, credential: str) -> dict:
        saved = self.subscribers.pop(credential, None)
        if saved:
            for job in saved.jobs:
                job.cancel()
        return {"enabled": False}

    def revoke(self):
        self._closed = True
        self.subscribers.clear()
        self._vapid = None
        self.manager.subscribers.discard(self._queue)
        self._monitor_task.cancel()
        for job in self._jobs:
            job.cancel()

    async def close(self):
        self.revoke()
        await asyncio.gather(self._monitor_task, *tuple(self._jobs), return_exceptions=True)

    async def _monitor(self):
        try:
            while not self._closed:
                frame = await self._queue.get()
                if not self.valid():
                    self.revoke()
                    break
                if frame.get("kind") == "event":
                    events = [frame["event"]]
                elif frame.get("kind") == "snapshot":
                    events = list({event["eventId"]: event for group in
                                   ("events", "activityEvents", "retainedEvents")
                                   for event in frame.get(group, [])}.values())
                else:
                    continue
                for event in sorted(events, key=lambda item: item["sequence"]):
                    if event.get("runId") != self.run_id or event["sequence"] <= self.sequence:
                        continue
                    self.sequence = event["sequence"]
                    if not self._completion(event):
                        continue
                    payload = {
                        "eventId": event["eventId"], "runId": self.run_id,
                        "title": "Work reported complete",
                        "body": f"{self.manager.current.root.name[:100]}: Your coding agent reported completion.",
                        "url": "/phone", "tag": f"codewatch:{self.run_id}:{event['eventId']}",
                    }
                    for credential, saved in tuple(self.subscribers.items()):
                        if event["sequence"] <= saved.baseline:
                            continue
                        job = asyncio.create_task(self._deliver(credential, saved, payload))
                        self._jobs.add(job)
                        saved.jobs.add(job)
                        job.add_done_callback(self._jobs.discard)
                        job.add_done_callback(saved.jobs.discard)
        except asyncio.CancelledError:
            pass

    async def _deliver(self, credential: str, saved: _Subscriber, payload: dict):
        try:
            if self._closed or not self.valid() or self.subscribers.get(credential) is not saved:
                return
            key, origin = self._vapid, self.origin()
            if not key or not origin:
                return

            def encode():
                from pywebpush import WebPusher
                parsed = urlsplit(saved.value["endpoint"])
                headers = key.sign({"aud": f"https://{parsed.hostname}", "sub": origin + "/phone",
                                    "exp": int(time()) + 3600})
                headers.update({"Content-Type": "application/octet-stream", "Content-Encoding": "aes128gcm",
                                "TTL": str(max(1, min(300, int(self.deadline - monotonic())))),
                                "Urgency": "normal"})
                body = WebPusher(saved.value).encode(json.dumps(payload).encode(), "aes128gcm")["body"]
                return headers, body

            headers, body = await asyncio.to_thread(encode)
            if self._closed or not self.valid() or self.subscribers.get(credential) is not saved:
                return
            status = await self.sender(saved.value["endpoint"], headers, body)
            if self.subscribers.get(credential) is not saved:
                return
            if status in {404, 410}:
                self.subscribers.pop(credential, None)
            elif not 200 <= status < 300:
                saved.error = "The phone push service could not accept the latest notification."
            else:
                saved.error = None
        except asyncio.CancelledError:
            pass
        except Exception:
            # Never print an endpoint, encryption key, request body or provider error.
            if self.subscribers.get(credential) is saved:
                saved.error = "The latest phone notification could not be delivered."
