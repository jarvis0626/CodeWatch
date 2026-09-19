"""Agent-reported intent and outcomes, kept separate from filesystem observations."""

from pathlib import PurePosixPath, PureWindowsPath

from backend.observer.manager import WatchManager, edge_id
from backend.observer.requests import (
    CommandRequest,
    CompleteRequest,
    ProgressRequest,
    RelationshipRequest,
    TestRequest,
)
from backend.observer.session import ProjectSession, file_id
from backend.observer.scanner import is_sensitive_name


def active_session(manager: WatchManager, run_id: str) -> ProjectSession:
    session = manager.current
    if not session or session.run_id != run_id or not session.watching:
        raise ValueError(
            "This watched run is no longer active. Connect the project and use its current runId."
        )
    return session


def relative_path(session: ProjectSession, path: str) -> str:
    normalized = path.replace("\\", "/")
    parts = PurePosixPath(normalized).parts
    if not parts or PurePosixPath(normalized).is_absolute() or PureWindowsPath(path).drive or ".." in parts:
        raise ValueError("Use a project-relative file path without parent traversal.")
    if any(
        is_sensitive_name(part)
        or part.lower()
        in {".git", ".ssh", ".aws", ".local", "node_modules", ".venv", "venv", "dist", "build"}
        for part in parts
    ):
        raise ValueError("Sensitive or generated paths cannot be reported.")
    if PurePosixPath(normalized).suffix.lower() in {".key", ".pem", ".p12", ".pfx"}:
        raise ValueError("Secret key files cannot be reported.")
    candidate = session.root.joinpath(*parts)
    try:
        candidate.resolve().relative_to(session.root)
        current = session.root
        for part in parts:
            current = current / part
            if current.is_symlink() or current.is_junction():
                raise ValueError("Linked paths are outside the observed project boundary.")
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("The reported file must stay inside the watched project.") from exc
    return PurePosixPath(*parts).as_posix()


def ensure_node(session: ProjectSession, path: str, kind: str = "module") -> str:
    node_id = file_id(path)
    if node_id not in session.nodes:
        if len(session.nodes) >= 600:
            raise ValueError("The graph has reached its 600-node limit. Watch a smaller project folder.")
        session.emit(
            "graph_node_added",
            event_source="agent",
            agent_name=session.agent_name,
            id=node_id,
            label=path.split("/")[-1],
            kind=kind,
            state="planned",
            path=path,
            message=f"Agent plans to work on {path}",
            description="Agent-reported file; not yet indexed on disk",
        )
    return node_id


def identify_agent(session: ProjectSession, name: str):
    if session.agent_name != name or session.nodes.get("agent", {}).get("state") == "planned":
        session.agent_name = name
        session.emit(
            "graph_node_added",
            event_source="agent",
            agent_name=name,
            id="agent",
            label=name,
            kind="agent",
            state="active",
            message=f"{name} is reporting its work to CodeWatch",
            description="Agent identity is provided by the connected integration.",
        )


def progress(session: ProjectSession, request: ProgressRequest):
    paths = [relative_path(session, path) for path in request.paths]
    missing = {file_id(path) for path in paths} - session.nodes.keys()
    if len(session.nodes) + len(missing) > 600:
        raise ValueError("The graph has reached its 600-node limit.")
    identify_agent(session, request.agentName)
    for node_id in session.active_paths:
        if session.nodes.get(node_id, {}).get("state") != "failed":
            session.node_state(
                node_id,
                "completed",
                "Agent moved to another action",
                event_source="agent",
                agent_name=request.agentName,
            )
    # Remove the previous action's visual focus edges; retain architectural relationships.
    for key in [key for key in session.edges if key.startswith("working:")]:
        session.emit(
            "graph_edge_removed",
            event_source="agent",
            agent_name=request.agentName,
            edgeId=key,
            message="Agent moved to another part of the flow",
        )
    session.active_paths.clear()
    for path in paths:
        node_id = ensure_node(session, path)
        session.active_paths.add(node_id)
        session.node_state(
            node_id, "active", request.message, event_source="agent", agent_name=request.agentName
        )
        session.emit(
            "graph_edge_added",
            event_source="agent",
            agent_name=request.agentName,
            id=f"working:{node_id}",
            source="agent",
            target=node_id,
            label="working on",
            evidence="reported",
            message=f"{request.agentName} is working on {path}",
        )
    session.node_state(
        "agent",
        "completed" if request.stage == "COMPLETE" else "active",
        request.message,
        event_source="agent",
        agent_name=request.agentName,
    )
    session.emit(
        "agent_stage",
        "completed" if request.stage == "COMPLETE" else "running",
        event_source="agent",
        agent_name=request.agentName,
        stage=request.stage,
        message=request.message,
    )


