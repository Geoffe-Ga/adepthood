from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Column, DateTime
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlalchemy.types import String
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .goal import Goal
    from .user import User


class Habit(SQLModel, table=True):
    """Tracks a user's habit and related goals.

    ``revealed`` is the single source of truth for whether a habit is unlocked
    ("unlocked" == ``revealed is True`` in product terms). New and seeded
    habits default to locked. Two things flip the flag on: the user, at any
    time; and the server, exactly once per habit, when the program calendar
    opens the habit's slot on its partition (``domain.habit_reveal``, run by
    ``GET /habits/``). That server flip stamps ``auto_revealed_at``, and the
    stamp is the one-shot marker: a habit whose stamp is set is never
    auto-revealed again, so a relock after the calendar's offer is final
    (#2576, superseding #1332 / PR #1349 by the owner ruling of 2026-09-06).
    Carryover habits and habits resting in a live Metta Return release are
    never auto-revealed. Re-locking (flipping ``revealed`` back to ``False``)
    preserves logged completions — those live on the habit's goals, never on
    this flag — so a re-locked habit keeps its history for when the user
    unlocks it again.

    ``is_carryover`` marks a habit the user brought into APTITUDE from before
    the program: ``True`` keeps it on its own partition (tracked without
    consuming a program stage), ``False`` a regular program habit.

    ``name`` is user-authored and deliberately **not** encrypted at rest, unlike
    the columns holding a person's prose. It is a short label rather than
    writing, and it has to stay legible to the database: ``routers.habits``
    compares ``lower(trim(name))`` against the caller's other habits to refuse a
    duplicate, and a partial unique index enforces the same thing underneath.
    Fernet ciphertext differs on every encryption of the same input, so an
    encrypted ``name`` would silently defeat both. The privacy policy names this
    column among what is stored as written rather than implying otherwise.
    """

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(max_length=255)
    icon: str = Field(max_length=100)
    start_date: date
    energy_cost: int
    energy_return: int
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    notification_times: list[str] | None = Field(
        default=None, sa_column=Column(PG_ARRAY(String), nullable=True)
    )
    notification_frequency: str | None = Field(default=None, max_length=20)
    notification_days: list[str] | None = Field(
        default=None, sa_column=Column(PG_ARRAY(String), nullable=True)
    )
    milestone_notifications: bool = Field(default=False)
    sort_order: int | None = None
    stage: str = Field(default="", max_length=100)
    streak: int = 0
    revealed: bool = Field(default=False)
    # Server-owned: when the calendar first revealed this habit; NULL = never.
    auto_revealed_at: datetime | None = Field(
        default=None, sa_column=Column(DateTime(timezone=True), nullable=True)
    )
    is_carryover: bool = Field(default=False)
    user: "User" = Relationship(back_populates="habits")
    goals: list["Goal"] = Relationship(
        back_populates="habit",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )
