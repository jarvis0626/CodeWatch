"""In-memory live project state with a bounded event feed and complete graph snapshots."""

from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from backend.agent.events import EventFactory
from backend.models.events import EventSource, Status


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def file_id(path: str) -> str:
    return f"file:{path}"


class ProjectSession:
    def __init__(self, root: Path, agent_name: str, publish):
        self.root = root
        self.agent_name = agent_name
        self.run_id = f"watch_{uuid4().hex}"
        self.factory = EventFactory(self.run_id)
        self.connected_at = utc_now()
        self.last_activity = self.connected_at
        self.watching = True
        self.history: deque[dict] = deque(maxlen=500)
        self.retained: dict[str, dict] = {}
        self.stage_history: deque[dict] = deque(maxlen=50)
        self.nodes: dict[str, dict] = {}
        self.edges: dict[str, dict] = {}
        self.tests: dict[str, dict] = {}
        self.commands: dict[str, dict] = {}
        self.touched: set[str] = set()
        self.tracked_files = 0
        self.warnings: list[str] = []
        self.active_paths: set[str] = set()
        self.publish = publish

    def info(self) -> dict:
        return {
            "runId": self.run_id,
            "projectPath": str(self.root),
            "projectName": self.root.name,
            "agentName": self.agent_name,
            "watching": self.watching,
            "connectedAt": self.connected_at,
            "lastActivityAt": self.last_activity,
            "eventCount": self.factory.sequence,
            "trackedFiles": self.tracked_files,
            "warnings": self.warnings,
            "filesTouched": len(self.touched),
        }

    def snapshot(self) -> dict:
        return {
            "kind": "snapshot",
            "session": self.info(),
            "events": list(self.history),
            "retainedEvents": sorted(
                [*self.retained.values(), *self.stage_history], key=lambda e: e["sequence"]
            ),
            "graph": {"nodes": list(self.nodes.values()), "edges": list(self.edges.values())},
        }

    def emit(
        self,
        event_type: str,
        status: Status = "completed",
        *,
        event_source: EventSource = "filesystem",
        agent_name: str | None = None,
        **data,
    ) -> dict:
        event = self.factory.emit(
            event_type, status, event_source=event_source, agent_name=agent_name, **data
        ).model_dump(mode="json")
        payload = event["data"]
        if event_type == "graph_node_added":
            self.nodes[payload["id"]] = payload
        elif event_type == "graph_node_updated" and payload["nodeId"] in self.nodes:
            self.nodes[payload["nodeId"]] = {
                **self.nodes[payload["nodeId"]],
                "state": payload["state"],
                "message": payload["message"],
            }
        elif event_type == "graph_node_removed":
            self.nodes.pop(payload["nodeId"], None)
            self.edges = {
                key: edge
                for key, edge in self.edges.items()
                if payload["nodeId"] not in (edge["source"], edge["target"])
            }
        elif event_type == "graph_edge_added":
            self.edges[payload["id"]] = payload
        elif event_type == "graph_edge_removed":
            self.edges.pop(payload["edgeId"], None)
        elif event_type.startswith("file_"):
            self.touched.add(payload["path"])
        elif event_type.startswith("test_"):
            self.tests[payload["name"]] = {**payload, "status": event_type.removeprefix("test_")}
            self.retained[f"test:{payload['name']}"] = event
        elif event_type.startswith("command_"):
            self.commands[payload["commandId"]] = {**payload, "status": status}
            self.retained[f"command:{payload['commandId']}"] = event
        if event_type == "agent_stage":
            self.stage_history.append(event)
        if not event_type.startswith("graph_"):
            self.retained["current"] = event
        self.history.append(event)
        self.last_activity = event["timestamp"]
        self.publish({"kind": "event", "event": event})
        return event

    def node_state(
        self,
        node_id: str,
        state: str,
        message: str,
        *,
        event_source: EventSource = "filesystem",
        agent_name: str | None = None,
    ):
        if node_id not in self.nodes:
            return
        self.emit(
            "graph_node_updated",
            "failed" if state == "failed" else "running" if state == "active" else "completed",
            nodeId=node_id,
            state=state,
            message=message,
            event_source=event_source,
            agent_name=agent_name,
        )
