from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .habit import Habit
    from .journal_entry import JournalEntry
    from .prompt_response import PromptResponse
    from .stage_progress import StageProgress


class User(SQLModel, table=True):
    """
    Represents a user account. Tracks relationships to habits, journal entries,
    weekly responses, and APTITUDE stage progress. Also includes offering_balance
    for credit-based access to AI features.
    """

    id: int | None = Field(default=None, primary_key=True)
    offering_balance: int = Field(default=0)
    email: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    habits: list[Habit] = Relationship(back_populates="user")
    journals: list[JournalEntry] = Relationship(back_populates="user")
    responses: list[PromptResponse] = Relationship(back_populates="user")
    stage_progress: StageProgress | None = Relationship(back_populates="user")
