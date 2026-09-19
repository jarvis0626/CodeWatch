"""Folder observation is independent of agents: disk changes never claim agent intent."""

import asyncio
import hashlib
import logging
from time import monotonic

from backend.observer.scanner import ProjectSnapshot, resolve_root, scan_project
from backend.observer.session import ProjectSession, file_id

logger = logging.getLogger("codewatch.observer")


def edge_id(source: str, target: str, prefix: str = "import") -> str:
    return prefix + ":" + hashlib.sha256(f"{source}\0{target}".encode()).hexdigest()[:24]


class WatchManager:
    def __init__(self, interval: float = 0.75):
        self.interval = interval
        self.current: ProjectSession | None = None
        self.task: asyncio.Task | None = None
        self.subscribers: set[asyncio.Queue] = set()
        self.lock = asyncio.Lock()
        self.previous: ProjectSnapshot | None = None
        self.active_until: dict[str, float] = {}

    def snapshot(self) -> dict:
        return (
            self.current.snapshot()
            if self.current
            else {
                "kind": "snapshot",
                "session": None,
                "events": [],
                "retainedEvents": [],
                "graph": {"nodes": [], "edges": []},
            }
        )

    def publish(self, frame: dict):
        for queue in tuple(self.subscribers):
            if queue.full():
                # Slow readers get canonical state, never a silently broken incremental graph.
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(self.snapshot())
            else:
                queue.put_nowait(frame)

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=512)
        queue.put_nowait(self.snapshot())
        self.subscribers.add(queue)
        return queue

    async def start(self, path: str, agent_name: str) -> dict:
        async with self.lock:
            root = await asyncio.to_thread(resolve_root, path)
            if self.current and self.current.watching and self.current.root == root:
                return self.current.info()
            snapshot = await asyncio.to_thread(scan_project, root)
            await self._stop()
            session = ProjectSession(root, agent_name, self.publish)
            self.current = session
            self.previous = None
            self.active_until.clear()
            self.publish(session.snapshot())
            session.emit(
                "graph_node_added",
                event_source="system",
                id="agent",
                label=agent_name,
                kind="agent",
                state="planned",
                message="Waiting for an explicit agent report",
                description="File changes are observed independently; their author is unknown.",
            )
            self.apply_scan(session, snapshot, initial=True)
            session.emit(
                "agent_message",
                event_source="system",
                message=f"Watching {root.name}: {len(snapshot.files)} files indexed. Connect an agent to see its current task.",
            )
            self.publish({"kind": "session", "session": session.info()})
            self.task = asyncio.create_task(self._observe(session), name=f"watch:{session.run_id}")
            return session.info()

    async def _stop(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None
        if self.current and self.current.watching:
            self.current.watching = False
            self.current.emit("agent_message", event_source="system", message="Project watcher stopped")
            self.publish({"kind": "session", "session": self.current.info()})

    async def stop(self, run_id: str):
        async with self.lock:
            if not self.current or self.current.run_id != run_id:
                raise ValueError("This run is no longer active. Refresh the session before stopping it.")
            await self._stop()
            return self.current.info()

    async def close(self):
        await self._stop()

    async def _observe(self, session: ProjectSession):
        try:
            while session.watching:
                await asyncio.sleep(self.interval)
                if not session.root.is_dir():
                    session.warnings = ["Project directory is no longer available. Watching has stopped."]
                    break
                snapshot = await asyncio.to_thread(scan_project, session.root)
                if self.current is not session:
                    return
                self.apply_scan(session, snapshot)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Project observation failed")
            session.warnings = ["The project could not be scanned. Check directory access and reconnect."]
        finally:
            if session.watching:
                session.watching = False
                self.publish({"kind": "session", "session": session.info()})

    def apply_scan(self, session: ProjectSession, snapshot: ProjectSnapshot, initial: bool = False):
        previous = self.previous.files if self.previous else {}
        changed = False
        if session.warnings != snapshot.warnings:
            session.warnings = snapshot.warnings
            changed = True
        for path, file in snapshot.files.items():
            node_id = file_id(path)
            created = path not in previous
            modified = not created and file.signature != previous[path].signature
            if not (created or modified):
                continue
            changed = True
            if created:
                session.emit(
                    "graph_node_added",
                    id=node_id,
                    label=path.split("/")[-1],
                    kind=file.kind,
                    state="completed" if initial else "active",
                    path=path,
                    description=f"{file.language} source · role inferred from its path",
                    message=f"{'Indexed' if initial else 'Observed new file'} {path}",
                )
            elif modified:
                session.node_state(node_id, "active", f"Observed a file edit: {path}")
            if not initial:
                session.emit(
                    "file_created" if created else "file_modified",
                    path=path,
                    nodeId=node_id,
                    message=f"{'Created' if created else 'Modified'} {path} (observed on disk)",
                )
                self.active_until[node_id] = monotonic() + 2.5
        # The scanner's bounded traversal is deterministic. A cap/permission warning is not a deletion.
        if not snapshot.truncated:
            for path in previous.keys() - snapshot.files.keys():
                changed = True
                node_id = file_id(path)
                for key, edge in tuple(session.edges.items()):
                    if node_id in (edge["source"], edge["target"]):
                        session.emit(
                            "graph_edge_removed", edgeId=key, message=f"Removed connection to {path}"
                        )
                if not (session.root / path).exists():
                    session.emit(
                        "file_deleted",
                        path=path,
                        nodeId=node_id,
                        message=f"Deleted {path} (observed on disk)",
                    )
                session.emit("graph_node_removed", nodeId=node_id, message=f"Removed {path} from the graph")
                self.active_until.pop(node_id, None)
        new_edges = {edge_id(a, b): (a, b, label) for a, b, label in snapshot.edges}
        for key, edge in tuple(session.edges.items()):
            if edge.get("evidence") == "import" and key not in new_edges and not snapshot.truncated:
                session.emit(
                    "graph_edge_removed", edgeId=key, message="Import no longer present in the current scan"
                )
                changed = True
        for key, (source, target, label) in new_edges.items():
            if key not in session.edges:
                session.emit(
                    "graph_edge_added",
                    id=key,
                    source=file_id(source),
                    target=file_id(target),
                    label=label,
                    evidence="import",
                    message=f"{source} imports {target}",
                )
                changed = True
        for node_id, deadline in tuple(self.active_until.items()):
            if deadline <= monotonic() and node_id not in session.active_paths:
                if session.nodes.get(node_id, {}).get("state") == "active":
                    session.node_state(node_id, "completed", "File change indexed; no test result is implied")
                self.active_until.pop(node_id, None)
        if snapshot.truncated:
            # Keep missing entries until a complete scan can tell us whether they were deleted.
            self.previous = ProjectSnapshot(
                files={**previous, **snapshot.files},
                edges=snapshot.edges,
                warnings=snapshot.warnings,
                truncated=True,
            )
        else:
            self.previous = snapshot
        session.tracked_files = len(snapshot.files)
        if changed:
            self.publish({"kind": "session", "session": session.info()})
