"""Goal related schemas."""

from __future__ import annotations

from pydantic import BaseModel


class Goal(BaseModel):
    """Public representation of a :class:`models.goal.Goal`.

    This schema mirrors the SQLModel definition so API consumers can rely on a
    stable contract. Only fields exposed over the wire are included.
    """

    id: int
    habit_id: int
    title: str
    description: str | None = None
    tier: str
    target: float
    target_unit: str
    frequency: float
    frequency_unit: str
    is_additive: bool = True
