"""Driving a connected vault's corpus from inert to ontologized.

Adepthood hands a vault two kinds of writing — journal entries as they are
saved, documents as they are imported — and a vault files both as fragments.
Filing is not ontologizing. A fragment nobody classified carries no APTITUDE
frequency, no Archetypal Wavelength phase and no links, so the vault-backed
reflection, the wheel read and the invitation engine all run over a corpus that
looks empty while being full. Creek's remedy is a pair of batch routes; this
module is the thing that calls them, and the decisions about *when* are the
whole content of the file.

**The ladder.** Semantic classification first, then temporal links, durable
embedding preparation, eddies and threads. The order is not stylistic.
Classification writes the labels the thread stage reads; temporal makes a fresh
corpus navigable immediately; the explicit embedding job keeps the two cluster
passes from discovering a cold vector cache inside a synchronous request.

**Why a rung is skipped is a stamp, not a flag.** Every stage carries its own
minimum interval and its own row in ``vaultpipelinerun``, and a stage runs only
when its last attempt is older than that interval. Per stage rather than per
run, because the cheap half and the expensive half want intervals two orders of
magnitude apart, and a single whole-run debounce makes them interfere: a user
who journals every ten minutes would keep resetting one window and never reach
the stages that only a document import asks for.

That same per-stage stamp is what keeps a failing rung from starving the ones
below it. One logical row follows the stage through bounded retries, and a
terminal or explicitly ambiguous outcome closes its window before independent
successor stages continue.

**Long work has a durable handle.** Contract 0.14 answers LLM classification and
embedding preparation with a consumer-bound job id. The id is committed before
polling, status failures retry with capped exponential backoff, and startup
resumes every still-attempted row. A timeout is therefore ambiguity, never proof
that Creek failed. New admissions are also retried off-request, at most three
times; exhausting them records ``ambiguous`` rather than inventing a failure.

**What one request may cost is bounded twice.** A journal save runs the cheap
half under a short wall clock; when the clock expires its accepted job continues
in the background instead of holding the save open. A document import may spend
a longer foreground budget on the whole ladder. Either clock bounds only the
originating request: durable status polling and bounded retries outlive it.

Every failure is swallowed. This runs after somebody's entry is already
committed and after their document is already stored, so nothing here may cost
them either; :func:`drive_vault_pipeline` never raises.
"""

from __future__ import annotations

import asyncio
import enum
import logging
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import cast
from uuid import UUID

from sqlalchemy import func
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from domain.creek_vault import (
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultClient,
    CreekVaultContractError,
    CreekVaultError,
    CreekVaultPayloadError,
    CreekVaultPipelineClient,
    CreekVaultUnavailableError,
    VaultClassificationPass,
    VaultLinkPass,
    VaultLinkStage,
    VaultPipelineJob,
    VaultPipelineJobState,
    VaultPipelineStage,
)
from domain.dates import ensure_aware
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun

_LOGGER = logging.getLogger(__name__)

#: The outcomes that mean a classification pass actually put labels in the
#: vault. ``ATTEMPTED`` is absent deliberately -- it records a call that was
#: made, not one that answered -- and so is ``FAILED``.
_LABELS_LANDED: tuple[str, ...] = (
    VaultPipelineOutcome.COMPLETED.value,
    VaultPipelineOutcome.INCOMPLETE.value,
)

#: The ladder, in the order Creek documents it. Classification first because the
#: thread stage reads the labels it writes; then the linker stages cheapest
#: first, so a truncated pass leaves the corpus navigable rather than leaving it
#: exactly as it found it.
LADDER: tuple[VaultPipelineStage, ...] = (
    VaultPipelineStage.CLASSIFY,
    VaultPipelineStage.TEMPORAL,
    VaultPipelineStage.EMBEDDINGS,
    VaultPipelineStage.EDDIES,
    VaultPipelineStage.THREADS,
)

#: How each rung of the ladder is spelled on Creek's linker route. A table rather
#: than a branch: classification has no entry, so "classification is not a link
#: stage" is a fact about this mapping rather than a condition somebody could
#: invert, and a stage added to either vocabulary without the other notices here.
LINK_STAGE_BY_PIPELINE_STAGE: Mapping[VaultPipelineStage, VaultLinkStage] = {
    VaultPipelineStage.TEMPORAL: VaultLinkStage.TEMPORAL,
    VaultPipelineStage.EMBEDDINGS: VaultLinkStage.EMBEDDINGS,
    VaultPipelineStage.EDDIES: VaultLinkStage.EDDIES,
    VaultPipelineStage.THREADS: VaultLinkStage.THREADS,
}


class VaultPipelineTrigger(enum.StrEnum):
    """What occasioned a pass, and therefore how much of the ladder it may climb.

    Two triggers because there are two honest answers to "how long may this
    request take". A journal save is the most frequent write in the app and the
    one a person is waiting on with something they just wrote; a document import
    is deliberate, rare, and already a file upload, so a caller has different
    patience for each. The depth is a property of the occasion rather than of the
    caller, which is why it is an enum here and not a parameter.

    Attributes:
        JOURNAL_WRITE: After an entry replicated to the vault. The cheap half
            only — classification and temporal linking — under the adapter's
            standing deadline.
        DOCUMENT_IMPORT: After a document was stored in the vault. The whole
            ladder, under a wall clock.
    """

    JOURNAL_WRITE = "journal_write"
    DOCUMENT_IMPORT = "document_import"


#: Which rungs each trigger is willing to pay for. The journal path's exclusion
#: of the two clustering stages is the single most load-bearing line in this
#: module: those stages run a local sentence-transformer pass over every uncached
#: fragment on a cold vault, which is minutes, and a journal save that could take
#: minutes is a broken journal however well it is bounded.
_STAGES_BY_TRIGGER: Mapping[VaultPipelineTrigger, frozenset[VaultPipelineStage]] = {
    VaultPipelineTrigger.JOURNAL_WRITE: frozenset(
        {VaultPipelineStage.CLASSIFY, VaultPipelineStage.TEMPORAL}
    ),
    VaultPipelineTrigger.DOCUMENT_IMPORT: frozenset(LADDER),
}

