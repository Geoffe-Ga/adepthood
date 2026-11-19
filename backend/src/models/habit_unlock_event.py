"""One row per change of a program habit's lock state (issue #3724).

``Habit.revealed`` is a boolean and ``Habit.auto_revealed_at`` a one-shot
"invitation consumed" stamp, so a second unlock left no trace and "when was this
habit most recently unlocked" could only be guessed. This log is append-only and
additive: every flip of ``revealed`` on a program habit writes a row in the same
commit as the flip, tagged with the pass it happened in and the habit's program
number at that moment. Neither ``revealed`` nor ``auto_revealed_at`` changes
meaning.

``pass_id`` is ``NULL`` when no pass covers the event: a backfilled unlock dated
outside every recorded pass, or a live change on an account that has not begun
the program, so has no pass to be in.
"""

from datetime import date, datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, Column, DateTime
from sqlmodel import Field, SQLModel


class UnlockKind(StrEnum):
    """Which way the lock moved."""

    UNLOCKED = "unlocked"
    RELOCKED = "relocked"


class UnlockSource(StrEnum):
    """Which writer flipped the lock."""

    #: ``PUT /habits/{id}`` changed ``revealed``.
    MANUAL = "manual"
    #: The habit list's read revealed it when the program's invitation reached it.
    AUTO_REVEAL = "auto_reveal"
    #: ``POST /habits/`` created it already unlocked.
    CREATED_UNLOCKED = "created_unlocked"
    #: Reconstructed by the migration from ``auto_revealed_at`` or a first check-in.
    BACKFILL = "backfill"
    #: A Metta Return arc released the habit, or re-committed to it (issue #3745).
    METTA_RETURN = "metta_return"


def _in_constraint(column: str, values: type[StrEnum]) -> str:
    """``column IN (...)`` over every value of ``values``."""
    return "{} IN ({})".format(column, ", ".join(f"'{value.value}'" for value in values))


class HabitUnlockEvent(SQLModel, table=True):
    """A habit unlocked or re-locked: when, in which pass, and at which program number.

    ``program_number`` is the habit's 1-based position among the account's
    non-carryover habits, in the habit list's own order, WHEN the event was
    written -- a later move does not rewrite it (epic #3722, decision 3).
    ``local_day`` is the account-zone day of ``occurred_at`` at write time.
    """

    __table_args__ = (
        CheckConstraint(_in_constraint("kind", UnlockKind), name="ck_habitunlockevent_kind_valid"),
        CheckConstraint(
            _in_constraint("source", UnlockSource), name="ck_habitunlockevent_source_valid"
        ),
        CheckConstraint("program_number >= 1", name="ck_habitunlockevent_program_number_positive"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, ondelete="CASCADE")
    habit_id: int = Field(foreign_key="habit.id", index=True, ondelete="CASCADE")
    pass_id: int | None = Field(
        default=None, foreign_key="programpass.id", index=True, ondelete="CASCADE"
    )
    kind: str = Field(max_length=16)
    occurred_at: datetime = Field(sa_column=Column(DateTime(timezone=True), nullable=False))
    local_day: date
    program_number: int = Field(ge=1)
    source: str = Field(max_length=32)
