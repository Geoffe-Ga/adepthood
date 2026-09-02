"""Driving a connected vault's corpus from inert to ontologized.

Adepthood hands a vault two kinds of writing — journal entries as they are
saved, documents as they are imported — and a vault files both as fragments.
Filing is not ontologizing. A fragment nobody classified carries no APTITUDE
frequency, no Archetypal Wavelength phase and no links, so the vault-backed
reflection, the wheel read and the invitation engine all run over a corpus that
looks empty while being full. Creek's remedy is a pair of batch routes; this
module is the thing that calls them, and the decisions about *when* are the
whole content of the file.

**The ladder.** Classification first, then the three linker stages in the order
Creek documents them: temporal, eddies, threads. The order is not stylistic.
Classification writes the labels the thread stage reads, and temporal is the one
stage that needs no vectors, so running it early is what makes a freshly-seeded
corpus navigable before the expensive stages have converged.

**Why a rung is skipped is a stamp, not a flag.** Every stage carries its own
minimum interval and its own row in ``vaultpipelinerun``, and a stage runs only
when its last attempt is older than that interval. Per stage rather than per
run, because the cheap half and the expensive half want intervals two orders of
magnitude apart, and a single whole-run debounce makes them interfere: a user
who journals every ten minutes would keep resetting one window and never reach
the stages that only a document import asks for.

That same per-stage stamp is what keeps a failing rung from starving the ones
below it. A failure records an attempt, so the failing stage's window closes
behind it and the next pass steps over it to the stage it was blocking.

**Nothing here retries, in the request or out of it.** Creek's embedding work
lands in a local cache even when the call it was doing it for ran out of time,
and both passes are idempotent and resumable, so the next window converges on
its own. A retry would spend a second request on work the first one already did,
and — because there is no scheduler in this deployment and "later" is therefore
not a thing that can be promised — it would spend it inside somebody's save.

**What one request may cost is bounded twice.** A journal save runs the cheap
half only, under the adapter's standing deadline, so the write path acquires no
new latency class at all. A document import may run the whole ladder, and is
bounded by a wall clock in the ``corpus_backfill`` idiom: a stage is not started
unless enough of the budget is left for it to be worth starting. The honest worst
case is that budget plus one stage's own deadline, because a stage already in
flight is not interrupted — the work it is doing is landing in a cache that makes
the next pass shorter, so cutting it off would throw away exactly the progress
that makes this design converge.

Every failure is swallowed. This runs after somebody's entry is already
committed and after their document is already stored, so nothing here may cost
them either; :func:`drive_vault_pipeline` never raises.
"""

from __future__ import annotations

import asyncio
import enum
import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.creek_vault import (
    CreekCapability,
    CreekVaultClient,
    CreekVaultError,
    VaultClassificationPass,
    VaultLinkPass,
    VaultLinkStage,
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
    VaultPipelineStage.EDDIES,
    VaultPipelineStage.THREADS,
)

#: How each rung of the ladder is spelled on Creek's linker route. A table rather
#: than a branch: classification has no entry, so "classification is not a link
#: stage" is a fact about this mapping rather than a condition somebody could
#: invert, and a stage added to either vocabulary without the other notices here.
LINK_STAGE_BY_PIPELINE_STAGE: Mapping[VaultPipelineStage, VaultLinkStage] = {
    VaultPipelineStage.TEMPORAL: VaultLinkStage.TEMPORAL,
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
    VaultPipelineStage.EDDIES: _CLUSTERING_STAGE_INTERVAL,
    VaultPipelineStage.THREADS: _CLUSTERING_STAGE_INTERVAL,
}

# How long a whole deep pass may go on starting new stages, and the least time
# worth starting one in. Both are the ``corpus_backfill`` idiom: a wall clock
# read from a monotonic source, and a "don't start what won't finish" floor, so a
# pass stops with a remainder rather than overrunning — and the remainder is
# picked up by the next import, because every rung's progress is persisted.
#
# Sixty seconds is a judgement rather than a derivation, and it is a judgement
# about the *import* route rather than about Creek: that route already accepts a
# file, already answers 202, and is the one place in this app where a person has
# asked for something to be done with a document rather than merely saved. It is
# not enough for a cold vault to finish clustering a large corpus in, and it is
# not meant to be. The vector cache is filled by whatever a truncated stage
# managed, so successive imports get progressively further, and the alternative —
# holding a request for the minutes a cold pass can genuinely take — is not
# something this deployment can offer, because it has no background worker to
# offer it from.
_DEEP_RUN_BUDGET_SECONDS = 60.0
_LEAST_WORTH_STARTING_SECONDS = 5.0

