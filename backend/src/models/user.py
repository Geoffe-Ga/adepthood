from datetime import UTC, datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import Column, DateTime
from sqlmodel import Field, Relationship, SQLModel

from services.usage import compute_next_reset

if TYPE_CHECKING:
    from .habit import Habit
    from .journal_entry import JournalEntry
    from .prompt_response import PromptResponse
    from .stage_progress import StageProgress


def _default_reset_date() -> datetime:
    """Initial ``monthly_reset_date`` for a newly created user — first-of-next-month UTC."""
    return compute_next_reset(datetime.now(UTC))


class User(SQLModel, table=True):
    """Represents a user account.

    Tracks relationships to habits, journal entries, weekly responses,
    and APTITUDE stage progress.

    BotMason access uses a two-bucket wallet:

    * ``monthly_messages_used`` / ``monthly_reset_date`` — a free monthly
      allocation (see ``BOTMASON_MONTHLY_CAP``) that resets on the first of
      every month.
    * ``offering_balance`` — purchased or gifted credits that never expire
      and are only drawn down once the monthly allocation is exhausted.
    """

    id: int | None = Field(default=None, primary_key=True)
    offering_balance: int = Field(default=0)
    monthly_messages_used: int = Field(default=0)
    monthly_reset_date: datetime = Field(
        default_factory=_default_reset_date,
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    email: str = Field(unique=True, index=True, max_length=254)
    password_hash: str = Field(default="")
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    habits: list["Habit"] = Relationship(back_populates="user")
    journals: list["JournalEntry"] = Relationship(back_populates="user")
    responses: list["PromptResponse"] = Relationship(back_populates="user")
    stage_progress: Optional["StageProgress"] = Relationship(back_populates="user")
