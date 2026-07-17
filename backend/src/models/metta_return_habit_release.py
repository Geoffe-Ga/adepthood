"""The per-arc record of habits a user released during a Return.

A ``MettaReturnHabitRelease`` row remembers that, within one Return arc (see
:mod:`domain.metta_return`), the user chose to *release* a habit — a soft,
never-shaming pause that flips :attr:`models.habit.Habit.revealed` to ``False``.
Releasing deletes nothing: goals and logged completions live on the habit's
goals, not on the reveal flag, so a released habit keeps its whole history for
when the user re-commits. Re-committing flips ``revealed`` back to ``True`` and
stamps :attr:`recommitted_at`. Nothing in this table gates or mutates a user's
stage progress.

Release is scoped to a single arc: a ``(arc_id, habit_id)`` unique constraint
makes a release idempotent within its arc, while the same habit may be released
again in a later arc. A non-unique arc index keeps "this arc's releases" a range
scan.
"""

from datetime import datetime

from sqlalchemy import Column, DateTime, Index, UniqueConstraint
from sqlmodel import Field, SQLModel


class MettaReturnHabitRelease(SQLModel, table=True):
    """One habit's release record within a single Return arc.

    The unique constraint ``uq_metta_return_habit_release_arc_habit`` on
    ``(arc_id, habit_id)`` guarantees at most one release row per habit per arc,
    so releasing the same habit twice in one arc is idempotent, while the same
    habit released in a different arc is a distinct, allowed row.
    :attr:`recommitted_at` is ``None`` while the release is live and is stamped
    when the user re-commits, so an arc's live releases are exactly the rows with
    a null ``recommitted_at``.
    """

    __table_args__ = (
        UniqueConstraint(
            "arc_id",
            "habit_id",
            name="uq_metta_return_habit_release_arc_habit",
        ),
        Index("ix_metta_return_habit_release_arc_id", "arc_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    arc_id: int = Field(foreign_key="mettareturnarc.id", ondelete="CASCADE")
    habit_id: int = Field(foreign_key="habit.id", ondelete="CASCADE")
    released_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    recommitted_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
