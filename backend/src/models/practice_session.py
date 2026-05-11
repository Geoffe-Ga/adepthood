from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Column, DateTime
from sqlmodel import Field, SQLModel

from domain.practice_modes import PracticeMode

# Insight is the short user-captured takeaway distinct from the long-form
# ``reflection``.  The cap mirrors the ritual-04 spec ("≤2k").
_INSIGHT_MAX_LENGTH = 2_000


class PracticeSession(SQLModel, table=True):
    """A single session log linked to a UserPractice selection.

    Sessions track duration and timestamp for consistency evaluation
    (target: minimum 4x/week) plus the ritual-04 mode-aware analytics
    columns:

    * ``mode`` is denormalized at write time from the resolved practice
      mode so the insights rollup can filter without a join — and so a
      future catalog edit cannot retro-rewrite session history.
    * ``mode_metadata`` carries engine-specific outputs (rep_count,
      bpm_used, tarot card index, …) validated by the matching
      :mod:`schemas.practice_session_metadata` discriminated-union model.
    * ``completed`` is ``False`` if the user cancelled before the target
      was reached.  Partial sessions still count toward weekly totals
      iff their duration is positive.
    * ``insight`` is a short user-captured takeaway, distinct from the
      long-form ``reflection``.
    """

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    user_practice_id: int = Field(foreign_key="userpractice.id")
    duration_minutes: float
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    reflection: str | None = Field(default=None, max_length=5_000)
    mode: str = Field(
        default=PracticeMode.MEDITATION_TIMER.value,
        max_length=32,
        description="Resolved practice mode at session time (denormalized).",
    )
    mode_metadata: dict[str, Any] | None = Field(
        default=None,
        sa_column=Column(JSON, nullable=True),
        description=(
            "Engine-specific outputs (rep_count, bpm_used, …) validated at the "
            "API edge by schemas.practice_session_metadata.SessionMetadata."
        ),
    )
    completed: bool = Field(
        default=True,
        description="False if the user cancelled before reaching the target.",
    )
    insight: str | None = Field(default=None, max_length=_INSIGHT_MAX_LENGTH)