# How long a stage stands down for after an attempt, successful or not.
#
# The cheap window is minutes because classification is what makes new writing
# visible to everything downstream, and because the pass short-circuits on the
# fragments it already stamped — so a repeat costs the vault a walk over its own
# frontmatter rather than a reclassification. Fifteen is a compromise between
# "the entry I wrote this morning is in my wheel" and "forty entries in an hour
# is forty passes".
#
# The expensive window is hours because the two clustering stages are the ones
# that actually cost a vault something, and because what they produce — topic
# clusters and narrative currents over a whole corpus — does not meaningfully
# change between one document and the next. Six is chosen so a person importing
# a morning's worth of files pays for one clustering pass rather than one per
# file, while a corpus that grows over a week is re-clustered several times
# across it.
_CHEAP_STAGE_INTERVAL = timedelta(minutes=15)
_CLUSTERING_STAGE_INTERVAL = timedelta(hours=6)

#: How long each rung stands down for after an attempt. A table for the reason
#: :data:`LINK_STAGE_BY_PIPELINE_STAGE` is one: a stage added without an interval
#: should fail to be schedulable rather than inherit somebody else's by falling
#: through an ``else``.
_STAGE_INTERVAL: Mapping[VaultPipelineStage, timedelta] = {
    VaultPipelineStage.CLASSIFY: _CHEAP_STAGE_INTERVAL,
    VaultPipelineStage.TEMPORAL: _CHEAP_STAGE_INTERVAL,
    VaultPipelineStage.EMBEDDINGS: _CLUSTERING_STAGE_INTERVAL,
    VaultPipelineStage.EDDIES: _CLUSTERING_STAGE_INTERVAL,
    VaultPipelineStage.THREADS: _CLUSTERING_STAGE_INTERVAL,
}

# Status reads are cheap and carry no content, but a hot polling loop over a
# minutes-long local model pass is still load. The delay grows geometrically and
# stops at a small ceiling: bounded backoff without turning completion into a
# minute-granularity event.
_JOB_POLL_INITIAL_SECONDS = 0.25
_JOB_POLL_MAX_SECONDS = 5.0

# A durable job may legitimately outlive either originating HTTP request, but
# one that reports queued/running forever must not own the user's in-process
# continuation slot forever. Thirty minutes accommodates cold local model and
# embedding passes; reaching it records ambiguity without admitting a duplicate.
_JOB_RECONCILIATION_BUDGET_SECONDS = 30 * 60

# A transient failure gets two independent retries after the originating call.
# Backoff is exponential but capped, so a sick vault is neither hammered nor
# allowed to turn a recoverable pass into a request-rate loop.
_MAX_STAGE_ATTEMPTS = 3
_RETRY_INITIAL_SECONDS = 1.0
_RETRY_MAX_SECONDS = 30.0
_BACKGROUND_STAGE_BUDGET_SECONDS = 60.0

_TaskKey = tuple[int, VaultPipelineStage]
_BACKGROUND_TASKS: dict[_TaskKey, asyncio.Task[None]] = {}

VaultClientResolver = Callable[[AsyncSession, int], Awaitable[CreekVaultPipelineClient]]

# How long a whole deep pass may go on starting new stages, and the least time
# worth starting one in. Both are the ``corpus_backfill`` idiom: a wall clock
# read from a monotonic source, and a "don't start what won't finish" floor, so a
# pass stops with a remainder rather than overrunning. An accepted job and the
# remainder are continued off-request, from the persisted run.
#
# Sixty seconds is a judgement rather than a derivation, and it is a judgement
# about the *import* route rather than about Creek: that route already accepts a
# file, already answers 202, and is the one place in this app where a person has
# asked for something to be done with a document rather than merely saved. It is
# not enough for a cold vault to finish clustering a large corpus in, and it is
# not meant to be. The durable job continues after the HTTP response, and its
# status is reconciled before eddies or threads begin.
_DEEP_RUN_BUDGET_SECONDS = 60.0
_LEAST_WORTH_STARTING_SECONDS = 5.0

# The same clock for the write path, and much shorter, because the two occasions
# are not comparable. A document import is deliberate, rare, and already a file
# upload; a journal save is the most frequent write in the app and somebody is
# waiting on it with something they just wrote. Ten seconds bounds waiting for
# the semantic classification job; it does not bound the job itself, which has a
# durable id and continues off-request before temporal linking runs.
#
# It is a bound on *elapsed time*, not a gate on starting: each stage runs under
# whatever is left of it. That distinction is the whole point. httpx's ``read``
# budget restarts on every socket read, so it is a floor on how long a call may
# take rather than a ceiling, and a trickling vault stays inside it forever --
# which is exactly how a journal save comes to take minutes while every timeout
# in the stack looks respected.
_JOURNAL_RUN_BUDGET_SECONDS = 10.0


def _run_budget(trigger: VaultPipelineTrigger) -> float:
    """How long a whole pass may take, by the occasion that asked for it.

    Both constants are read here, at call time, rather than frozen into a
    module-level table: a value captured at import is one neither a redeployment
    nor a test can move, which is the same reason the adapter reads its own
    deadline per call instead of capturing it.
    """
    if trigger is VaultPipelineTrigger.DOCUMENT_IMPORT:
        return _DEEP_RUN_BUDGET_SECONDS
    return _JOURNAL_RUN_BUDGET_SECONDS


def _stamps_by_stage(rows: list[VaultPipelineRun]) -> dict[str, datetime]:
    """The instant each stage was last attempted, keyed by stage."""
    return {row.stage: ensure_aware(row.ran_at) for row in rows}


