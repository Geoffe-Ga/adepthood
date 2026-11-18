"""One row per pass through the ten stages (issue #3723).

``StageProgress`` holds only the LIVE program anchor plus the list of earlier
starts on ``past_cycle_anchors``; a pass's end and how far it got were never
stored, so every view of an earlier pass had to be recomputed from history the
live anchor no longer describes. This table keeps each pass as its own record:
the day it started, the day it ended (``NULL`` while it is live), how it began,
and the stage and week it reached when it was closed.

Days, not instants: ``started_on`` and ``ended_on`` are calendar dates in the
account's own zone, the unit the program calendar already counts in
(:func:`domain.program_calendar.elapsed_days`). A pass ends the day before the
next one starts, so two passes never share a day.
"""

from datetime import date
from enum import StrEnum

from sqlalchemy import CheckConstraint, UniqueConstraint
from sqlmodel import Field, SQLModel

from domain.constants import TOTAL_PROGRAM_WEEKS, TOTAL_STAGES


class PassOrigin(StrEnum):
    """How a pass began."""

    #: The pass opened when the account's progress row was first provisioned.
    FIRST_RUN = "first_run"
    #: Re-running Energy Scaffolding opened it (``POST /stages/passes``, issue #3725).
    RESCAFFOLD = "rescaffold"
    #: ``POST /stages/begin-again`` opened it.
    BEGIN_AGAIN = "begin_again"
    #: Reconstructed from ``past_cycle_anchors`` and the live anchor after the fact.
    BACKFILL = "backfill"


_ORIGIN_CONSTRAINT_SQL = "origin IN ({})".format(
    ", ".join(f"'{origin.value}'" for origin in PassOrigin)
)


class ProgramPass(SQLModel, table=True):
    """A single pass through the stages: when it ran, how it began, how far it got.

    ``reached_stage`` and ``reached_week`` stay ``NULL`` while the pass is live
    and are filled by :func:`domain.program_pass.close_pass` from the pass's own
    ``started_on`` -- never from the live anchor, which by then belongs to the
    next pass. ``completed`` is true only for a pass that ran to the end of
    stage 10; anything shorter is a partial completion.

    ``pass_number`` follows the cycle it belongs to, so a cycle whose start was
    destroyed before #2894 leaves a gap in the numbering rather than a guess.
    """

    __tablename__ = "programpass"
    __table_args__ = (
        UniqueConstraint("user_id", "pass_number", name="uq_programpass_user_pass_number"),
        CheckConstraint("pass_number >= 1", name="ck_programpass_pass_number_positive"),
        CheckConstraint(_ORIGIN_CONSTRAINT_SQL, name="ck_programpass_origin_valid"),
        CheckConstraint(
            f"reached_stage IS NULL OR (reached_stage >= 1 AND reached_stage <= {TOTAL_STAGES})",
            name="ck_programpass_reached_stage_range",
        ),
        CheckConstraint(
            "reached_week IS NULL OR "
            f"(reached_week >= 1 AND reached_week <= {TOTAL_PROGRAM_WEEKS})",
            name="ck_programpass_reached_week_range",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, ondelete="CASCADE")
    pass_number: int = Field(ge=1)
    started_on: date
    ended_on: date | None = None
    origin: str = Field(max_length=32)
    reached_stage: int | None = Field(default=None, ge=1, le=TOTAL_STAGES)
    reached_week: int | None = Field(default=None, ge=1, le=TOTAL_PROGRAM_WEEKS)
    completed: bool = False
