"""A deterministic scenario. Commands and paths describe simulated activity only."""

from dataclasses import dataclass, field

from backend.models.events import NodeKind, NodeState, Stage, Status


@dataclass(frozen=True)
class Step:
    type: str
    status: Status = "running"
    data: dict[str, object] = field(default_factory=dict)


def workflow() -> list[Step]:
    steps: list[Step] = []

    def add(event_type: str, message: str, status: Status = "running", **data: object) -> None:
        steps.append(Step(event_type, status, {"message": message, **data}))

    def stage(name: Stage, message: str) -> None:
        add("agent_stage", message, stage=name)

    def node(node_id: str, label: str, kind: NodeKind, path: str | None = None) -> None:
        add(
            "graph_node_added",
            f"Added {label} to the architecture",
            id=node_id,
            label=label,
            kind=kind,
            state="planned",
            path=path,
        )

    def state(node_id: str, value: NodeState, message: str) -> None:
        add(
            "graph_node_updated",
            message,
            "failed" if value == "failed" else "completed" if value == "completed" else "running",
            nodeId=node_id,
            state=value,
        )

    def edge(source: str, target: str, label: str) -> None:
        add(
            "graph_edge_added",
            f"Connected {source} to {target}",
            "completed",
            id=f"{source}-{target}",
            source=source,
            target=target,
            label=label,
        )

    def file(path: str, node_id: str, modified: bool = False) -> None:
        add(
            "file_modified" if modified else "file_created",
            f"{'Modified' if modified else 'Created'} {path}",
            "completed",
            path=path,
            nodeId=node_id,
        )

    def command(
        command_id: str, text: str, finished: bool = False, output: str | None = None, exit_code: int = 0
    ) -> None:
        add(
            "command_finished" if finished else "command_started",
            (output or f"Running {text}"),
            ("failed" if exit_code else "completed") if finished else "running",
            commandId=command_id,
            command=text,
            output=output,
            exitCode=exit_code if finished else None,
        )

    def test(name: str, attempt: int, result: str = "started", details: str | None = None) -> None:
        add(
            f"test_{result}",
            f"{name}: {result}",
            "failed" if result == "failed" else "completed" if result == "passed" else "running",
            name=name,
            nodeId="tests",
            attempt=attempt,
            details=details,
        )

    stage("PLANNING", "Planning the Todo application architecture")
    state("agent", "active", "Simulator is analyzing the requested application")
    add("agent_message", "A React client, a FastAPI service, and SQLite storage. Let's build it.")
    stage("EXPLORING", "Checking the project workspace and identifying entry points")
    add("agent_message", "Workspace is ready. Starting with the application layers.")
    stage("IMPLEMENTING", "Building the frontend and backend")

    node("frontend", "React Frontend", "frontend", "frontend/src/App.tsx")
    state("frontend", "active", "Creating the Todo interface")
    file("frontend/src/App.tsx", "frontend")
    edge("agent", "frontend", "builds")
    state("frontend", "completed", "React interface is ready")

    node("api", "FastAPI", "api", "backend/main.py")
    state("api", "active", "Creating the API and Todo model")
    file("backend/main.py", "api")
    file("backend/models/todo.py", "api")
    edge("frontend", "api", "HTTP / REST")
    file("backend/routes/todo.py", "api")
    state("api", "completed", "Todo API routes are ready")

    node("service", "TodoService", "service", "backend/services/todo_service.py")
    state("service", "active", "Implementing Todo business logic")
    file("backend/services/todo_service.py", "service")
    edge("api", "service", "calls")
    state("service", "completed", "TodoService implementation is ready")

    node("repository", "TodoRepository", "repository", "backend/repositories/todo_repository.py")
    state("repository", "active", "Creating the persistence layer")
    file("backend/repositories/todo_repository.py", "repository")
    edge("service", "repository", "reads / writes")
    state("repository", "completed", "Repository implementation is ready")

    node("database", "SQLite", "database", "backend/database.py")
    state("database", "active", "Configuring local SQLite storage")
    file("backend/database.py", "database")
    edge("repository", "database", "SQL")
    state("database", "completed", "Database configuration is ready")

    node("tests", "Test suite", "test", "backend/tests/test_todos.py")
    file("backend/tests/test_todos.py", "tests")
    edge("service", "tests", "tested by")

    stage("RUNNING", "Installing dependencies in the simulated workspace")
    command("pip-1", "pip install -r requirements.txt")
    command(
        "pip-1",
        "pip install -r requirements.txt",
        True,
        "Successfully installed fastapi, uvicorn, and pytest (simulated)",
    )
    command("npm-1", "npm install")
    command("npm-1", "npm install", True, "Dependencies installed (simulated)")

    stage("TESTING", "Running the initial Todo test suite")
    state("tests", "active", "Executing three Todo tests")
    command("pytest-1", "pytest -q")
    test("test_list_todos", 1)
    test("test_list_todos", 1, "passed")
    test("test_create_todo", 1)
    test("test_create_todo", 1, "failed", "AssertionError: expected a persisted Todo ID, received None")
    state("tests", "failed", "The create Todo test failed")
    test("test_delete_todo", 1)
    test("test_delete_todo", 1, "passed")
    command("pytest-1", "pytest -q", True, "1 failed, 2 passed in 0.42s (simulated)", 1)

    stage("DEBUGGING", "Investigating the failed TodoService test")
    state("service", "active", "Fixing TodoService persistence")
    add(
        "agent_message",
        "The service returns before the transaction commits. Commit and refresh the Todo before returning.",
    )
    file("backend/services/todo_service.py", "service", modified=True)
    state("service", "completed", "TodoService now returns the persisted Todo")

    stage("TESTING", "Rerunning the test suite after the fix")
    state("tests", "active", "Verifying the fix across all three tests")
    command("pytest-2", "pytest -q")
    for name in ("test_list_todos", "test_create_todo", "test_delete_todo"):
        test(name, 2)
        test(name, 2, "passed")
    command("pytest-2", "pytest -q", True, "3 passed in 0.31s (simulated)")
    state("tests", "completed", "All three tests are passing")

    stage("VALIDATING", "Validating the architecture and final build")
    add("agent_message", "All application layers are connected. Eight files touched; all three tests pass.")
    state("agent", "completed", "Simulation finished successfully")
    stage("COMPLETE", "The Todo application simulation is complete")
    add(
        "build_complete",
        "Build complete. Every layer is connected and all tests pass.",
        "completed",
        filesTouched=8,
        testsPassed=3,
        testsTotal=3,
    )
    return steps