async def _latest_attempt_per_stage(session: AsyncSession, user_id: int) -> list[VaultPipelineRun]:
    """The newest attempt at each stage: at most one row per rung.

    A grouped ``max(id)`` rather than "the newest N rows overall", and the
    difference is the difference between a debounce that holds and one that
    quietly stops holding. A row-count window looks equivalent and is not: the
    cheap stages run every fifteen minutes on an active account, so within an
    hour they fill any small window entirely and push the clustering stages'
    rows off the end -- and a stage whose last attempt has fallen out of the
    read is indistinguishable from one that never ran, so its six-hour interval
    reopens early on an account that merely journals often.

    Asking the database for the maximum per group has no such horizon and needs
    no bound chosen against an assumed write rate. It answers at most one row
    per rung, whatever the account's history, and the composite index over
    ``(user_id, stage, id)`` is the one it walks.
    """
    newest = (
        select(func.max(col(VaultPipelineRun.id)))
        .where(col(VaultPipelineRun.user_id) == user_id)
        .group_by(col(VaultPipelineRun.stage))
    )
    result = await session.execute(
        select(VaultPipelineRun).where(col(VaultPipelineRun.id).in_(newest))
    )
    return list(result.scalars().all())


async def _classification_has_landed(session: AsyncSession, user_id: int) -> bool:
    """Whether any classification pass has ever put labels in this vault.

    Its own query rather than a read of the rows above, because the two ask
    different questions across different spans of history. "Is this stage due?"
    is about the *latest* attempt; "may the clustering stages run at all?" is
    about whether one ever succeeded -- and an account whose most recent
    classification failed may still be carrying the labels a pass wrote last
    week. Reading the second off the first would stand those accounts down for
    good.

    ``INCOMPLETE`` counts, and should: a pass that skipped some fragments still
    labelled the rest, and the labels it wrote are not provisional. ``ATTEMPTED``
    does not: it is a call whose answer never arrived, so whether it wrote a
    single label is precisely what nobody knows.
    """
    result = await session.execute(
        select(col(VaultPipelineRun.id))
        .where(col(VaultPipelineRun.user_id) == user_id)
        .where(col(VaultPipelineRun.stage) == VaultPipelineStage.CLASSIFY.value)
        .where(col(VaultPipelineRun.outcome).in_(_LABELS_LANDED))
        .limit(1)
    )
    return result.first() is not None


def _due(stage: VaultPipelineStage, stamps: Mapping[str, datetime], now: datetime) -> bool:
    """Whether this stage's own window has reopened."""
    last = stamps.get(stage.value)
    return last is None or now - last >= _STAGE_INTERVAL[stage]


def _classification_outcome(result: VaultClassificationPass) -> VaultPipelineOutcome:
    """Read a classification pass as the outcome it is.

    ``complete: false`` is not a failure. The pass is resumable and short-circuits
    on what it already stamped, so an incomplete run means the honest next step is
    to call again — and the labels it did write are real, which is why the stages
    that read them are still allowed to run in the same pass.
    """
    return VaultPipelineOutcome.COMPLETED if result.complete else VaultPipelineOutcome.INCOMPLETE


@dataclass(frozen=True)
class _StageCounts:
    """What one rung reached, in the one vocabulary both routes are read through.

    Creek answers a classification pass and a linker stage in different fields,
    and the scheduler that records them does not care which route answered: what
    it needs is how much was looked at, how much was acted on, and how much was
    lost. Defaulting all three to zero is what lets a failed attempt be recorded
    with the same call as a successful one -- a stage that did not land reached
    nothing, and saying so is more honest than leaving the row's counts to a
    sentinel.

    Attributes:
        seen: Fragments the stage loaded or visited.
        touched: Fragments it rewrote, or links it emitted.
        lost: Fragments it dropped to noise. Only a clustering stage can lose
            any; the classification pass loses nothing.
    """

    seen: int = 0
    touched: int = 0
    lost: int = 0


_NOTHING_REACHED = _StageCounts()


@dataclass(frozen=True)
class _StageContext:
    """The persisted identity shared by every attempt at one logical rung."""

    user_id: int
    stage: VaultPipelineStage
    trigger: VaultPipelineTrigger


def _record(
    session: AsyncSession,
    context: _StageContext,
    outcome: VaultPipelineOutcome,
    counts: _StageCounts = _NOTHING_REACHED,
) -> VaultPipelineRun:
    """Stage one attempt's row and hand it back. The caller owns the commit."""
    run = VaultPipelineRun(
        user_id=context.user_id,
        stage=context.stage.value,
        trigger=context.trigger.value,
        outcome=outcome.value,
        fragments_seen=counts.seen,
        fragments_touched=counts.touched,
        fragments_lost=counts.lost,
    )
    session.add(run)
    return run


def _note_link_loss(stage: VaultLinkStage, result: VaultLinkPass) -> None:
    """Log real partial data loss, in enum values and integers alone.

    Fragments dropped to noise carry no link at all, and Creek publishes the
    count rather than folding it away precisely so a caller cannot read a lossy
    pass as a clean one. The record is content-free by construction: a stage
    name from a closed set of our own, and two numbers.
    """
    if result.oversized_discarded:
        _LOGGER.warning(
            "creek vault link stage dropped fragments to noise",
            extra={
                "stage": stage.value,
                "fragments_lost": result.oversized_discarded,
                "fragments_seen": result.fragment_count,
            },
        )


def _counts_from_result(
    result: VaultClassificationPass | VaultLinkPass,
) -> tuple[VaultPipelineOutcome, _StageCounts]:
    """Read either published counts-only result into the persisted vocabulary."""
    if isinstance(result, VaultClassificationPass):
        return _classification_outcome(result), _StageCounts(
            seen=result.total,
            touched=result.classified,
        )
    _note_link_loss(result.stage, result)
    return VaultPipelineOutcome.COMPLETED, _StageCounts(
        seen=result.fragment_count,
        touched=result.link_count,
        lost=result.oversized_discarded,
    )


