"""One bulk upload's vault pass, from the drain that pressed it to its end (#3773).

A bulk upload sends many documents under one ``upload_run`` id and, since
#3773, none of them drives the vault's ontologization ladder inline. When the
client's upload queue drains it presses ``POST /corpus/import/complete`` once,
naming that id as ``batch_id``, and this row is the run that press started: a
background driver hands one full ``bulk_import`` pass to the durable pipeline
(:mod:`services.creek_vault_pipeline`), waits for it to climb, then starts or
joins the corpus sweep.

**Idempotent per batch.** ``(user_id, batch_id)`` is unique, so a second press
of the same batch -- a retried request, two tabs -- finds this row and joins it.

**Single-flight per account.** At most one ``running`` row per account,
enforced by a partial unique index, the :mod:`models.corpus_sort_run` pattern.
A different batch pressed while one runs is recorded ``queued`` and promoted
when the running one ends (or by recovery), because its documents landed after
the running pass took its snapshot.

**Durable.** A running row carries an opaque lease -- owner token and
heartbeat. A row whose heartbeat goes stale belonged to a worker that died, and
the next press or the recovery loop claims it and carries on.
``dispatched_at`` records that the pass was handed to the durable pipeline, so
a resumed run never hands the same pass on twice.

**Content-free.** A batch id the client minted at random, a count the client
reported, a closed vocabulary and instants. Nothing names a document.
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime
from typing import Final

from sqlalchemy import CheckConstraint, Column, DateTime, Index, UniqueConstraint, text
from sqlmodel import Field, SQLModel


class BulkImportRunState(enum.StrEnum):
    """Where a run is. ``queued`` and ``running`` may change; the other three are final."""

    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    STOPPED = "stopped"
    FAILED = "failed"


class BulkImportStopReason(enum.StrEnum):
    """Why a run ended without handing a pass on, in words safe to show and log."""

    #: The account's vault did not answer its handshake, or there is none.
    VAULT_UNAVAILABLE = "vault_unavailable"
    #: The vault answered but advertises no batch pipeline to drive.
    PIPELINE_UNSUPPORTED = "pipeline_unsupported"


#: Widths of the closed-vocabulary columns: the longest value with headroom.
_STATE_WIDTH: Final = 16
_STOP_REASON_WIDTH: Final = 32
#: An opaque lease token: a UUID's 32 hex characters.
_OWNER_WIDTH: Final = 32
#: The client's ``upload_run`` id, whose schema caps it at 64 characters.
BATCH_ID_WIDTH: Final = 64

#: A run counts documents; it cannot count fewer than none.
_MIN_COUNT: Final = 0


def _quoted(values: type[enum.StrEnum]) -> str:
    """Render an enum's values as a SQL ``IN`` list, in declaration order."""
    return ", ".join(f"'{member.value}'" for member in values)


#: The CHECK conditions, in one place so the migration can freeze the same text.
STATE_CONDITION: Final = f"state IN ({_quoted(BulkImportRunState)})"
# ``IS NOT NULL`` is not redundant with ``IN``: ``NULL IN (...)`` is NULL, and
# a CHECK refuses only FALSE, so without it a stopped run with no reason passes.
STOP_REASON_CONDITION: Final = (
    "(state = 'stopped' AND stop_reason IS NOT NULL AND stop_reason IN "
    f"({_quoted(BulkImportStopReason)})) OR (state <> 'stopped' AND stop_reason IS NULL)"
)
FINISHED_CONDITION: Final = (
    "(state IN ('queued', 'running') AND finished_at IS NULL) "
    "OR (state NOT IN ('queued', 'running') AND finished_at IS NOT NULL)"
)
LEASE_CONDITION: Final = (
    "(state = 'running' AND owner_id IS NOT NULL AND heartbeat_at IS NOT NULL) "
    "OR (state <> 'running' AND owner_id IS NULL AND heartbeat_at IS NULL)"
)
LANDED_CONDITION: Final = f"landed >= {_MIN_COUNT}"
#: The rows the single-flight index covers.
RUNNING_CONDITION: Final = "state = 'running'"


class VaultBulkImportRun(SQLModel, table=True):
    """One bulk upload's single vault pass, keyed by the batch the client minted."""

    __tablename__ = "vaultbulkimportrun"

    # Declared here as well as in the migration so ``alembic check`` sees no drift.
    __table_args__ = (
        UniqueConstraint("user_id", "batch_id", name="uq_vaultbulkimportrun_user_batch"),
        Index("ix_vaultbulkimportrun_user_id_id", "user_id", "id"),
        Index(
            "ix_vaultbulkimportrun_running_user_unique",
            "user_id",
            unique=True,
            postgresql_where=text(RUNNING_CONDITION),
            sqlite_where=text(RUNNING_CONDITION),
        ),
        CheckConstraint(STATE_CONDITION, name="ck_vaultbulkimportrun_state_valid"),
        CheckConstraint(STOP_REASON_CONDITION, name="ck_vaultbulkimportrun_stop_reason_valid"),
        CheckConstraint(FINISHED_CONDITION, name="ck_vaultbulkimportrun_finished_at_valid"),
        CheckConstraint(LEASE_CONDITION, name="ck_vaultbulkimportrun_lease_valid"),
        CheckConstraint(LANDED_CONDITION, name="ck_vaultbulkimportrun_landed_valid"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    batch_id: str = Field(max_length=BATCH_ID_WIDTH)
    landed: int = Field(nullable=False)
    state: str = Field(max_length=_STATE_WIDTH)
    stop_reason: str | None = Field(default=None, max_length=_STOP_REASON_WIDTH)
    owner_id: str | None = Field(default=None, max_length=_OWNER_WIDTH)
    heartbeat_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    dispatched_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    started_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    finished_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
