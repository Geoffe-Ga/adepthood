"""Goal related schemas."""

from __future__ import annotations

from pydantic import BaseModel


class Goal(BaseModel):
    id: int
    target: float
    mode: str = "additive"