async def _perform(
    client: CreekVaultPipelineClient, stage: VaultPipelineStage
) -> tuple[VaultPipelineOutcome, _StageCounts] | VaultPipelineJob:
    """Run one rung against the vault and read its answer into the row vocabulary.

    The only place either pipeline call is made. It reports rather than records:
    persisting is :func:`_run_stage`'s job, because the row has to exist before
    this runs and be amended after it.
    """
    if stage is VaultPipelineStage.CLASSIFY:
        classification_result = await client.classify_corpus()
        return (
            classification_result
            if isinstance(classification_result, VaultPipelineJob)
            else _counts_from_result(classification_result)
        )
    wire_stage = LINK_STAGE_BY_PIPELINE_STAGE[stage]
    link_result = await client.link_corpus(wire_stage)
    return (
        link_result
        if isinstance(link_result, VaultPipelineJob)
        else _counts_from_result(link_result)
    )


async def _await_job(
    client: CreekVaultPipelineClient,
    job: VaultPipelineJob,
) -> tuple[VaultPipelineOutcome, _StageCounts]:
    """Poll one accepted pass to a terminal result under the caller's clock."""
    delay = _JOB_POLL_INITIAL_SECONDS
    current = job
    while current.state is not VaultPipelineJobState.FAILED:
        await asyncio.sleep(delay)
        try:
            result = await client.pipeline_job(current)
        except (
            CreekCapabilityUnsupportedError,
            CreekVaultAuthError,
            CreekVaultContractError,
            CreekVaultPayloadError,
        ):
            return VaultPipelineOutcome.FAILED, _NOTHING_REACHED
        if not isinstance(result, VaultPipelineJob):
            return _counts_from_result(result)
        current = result
        delay = min(delay * 2, _JOB_POLL_MAX_SECONDS)
    return VaultPipelineOutcome.FAILED, _NOTHING_REACHED


@dataclass(frozen=True)
class _RunResult:
    """The persisted identity and current outcome of one logical stage run."""

    run_id: int
    outcome: VaultPipelineOutcome


def _finish_run(
    session: AsyncSession,
    run: VaultPipelineRun,
    outcome: VaultPipelineOutcome,
    counts: _StageCounts,
) -> None:
    """Stage the terminal, counts-only result on an existing logical run."""
    run.outcome = outcome.value
    run.fragments_seen = counts.seen
    run.fragments_touched = counts.touched
    run.fragments_lost = counts.lost
    session.add(run)


async def _perform_within_budget(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    run: VaultPipelineRun,
    stage: VaultPipelineStage,
    budget: float,
) -> tuple[VaultPipelineOutcome, _StageCounts]:
    """Perform and, when admitted, durably follow one stage under its clock."""
    async with asyncio.timeout(budget):
        result = await _perform(client, stage)
        if isinstance(result, VaultPipelineJob):
            run.job_id = str(result.job_id)
            session.add(run)
            await session.commit()
            return await _await_job(client, result)
        return result


async def _run_stage(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    context: _StageContext,
    budget: float,
) -> _RunResult:
    """Run one rung, committing its stamp before the wire and its outcome after.

    **The commit before the call is load-bearing twice over, and neither reason
    is about durability.**

    It releases the pooled database connection. A Session autobegins on its
    first ``execute`` and holds that transaction -- and therefore a checked-out
    connection -- across every subsequent ``await``. Dialling a vault with one
    open would hold a connection from a pool of fifteen for the length of a
    network climb, and the sixteenth request to *any* database-backed endpoint
    would block on checkout and fail. It is the same invariant
    ``_record_vault_outcome`` commits before its own ingest to protect, and this
    runs immediately after that mitigation.

    It also throttles arrivals. The interval is read from these rows, so a stamp
    that stays invisible until the pass ends means every request arriving during
    a pass reads an empty log, finds the stage due, and dials the vault as well.
    Committing the attempt first is what makes the debounce hold under
    concurrency rather than only in a quiet test.

    ``budget`` bounds the foreground wait in elapsed time. Accepted long work is
    not cancelled with it: the job id is already committed, so a continuation
    polls the same pass instead of guessing whether it landed or submitting a
    concurrent duplicate.
    """
    run = _record(session, context, VaultPipelineOutcome.ATTEMPTED)
    await session.commit()
    if run.id is None:
        raise RuntimeError("persisted vault pipeline run has no id")
    try:
        outcome, counts = await _perform_within_budget(session, client, run, context.stage, budget)
    except (
        CreekCapabilityUnsupportedError,
        CreekVaultAuthError,
        CreekVaultContractError,
        CreekVaultPayloadError,
    ):
        _LOGGER.info(
            "creek vault pipeline stage was refused",
            extra={"stage": context.stage.value},
        )
        _finish_run(session, run, VaultPipelineOutcome.FAILED, _NOTHING_REACHED)
        await session.commit()
        return _RunResult(run_id=run.id, outcome=VaultPipelineOutcome.FAILED)
    except (CreekVaultError, TimeoutError):
        _LOGGER.info(
            "creek vault pipeline stage did not land",
            extra={"stage": context.stage.value},
        )
        return _RunResult(run_id=run.id, outcome=VaultPipelineOutcome.ATTEMPTED)
    if outcome is VaultPipelineOutcome.FAILED:
        return _RunResult(run_id=run.id, outcome=VaultPipelineOutcome.ATTEMPTED)
    _finish_run(session, run, outcome, counts)
    await session.commit()
    return _RunResult(run_id=run.id, outcome=outcome)


def _job_from_run(run: VaultPipelineRun, stage: VaultPipelineStage) -> VaultPipelineJob | None:
    """Rebuild a validated opaque handle from one persisted in-flight row."""
    if run.job_id is None:
        return None
    try:
        job_id = UUID(run.job_id)
    except ValueError:
        return None
    return VaultPipelineJob(
        job_id=job_id,
        stage=stage,
        state=VaultPipelineJobState.QUEUED,
    )


