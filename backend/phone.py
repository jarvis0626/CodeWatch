"""Revocable, read-only phone projection on its own loopback listener."""

import asyncio
from collections import deque
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import secrets
import socket
from time import monotonic, time
from urllib.parse import urlsplit

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.gzip import GZipMiddleware
import uvicorn

from backend.observer.manager import WatchManager
from backend.observer.scanner import is_sensitive_name
from backend.observer.session import ProjectSession

COOKIE = "codewatch_phone"
MAX_PAIR_BYTES = 4096
MAX_VIEWERS = 8
MAX_PAIR_FAILURES = 20
PUBLIC_HOST = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$")


def _relative(path: str | None) -> str | None:
    if not path or not isinstance(path, str):
        return None
    normalized = path.replace("\\", "/")
    parts = PurePosixPath(normalized).parts
    if not parts or PurePosixPath(normalized).is_absolute() or PureWindowsPath(path).drive:
        return None
    if any(part == ".." or is_sensitive_name(part) for part in parts):
        return None
    return PurePosixPath(*parts).as_posix()


def phone_snapshot(session: ProjectSession) -> dict:
    """Expose report text and relative metadata, never roots, output logs or code."""
    root = str(session.root)
    roots = {root, root.replace("\\", "/"), root.replace("/", "\\")}
    roots |= {value.replace("\\", "\\\\") for value in roots}

    def text(value):
        if not isinstance(value, str):
            return value
        for prefix in sorted(roots, key=len, reverse=True):
            value = re.sub(re.escape(prefix), "[project]", value, flags=re.IGNORECASE)
        value = re.sub(r"\b[A-Za-z]:[\\/][^\s\"'<>|]*", "[local path]", value)
        return value

    def node(data):
        path = _relative(data.get("path"))
        if data.get("path") and not path:
            return None
        return {
            key: text(value) for key, value in data.items()
            if key in {"id", "kind", "state", "message"}
        } | {"path": path, "label": path.split("/")[-1] if path else text(data["label"])}

    def edge(data):
        return {key: text(value) for key, value in data.items()
                if key in {"id", "source", "target", "label", "message", "evidence"}}

    def event(original):
        kind = original["type"]
        payload = original["data"]
        data = {key: text(value) for key, value in payload.items()
                if key not in {"output", "details", "description"}}
        if kind.startswith("file_"):
            path = _relative(payload.get("path"))
            if not path:
                return None
            data["path"] = path
        elif kind == "graph_node_added":
            data = node(payload)
            if not data:
                return None
        elif kind == "graph_edge_added":
            data = edge(payload)
        elif kind.startswith("command_"):
            # Command arguments can contain credentials even without output.
            parts = payload["command"].strip().split(maxsplit=1)
            first = parts[0].strip('"\'') if parts else "Command"
            name = first.replace("\\", "/").split("/")[-1]
            name = name if re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", name) else "Command"
            data["command"] = name
            data["message"] = f"{name}: {original['status']}"
        return {key: text(value) for key, value in original.items() if key != "data"} | {"data": data}

    raw = session.snapshot()
    nodes = [projected for item in raw["graph"]["nodes"] if (projected := node(item))]
    node_ids = {item["id"] for item in nodes}
    edges = [projected for item in raw["graph"]["edges"]
             if (projected := edge(item))["source"] in node_ids and projected["target"] in node_ids]
    info = raw["session"]
    info = {key: text(value) for key, value in info.items() if key not in {"projectPath", "warnings"}}
    info.update(projectPath="", warnings=[])
    return {
        "kind": "snapshot", "session": info,
        **{key: [projected for item in raw[key] if (projected := event(item))]
           for key in ("events", "activityEvents", "retainedEvents")},
        "graph": {"nodes": nodes, "edges": edges},
    }


class _PhoneServer(uvicorn.Server):
    @contextmanager
    def capture_signals(self):
        # The owning desktop server handles process signals.
        yield


class _Activate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    shareId: str = Field(min_length=1, max_length=128)
    publicUrl: str = Field(min_length=1, max_length=512)


class _Stop(BaseModel):
    model_config = ConfigDict(extra="forbid")
    shareId: str | None = Field(default=None, max_length=128)


