"""Local project and producer API. Watching never executes the target repository."""

import asyncio
from pathlib import Path
import sys

import anyio
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from backend.observer import reports
from backend.observer.manager import WatchManager
from backend.observer.requests import (
    CommandRequest,
    CompleteRequest,
    ProgressRequest,
    RelationshipRequest,
    StopRequest,
    TestRequest,
    WatchRequest,
)


def make_router(
    manager: WatchManager, origins: list[str], server_url: str, *, discovery_path: str | None = None
) -> APIRouter:
    router = APIRouter()

    @router.get("/api/session")
    async def session():
        return {"session": manager.current.info() if manager.current else None}

    @router.post("/api/watch")
    async def watch(body: WatchRequest):
        try:
            return await manager.start(body.path, body.agentName)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.post("/api/watch/stop")
    async def stop(body: StopRequest):
        try:
            return await manager.stop(body.runId)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @router.get("/api/integrations")
    async def integrations():
        from backend.integrations.config import integration_config

        return integration_config(
            server_url, sys.executable, str(Path(__file__).resolve().parents[1] / "mcp_server.py"),
            discovery_path=discovery_path,
        )

    def report(body, handler):
        try:
            current = reports.active_session(manager, body.runId)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        sequence = current.factory.sequence
        try:
            handler(current, body)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        manager.publish({"kind": "session", "session": current.info()})
        return {
            "accepted": True,
            "runId": current.run_id,
            "eventIds": [event["eventId"] for event in current.history if event["sequence"] > sequence],
        }

    @router.post("/api/agent/progress")
    async def progress(body: ProgressRequest):
        return report(body, reports.progress)

    @router.post("/api/agent/relationship")
    async def relationship(body: RelationshipRequest):
        return report(body, reports.relationship)

    @router.post("/api/agent/test")
    async def test_result(body: TestRequest):
        return report(body, reports.test_result)

    @router.post("/api/agent/command")
    async def command_result(body: CommandRequest):
        return report(body, reports.command_result)

    @router.post("/api/agent/complete")
    async def complete(body: CompleteRequest):
        return report(body, reports.complete)

    @router.websocket("/ws/live")
    async def live(websocket: WebSocket):
        origin = websocket.headers.get("origin")
        if origin and origin not in origins:
            await websocket.close(code=1008, reason="Origin not allowed")
            return
        await websocket.accept()
        queue = manager.subscribe()

        async def send_frames():
            try:
                while True:
                    try:
                        frame = await asyncio.wait_for(queue.get(), timeout=10)
                    except asyncio.TimeoutError:
                        frame = {"kind": "heartbeat"}
                    await websocket.send_json(frame)
            except (WebSocketDisconnect, OSError, RuntimeError):
                pass
            finally:
                group.cancel_scope.cancel()

        async def receive_frames():
            try:
                while True:
                    frame = await websocket.receive()
                    if frame["type"] == "websocket.disconnect":
                        return
            finally:
                group.cancel_scope.cancel()

        try:
            async with anyio.create_task_group() as group:
                group.start_soon(send_frames)
                group.start_soon(receive_frames)
        finally:
            manager.subscribers.discard(queue)

    return router