def _failed_job(job: VaultPipelineJob) -> VaultPipelineJob:
    """Return the content-free terminal handle used for definitive status faults."""
    return VaultPipelineJob(
        job_id=job.job_id,
        stage=job.stage,
        state=VaultPipelineJobState.FAILED,
    )


async def _poll_job_once(
    client: CreekVaultPipelineClient,
    job: VaultPipelineJob,
) -> VaultClassificationPass | VaultLinkPass | VaultPipelineJob | None:
    """Make one status read; ``None`` means the vault is transiently absent."""
    try:
        return await client.pipeline_job(job)
    except (
        CreekCapabilityUnsupportedError,
        CreekVaultAuthError,
        CreekVaultContractError,
        CreekVaultPayloadError,
    ):
        return _failed_job(job)
    except CreekVaultUnavailableError:
        await client.handshake()
        return None


def _pending_job(
    result: VaultClassificationPass | VaultLinkPass | VaultPipelineJob,
) -> VaultPipelineJob | None:
    """Return the next pending handle, or ``None`` for a terminal answer."""
    if isinstance(result, VaultPipelineJob) and (result.state is not VaultPipelineJobState.FAILED):
        return result
    return None


async def _poll_statuses(
    client: CreekVaultPipelineClient,
    job: VaultPipelineJob,
) -> VaultClassificationPass | VaultLinkPass | VaultPipelineJob:
    """Poll status answers; the caller supplies the elapsed-time ceiling."""
    delay = _JOB_POLL_INITIAL_SECONDS
    current = job
    while True:
        result = await _poll_job_once(client, current)
        if result is not None:
            pending = _pending_job(result)
            if pending is None:
                return result
            current = pending
        await asyncio.sleep(delay)
        delay = min(delay * 2, _JOB_POLL_MAX_SECONDS)


async def _poll_until_terminal(
    client: CreekVaultPipelineClient,
    job: VaultPipelineJob,
) -> VaultClassificationPass | VaultLinkPass | VaultPipelineJob | None:
    """Poll until terminal or the reconciliation ceiling; ``None`` means ambiguous."""
    try:
        async with asyncio.timeout(_JOB_RECONCILIATION_BUDGET_SECONDS):
            return await _poll_statuses(client, job)
    except TimeoutError:
        _LOGGER.warning(
            "creek vault pipeline job stayed non-terminal through its polling ceiling",
            extra={"stage": job.stage.value, "job_id": str(job.job_id)},
        )
        return None


async def _retry_once(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    run: VaultPipelineRun,
    stage: VaultPipelineStage,
) -> tuple[VaultPipelineOutcome, _StageCounts] | VaultPipelineJob | None:
    """Back off, persist the attempt number, and try one fresh admission."""
    delay = min(
        _RETRY_INITIAL_SECONDS * (2 ** (run.attempt_count - 1)),
        _RETRY_MAX_SECONDS,
    )
    await asyncio.sleep(delay)
    run.attempt_count += 1
    run.job_id = None
    session.add(run)
    await session.commit()
    try:
        if not client.supports(CreekCapability.PIPELINE):
            await client.handshake()
        return await _perform(client, stage)
    except (CreekVaultUnavailableError, TimeoutError):
        return None


async def _land_result(
    session: AsyncSession,
    run: VaultPipelineRun,
    result: VaultClassificationPass | VaultLinkPass | tuple[VaultPipelineOutcome, _StageCounts],
) -> VaultPipelineOutcome:
    """Persist a synchronous or job-produced terminal result and its real counts."""
    outcome, counts = result if isinstance(result, tuple) else _counts_from_result(result)
    _finish_run(session, run, outcome, counts)
    await session.commit()
    return outcome


@dataclass(frozen=True)
class _Reconciliation:
    """The mutable facts carried between bounded reconciliation attempts."""

    job: VaultPipelineJob | None
    ambiguous: bool


async def _clear_job(session: AsyncSession, run: VaultPipelineRun) -> None:
    """Forget a terminal or lost handle before considering fresh admission."""
    run.job_id = None
    session.add(run)
    await session.commit()


async def _finish_exhausted_run(
    session: AsyncSession,
    run: VaultPipelineRun,
    *,
    ambiguous: bool,
) -> VaultPipelineOutcome:
    """Close a retry-exhausted row without inventing certainty."""
    outcome = VaultPipelineOutcome.AMBIGUOUS if ambiguous else VaultPipelineOutcome.FAILED
    _finish_run(session, run, outcome, _NOTHING_REACHED)
    await session.commit()
    return outcome


async def _retry_for_reconciliation(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    run: VaultPipelineRun,
    stage: VaultPipelineStage,
) -> tuple[VaultPipelineOutcome, _StageCounts] | VaultPipelineJob | VaultPipelineOutcome | None:
    """Try fresh admission, turning a definitive refusal into a final outcome."""
    try:
        return await _retry_once(session, client, run, stage)
    except (
        CreekCapabilityUnsupportedError,
        CreekVaultAuthError,
        CreekVaultContractError,
        CreekVaultPayloadError,
    ):
        _finish_run(session, run, VaultPipelineOutcome.FAILED, _NOTHING_REACHED)
        await session.commit()
        return VaultPipelineOutcome.FAILED


async def _continue_after_retry(
    session: AsyncSession,
    run: VaultPipelineRun,
    retried: tuple[VaultPipelineOutcome, _StageCounts] | VaultPipelineJob | None,
    state: _Reconciliation,
) -> VaultPipelineOutcome | _Reconciliation:
    """Persist a fresh handle or terminal result and advance reconciliation."""
    if retried is None:
        return _Reconciliation(job=None, ambiguous=True)
    if isinstance(retried, VaultPipelineJob):
        run.job_id = str(retried.job_id)
        session.add(run)
        await session.commit()
        return _Reconciliation(job=retried, ambiguous=state.ambiguous)
    return await _land_result(session, run, retried)


