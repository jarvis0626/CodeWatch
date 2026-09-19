"""Local HTTP/WebSocket transport. One connection owns one independent run."""

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager, suppress
from pathlib import Path

# Support both `uvicorn backend.main:app` and `cd backend; uvicorn main:app`.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from backend.agent.simulator import DEFAULT_EVENT_INTERVAL, simulate_build  # noqa: E402
from backend.models.events import StartBuild, event_adapter  # noqa: E402
from backend.observer.manager import WatchManager  # noqa: E402
from backend.observer.routes import make_router  # noqa: E402

logger = logging.getLogger("codewatch")
LOCAL_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]


def create_app(
    *,
    event_interval: float = DEFAULT_EVENT_INTERVAL,
    watch_interval: float = 0.75,
    project_path: str | None = None,
    server_url: str = "http://127.0.0.1:8000",
) -> FastAPI:
    manager = WatchManager(watch_interval)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if project_path:
            await manager.start(project_path, "External agent")
        try:
            yield
        finally:
            await manager.close()

    app = FastAPI(title="CodeWatch", version="0.2.0", lifespan=lifespan)
    app.state.watch_manager = manager
    origins = os.getenv("CODEWATCH_ALLOWED_ORIGINS", ",".join(LOCAL_ORIGINS)).split(",")
    origins = [origin.strip() for origin in origins if origin.strip()]
    origins = list(dict.fromkeys([*origins, server_url]))
    app.add_middleware(
        CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"], allow_headers=["Content-Type"]
    )

    @app.middleware("http")
    async def protect_local_api(request: Request, call_next):
        origin = request.headers.get("origin")
        if request.url.path.startswith("/api/") and origin and origin not in origins:
            return JSONResponse({"detail": "Origin not allowed"}, status_code=403)
        # Mutations must use JSON, so cross-origin HTML forms cannot attach arbitrary folders.
        if request.url.path.startswith("/api/") and request.method == "POST":
            if request.headers.get("content-type", "").split(";")[0] != "application/json":
                return JSONResponse({"detail": "Use application/json"}, status_code=415)
        return await call_next(request)

    app.include_router(make_router(manager, origins, server_url))

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/events/schema")
    async def event_schema():
        return event_adapter.json_schema()

    @app.websocket("/ws/build")
    async def build(websocket: WebSocket):
        # CORS doesn't cover WebSockets. Allow local browser origins and clients with no Origin.
        origin = websocket.headers.get("origin")
        if origin and origin not in origins:
            await websocket.close(code=1008, reason="Origin not allowed")
            return
        await websocket.accept()
        try:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
            StartBuild.model_validate_json(raw)
        except (ValidationError, asyncio.TimeoutError):
            await websocket.close(code=1008, reason="Send a valid start message within 10 seconds")
            return
        except WebSocketDisconnect:
            return

        async def produce():
            async for event in simulate_build(interval=event_interval):
                await websocket.send_json(event.model_dump(mode="json"))

        async def watch_disconnect():
            # Receiving concurrently makes reset/unmount cancel the producer immediately.
            while True:
                await websocket.receive_text()

        producer = asyncio.create_task(produce())
        receiver = asyncio.create_task(watch_disconnect())
        try:
            done, _ = await asyncio.wait({producer, receiver}, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            if producer in done:
                await websocket.close(code=1000, reason="Build complete")
        except (WebSocketDisconnect, OSError):
            pass
        except Exception:
            logger.exception("Build stream failed")
            with suppress(RuntimeError, OSError):
                await websocket.close(code=1011, reason="Build stream failed")
        finally:
            for task in (producer, receiver):
                task.cancel()
            await asyncio.gather(producer, receiver, return_exceptions=True)

    dashboard = Path(__file__).resolve().parent.parent / "frontend" / "dist"
    if dashboard.is_dir():
        app.mount("/", StaticFiles(directory=dashboard, html=True), name="dashboard")
    return app


app = create_app()
