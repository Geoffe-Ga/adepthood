from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import Column, Integer
from sqlalchemy.dialects.postgresql import ARRAY
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .user import User


class StageProgress(SQLModel, table=True):
    """
    Tracks which stage a user is currently working on, and which stages
    have been completed.
    """

    id: int | None = Field(default=None, primary_key=True)
    current_stage: int
    completed_stages: list[int] = Field(
        default_factory=list,
        sa_column=Column(ARRAY(Integer), nullable=False),
    )
    user_id: int = Field(foreign_key="user.id", unique=True)
    user: User = Relationship(back_populates="stage_progress")