async def _reconcile_existing_job(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    run: VaultPipelineRun,
    job: VaultPipelineJob,
) -> VaultPipelineOutcome | None:
    """Land, retire, or bound one persisted job; ``None`` permits readmission."""
    polled = await _poll_until_terminal(client, job)
    if polled is None:
        return await _finish_exhausted_run(session, run, ambiguous=True)
    if not isinstance(polled, VaultPipelineJob):
        return await _land_result(session, run, polled)
    await _clear_job(session, run)
    return None


async def _reconciliation_step(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    run: VaultPipelineRun,
    stage: VaultPipelineStage,
    state: _Reconciliation,
) -> VaultPipelineOutcome | _Reconciliation:
    """Advance one poll-or-admit transition of a logical stage run."""
    if state.job is not None:
        outcome = await _reconcile_existing_job(session, client, run, state.job)
        if outcome is not None:
            return outcome
    if run.attempt_count >= _MAX_STAGE_ATTEMPTS:
        return await _finish_exhausted_run(session, run, ambiguous=state.ambiguous)
    retried = await _retry_for_reconciliation(session, client, run, stage)
    if isinstance(retried, VaultPipelineOutcome):
        return retried
    return await _continue_after_retry(session, run, retried, state)


async def _reconcile_run(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    run_id: int,
    stage: VaultPipelineStage,
) -> VaultPipelineOutcome:
    """Poll or retry one in-flight row until counts land or retries exhaust."""
    run = await session.get(VaultPipelineRun, run_id)
    if run is None:
        return VaultPipelineOutcome.AMBIGUOUS
    await session.commit()
    job = _job_from_run(run, stage)
    state: VaultPipelineOutcome | _Reconciliation = _Reconciliation(
        job=job,
        ambiguous=job is None,
    )
    while isinstance(state, _Reconciliation):
        state = await _reconciliation_step(session, client, run, stage, state)
    return state


def _due_stages(
    permitted: frozenset[VaultPipelineStage], stamps: Mapping[str, datetime], now: datetime
) -> tuple[VaultPipelineStage, ...]:
    """The rungs this trigger may pay for whose own windows have reopened.

    Walks :data:`LADDER` rather than the permitted set, so the answer comes back
    in the order Creek documents the passes in rather than in whatever order a
    set happens to iterate.
    """
    return tuple(stage for stage in LADDER if stage in permitted and _due(stage, stamps, now))


def _stages_to_run(
    trigger: VaultPipelineTrigger,
    stamps: Mapping[str, datetime],
    now: datetime,
    *,
    classification_landed: bool,
) -> tuple[VaultPipelineStage, ...]:
    """Which rungs this pass may climb, in ladder order.

    Three filters, and the third is what makes the ordering safe to rely on: the
    trigger's depth, each stage's own window, and the requirement that a
    classification pass has landed at some point -- in this run or an earlier
    one. Without the third, a vault whose classification window is still closed
    would have its clustering stages run over labels that were never written.
    """
    due = _due_stages(_STAGES_BY_TRIGGER[trigger], stamps, now)
    if classification_landed or VaultPipelineStage.CLASSIFY in due:
        return due
    return ()


async def _promote_active_classification(
    session: AsyncSession,
    user_id: int,
    trigger: VaultPipelineTrigger,
) -> bool:
    """Attach a deeper trigger to the classification already in flight.

    A document can arrive while a journal-triggered semantic pass is still
    running. The active-row uniqueness rule correctly prevents a second pass,
    but treating that as a plain debounce would lose the import's deeper ladder
    forever. Persisting the stronger trigger lets whichever request or restart
    finishes the shared classification continue through every stage the import
    earned.

    The row is selected again under a write lock instead of reusing the earlier
    scheduler read. If classification became terminal between those reads, the
    caller re-evaluates once and schedules the newly eligible successors.
    """
    if trigger is not VaultPipelineTrigger.DOCUMENT_IMPORT:
        return False
    result = await session.execute(
        select(VaultPipelineRun)
        .where(col(VaultPipelineRun.user_id) == user_id)
        .where(col(VaultPipelineRun.stage) == VaultPipelineStage.CLASSIFY.value)
        .where(col(VaultPipelineRun.outcome) == VaultPipelineOutcome.ATTEMPTED.value)
        .with_for_update()
    )
    run = result.scalars().one_or_none()
    if run is None:
        await session.commit()
        return False
    run.trigger = trigger.value
    session.add(run)
    await session.commit()
    return True


async def _scope_after_classification(
    session: AsyncSession,
    *,
    user_id: int,
    run_id: int,
    fallback: VaultPipelineTrigger,
) -> tuple[VaultPipelineTrigger, tuple[VaultPipelineStage, ...]]:
    """Read the latest trigger and due successors after classification lands.

    The trigger may have been promoted by a concurrent document import while
    this session waited on Creek, so it must be read from the database rather
    than from the request-owned context. Re-reading stage stamps at the same
    boundary also prevents a successor another worker just completed from being
    run twice.
    """
    trigger_result = await session.execute(
        select(col(VaultPipelineRun.trigger)).where(col(VaultPipelineRun.id) == run_id)
    )
    raw_trigger = trigger_result.scalar_one_or_none()
    trigger = fallback if raw_trigger is None else VaultPipelineTrigger(raw_trigger)
    stamps = _stamps_by_stage(await _latest_attempt_per_stage(session, user_id))
    await session.commit()
    successors = tuple(
        stage
        for stage in _due_stages(_STAGES_BY_TRIGGER[trigger], stamps, datetime.now(UTC))
        if stage is not VaultPipelineStage.CLASSIFY
    )
    return trigger, successors


def _session_factory_for(session: AsyncSession) -> async_sessionmaker[AsyncSession]:
    """Build background sessions against the same engine as the trigger session."""
    if session.bind is None:
        raise RuntimeError("vault pipeline session is not bound")
    return async_sessionmaker(session.bind, class_=AsyncSession, expire_on_commit=False)


