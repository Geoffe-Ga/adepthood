"""One press of "Sort the rest of your writing", carried to the end in the background.

Sorting used to be a bounded pass on the request that asked for it: forty
entries and twenty seconds at most, because somebody was waiting on the answer.
A long backlog took a press per forty entries, each one a decision the person
had already made. A run is that decision recorded once: the request that starts
it returns at once, and a background driver walks *every* entry that was
pending, once, until none is left that it has not offered.

**A row rather than a task handle, because the answer has to outlive the
process.** The screen that asked reads progress from whichever server worker
answers its next request, a deploy can end the worker driving the run, and a
second press can land on a different worker than the first. All three are
questions about durable state, so the run's state, its counts and its lease
live here.

**Single-flight is the database's job.** At most one ``running`` row per
account, enforced by a partial unique index -- not by an in-process lock, which
one worker could not see on another. A second press finds the running row and
joins it; two presses racing each other both try to insert, and the loser reads
the winner's row back.

**The lease is how an orphan is recovered.** ``owner_id`` names the driver
holding the run and ``heartbeat_at`` says when it last proved it was alive. A
run whose heartbeat has gone stale belonged to a process that died, and the next
press, or the next recovery sweep, claims it and carries on. The walk is
idempotent -- an entry already sorted is no longer pending -- so resuming from
the top costs only the reads.

**The row is content-free.** Three counts, a closed vocabulary of states and
stop reasons, a lane, an opaque lease token and instants. Nothing from any
entry, so an operator can read how a sort went without reading a word of it.
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime
from typing import Final

from sqlalchemy import CheckConstraint, Column, DateTime, Index, text
from sqlmodel import Field, SQLModel


class SortLane(enum.StrEnum):
    """Which side sorts this account's writing, resolved from its boundary at start.

    ``app_provider`` classifies each entry with the app's own model into the
    corpus. ``vault_bound`` hands each entry to the writer's vault, which
    classifies what it receives (#3156): the app's model is never asked.
    """

    APP_PROVIDER = "app_provider"
    VAULT_BOUND = "vault_bound"


class SortRunState(enum.StrEnum):
    """Where a run is. Only ``running`` may change; the other three are final."""

    RUNNING = "running"
    COMPLETED = "completed"
    STOPPED = "stopped"
    FAILED = "failed"


class SortStopReason(enum.StrEnum):
    """Why a run ended before offering everything, in words safe to show and log.

    Each is a fact about the account or the deployment rather than about one
    entry -- an entry that fails on its own stays pending and the run carries
    on -- which is why each one ends the run instead of being retried per row.
    """

    #: No standing yes for sorting what is written here; nothing was offered.
    NO_CONSENT = "no_consent"
    #: The yes was withdrawn while the run was going.
    CONSENT_WITHDRAWN = "consent_withdrawn"
    #: A vault was connected or disconnected mid-run, so the side allowed to
    #: sort this writing changed under it (#3156).
    BOUNDARY_CHANGED = "boundary_changed"
    #: An operator suspended outbound AI calls or vault sends.
    SUSPENDED = "suspended"
    #: The app provider refused to bill (a spent balance).
    PROVIDER_REFUSED = "provider_refused"
    #: The writer's vault could not take writing.
    VAULT_UNAVAILABLE = "vault_unavailable"


#: Widths of the closed-vocabulary columns: the longest value with headroom.
_LANE_WIDTH: Final = 16
_STATE_WIDTH: Final = 16
_STOP_REASON_WIDTH: Final = 32
#: An opaque lease token: a UUID's 32 hex characters.
_OWNER_WIDTH: Final = 32

#: A run counts entries; it cannot count fewer than none.
_MIN_COUNT: Final = 0


def _quoted(values: type[enum.StrEnum]) -> str:
    """Render an enum's values as a SQL ``IN`` list, in declaration order."""
    return ", ".join(f"'{member.value}'" for member in values)


#: The CHECK conditions, in one place so the migration can freeze the same text.
LANE_CONDITION: Final = f"lane IN ({_quoted(SortLane)})"
STATE_CONDITION: Final = f"state IN ({_quoted(SortRunState)})"
# ``IS NOT NULL`` is not redundant with ``IN``: ``NULL IN (...)`` is NULL, and
# a CHECK refuses only FALSE, so without it a stopped run with no reason passes.
STOP_REASON_CONDITION: Final = (
    "(state = 'stopped' AND stop_reason IS NOT NULL AND stop_reason IN "
    f"({_quoted(SortStopReason)})) OR (state <> 'stopped' AND stop_reason IS NULL)"
)
FINISHED_CONDITION: Final = (
    "(state = 'running' AND finished_at IS NULL) "
    "OR (state <> 'running' AND finished_at IS NOT NULL)"
)
LEASE_CONDITION: Final = (
    "(owner_id IS NULL AND heartbeat_at IS NULL) "
    "OR (owner_id IS NOT NULL AND heartbeat_at IS NOT NULL)"
)
COUNTS_CONDITION: Final = (
    f"entries_total >= {_MIN_COUNT} AND entries_offered >= {_MIN_COUNT} "
    f"AND entries_sorted >= {_MIN_COUNT} AND entries_sorted <= entries_offered"
)
#: The rows the single-flight index covers.
RUNNING_CONDITION: Final = "state = 'running'"


class CorpusSortRun(SQLModel, table=True):
    """One sort of one account's backlog, from the press that started it to its end.

    ``entries_total`` is how much was pending when the run started -- the
    number the screen counts progress against. ``entries_offered`` is how many
    the run actually offered, and ``entries_sorted`` how many of those became
    sorted: a fragment in the corpus on the app-provider lane, a copy in the
    vault on the vault-bound lane. An entry offered and not sorted (one the
    classifier could place nowhere, or a write the vault dropped) stays pending
    for a later run, which is why the two counts are not the same number.
    """

    __tablename__ = "corpussortrun"

    # "This account's runs, newest first" is the only read, so the composite
    # serves it and covers ``user_id`` as a prefix. Declared here as well as in
    # the migration so ``alembic check`` sees no drift.
    __table_args__ = (
        Index("ix_corpussortrun_user_id_id", "user_id", "id"),
        Index(
            "ix_corpussortrun_running_user_unique",
            "user_id",
            unique=True,
            postgresql_where=text(RUNNING_CONDITION),
            sqlite_where=text(RUNNING_CONDITION),
        ),
        CheckConstraint(LANE_CONDITION, name="ck_corpussortrun_lane_valid"),
        CheckConstraint(STATE_CONDITION, name="ck_corpussortrun_state_valid"),
        CheckConstraint(STOP_REASON_CONDITION, name="ck_corpussortrun_stop_reason_valid"),
        CheckConstraint(FINISHED_CONDITION, name="ck_corpussortrun_finished_at_valid"),
        CheckConstraint(LEASE_CONDITION, name="ck_corpussortrun_lease_valid"),
        CheckConstraint(COUNTS_CONDITION, name="ck_corpussortrun_counts_valid"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    lane: str = Field(max_length=_LANE_WIDTH)
    state: str = Field(max_length=_STATE_WIDTH)
    stop_reason: str | None = Field(default=None, max_length=_STOP_REASON_WIDTH)
    entries_total: int = Field(nullable=False)
    entries_offered: int = Field(default=0, nullable=False)
    entries_sorted: int = Field(default=0, nullable=False)
    owner_id: str | None = Field(default=None, max_length=_OWNER_WIDTH)
    heartbeat_at: datetime | None = Field(
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
