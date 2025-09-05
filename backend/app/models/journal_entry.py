from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .user import User


class JournalEntry(SQLModel, table=True):
    """
    Stores a chat message between the user and BotMason. Supports context tagging
    for stage reflections, practice notes, and habit-related thoughts.
    """

    id: int | None = Field(default=None, primary_key=True)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    message: str
    sender: str  # 'user' or 'bot'
    user_id: int = Field(foreign_key="user.id")
    is_stage_reflection: bool = False
    is_practice_note: bool = False
    is_habit_note: bool = False
    practice_session_id: int | None = Field(default=None, foreign_key="practicesession.id")
    user_practice_id: int | None = Field(default=None, foreign_key="userpractice.id")
    user: User = Relationship(back_populates="journals")
