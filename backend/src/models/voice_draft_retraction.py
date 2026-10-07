"""Durable, content-free record of each mirrored Voice Draft and its withdrawal.

A generated essay may be mirrored into the writer's connected Creek vault, and
a later Intimate reclassification or journal deletion owes that vault a
content-free DELETE. Before this table, nothing local said which essays had
been sent, or where, and the DELETE a privacy PATCH sent was attempted once and
then forgotten (#3060, #3077).

One row per (account, marginalia) moves through a closed lifecycle:

* ``mirror_intent`` -- written and committed *before* the PUT is dialled, so a
  crash or a lost acknowledgement after Creek stored the draft still leaves a
  local trace. An essay with no row was provably never offered to a vault and
  needs no retraction.
* ``pending`` -- a withdrawal is owed. It stays here across failed attempts,
  restarts, and repeated requests until the destination confirms absence.
* ``confirmed`` -- the destination that received the copy confirmed it absent.

``destination`` is an opaque fingerprint of the vault the copy was sent to
(:func:`dependencies.creek_vault.vault_destination_fingerprint`), so a
confirmation counts only when it comes from that same vault: a replaced
connection answering "unknown id, withdrawn" is not proof the old vault let go.

Content-free by construction: ids, a closed state, a closed failure code, an
attempt count, an opaque fingerprint, and timestamps. No essay, body, title,
URL, credential, or content hash is stored.
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime, Index
from sqlmodel import Field, SQLModel

from models.journal_entry import VAULT_DESTINATION_WIDTH

_STATE_WIDTH = 16
_FAILURE_CODE_WIDTH = 32


class VoiceDraftRetractionState(enum.StrEnum):
    """Closed lifecycle of one mirrored Voice Draft."""

    MIRROR_INTENT = "mirror_intent"
    PENDING = "pending"
    CONFIRMED = "confirmed"


class RetractionFailureCode(enum.StrEnum):
    """Closed, content-free reasons a withdrawal stayed pending."""

    VAULT_UNAVAILABLE = "vault_unavailable"
    CAPABILITY_MISSING = "capability_missing"
    VAULT_ERROR = "vault_error"
    NOT_DELETED = "not_deleted"
    DESTINATION_CHANGED = "destination_changed"


def _quoted(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


_STATES = tuple(state.value for state in VoiceDraftRetractionState)
_FAILURE_CODES = tuple(code.value for code in RetractionFailureCode)


class VoiceDraftRetraction(SQLModel, table=True):
    """One account's mirror-and-withdrawal obligation for one expanded note."""

    __tablename__ = "voicedraftretraction"
    __table_args__ = (
        CheckConstraint(
            f"state IN ({_quoted(_STATES)})",
            name="ck_voicedraftretraction_state_valid",
        ),
        CheckConstraint(
            f"safe_failure_code IS NULL OR safe_failure_code IN ({_quoted(_FAILURE_CODES)})",
            name="ck_voicedraftretraction_failure_code_valid",
        ),
        CheckConstraint(
            "attempt_count >= 0",
            name="ck_voicedraftretraction_attempt_count_range",
        ),
        Index(
            "ix_voicedraftretraction_user_marginalia_unique",
            "user_id",
            "marginalia_id",
            unique=True,
        ),
        Index("ix_voicedraftretraction_state_next_attempt", "state", "next_attempt_at"),
        Index("ix_voicedraftretraction_journal_entry_id", "journal_entry_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    journal_entry_id: int = Field(foreign_key="journalentry.id", ondelete="CASCADE")
    # Deliberately not a foreign key: the obligation describes a remote copy,
    # and must outlive any local change to the note that produced it.
    marginalia_id: int
    state: str = Field(
        default=VoiceDraftRetractionState.MIRROR_INTENT.value,
        max_length=_STATE_WIDTH,
    )
    destination: str | None = Field(default=None, max_length=VAULT_DESTINATION_WIDTH)
    attempt_count: int = Field(default=0, ge=0, nullable=False)
    safe_failure_code: str | None = Field(default=None, max_length=_FAILURE_CODE_WIDTH)
    next_attempt_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    confirmed_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