@dataclass(frozen=True)
class _Continuation:
    """Everything an off-request continuation needs to finish its ladder."""

    factory: async_sessionmaker[AsyncSession]
    client: CreekVaultPipelineClient
    user_id: int
    trigger: VaultPipelineTrigger
    pending: _RunResult
    stage: VaultPipelineStage
    remaining: tuple[VaultPipelineStage, ...]


@dataclass(frozen=True)
class _ClimbContext:
    """The request-owned bounds and identity for one foreground climb."""

    user_id: int
    trigger: VaultPipelineTrigger
    stages: tuple[VaultPipelineStage, ...]
    deadline: float


def _classification_allows_progress(
    stage: VaultPipelineStage,
    outcome: VaultPipelineOutcome,
) -> bool:
    """Whether this outcome leaves classification's downstream labels usable."""
    return stage is not VaultPipelineStage.CLASSIFY or outcome in {
        VaultPipelineOutcome.COMPLETED,
        VaultPipelineOutcome.INCOMPLETE,
    }


async def _continuation_scope(
    session: AsyncSession,
    continuation: _Continuation,
) -> tuple[VaultPipelineTrigger, tuple[VaultPipelineStage, ...]]:
    """Resolve the trigger and successors, including a concurrent promotion."""
    if continuation.stage is not VaultPipelineStage.CLASSIFY:
        return continuation.trigger, continuation.remaining
    return await _scope_after_classification(
        session,
        user_id=continuation.user_id,
        run_id=continuation.pending.run_id,
        fallback=continuation.trigger,
    )


async def _continue_stage(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    context: _StageContext,
) -> bool:
    """Run and reconcile one background rung; report whether to keep climbing."""
    started = await _run_stage(
        session,
        client,
        context,
        _BACKGROUND_STAGE_BUDGET_SECONDS,
    )
    outcome = started.outcome
    if outcome is VaultPipelineOutcome.ATTEMPTED:
        outcome = await _reconcile_run(session, client, started.run_id, context.stage)
    return _classification_allows_progress(context.stage, outcome)


async def _continue_ladder(continuation: _Continuation) -> None:
    """Finish an in-flight rung and every permitted successor off-request."""
    async with continuation.factory() as session:
        outcome = await _reconcile_run(
            session,
            continuation.client,
            continuation.pending.run_id,
            continuation.stage,
        )
        if not _classification_allows_progress(continuation.stage, outcome):
            return
        trigger, remaining = await _continuation_scope(session, continuation)
        for next_stage in remaining:
            should_continue = await _continue_stage(
                session,
                continuation.client,
                _StageContext(
                    continuation.user_id,
                    next_stage,
                    trigger,
                ),
            )
            if not should_continue:
                return


def _forget_background_task(key: _TaskKey, task: asyncio.Task[None]) -> None:
    """Drop a finished task and observe its exception without leaking content."""
    if _BACKGROUND_TASKS.get(key) is task:
        _BACKGROUND_TASKS.pop(key, None)
    if task.cancelled():
        return
    if task.exception() is not None:
        _LOGGER.warning(
            "creek vault pipeline background continuation failed",
            extra={"stage": key[1].value},
        )


def _schedule_continuation(continuation: _Continuation) -> None:
    """Schedule at most one continuation per user and active stage in-process."""
    key = (continuation.user_id, continuation.stage)
    active = _BACKGROUND_TASKS.get(key)
    if active is not None and not active.done():
        return
    task = asyncio.create_task(_continue_ladder(continuation))
    _BACKGROUND_TASKS[key] = task
    task.add_done_callback(lambda completed: _forget_background_task(key, completed))


async def _resume_run(
    factory: async_sessionmaker[AsyncSession],
    resolve_client: VaultClientResolver,
    session: AsyncSession,
    run: VaultPipelineRun,
) -> None:
    """Schedule one valid persisted run using its original trigger scope."""
    if run.id is None or run.trigger is None:
        return
    stage = VaultPipelineStage(run.stage)
    trigger = VaultPipelineTrigger(run.trigger)
    client = await resolve_client(session, run.user_id)
    await client.handshake()
    permitted = _STAGES_BY_TRIGGER[trigger]
    remaining = tuple(
        candidate for candidate in LADDER[LADDER.index(stage) + 1 :] if candidate in permitted
    )
    _schedule_continuation(
        _Continuation(
            factory=factory,
            client=client,
            user_id=run.user_id,
            trigger=trigger,
            pending=_RunResult(
                run_id=run.id,
                outcome=VaultPipelineOutcome.ATTEMPTED,
            ),
            stage=stage,
            remaining=remaining,
        )
    )


async def resume_vault_pipeline_runs(
    factory: async_sessionmaker[AsyncSession],
    resolve_client: VaultClientResolver,
) -> None:
    """Resume every persisted in-flight run after an Adepthood restart."""
    async with factory() as session:
        result = await session.execute(
            select(VaultPipelineRun)
            .where(col(VaultPipelineRun.outcome) == VaultPipelineOutcome.ATTEMPTED.value)
            .where(col(VaultPipelineRun.trigger).is_not(None))
            .order_by(col(VaultPipelineRun.id))
        )
        runs = list(result.scalars().all())
        await session.commit()
        for run in runs:
            await _resume_run(factory, resolve_client, session, run)


async def close_vault_pipeline_tasks() -> None:
    """Cancel in-process continuations; their attempted rows remain restartable."""
    tasks = tuple(_BACKGROUND_TASKS.values())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    _BACKGROUND_TASKS.clear()


async def wait_for_vault_pipeline_tasks() -> None:
    """Wait for current continuations; used by deterministic lifecycle checks."""
    tasks = tuple(_BACKGROUND_TASKS.values())
    if tasks:
        await asyncio.gather(*tasks)


@dataclass(frozen=True)
class _ClimbProgress:
    """The stage list and cursor after each foreground rung."""

    trigger: VaultPipelineTrigger
    stages: tuple[VaultPipelineStage, ...]
    index: int = 0


