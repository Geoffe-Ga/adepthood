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

import enum
import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

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


def _stamps_by_stage(rows: list[VaultPipelineRun]) -> dict[str, datetime]:
    """The newest attempt at each stage, keyed by stage.

    Newest-first input, so the first row seen for a stage is its latest attempt
    and later ones are ignored rather than compared — one pass over the rows
    instead of a max per stage.
    """
    stamps: dict[str, datetime] = {}
    for row in rows:
        stamps.setdefault(row.stage, ensure_aware(row.ran_at))
    return stamps


async def _recent_attempts(session: AsyncSession, user_id: int) -> list[VaultPipelineRun]:
    """The account's most recent attempts, newest first.

    Bounded by the ladder's own length rather than by a date, because the answer
    wanted is "the latest row per stage" and there are four stages: a fixed
    ceiling of one row per rung, plus enough slack for the rows a single pass
    writes, is always enough to find every one of them and is a constant-size
    read whatever the account's history.
    """
    result = await session.execute(
        select(VaultPipelineRun)
        .where(col(VaultPipelineRun.user_id) == user_id)
        .order_by(col(VaultPipelineRun.id).desc())
        .limit(len(LADDER) * 2)
    )
    return list(result.scalars().all())


def _classification_landed(rows: list[VaultPipelineRun]) -> bool:
    """Whether any classification pass has ever put labels in this vault.

    The precondition the linker stages have and cannot check for themselves: the
    thread stage reads the APTITUDE labels a classification pass writes, so
    linking a vault nobody classified spends the expensive stages producing
    clusters over unlabelled text. ``INCOMPLETE`` counts, and should: a pass that
    skipped some fragments still labelled the rest, and the labels it wrote are
    not provisional.
    """
    return any(
        row.stage == VaultPipelineStage.CLASSIFY and row.outcome != VaultPipelineOutcome.FAILED
        for row in rows
    )


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
) -> None:
    """Stage one attempt's row. The caller owns the commit."""
    session.add(
        VaultPipelineRun(
            user_id=user_id,
            stage=stage.value,
            outcome=outcome.value,
            fragments_seen=counts.seen,
            fragments_touched=counts.touched,
            fragments_lost=counts.lost,
        )
    )


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


async def _run_classification(
    session: AsyncSession, client: CreekVaultClient, user_id: int
) -> VaultPipelineOutcome:
    """Run the classification rung and record what it did."""
    result = await client.classify_corpus()
    outcome = _classification_outcome(result)
    _record(
        session,
        user_id=user_id,
        stage=VaultPipelineStage.CLASSIFY,
        outcome=outcome,
        counts=_StageCounts(seen=result.total, touched=result.classified),
    )
    return outcome


async def _run_link(
    session: AsyncSession, client: CreekVaultClient, user_id: int, stage: VaultPipelineStage
) -> VaultPipelineOutcome:
    """Run one linker rung and record what it did."""
    wire_stage = LINK_STAGE_BY_PIPELINE_STAGE[stage]
    result = await client.link_corpus(wire_stage)
    _note_link_loss(wire_stage, result)
    _record(
        session,
        user_id=user_id,
        stage=stage,
        outcome=VaultPipelineOutcome.COMPLETED,
        counts=_StageCounts(
            seen=result.fragment_count,
            touched=result.link_count,
            lost=result.oversized_discarded,
        ),
    )
    return VaultPipelineOutcome.COMPLETED


async def _run_stage(
    session: AsyncSession, client: CreekVaultClient, user_id: int, stage: VaultPipelineStage
) -> VaultPipelineOutcome:
    """Run one rung, recording the attempt whether it landed or not.

    Every vault failure is caught here and turned into a recorded ``FAILED``
    rather than propagated. Recording it is the point: an attempt that left no
    stamp would be repeated on the very next request, which is how a vault
    refusing one stage becomes a request-rate loop against it.
    """
    try:
        if stage is VaultPipelineStage.CLASSIFY:
            return await _run_classification(session, client, user_id)
        return await _run_link(session, client, user_id, stage)
    except CreekVaultError:
        _LOGGER.info("creek vault pipeline stage did not land", extra={"stage": stage.value})
        _record(session, user_id=user_id, stage=stage, outcome=VaultPipelineOutcome.FAILED)
        return VaultPipelineOutcome.FAILED


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
    trigger: VaultPipelineTrigger, rows: list[VaultPipelineRun], now: datetime
) -> tuple[VaultPipelineStage, ...]:
    """Which rungs this pass may climb, in ladder order.

    Three filters, and the third is what makes the ordering safe to rely on: the
    trigger's depth, each stage's own window, and the requirement that a
    classification pass has landed at some point -- in this run or an earlier
    one. Without the third, a vault whose classification window is still closed
    would have its clustering stages run over labels that were never written.
    """
    due = _due_stages(_STAGES_BY_TRIGGER[trigger], _stamps_by_stage(rows), now)
    if _classification_landed(rows) or VaultPipelineStage.CLASSIFY in due:
        return due
    return ()


async def _climb(
    session: AsyncSession,
    client: CreekVaultClient,
    user_id: int,
    stages: tuple[VaultPipelineStage, ...],
    deadline: float | None,
) -> None:
    """Climb the ladder in order, stopping at the first rung that did not land.

    Stopping rather than skipping ahead, because a stage that just failed is
    usually a vault that is refusing, unreachable or out of time, and the rung
    below it would only discover the same thing at the same cost. The stages that
    did not run keep their old stamps, so the next pass reaches them first.

    ``deadline`` is a monotonic instant after which no *new* stage is started. A
    stage already in flight runs to its own budget: the work it is doing lands in
    a cache that shortens every later pass, so interrupting it would discard the
    progress this design converges by.
    """
    for stage in stages:
        if deadline is not None and deadline - time.monotonic() < _LEAST_WORTH_STARTING_SECONDS:
            return
        if await _run_stage(session, client, user_id, stage) is VaultPipelineOutcome.FAILED:
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
        rows = await _recent_attempts(session, user_id)
        stages = _stages_to_run(trigger, rows, datetime.now(UTC))
        if not stages:
            return
        deadline = (
            time.monotonic() + _DEEP_RUN_BUDGET_SECONDS
            if trigger is VaultPipelineTrigger.DOCUMENT_IMPORT
            else None
        )
        await _climb(session, client, user_id, stages, deadline)
        await session.commit()
    except SQLAlchemyError:
        _LOGGER.warning("creek vault pipeline could not record its pass")
        await session.rollback()