def relationship(session: ProjectSession, request: RelationshipRequest):
    source, target = relative_path(session, request.source), relative_path(session, request.target)
    if source == target:
        raise ValueError("Choose two different files for a relationship.")
    missing = {file_id(source), file_id(target)} - session.nodes.keys()
    if len(session.nodes) + len(missing) > 600 or len(session.edges) >= 5000:
        raise ValueError("The graph has reached its size limit.")
    identify_agent(session, request.agentName)
    session.emit(
        "graph_edge_added",
        event_source="agent",
        agent_name=request.agentName,
        id=edge_id(source, target, "reported"),
        source=ensure_node(session, source),
        target=ensure_node(session, target),
        label=request.label,
        evidence="reported",
        message=request.description or f"Agent reports: {source} {request.label} {target}",
    )


def test_result(session: ProjectSession, request: TestRequest):
    path = relative_path(session, request.path) if request.path else None
    previous = session.tests.get(request.name)
    if previous and request.attempt < previous["attempt"]:
        raise ValueError("This test report is from an older attempt.")
    if request.name not in session.tests and len(session.tests) >= 500:
        raise ValueError("The session has reached its 500-test limit.")
    requested_id = file_id(path) if path else "tests"
    if requested_id not in session.nodes and len(session.nodes) >= 600:
        raise ValueError("The graph has reached its 600-node limit.")
    identify_agent(session, request.agentName)
    origin = "command" if request.capture == "wrapper" else "agent"
    node_id = ensure_node(session, path, "test") if path else "tests"
    if node_id == "tests" and node_id not in session.nodes:
        session.emit(
            "graph_node_added",
            event_source="agent",
            agent_name=request.agentName,
            id=node_id,
            label="Reported tests",
            kind="test",
            state="planned",
            message="Test results reported by the connected agent",
        )
    result = "started" if request.status == "running" else request.status
    session.emit(
        f"test_{result}",
        "running" if result == "started" else "failed" if result == "failed" else "completed",
        event_source=origin,
        agent_name=request.agentName,
        name=request.name,
        attempt=request.attempt,
        nodeId=node_id,
        details=request.details,
        message=f"{request.name}: {request.status} ({'JUnit capture' if origin == 'command' else 'agent reported'})",
    )
    relevant = [item["status"] for item in session.tests.values() if item["nodeId"] == node_id]
    state = "failed" if "failed" in relevant else "active" if "started" in relevant else "completed"
    session.node_state(
        node_id, state, "Latest reported test results", event_source=origin, agent_name=request.agentName
    )


def command_result(session: ProjectSession, request: CommandRequest):
    previous = session.commands.get(request.commandId)
    if not previous and request.status != "running":
        raise ValueError("Report command_started before its result, using the same commandId.")
    if previous and (previous["command"] != request.command or previous["status"] != "running"):
        raise ValueError("Use a new commandId for each command invocation.")
    if not previous and len(session.commands) >= 500:
        raise ValueError("The session has reached its 500-command limit.")
    if request.status == "completed" and request.exitCode != 0:
        raise ValueError("A completed command must have exitCode 0.")
    if request.status == "failed" and request.exitCode in (None, 0):
        raise ValueError("A failed command must have a nonzero exitCode.")
    identify_agent(session, request.agentName)
    session.emit(
        "command_started" if request.status == "running" else "command_finished",
        request.status,
        event_source="command" if request.capture == "wrapper" else "agent",
        agent_name=request.agentName,
        commandId=request.commandId,
        command=request.command,
        output=request.output,
        exitCode=request.exitCode,
        message=f"{request.command}: {request.status}",
    )


def complete(session: ProjectSession, request: CompleteRequest):
    identify_agent(session, request.agentName)
    for node_id in session.active_paths:
        if session.nodes.get(node_id, {}).get("state") != "failed":
            session.node_state(
                node_id,
                "completed",
                "Agent reports its work complete",
                event_source="agent",
                agent_name=request.agentName,
            )
    session.active_paths.clear()
    for key in [key for key in session.edges if key.startswith("working:")]:
        session.emit(
            "graph_edge_removed",
            event_source="agent",
            agent_name=request.agentName,
            edgeId=key,
            message="Agent finished its current task",
        )
    session.node_state(
        "agent", "completed", request.message, event_source="agent", agent_name=request.agentName
    )
    session.emit(
        "agent_stage",
        event_source="agent",
        agent_name=request.agentName,
        stage="COMPLETE",
        message=request.message,
    )
    session.emit(
        "build_complete",
        event_source="agent",
        agent_name=request.agentName,
        message=request.message,
        filesTouched=len(session.touched),
        testsPassed=sum(item["status"] == "passed" for item in session.tests.values()),
        testsTotal=len(session.tests),
    )
