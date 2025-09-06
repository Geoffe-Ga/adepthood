"""Check-in request/response schemas."""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel

from .milestone import Milestone


class CheckInRequest(BaseModel):
    goal_id: int
    date: date


class CheckInResult(BaseModel):
    streak: int
    milestones: list[Milestone] = []
    reason_code: str
