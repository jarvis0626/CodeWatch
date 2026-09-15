"""An async event source. Replace this iterator with a real adapter in V2."""

import asyncio
from collections.abc import AsyncIterator
from uuid import uuid4

from backend.agent.events import EventFactory
from backend.agent.workflow import workflow
from backend.models.events import AgentEvent

DEFAULT_EVENT_INTERVAL = 0.5


async def simulate_build(*, interval: float = DEFAULT_EVENT_INTERVAL) -> AsyncIterator[AgentEvent]:
    factory = EventFactory(f"run_{uuid4().hex}")
    for index, step in enumerate(workflow()):
        if index:
            await asyncio.sleep(interval)
        yield factory.emit(step.type, step.status, **step.data)