class PhoneShare:
    def __init__(self, manager: WatchManager, *, frontend_dir: Path | None = None, ttl_seconds: float = 28800):
        if ttl_seconds <= 0:
            raise ValueError("Phone sharing needs a positive lifetime")
        self.manager = manager
        self.frontend_dir = frontend_dir or Path(__file__).resolve().parent.parent / "frontend" / "dist"
        self.ttl_seconds = ttl_seconds
        self._lock = asyncio.Lock()
        self._server = None
        self._server_task = None
        self._monitor_task = None
        self._listener = None
        self._endpoint = None
        self._share_id = None
        self._run_id = None
        self._pair_token = None
        self._expires_at = None
        self._deadline = 0.0
        self._public_origin = None
        self._sessions: dict[str, float] = {}
        self._pair_failures: deque[float] = deque(maxlen=MAX_PAIR_FAILURES)

    def _revoke(self):
        self._pair_token = None
        self._sessions.clear()
        self._public_origin = None
        if self._server:
            self._server.should_exit = True

    def _valid(self) -> bool:
        current = self.manager.current
        if not self._pair_token:
            return False
        if monotonic() >= self._deadline or not current or current.run_id != self._run_id:
            self._revoke()
            return False
        if self._server_task and self._server_task.done():
            self._revoke()
            return False
        return True

    def status(self) -> dict:
        active = self._valid()
        return {
            "active": active, "shareId": self._share_id if active else None,
            "endpoint": self._endpoint if active else None, "runId": self._run_id if active else None,
            "expiresAt": self._expires_at if active else None, "pairedDevices": len(self._sessions),
        }

    def _start_result(self):
        return {"endpoint": self._endpoint, "pairToken": self._pair_token,
                "expiresAt": self._expires_at, "runId": self._run_id, "shareId": self._share_id}

    async def start(self) -> dict:
        async with self._lock:
            if self._valid():
                return self._start_result()
            await self._stop_locked()
            session = self.manager.current
            if not session or not session.watching:
                raise HTTPException(409, "Connect a project before sharing its flow")
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                listener.bind(("127.0.0.1", 0))
                self._listener = listener
                self._endpoint = f"http://127.0.0.1:{listener.getsockname()[1]}"
                self._share_id = secrets.token_urlsafe(18)
                self._pair_token = secrets.token_urlsafe(32)
                self._run_id = session.run_id
                self._deadline = monotonic() + self.ttl_seconds
                self._expires_at = datetime.fromtimestamp(time() + self.ttl_seconds, timezone.utc).isoformat()
                self._pair_failures.clear()
                config = uvicorn.Config(self.viewer_app(), log_level="warning", access_log=False,
                                        loop="asyncio", http="h11", ws="none", lifespan="off",
                                        proxy_headers=False, timeout_graceful_shutdown=1, limit_concurrency=32)
                self._server = _PhoneServer(config)
                self._server_task = asyncio.create_task(self._server.serve(sockets=[listener]))
                deadline = monotonic() + 5
                while not self._server.started and not self._server_task.done() and monotonic() < deadline:
                    await asyncio.sleep(0.02)
                if not self._server.started or self._server_task.done():
                    raise RuntimeError("Phone viewer could not start")
                self._monitor_task = asyncio.create_task(self._monitor())
                return self._start_result()
            except BaseException:
                await self._stop_locked()
                listener.close()
                raise

    async def activate(self, share_id: str, public_url: str) -> dict:
        try:
            parsed = urlsplit(public_url)
        except ValueError as exc:
            raise HTTPException(422, "Use the exact generated HTTPS viewer origin") from exc
        if (parsed.scheme != "https" or not parsed.hostname or not PUBLIC_HOST.fullmatch(parsed.hostname)
                or parsed.netloc != parsed.hostname or parsed.path or parsed.query or parsed.fragment
                or parsed.username or parsed.password or public_url != f"https://{parsed.hostname}"):
            raise HTTPException(422, "Use the exact generated HTTPS viewer origin")
        async with self._lock:
            if not self._valid() or share_id != self._share_id:
                raise HTTPException(409, "This phone sharing session has ended")
            if self._public_origin and self._public_origin != public_url:
                self._sessions.clear()
            self._public_origin = public_url
            return self.status()

    async def _monitor(self):
        try:
            while self._valid():
                await asyncio.sleep(min(1, self.ttl_seconds))
            await self.stop()
        except asyncio.CancelledError:
            pass

    async def _stop_locked(self):
        self._revoke()
        monitor, server_task = self._monitor_task, self._server_task
        self._monitor_task = None
        if monitor and monitor is not asyncio.current_task():
            monitor.cancel()
            await asyncio.gather(monitor, return_exceptions=True)
        if server_task:
            try:
                await asyncio.wait_for(asyncio.shield(server_task), timeout=3)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                server_task.cancel()
                await asyncio.gather(server_task, return_exceptions=True)
            except Exception:
                pass
        if self._listener:
            self._listener.close()
        self._server = self._server_task = self._listener = None
        self._endpoint = self._share_id = self._run_id = self._expires_at = None
        self._pair_failures.clear()

    async def stop(self, share_id: str | None = None) -> dict:
        async with self._lock:
            if share_id and self._share_id and share_id != self._share_id:
                raise HTTPException(409, "This phone sharing session has ended")
            await self._stop_locked()
            return {"active": False}

    async def close(self):
        await self.stop()

    def router(self) -> APIRouter:
        router = APIRouter()

        @router.get("/api/phone/status")
        async def status():
            return self.status()

        @router.post("/api/phone/start")
        async def start():
            return await self.start()

        @router.post("/api/phone/activate")
        async def activate(body: _Activate):
            return await self.activate(body.shareId, body.publicUrl)

        @router.post("/api/phone/stop")
        async def stop(body: _Stop):
            return await self.stop(body.shareId)

        return router

    def _origin(self, request: Request) -> str | None:
        host = request.headers.get("host", "")
        if self._endpoint and host == urlsplit(self._endpoint).netloc:
            return self._endpoint
        if self._public_origin and host == urlsplit(self._public_origin).netloc:
            return self._public_origin
        return None

    def _authorized(self, request: Request) -> bool:
        credential = request.cookies.get(COOKIE, "")
        deadline = self._sessions.get(credential, 0)
        return self._valid() and deadline > monotonic()

    def viewer_app(self) -> FastAPI:
        app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
        app.add_middleware(GZipMiddleware, minimum_size=1000)

        @app.middleware("http")
        async def viewer_boundary(request, call_next):
            expected = self._origin(request)
            origin = request.headers.get("origin")
            if not self._valid():
                return JSONResponse({"detail": "Phone sharing has ended"}, status_code=410)
            if not expected or (origin and origin != expected):
                return JSONResponse({"detail": "Viewer connection denied"}, status_code=403)
            response = await call_next(request)
            response.headers.update({
                "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'self'; script-src 'self'; "
                    "style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; "
                    "font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            })
            return response

        @app.get("/phone")
        async def page():
            index = self.frontend_dir / "index.html"
            if not index.is_file():
                raise HTTPException(503, "Phone viewer assets are not built")
            return FileResponse(index, media_type="text/html")

        @app.get("/phone/health")
        async def health():
            return {"shareId": self._share_id, "active": True}

        @app.post("/api/pair")
        async def pair(request: Request):
            if request.headers.get("origin") != self._origin(request):
                raise HTTPException(403, "Viewer connection denied")
            if request.headers.get("content-type", "").split(";")[0] != "application/json":
                raise HTTPException(415, "Use application/json")
            length = request.headers.get("content-length", "0")
            if not length.isdigit() or len(length) > 16 or int(length) > MAX_PAIR_BYTES:
                raise HTTPException(413, "Pairing request too large")
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > MAX_PAIR_BYTES:
                    raise HTTPException(413, "Pairing request too large")
            try:
                value = json.loads(body)
                credential = value["token"] if isinstance(value, dict) else None
            except (ValueError, KeyError, TypeError):
                credential = None
            now = monotonic()
            while self._pair_failures and self._pair_failures[0] <= now - 60:
                self._pair_failures.popleft()
            if len(self._pair_failures) >= MAX_PAIR_FAILURES:
                raise HTTPException(429, "Too many pairing attempts. Try again shortly")
            if (not isinstance(credential, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", credential)
                    or not self._pair_token
                    or not secrets.compare_digest(credential.encode(), self._pair_token.encode())):
                self._pair_failures.append(now)
                raise HTTPException(403, "Pairing code is invalid or sharing has ended")
            existing = request.cookies.get(COOKIE)
            if existing and self._authorized(request):
                session_token = existing
            else:
                if len(self._sessions) >= MAX_VIEWERS:
                    raise HTTPException(429, "This sharing session has reached its viewer limit")
                session_token = secrets.token_urlsafe(32)
                self._sessions[session_token] = self._deadline
            response = JSONResponse({"paired": True, "expiresAt": self._expires_at})
            response.set_cookie(COOKIE, session_token, httponly=True, samesite="strict",
                                secure=self._origin(request).startswith("https:"),
                                max_age=max(1, int(self._deadline - monotonic())), path="/")
            return response

        @app.get("/api/snapshot")
        async def snapshot(request: Request):
            if not self._authorized(request):
                raise HTTPException(403, "Scan the current sharing QR code to connect")
            current = self.manager.current
            revision = f'"{self._share_id}:{current.run_id}:{current.factory.sequence}:{int(current.watching)}"'
            if request.headers.get("if-none-match") == revision:
                return Response(status_code=304, headers={"ETag": revision})
            return JSONResponse(phone_snapshot(current), headers={"ETag": revision})

        assets = self.frontend_dir / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=assets), name="phone-assets")
        return app
