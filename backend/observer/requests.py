"""Small producer-facing requests; the server assigns event IDs and ordering."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from backend.models.events import Stage


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class WatchRequest(Request):
    path: str = Field(min_length=1, max_length=4096)
    agentName: str = Field(default="External agent", min_length=1, max_length=100)


class StopRequest(Request):
    runId: str


class AgentRequest(StopRequest):
    agentName: str = Field(default="External agent", min_length=1, max_length=100)


class ProgressRequest(AgentRequest):
    stage: Stage
    message: str = Field(min_length=1, max_length=4000)
    paths: list[str] = Field(default_factory=list, max_length=50)


class RelationshipRequest(AgentRequest):
    source: str = Field(min_length=1, max_length=1024)
    target: str = Field(min_length=1, max_length=1024)
    label: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)


class TestRequest(AgentRequest):
    name: str = Field(min_length=1, max_length=200)
    status: Literal["running", "passed", "failed"]
    attempt: int = Field(default=1, ge=1)
    path: str | None = Field(default=None, max_length=1024)
    details: str | None = Field(default=None, max_length=4000)
    capture: Literal["reported", "wrapper"] = "reported"


class CommandRequest(AgentRequest):
    commandId: str = Field(min_length=1, max_length=100)
    command: str = Field(min_length=1, max_length=2000)
    status: Literal["running", "completed", "failed"]
    output: str | None = Field(default=None, max_length=16000)
    exitCode: int | None = None
    capture: Literal["reported", "wrapper"] = "reported"


class CompleteRequest(AgentRequest):
    message: str = Field(default="Agent task complete", min_length=1, max_length=4000)
