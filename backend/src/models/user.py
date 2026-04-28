from datetime import UTC, datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import Column, DateTime, String
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


# IANA timezone fallback used both as the column default and as the runtime
# default in ``domain.dates`` when a user row was created before the
# timezone column existed (legacy rows backfilled to ``"UTC"``).
DEFAULT_USER_TIMEZONE = "UTC"


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

    The ``timezone`` column stores the user's IANA timezone (e.g.
    ``"America/Los_Angeles"``).  It defaults to ``"UTC"`` so legacy rows
    and new signups that decline to share their timezone keep working;
    the frontend sends the browser's resolved zone on signup.  Streak and
    daily-completion math reads this column via :mod:`domain.dates` to
    avoid the UTC/local boundary drift family of bugs (BUG-STREAK-002,
    BUG-HABIT-006, BUG-GOAL-004).
    """

    id: int | None = Field(default=None, primary_key=True)
    is_admin: bool = Field(default=False, nullable=False)
    offering_balance: int = Field(default=0)
    monthly_messages_used: int = Field(default=0)
    monthly_reset_date: datetime = Field(
        default_factory=_default_reset_date,
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    email: str = Field(unique=True, index=True, max_length=254)
    # BUG-AUTH-018: ``password_hash`` previously defaulted to ``""`` so a
    # row could (in test fixtures, badly-written admin scripts, or a future
    # signup-flow regression) be persisted without a real hash.  An empty
    # string is not a valid bcrypt digest -- ``_verify_password`` would
    # raise on it -- but the column itself was happy to accept it.  Drop
    # the default so SQLModel forces every caller to supply a hash and a
    # blank-password account becomes impossible at the schema level.
    password_hash: str = Field(min_length=1)
    timezone: str = Field(
        default=DEFAULT_USER_TIMEZONE,
        sa_column=Column(
            String(64),
            nullable=False,
            server_default=DEFAULT_USER_TIMEZONE,
        ),
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    habits: list["Habit"] = Relationship(back_populates="user")
    journals: list["JournalEntry"] = Relationship(back_populates="user")
    responses: list["PromptResponse"] = Relationship(back_populates="user")
    stage_progress: Optional["StageProgress"] = Relationship(back_populates="user")
