"""Check-in request/response schemas."""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel

from .milestone import Milestone

# BUG-SCHEMA-003: the server emits a fixed set of reason codes from
# ``services.streaks`` and ``routers.goal_completions``; promoting the
# field to ``Literal`` pins the API contract so a typo at the emit site
# fails type-check before the client gets a value it cannot route.
CheckInReasonCode = Literal[
    "streak_incremented",
    "streak_reset",
    "already_logged_today",
]


class CheckInRequest(BaseModel):
    goal_id: int
    date: date


class CheckInResult(BaseModel):
    streak: int
    milestones: list[Milestone] = []
    reason_code: CheckInReasonCode
