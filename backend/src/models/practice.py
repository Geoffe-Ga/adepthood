from __future__ import annotations

from sqlmodel import Field, SQLModel


class Practice(SQLModel, table=True):
    """Defines a single practice users can perform."""

    id: int | None = Field(default=None, primary_key=True)
    stage_number: int
    name: str
    description: str
    instructions: str
    default_duration_minutes: int
    submitted_by_user_id: int | None = Field(default=None, foreign_key="user.id")
    approved: bool = True
