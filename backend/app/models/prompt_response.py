from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .user import User


class PromptResponse(SQLModel, table=True):
    """
    Captures responses to weekly prompts within the APTITUDE program.
    Used for tracking journaling engagement.
    """

    id: int | None = Field(default=None, primary_key=True)
    week_number: int
    question: str
    response: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    user_id: int = Field(foreign_key="user.id")
    user: User = Relationship(back_populates="responses")
