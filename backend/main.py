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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from backend.agent.simulator import DEFAULT_EVENT_INTERVAL, simulate_build  # noqa: E402
from backend.models.events import StartBuild, event_adapter  # noqa: E402

logger = logging.getLogger("codewatch")
LOCAL_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]


def create_app(*, event_interval: float = DEFAULT_EVENT_INTERVAL) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield

    app = FastAPI(title="CodeWatch", version="1.0.0", lifespan=lifespan)
    origins = os.getenv("CODEWATCH_ALLOWED_ORIGINS", ",".join(LOCAL_ORIGINS)).split(",")
    origins = [origin.strip() for origin in origins if origin.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET"], allow_headers=["*"])

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

    return app


app = create_app()
