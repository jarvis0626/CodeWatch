"""Create validated envelopes without coupling the event producer to FastAPI."""

from datetime import datetime, timezone
from uuid import uuid4

from backend.models.events import AgentEvent, Status, event_adapter


class EventFactory:
    def __init__(self, run_id: str):
        self.run_id = run_id
        self.sequence = 0

    def emit(self, event_type: str, status: Status = "running", **data: object) -> AgentEvent:
        self.sequence += 1
        return event_adapter.validate_python(
            {
                "schemaVersion": 1,
                "runId": self.run_id,
                "eventId": f"evt_{uuid4().hex}",
                "timestamp": datetime.now(timezone.utc),
                "sequence": self.sequence,
                "type": event_type,
                "status": status,
                "data": data,
            }
        )
