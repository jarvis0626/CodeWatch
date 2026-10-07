"""Local project and producer API. Watching never executes the target repository."""

import asyncio
import json
from pathlib import Path
import sys

import anyio
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from backend.integrations.config import ReportingMode, reporting_instructions
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


class ReportingPreference(BaseModel):
    mode: ReportingMode


def make_router(
    manager: WatchManager, origins: list[str], server_url: str, *, discovery_path: str | None = None
) -> APIRouter:
    router = APIRouter()
    preference_path = Path(discovery_path).parent / "reporting-mode.json" if discovery_path else None
    mode: ReportingMode = "light"
    if preference_path and preference_path.exists():
        try:
            saved = json.loads(preference_path.read_text(encoding="utf-8"))
            mode = ReportingPreference.model_validate(saved).mode
        except (OSError, ValueError):
            pass

    def guidance():
        return {"mode": mode, "instructions": reporting_instructions(mode)}

    @router.get("/api/reporting")
    async def reporting():
        return {"mode": mode}

    @router.post("/api/reporting")
    async def set_reporting(body: ReportingPreference):
        nonlocal mode
        if preference_path:
            try:
                preference_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = preference_path.with_suffix(".tmp")
                temporary.write_text(body.model_dump_json(), encoding="utf-8")
                temporary.replace(preference_path)
            except OSError as exc:
                raise HTTPException(500, "Could not save reporting mode; please retry") from exc
        mode = body.mode
        return {"mode": mode}


    @router.get("/api/session")
    async def session():
        return {"session": manager.current.info() if manager.current else None, "reporting": guidance()}

    @router.get("/api/notifications")
    async def notifications():
        """Small local feed for native alerts, independent of a hidden renderer."""
        current = manager.current
        if not current:
            return {"session": None, "sequence": 0, "events": []}
        events = {event["eventId"]: event for event in
                  [*current.activity_history, *current.stage_history, *current.retained.values()]
                  if event["source"] == "agent" and event["type"] in {"agent_stage", "build_complete"}}
        return {
            "session": {"runId": current.run_id, "projectName": current.root.name,
                        "watching": current.watching},
            "sequence": current.factory.sequence,
            "events": sorted(events.values(), key=lambda event: event["sequence"]),
        }

    @router.post("/api/watch")
    async def watch(body: WatchRequest):
        try:
            return {**await manager.start(body.path, body.agentName), "reporting": guidance()}
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
            discovery_path=discovery_path, reporting_mode=mode,
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
            "reporting": guidance(),
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
