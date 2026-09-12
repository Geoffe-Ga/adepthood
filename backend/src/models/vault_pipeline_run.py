"""One rung of a vault's ontologization ladder, and how far it got.

A connected vault files what adepthood sends it as fragments, and a fragment
nobody classified carries no frequency, no phase and no links: the reflection
surface, the wheel and the invitation engine all read it as absence rather than
as writing. Creek's remedy is a batch pass — classify everything, then link it
four ways — and this table is adepthood's memory of having driven it.

**A rung is a row because "how long since" is a question, and a question needs
rows.** The pass is triggered from two request paths that run on ordinary user
activity, so the thing that keeps it from running on every journal save is a
per-stage interval, and an interval can only be measured against a stamp that
outlives the request that wrote it. A log line outlives nothing that can be
compared: it is retained for a window, it cannot be read back by the code that
has to decide, and no surface can query it.

**The row is content-free.** A stage, original trigger and optional follow-up
trigger, an outcome, attempt count, opaque job and lease UUIDs, three counts and
two instants. Nothing from any fragment, nothing from any document, and nothing
a reader could reconstruct one from. Creek's job surface and pipeline responses
publish counts and opaque correlation only: no fragment id, path, title,
excerpt, or error string.

**Every logical run writes one row before its first attempt.** Retries increment
that row rather than creating new debounce stamps. A write that arrives after a
classification was admitted cannot be claimed by that earlier snapshot, so it
adds only a follow-up trigger to the active row. Its scope is first committed to
the separate content-free ``vaultpipelinefollowup`` rendezvous row, allowing a
terminalizer to see it even while PostgreSQL makes the run-row update wait.
Terminalizing that row and inserting one ``queued`` successor then share a
transaction. The partial unique index spans both queued and attempted
user/stage pairs, closing concurrent admission across workers; a durable job id
lets startup resume the accepted pass instead of submitting a duplicate after
a process restart. Startup itself takes a content-free UUID and timestamp lease
on the row before it schedules recovery. A live process renews that timestamp,
another process cannot release an owner it did not claim, and a hard-killed
process's lease becomes stale so the next healthy boot can recover the same
durable handle.

It also keeps a persistently failing linker from starving the rungs behind it:
after bounded retries its terminal or ambiguous result closes its interval and
the background continuation advances. Classification alone remains a hard
prerequisite because threads consume the labels it writes.

**The instant is declared zoned.** Comparing these rows against a clock is the
entire use of them, and that comparison is made by different requests in
different processes, so an unzoned answer would leave the deciding code to guess
which zone the deployment was in. ``DateTime(timezone=True)``, the declaration
``corpussweep`` makes, so the two can be read against each other.
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime, Index, text
from sqlmodel import Field, SQLModel

from domain.creek_vault import VaultPipelineStage

# A stage reaches fragments or it reaches none; it cannot reach a negative
# number of them, and a negative count would read as a sentinel nobody defined.
_MIN_FRAGMENTS = 0

# Symbolic tokens from closed sets, never prose. The CHECKs below pin which, and
# the widths are the ``corpusconsentevent`` convention rather than a measurement
# of today's longest member: a column sized to the current vocabulary is one that
# has to be migrated the first time a member is renamed.
_STAGE_WIDTH = 20
_OUTCOME_WIDTH = 20
_TRIGGER_WIDTH = 20
_JOB_ID_WIDTH = 36
_MIN_ATTEMPTS = 1


class VaultPipelineOutcome(enum.StrEnum):
    """Where one durable rung is in its admission lifecycle.

    Six members, separating promised work, uncertain admission, incomplete work,
    failure, and ambiguity.
    ``INCOMPLETE`` is Creek's ``complete: false`` — a classification pass that
    skipped some fragments — and it is neither a success nor a failure: the pass
    is resumable, so it means the honest next step is to call again, while the
    labels it did write are real and the stages that read them may run. Folding
    it into ``COMPLETED`` would lose the reason to come back; folding it into
    ``FAILED`` would stand down a stage that in fact did most of its work.

    Values are stored, so they are a persisted vocabulary and must not be
    reworded without a migration.

    Attributes:
        QUEUED: A joined write durably promised one follow-up, but no socket has
            opened for it yet. It is inserted in the same transaction that
            terminalizes the snapshot it follows, and startup may claim it.
        ATTEMPTED: The row was written and committed *before* the vault was
            dialled, and no answer has replaced it yet. It is what makes the
            stamp visible to a concurrent request while the call is still in
            flight -- without it, every request arriving during one pass reads
            an empty log and dials the vault too. A row left in this state is a
            process that died mid-call, and it is read as "attempted, outcome
            unknown": it holds the interval closed, and it does not count as a
            classification having landed.
        COMPLETED: The vault ran the stage and reported it clean.
        INCOMPLETE: The vault ran the stage and reported that some fragments
            were skipped. Only a classification pass can report this; the linker
            has no per-fragment error accumulator to collapse.
        FAILED: The stage definitively failed or was refused after its bounded
            retry path. A timeout or lost answer alone is not sufficient.
        AMBIGUOUS: Bounded retries were exhausted without a terminal answer.
            The vault may still have landed an idempotent pass, so this outcome
            must never be promoted into proof that it failed.
    """

    QUEUED = "queued"
    ATTEMPTED = "attempted"
    COMPLETED = "completed"
    INCOMPLETE = "incomplete"
    FAILED = "failed"
    AMBIGUOUS = "ambiguous"


def _quoted(values: tuple[str, ...]) -> str:
    """Render enum values as the quoted SQL literal list a CHECK reads."""
    return ", ".join(f"'{value}'" for value in values)


def _stage_check() -> CheckConstraint:
    """CHECK that a row names a rung of the ladder and not some other word."""
    return CheckConstraint(
        f"stage IN ({_quoted(tuple(stage.value for stage in VaultPipelineStage))})",
        name="ck_vaultpipelinerun_stage_valid",
    )


def _outcome_check() -> CheckConstraint:
    """CHECK that a row names one state in the durable admission lifecycle."""
    return CheckConstraint(
        f"outcome IN ({_quoted(tuple(outcome.value for outcome in VaultPipelineOutcome))})",
        name="ck_vaultpipelinerun_outcome_valid",
    )


def _fragments_seen_check() -> CheckConstraint:
    """CHECK that the number of fragments a stage looked at is a count."""
    return CheckConstraint(
        f"fragments_seen >= {_MIN_FRAGMENTS}",
        name="ck_vaultpipelinerun_fragments_seen_range",
    )


def _fragments_touched_check() -> CheckConstraint:
    """CHECK that the number of fragments a stage acted on is a count."""
    return CheckConstraint(
        f"fragments_touched >= {_MIN_FRAGMENTS}",
        name="ck_vaultpipelinerun_fragments_touched_range",
    )


def _fragments_lost_check() -> CheckConstraint:
    """CHECK that the number of fragments a stage dropped is a count."""
    return CheckConstraint(
        f"fragments_lost >= {_MIN_FRAGMENTS}",
        name="ck_vaultpipelinerun_fragments_lost_range",
    )


def _trigger_check() -> CheckConstraint:
    """CHECK the trigger when a new durable run records one."""
    return CheckConstraint(
        "trigger IS NULL OR trigger IN ('journal_write', 'document_import')",
        name="ck_vaultpipelinerun_trigger_valid",
    )


def _follow_up_trigger_check() -> CheckConstraint:
    """CHECK the content-free scope requested by a write that joined this run."""
    return CheckConstraint(
        "follow_up_trigger IS NULL OR follow_up_trigger IN ('journal_write', 'document_import')",
        name="ck_vaultpipelinerun_follow_up_trigger_valid",
    )


def _attempt_count_check() -> CheckConstraint:
    """CHECK that only a durably queued follow-up has no wire attempt yet."""
    return CheckConstraint(
        "(outcome = 'queued' AND attempt_count = 0) OR "
        f"(outcome != 'queued' AND attempt_count >= {_MIN_ATTEMPTS})",
        name="ck_vaultpipelinerun_attempt_count_range",
    )


def _resume_claim_check() -> CheckConstraint:
    """CHECK that a startup lease always has both its owner and its clock."""
    return CheckConstraint(
        "(resume_claim_id IS NULL AND resume_claimed_at IS NULL) OR "
        "(resume_claim_id IS NOT NULL AND resume_claimed_at IS NOT NULL)",
        name="ck_vaultpipelinerun_resume_claim_complete",
    )


class VaultPipelineRun(SQLModel, table=True):
    """One logical run of one stage in the vault ontologization ladder.

    The three counts are the two pipeline responses read through one vocabulary,
    because the scheduler that writes them does not care which route answered.
    For a classification pass they are fragments visited, fragments whose
    frontmatter was rewritten, and zero — that pass loses nothing. For a linker
    stage they are fragments loaded, links (or eddies, or threads) emitted, and
    fragments dropped to noise because their cluster stayed oversized after the
    split budget was spent.

    ``fragments_lost`` is the one worth reading twice. Creek publishes it rather
    than folding it away because a caller who cannot see it reads a lossy pass as
    a clean one, and it is kept here for the same reason: those fragments carry
    no link at all, and a corpus quietly missing some of its threads is exactly
    the failure this whole table exists to make visible.

    ``user_id`` and not a vault url, because the account is what the ladder is
    driven on behalf of and what the interval is measured per. It is also the
    only key that covers both kinds of vault this deployment can reach: an
    account with its own connection has a ``uservaultconfig`` row, and the owner
    of a deployment-wide vault has none, so a stamp hung off that table would
    silently exempt the second from every interval it defines.
    """

    __tablename__ = "vaultpipelinerun"

    # The read is always "this account's attempts at this stage, newest first",
    # so the index carries the filter, the discriminator and the ordering key and
    # answers it in one scan. ``user_id`` deliberately carries no index of its
    # own: the composite covers it as a prefix, and a second index over the same
    # column would be paid for on every insert to serve a query the first one
    # already serves. Declared here as well as in the migration so
    # ``alembic check`` sees no drift.
    __table_args__ = (
        Index("ix_vaultpipelinerun_user_id_stage_id", "user_id", "stage", "id"),
        Index("ix_vaultpipelinerun_outcome_id", "outcome", "id"),
        Index(
            "ix_vaultpipelinerun_active_user_stage_unique",
            "user_id",
            "stage",
            unique=True,
            postgresql_where=text("outcome IN ('queued', 'attempted')"),
            sqlite_where=text("outcome IN ('queued', 'attempted')"),
        ),
        _stage_check(),
        _outcome_check(),
        _trigger_check(),
        _follow_up_trigger_check(),
        _attempt_count_check(),
        _resume_claim_check(),
        _fragments_seen_check(),
        _fragments_touched_check(),
        _fragments_lost_check(),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    stage: str = Field(max_length=_STAGE_WIDTH)
    outcome: str = Field(max_length=_OUTCOME_WIDTH)
    trigger: str | None = Field(default=None, max_length=_TRIGGER_WIDTH)
    follow_up_trigger: str | None = Field(default=None, max_length=_TRIGGER_WIDTH)
    job_id: str | None = Field(default=None, max_length=_JOB_ID_WIDTH)
    attempt_count: int = Field(default=_MIN_ATTEMPTS, nullable=False)
    resume_claim_id: str | None = Field(default=None, max_length=_JOB_ID_WIDTH)
    resume_claimed_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    fragments_seen: int = Field(nullable=False)
    fragments_touched: int = Field(nullable=False)
    fragments_lost: int = Field(nullable=False)
    ran_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
