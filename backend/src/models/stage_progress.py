from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import JSON, CheckConstraint, Column, DateTime, Integer
from sqlalchemy.dialects.postgresql import ARRAY
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .user import User


class StageProgress(SQLModel, table=True):
    """Tracks which stage a user is currently working on and which stages have been completed."""

    __table_args__ = (
        CheckConstraint("cycle_number >= 1", name="ck_stageprogress_cycle_number_positive"),
        CheckConstraint(
            "highest_stage_reached >= 1",
            name="ck_stageprogress_highest_stage_reached_positive",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    current_stage: int
    completed_stages: list[int] = Field(
        default_factory=list,
        sa_column=Column(ARRAY(Integer), nullable=False),
    )
    stage_started_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    # Program-wide start anchor (issue #386): the single date every
    # stage/week calendar derivation keys off, mirroring the frontend's
    # ``programStartDate``.  Nullable for legacy rows; the migration
    # backfills from the earliest habit start date (else
    # ``stage_started_at``), and ``resolve_program_anchor`` falls back at
    # read time for anything the backfill missed.
    program_started_at: datetime | None = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    # Loop index for the 36-week arc; progression/loop logic lands in a later issue.
    cycle_number: int = Field(default=1, ge=1)
    # Every EARLIER cycle's program-start anchor, oldest first (issue #2894).
    # Three load-bearing facts:
    #   (a) element ``i`` is cycle ``i + 1``'s ``program_started_at`` as an
    #       ISO-8601 string, so ``len(...) == cycle_number - 1`` always — the
    #       write site pads before appending so the index cannot drift;
    #   (b) ``None`` at an index means that anchor was DESTROYED by begin-again
    #       before #2894 and is NOT RECOVERABLE. It is recorded as unknown and
    #       never guessed: every available approximation would fabricate a
    #       window and re-create the wrong-period bug of #2886;
    #   (c) cycle k's END is element ``k`` — or the live ``program_started_at``
    #       for the newest past cycle — because ``_loop_to_next_cycle`` writes
    #       ONE ``now`` to both the outgoing end and the incoming start. That is
    #       why there is no separate ``ended_at`` column to drift out of step.
    # Declared as JSON with no length to match the migration exactly (drift-free)
    # and nullable so the write path is purely additive over existing rows.
    past_cycle_anchors: list[str | None] | None = Field(
        default=None, sa_column=Column(JSON, nullable=True)
    )
    # Lifetime high-water mark: the highest stage ever reached by advancement.
    # Monotone — bumped on advance, never cleared by begin-again — so a Return
    # stays eligible from any current stage once Blue was ever passed.
    highest_stage_reached: int = Field(default=1, ge=1)
    user_id: int = Field(foreign_key="user.id", unique=True, ondelete="CASCADE")
    user: "User" = Relationship(back_populates="stage_progress")