# The same clock for the write path, and much shorter, because the two occasions
# are not comparable. A document import is deliberate, rare, and already a file
# upload; a journal save is the most frequent write in the app and somebody is
# waiting on it with something they just wrote. Ten seconds is what the two cheap
# stages need on any healthy vault -- neither loads a model or touches a vector
# -- and a vault too slow to classify inside it simply converges on the next
# window, because the pass is resumable and short-circuits on what it stamped.
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


def _record(
    session: AsyncSession,
    *,
    user_id: int,
    stage: VaultPipelineStage,
    outcome: VaultPipelineOutcome,
    counts: _StageCounts = _NOTHING_REACHED,
) -> VaultPipelineRun:
    """Stage one attempt's row and hand it back. The caller owns the commit."""
    run = VaultPipelineRun(
        user_id=user_id,
        stage=stage.value,
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


async def _perform(
    client: CreekVaultClient, stage: VaultPipelineStage
) -> tuple[VaultPipelineOutcome, _StageCounts]:
    """Run one rung against the vault and read its answer into the row vocabulary.

    The only place either pipeline call is made. It reports rather than records:
    persisting is :func:`_run_stage`'s job, because the row has to exist before
    this runs and be amended after it.
    """
    if stage is VaultPipelineStage.CLASSIFY:
        classification = await client.classify_corpus()
        return _classification_outcome(classification), _StageCounts(
            seen=classification.total, touched=classification.classified
        )
    wire_stage = LINK_STAGE_BY_PIPELINE_STAGE[stage]
    link = await client.link_corpus(wire_stage)
    _note_link_loss(wire_stage, link)
    return VaultPipelineOutcome.COMPLETED, _StageCounts(
        seen=link.fragment_count, touched=link.link_count, lost=link.oversized_discarded
    )


async def _run_stage(
    session: AsyncSession,
    client: CreekVaultClient,
    user_id: int,
    stage: VaultPipelineStage,
    budget: float,
) -> VaultPipelineOutcome:
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

    ``budget`` bounds the call in elapsed time. The adapter's own deadline
    already bounds the socket, but a phase budget restarts on every read and is
    therefore a floor rather than a ceiling; this is the ceiling. Cancelling a
    slow stage costs nothing that matters -- Creek's embedding work lands in its
    own cache whether or not this process is still waiting for the answer.
    """
    run = _record(session, user_id=user_id, stage=stage, outcome=VaultPipelineOutcome.ATTEMPTED)
    await session.commit()
    try:
        async with asyncio.timeout(budget):
            outcome, counts = await _perform(client, stage)
    except (CreekVaultError, TimeoutError):
        _LOGGER.info("creek vault pipeline stage did not land", extra={"stage": stage.value})
        outcome, counts = VaultPipelineOutcome.FAILED, _NOTHING_REACHED
    run.outcome = outcome.value
    run.fragments_seen = counts.seen
    run.fragments_touched = counts.touched
    run.fragments_lost = counts.lost
    session.add(run)
    await session.commit()
    return outcome


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


async def _climb(
    session: AsyncSession,
    client: CreekVaultClient,
    user_id: int,
    stages: tuple[VaultPipelineStage, ...],
    deadline: float,
) -> None:
    """Climb the ladder in order, within one wall clock.

    **A failed classification stops the pass; a failed linker stage does not.**
    Classification is the one genuine prerequisite -- the thread stage reads the
    labels it writes -- while the three linker stages are independent of each
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
    for stage in stages:
        remaining = deadline - time.monotonic()
        if remaining < _LEAST_WORTH_STARTING_SECONDS:
            return
        outcome = await _run_stage(session, client, user_id, stage, remaining)
        if outcome is VaultPipelineOutcome.FAILED and stage is VaultPipelineStage.CLASSIFY:
            return


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
    try:
        stamps = _stamps_by_stage(await _latest_attempt_per_stage(session, user_id))
        landed = await _classification_has_landed(session, user_id)
        stages = _stages_to_run(trigger, stamps, datetime.now(UTC), classification_landed=landed)
        # Both reads are done, and a Session holds the connection it autobegan on
        # the first of them until something ends that transaction. Ending it here
        # is what keeps the climb below off the pool entirely.
        await session.commit()
        if not stages:
            return
        await _climb(
            session,
            client,
            user_id,
            stages,
            time.monotonic() + _run_budget(trigger),
        )
    except SQLAlchemyError:
        _LOGGER.warning("creek vault pipeline could not record its pass")
        await session.rollback()
