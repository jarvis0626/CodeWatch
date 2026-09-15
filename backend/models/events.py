"""Transport-independent, versioned event contract for CodeWatch producers."""

from datetime import datetime
from typing import Annotated, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

Stage = Literal[
    "PLANNING",
    "EXPLORING",
    "IMPLEMENTING",
    "RUNNING",
    "TESTING",
    "DEBUGGING",
    "VALIDATING",
    "COMPLETE",
]
Status = Literal["pending", "running", "completed", "failed"]
NodeKind = Literal["agent", "frontend", "api", "service", "repository", "database", "test"]
NodeState = Literal["planned", "active", "completed", "failed"]


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str


class StageData(Payload):
    stage: Stage


class FileData(Payload):
    path: str
    nodeId: str


class CommandData(Payload):
    commandId: str
    command: str
    output: str | None = None
    exitCode: int | None = None


class TestData(Payload):
    name: str
    nodeId: str = "tests"
    attempt: int = Field(ge=1)
    details: str | None = None


class GraphNode(Payload):
    id: str
    label: str
    kind: NodeKind
    state: NodeState
    path: str | None = None


class NodeUpdate(Payload):
    nodeId: str
    state: NodeState


class GraphEdge(Payload):
    id: str
    source: str
    target: str
    label: str


class CompleteData(Payload):
    filesTouched: int = Field(ge=0)
    testsPassed: int = Field(ge=0)
    testsTotal: int = Field(ge=0)


Data = TypeVar("Data", bound=Payload)


class Envelope(BaseModel, Generic[Data]):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal[1] = 1
    runId: str
    eventId: str
    timestamp: datetime
    sequence: int = Field(ge=1)
    status: Status
    data: Data


class StageEvent(Envelope[StageData]):
    type: Literal["agent_stage"]


class MessageEvent(Envelope[Payload]):
    type: Literal["agent_message"]


class FileEvent(Envelope[FileData]):
    type: Literal["file_created", "file_modified"]


class CommandEvent(Envelope[CommandData]):
    type: Literal["command_started", "command_finished"]


class TestEvent(Envelope[TestData]):
    type: Literal["test_started", "test_passed", "test_failed"]


class NodeEvent(Envelope[GraphNode]):
    type: Literal["graph_node_added"]


class NodeUpdateEvent(Envelope[NodeUpdate]):
    type: Literal["graph_node_updated"]


class EdgeEvent(Envelope[GraphEdge]):
    type: Literal["graph_edge_added"]


class CompleteEvent(Envelope[CompleteData]):
    type: Literal["build_complete"]


AgentEvent = Annotated[
    StageEvent
    | MessageEvent
    | FileEvent
    | CommandEvent
    | TestEvent
    | NodeEvent
    | NodeUpdateEvent
    | EdgeEvent
    | CompleteEvent,
    Field(discriminator="type"),
]
event_adapter = TypeAdapter(AgentEvent)


class StartBuild(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["start"]
    prompt: str = Field(default="Build a Todo application with React, FastAPI and SQLite", max_length=2000)
