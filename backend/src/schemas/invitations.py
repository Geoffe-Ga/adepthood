"""Response schema for the invitation-signal endpoints."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class InvitationResponse(BaseModel):
    """One pending invitation projected for the caller.

    ``user_id`` is intentionally excluded — the caller already knows its own
    identity from the JWT, and surfacing the surrogate owner key would aid
    enumeration. Only the stable coordinate (``target_type`` / ``target_id`` /
    ``kind``), the row ``id`` needed to dismiss it, and ``created_at`` are
    exposed.
    """

    id: int
    target_type: str
    target_id: int | None
    kind: str
    created_at: datetime