async def _climb_once(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    context: _ClimbContext,
    factory: async_sessionmaker[AsyncSession],
    progress: _ClimbProgress,
) -> _ClimbProgress | None:
    """Run one foreground rung, scheduling durable continuation when needed."""
    stage = progress.stages[progress.index]
    remaining_budget = context.deadline - time.monotonic()
    if remaining_budget < _LEAST_WORTH_STARTING_SECONDS:
        return None
    result = await _run_stage(
        session,
        client,
        _StageContext(context.user_id, stage, progress.trigger),
        remaining_budget,
    )
    if result.outcome is VaultPipelineOutcome.ATTEMPTED:
        _schedule_continuation(
            _Continuation(
                factory=factory,
                client=client,
                user_id=context.user_id,
                trigger=progress.trigger,
                pending=result,
                stage=stage,
                remaining=progress.stages[progress.index + 1 :],
            )
        )
        return None
    if not _classification_allows_progress(stage, result.outcome):
        return None
    if stage is not VaultPipelineStage.CLASSIFY:
        return _ClimbProgress(progress.trigger, progress.stages, progress.index + 1)
    trigger, successors = await _scope_after_classification(
        session,
        user_id=context.user_id,
        run_id=result.run_id,
        fallback=progress.trigger,
    )
    return _ClimbProgress(
        trigger,
        (*progress.stages[: progress.index + 1], *successors),
        progress.index + 1,
    )


async def _climb(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    context: _ClimbContext,
) -> None:
    """Climb the ladder in order, within one wall clock.

    **A failed classification stops the pass; a failed linker stage does not.**
    Classification is the one genuine prerequisite -- the thread stage reads the
    labels it writes -- while the four linker stages are independent of each
    other and of each other's failures.

    Stopping at any failure looks more conservative and is in fact a trap. The
    cheap rungs carry a fifteen-minute interval and the clustering rungs six
    hours, so a linker stage that fails on essentially every pass is due again
    long before the stages behind it are: a ladder that halted there would retry
    it first, fail again, and halt again, on every pass, and the clustering
    stages would never run once. The wall clock is what makes continuing safe --
    the cost of trying the next rung is bounded whether or not it also fails.

    ``deadline`` is a monotonic instant. Each stage runs under whatever is left
    of it, so the pass is bounded in elapsed time rather than merely gated at its
    start, and a stage is not begun at all with less than
    :data:`_LEAST_WORTH_STARTING_SECONDS` remaining.
    """
    factory = _session_factory_for(session)
    progress: _ClimbProgress | None = _ClimbProgress(context.trigger, context.stages)
    while progress is not None and progress.index < len(progress.stages):
        progress = await _climb_once(session, client, context, factory, progress)


async def _evaluate_pipeline_stages(
    session: AsyncSession,
    user_id: int,
    trigger: VaultPipelineTrigger,
) -> tuple[tuple[VaultPipelineStage, ...], bool]:
    """Evaluate the independent stage clocks and classification prerequisite."""
    stamps = _stamps_by_stage(await _latest_attempt_per_stage(session, user_id))
    landed = await _classification_has_landed(session, user_id)
    return (
        _stages_to_run(
            trigger,
            stamps,
            datetime.now(UTC),
            classification_landed=landed,
        ),
        landed,
    )


async def _settle_pipeline_recheck(
    session: AsyncSession,
    user_id: int,
    trigger: VaultPipelineTrigger,
    stages: tuple[VaultPipelineStage, ...],
    *,
    landed: bool,
) -> tuple[VaultPipelineStage, ...]:
    """Finish the race recheck, preserving a newly active shared pass's scope."""
    if stages:
        await session.commit()
        return stages
    if landed:
        await session.commit()
    else:
        await _promote_active_classification(session, user_id, trigger)
    return ()


async def _pipeline_stages(
    session: AsyncSession,
    user_id: int,
    trigger: VaultPipelineTrigger,
) -> tuple[VaultPipelineStage, ...]:
    """Resolve due stages, promoting a shared classification at most once."""
    stages, landed = await _evaluate_pipeline_stages(session, user_id, trigger)
    if stages:
        await session.commit()
        return stages
    if trigger is not VaultPipelineTrigger.DOCUMENT_IMPORT or landed:
        await session.commit()
        return ()
    promoted = await _promote_active_classification(session, user_id, trigger)
    if promoted:
        return ()
    stages, landed = await _evaluate_pipeline_stages(session, user_id, trigger)
    return await _settle_pipeline_recheck(
        session,
        user_id,
        trigger,
        stages,
        landed=landed,
    )


async def drive_vault_pipeline(
    session: AsyncSession,
    client: CreekVaultClient,
    *,
    user_id: int,
    trigger: VaultPipelineTrigger,
) -> None:
    """Drive as much of the ontologization ladder as this occasion has earned.

    Best-effort and silent in both directions. It runs after the caller's write
    has already been committed, so it may never raise; and it changes nothing a
    user can see — no screen, no prompt, no status code, no message — because it
    is maintenance on the corpus somebody already chose to keep in a vault
    rather than a new depth being offered to them.

    The capability gate is read **first**, and that ordering is the whole cost
    story for everyone without a vault. It is a pure read of the handshake both
    trigger sites have already performed, so an account with no vault, or with
    one that does not advertise the pipeline, spends no network call, no database
    read and no row here — and the local-fallback client answers it without
    knowing this module exists.
    """
    if not client.supports(CreekCapability.PIPELINE):
        return
    # ``PIPELINE`` is the wire-level discriminator: every production adapter
    # advertising it implements the narrower polling protocol.
    pipeline_client = cast("CreekVaultPipelineClient", client)
    try:
        stages = await _pipeline_stages(session, user_id, trigger)
        if not stages:
            return
        await _climb(
            session,
            pipeline_client,
            _ClimbContext(
                user_id=user_id,
                trigger=trigger,
                stages=stages,
                deadline=time.monotonic() + _run_budget(trigger),
            ),
        )
    except SQLAlchemyError:
        _LOGGER.warning("creek vault pipeline could not record its pass")
        await session.rollback()
