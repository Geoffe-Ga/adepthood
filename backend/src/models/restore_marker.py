"""Content-free record that a restored database had its deletions reapplied (#3063).

A backup restore brings back every account and entry deleted after the backup
was taken. Restore suppression (:mod:`services.restore_suppression`) reapplies
the exported tombstones before cutover; this row is how the rest of the system
can tell that happened:

* ``in_progress`` -- a reapply started and did not finish. Rerunning it resumes
  (every step is idempotent).
* ``complete`` -- the reapply finished. A second reapply under the same
  ``restore_id`` is refused, because after cutover the database's sequences
  have moved on and an entry tombstone could name a new row.

The optional startup gate (``RESTORE_SUPPRESSION_REQUIRED``) refuses to serve
until the marker for the configured ``RESTORE_ID`` is ``complete``.

Content-free by construction: an operator-chosen restore id, a closed state,
counts, timestamps and the build version. No user id, email or content.
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime
from sqlmodel import Field, SQLModel

#: Width of the operator-chosen restore identifier.
RESTORE_ID_WIDTH = 64
_STATE_WIDTH = 16
_BUILD_VERSION_WIDTH = 64


class RestoreState(enum.StrEnum):
    """Closed lifecycle of one restore's reapply."""

    IN_PROGRESS = "in_progress"
    COMPLETE = "complete"


_STATES = ", ".join(f"'{state.value}'" for state in RestoreState)


class RestoreMarker(SQLModel, table=True):
    """One row per restore whose tombstones were (being) reapplied."""

    __tablename__ = "restoremarker"
    __table_args__ = (
        CheckConstraint(f"state IN ({_STATES})", name="ck_restoremarker_state_valid"),
        CheckConstraint(
            "accounts_reapplied >= 0 AND entries_reapplied >= 0 AND identity_mismatches >= 0",
            name="ck_restoremarker_counts_range",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    restore_id: str = Field(max_length=RESTORE_ID_WIDTH, unique=True)
    state: str = Field(default=RestoreState.IN_PROGRESS.value, max_length=_STATE_WIDTH)
    started_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    completed_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    accounts_reapplied: int = Field(default=0, nullable=False)
    entries_reapplied: int = Field(default=0, nullable=False)
    identity_mismatches: int = Field(default=0, nullable=False)
    build_version: str | None = Field(default=None, max_length=_BUILD_VERSION_WIDTH)
