from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Column, DateTime
from sqlmodel import Field, SQLModel

from domain.practice_modes import PracticeMode
from services.journal_encryption import EncryptedString


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

    ``reflection`` and ``insight`` are the only columns here holding prose a
    person composed, and both are encrypted at rest via ``EncryptedString``.
    They are not copies of a journal entry -- which is why the sweep that
    encrypted every copy of journal text left them behind -- but they are the
    same category of private, deliberate writing, and a stolen dump reads them
    the same way.  Neither carries a Field ``max_length``: the column is
    ``Text``, because a Fernet token is ~1.67x the plaintext plus the marker and
    would not fit the bound.  The user-visible caps are unchanged and still
    enforced at the write boundary, by ``PRACTICE_REFLECTION_MAX_LENGTH`` and
    ``PRACTICE_INSIGHT_MAX_LENGTH`` on the request schema -- which is the layer
    the OpenAPI ``maxLength`` the client reads is generated from.

    Every other column is a measurement or a machine-chosen value and stays
    plaintext: encrypting ``mode`` would buy nothing (it is one of a published
    enum) and would break the rollup that filters on it.
    """

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    user_practice_id: int = Field(foreign_key="userpractice.id")
    duration_minutes: float
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    reflection: str | None = Field(default=None, sa_column=Column(EncryptedString(), nullable=True))
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
    insight: str | None = Field(default=None, sa_column=Column(EncryptedString(), nullable=True))
