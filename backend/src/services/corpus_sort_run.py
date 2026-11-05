"""Sort an account's whole backlog from one press, in the background.

Sorting used to be a pass bounded by the request that asked for it -- forty
entries and twenty seconds at most, because somebody was waiting on the answer
-- so a long backlog took one press per forty entries, each a decision already
made. A press now starts a *run*: the request records it and returns, and a
background driver offers every entry that is pending, once, until none is left
that it has not offered. The screen follows the run's row
(:class:`models.corpus_sort_run.CorpusSortRun`) by polling.

**Comprehensive, and guaranteed to end.** The driver walks pending entry ids
downward with a cursor, so each row is visited at most once per run whatever
becomes of it. An entry the classifier places nowhere, or a write the vault
dropped, stays pending on purpose -- and could not be revisited by this run, so
a loop waiting for an empty backlog cannot spin on it. A later press offers it
again.

**Idempotent and single-flight.** At most one running row per account,
enforced by the database (see the model), so a second press joins the run
going. Offering an entry is idempotent too: one already sorted is no longer
pending, so a run resumed from the top re-reads rather than re-sends.

**Every gate the bounded pass kept, per entry.** Each entry goes through the
same seam the bounded pass uses -- :func:`services.corpus_backfill.offer_entry`
for the app provider, :func:`services.corpus_vault_sort.offer_to_vault` for a
vault -- which takes the account barrier per entry and re-reads consent, the
account and the row inside it. On top of that the driver re-resolves the
account's boundary before every entry, because a run can outlast the moment a
vault is connected: once a vault answers for the writing, the app's model is
not asked again (#3156).

**Durable, and recoverable.** The row carries a lease -- an owner token and a
heartbeat refreshed with every entry's progress. A run whose heartbeat goes
stale belonged to a worker that died (a deploy, a crash); the next press, or
:func:`resume_corpus_sort_runs` on the recovery loop, claims it and carries on.
A shutdown cancels drivers without marking anything, so the row stays running
and is resumed rather than reported as failed.

**Keyless.** A driver runs off the request's context
(:func:`services.creek_vault_relay.keyless_context`), so a provider key relayed
on the press never rides along into the background (#3437); the vault's own
pipeline reads the account's stored key where it has one.

**Content-free.** The row holds counts, a closed vocabulary and instants; the
log lines hold ids, counts and those words. Nothing quotes the writing.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Final

from fastapi import HTTPException, status
from sqlalchemy import or_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from dependencies.creek_vault import resolve_reflection_boundary, resolved_vault_destination
from domain.creek_vault import CreekVaultClient
from domain.dates import ensure_aware
from models.corpus_sort_run import CorpusSortRun, SortLane, SortRunState, SortStopReason
from services import corpus_backfill, corpus_vault_sort
from services.corpus_backfill import BackfillOutcome
from services.corpus_consent import load_consent, standing_consent_change
from services.corpus_ingest import INGEST_SOURCE
from services.creek_vault_relay import keyless_context
from services.creek_vault_write import VaultWriteOutcome, VaultWriteStatus
from services.privacy_suspension import external_ai_suspended
from services.reflection_boundary import ReflectionBoundary

logger = logging.getLogger(__name__)

#: How many pending ids one cursor read fetches. A memory bound on the walk,
#: not a bound on the run: the driver reads the next batch when this one ends.
SORT_BATCH_SIZE: Final[int] = 50

#: How long a running row's heartbeat may go unrefreshed before the run counts
#: as abandoned. The heartbeat is refreshed with every entry's progress, and
#: one entry is bounded well inside this: an app-provider classification by
#: ``BACKFILL_ENTRY_SECONDS`` (8s), a vault send by the vault adapter's
#: whole-request deadline (30s) plus the pipeline nudge's own clock (10s), with
#: the account barrier's wait in front. Three minutes leaves several times that
#: before a live driver could be mistaken for a dead one. A vault send retried
#: through :data:`VAULT_RETRY_DELAYS_SECONDS` refreshes the heartbeat before
#: every wait, so the ladder as a whole never counts against this.
STALE_AFTER: Final[timedelta] = timedelta(minutes=3)

#: How long to wait before each retry of a vault send that found the vault
#: unavailable, in seconds. A managed vault sheds with ``503
#: temporarily_unavailable`` whenever it cannot take a request just then
#: (``domain.creek_vault``), and a shed clears in a second or two -- so a single
#: shed is not a vault that is down. It can land on the handshake or on the
#: ingest after it, and both are retried: stopping on the first ended whole
#: sorts on a blip, and moving past the second left every shed entry unsorted.
#: Doubling, five retries, about half a minute in all: long enough to ride out a
#: shed, short enough that a vault that really is down is reported as such while
#: somebody may still be looking.
VAULT_RETRY_DELAYS_SECONDS: Final[tuple[float, ...]] = (1.0, 2.0, 4.0, 8.0, 16.0)

#: The log lines a run writes: ids, counts and the closed vocabulary only.
FINISHED_EVENT: Final[str] = "corpus_sort_run_finished"
FAULT_EVENT: Final[str] = "corpus_sort_run_fault"
#: Written when the account barrier refused to order a run's egress (its lock
#: connection would not open), naming the run it ended (#3675).
ORDERING_REFUSED_EVENT: Final[str] = "corpus_sort_run_ordering_refused"

#: Builds a vault client for an account, for a run resumed off any request.
VaultClientResolver = Callable[[AsyncSession, int], Awaitable[CreekVaultClient]]

#: In-process drivers by run id, so a shutdown can stop them and a test can
#: wait for them. The row, not this map, is the source of truth for a run.
_TASKS: dict[int, asyncio.Task[None]] = {}

_LANE_BY_BOUNDARY: Final = {
    ReflectionBoundary.APP_PROVIDER: SortLane.APP_PROVIDER,
    ReflectionBoundary.VAULT_BOUND: SortLane.VAULT_BOUND,
}


class _LeaseLostError(Exception):
    """The run's row is gone (its account was erased) or another driver holds it."""


class _NoWinningRunError(RuntimeError):
    """A single-flight conflict was reported, yet no run for the account exists."""

    def __init__(self) -> None:
        """Carry a static message; nothing about the account."""
        super().__init__("corpus sort run conflict with no winning run")


@dataclass(frozen=True, slots=True)
class _Step:
    """What offering one entry did, or why the run must end before it."""

    offered: bool = False
    sorted: bool = False
    stop: SortStopReason | None = None


_NOT_OFFERED: Final = _Step()

#: The vault lane's answer for each write outcome. A dropped write and an
#: Intimate skip were offered without being sorted; an operator's suspension is
#: a fact about every entry, so the run stops. ``UNAVAILABLE`` stops it too, but
#: only once :data:`VAULT_RETRY_DELAYS_SECONDS` has been spent on that entry,
#: and so does a shed ingest (:data:`_SHED_THROUGHOUT`).
_VAULT_STEPS: Final = {
    VaultWriteStatus.INGESTED: _Step(offered=True, sorted=True),
    VaultWriteStatus.DEGRADED: _Step(offered=True),
    VaultWriteStatus.SKIPPED_INTIMATE: _Step(offered=True),
    VaultWriteStatus.UNAVAILABLE: _Step(stop=SortStopReason.VAULT_UNAVAILABLE),
    VaultWriteStatus.SUSPENDED: _Step(stop=SortStopReason.SUSPENDED),
}

#: A ``DEGRADED`` write the vault was still shedding when the ladder ran out.
#: Moving on would spend the same half minute on every entry after it, so the
#: run stops as it would on a vault that never answered the handshake.
_SHED_THROUGHOUT: Final = _Step(stop=SortStopReason.VAULT_UNAVAILABLE)


@dataclass(slots=True)
class _Drive:
    """One driver's hold on one run: who it is, which side sorts, how far it got.

    ``client`` and ``destination`` are read only on the vault-bound lane. The
    lanes are dispatched by :func:`_next_ids` and :func:`_offer`, plain
    functions rather than methods on a lane object, so the egress call graph
    (``tests/support/egress_call_graph.py``), which resolves names and not
    instances, can follow every path from the route to a dial.
    """

    run_id: int
    user_id: int
    owner: str
    kind: SortLane
    client: CreekVaultClient
    destination: str | None
    offered: int
    sorted: int

    @property
    def vault(self) -> corpus_vault_sort.VaultTarget:
        """Where this run's vault lane sends."""
        return corpus_vault_sort.VaultTarget(self.user_id, self.destination, self.client)


async def _next_ids(session: AsyncSession, drive: _Drive, below_id: int | None) -> list[int]:
    """The next batch of pending ids under the cursor, highest first, per the lane's predicate."""
    if drive.kind is SortLane.VAULT_BOUND:
        return await corpus_vault_sort.pending_vault_entry_ids(
            session, drive.user_id, drive.destination, below_id=below_id, limit=SORT_BATCH_SIZE
        )
    return await corpus_backfill.pending_entry_ids(
        session, drive.user_id, below_id=below_id, limit=SORT_BATCH_SIZE
    )


async def _offer_to_corpus(session: AsyncSession, drive: _Drive, entry_id: int) -> _Step:
    """Classify with the app's model through the bounded sweep's seam; name any stop."""
    offer = await corpus_backfill.offer_entry(
        session,
        entry_id=entry_id,
        user_id=drive.user_id,
        boundary=ReflectionBoundary.APP_PROVIDER,
    )
    if offer.stop:
        return _Step(stop=await _why_the_app_lane_stopped(session, drive.user_id))
    return _Step(offered=offer.offered, sorted=offer.stored)


async def _send_once(
    session: AsyncSession, drive: _Drive, entry_id: int
) -> VaultWriteOutcome | None:
    """One send down the journal save's own path, without the per-write pipeline nudge.

    The nudge is left to :func:`_nudge_the_vault` at the end: a nudge per entry
    spawned classification polling on this same client beside the next send,
    which is what pushed a managed vault into shedding mid-sort.
    """
    return await corpus_vault_sort.offer_to_vault(
        session, drive.vault, entry_id, drive_pipeline=False
    )


def _waits(outcome: VaultWriteOutcome | None) -> bool:
    """Whether a send found the vault unable to take it just now, at handshake or ingest."""
    return outcome is not None and (
        outcome.status is VaultWriteStatus.UNAVAILABLE or outcome.retryable
    )


def _step_for(outcome: VaultWriteOutcome | None) -> _Step:
    """Read a send's last answer as the run's next step."""
    if outcome is None:
        return _NOT_OFFERED
    if outcome.retryable:
        return _SHED_THROUGHOUT
    return _VAULT_STEPS[outcome.status]


async def _offer_to_vault(session: AsyncSession, drive: _Drive, entry_id: int) -> _Step:
    """Send one entry, waiting out a vault that is unavailable for a moment.

    An unavailable handshake or a shed ingest (:func:`_waits`) is retried after
    each of :data:`VAULT_RETRY_DELAYS_SECONDS`; the ingest is an upsert keyed by
    the entry id, so a send that did land is not duplicated. Before every wait
    the heartbeat is refreshed -- which also commits, so no pooled connection is
    held while asleep -- and a lost lease ends the driver there rather than
    after the wait. Read through :func:`_step_for` once the answer is anything
    else, or once the ladder is spent.
    """
    outcome = await _send_once(session, drive, entry_id)
    for delay in VAULT_RETRY_DELAYS_SECONDS:
        if not _waits(outcome):
            break
        await _record(session, drive, _NOT_OFFERED)
        await asyncio.sleep(delay)
        outcome = await _send_once(session, drive, entry_id)
    return _step_for(outcome)


async def _offer(session: AsyncSession, drive: _Drive, entry_id: int) -> _Step:
    """Offer one entry to whichever side sorts this run's writing."""
    if drive.kind is SortLane.VAULT_BOUND:
        return await _offer_to_vault(session, drive, entry_id)
    return await _offer_to_corpus(session, drive, entry_id)


async def _consent_granted(session: AsyncSession, user_id: int) -> bool:
    """Whether a standing yes covers sorting what is written here."""
    return (await load_consent(session, user_id=user_id, source=INGEST_SOURCE)).granted


async def _lane_now(session: AsyncSession, user_id: int) -> SortLane:
    """Which side may sort this account's writing, from the server's own record."""
    return _LANE_BY_BOUNDARY[await resolve_reflection_boundary(session, user_id)]


async def _why_the_app_lane_stopped(session: AsyncSession, user_id: int) -> SortStopReason:
    """Name the account-level reason the bounded sweep's seam asked to stop.

    That seam answers "stop" alike for a revoked yes, a vault now answering,
    an operator's suspension and a provider refusing to bill, because to the
    bounded pass they are one fact. A run reports which, so the screen can say
    something true; the provider is what is left once the account is ruled out.
    """
    if not await _consent_granted(session, user_id):
        return SortStopReason.CONSENT_WITHDRAWN
    if await _lane_now(session, user_id) is not SortLane.APP_PROVIDER:
        return SortStopReason.BOUNDARY_CHANGED
    if external_ai_suspended():
        return SortStopReason.SUSPENDED
    return SortStopReason.PROVIDER_REFUSED


async def _stop_before_offering(
    session: AsyncSession, user_id: int, kind: SortLane
) -> SortStopReason | None:
    """Re-read the account before each entry: is the run still allowed to go on?

    The offer seams re-read consent under the barrier as well, which is what
    makes a revocation race-free; this read is what lets the run *name* the
    stop, and it is the only place the boundary is re-resolved mid-run.
    """
    if not await _consent_granted(session, user_id):
        return SortStopReason.CONSENT_WITHDRAWN
    if await _lane_now(session, user_id) is not kind:
        return SortStopReason.BOUNDARY_CHANGED
    return None


async def count_unsorted(session: AsyncSession, user_id: int) -> int:
    """How much this account's sort would still reach, on the side its boundary allows."""
    if await _lane_now(session, user_id) is SortLane.VAULT_BOUND:
        return await corpus_vault_sort.count_vault_pending(session, user_id)
    return await corpus_backfill.count_pending_entries(session, user_id)


async def latest_run(session: AsyncSession, user_id: int) -> CorpusSortRun | None:
    """This account's newest run, whatever its state, or ``None`` if it never pressed Sort."""
    result = await session.execute(
        select(CorpusSortRun)
        .where(col(CorpusSortRun.user_id) == user_id)
        .order_by(col(CorpusSortRun.id).desc())
        .limit(1)
        .execution_options(populate_existing=True)
    )
    return result.scalars().first()


def _new_owner() -> str:
    """A fresh, opaque lease token."""
    return uuid.uuid4().hex


def _is_live(run: CorpusSortRun, now: datetime) -> bool:
    """Whether a running row's driver has proved itself alive recently enough."""
    return run.heartbeat_at is not None and ensure_aware(run.heartbeat_at) > now - STALE_AFTER


async def _claim(session: AsyncSession, run_id: int) -> str | None:
    """Take over a running row whose lease is free or stale; the new token, or ``None``.

    A compare-and-swap, so two claimants racing for one orphan cannot both win.
    The staleness test runs in SQL only: the ORM's default "evaluate" sync would
    re-run it in Python against loaded rows, and SQLite reads them back naive.
    """
    owner = _new_owner()
    now = datetime.now(UTC)
    result = await session.execute(
        update(CorpusSortRun)
        .where(
            col(CorpusSortRun.id) == run_id,
            col(CorpusSortRun.state) == SortRunState.RUNNING.value,
            or_(
                col(CorpusSortRun.heartbeat_at).is_(None),
                col(CorpusSortRun.heartbeat_at) <= now - STALE_AFTER,
            ),
        )
        .values(owner_id=owner, heartbeat_at=now)
        .returning(col(CorpusSortRun.id))
        .execution_options(synchronize_session=False)
    )
    claimed = result.scalar_one_or_none() is not None
    await session.commit()
    return owner if claimed else None


def _forget(run_id: int, task: asyncio.Task[None]) -> None:
    """Drop a finished driver and observe its fault without leaking anything."""
    if _TASKS.get(run_id) is task:
        _TASKS.pop(run_id, None)
    if not task.cancelled() and task.exception() is not None:
        logger.warning(FAULT_EVENT, extra={"run_id": run_id})


def _spawn(
    factory: async_sessionmaker[AsyncSession], run_id: int, owner: str, client: CreekVaultClient
) -> None:
    """Start a driver for ``run_id`` off the request, holding no relayed key."""
    task = asyncio.create_task(
        _drive(factory, run_id=run_id, owner=owner, client=client), context=keyless_context()
    )
    _TASKS[run_id] = task
    task.add_done_callback(partial(_forget, run_id), context=keyless_context())


def _factory_for(session: AsyncSession) -> async_sessionmaker[AsyncSession]:
    """Background sessions against the same engine as the request's session."""
    if session.bind is None:
        msg = "corpus sort run session is not bound"
        raise RuntimeError(msg)
    return async_sessionmaker(session.bind, class_=AsyncSession, expire_on_commit=False)


async def _join(
    session: AsyncSession, run: CorpusSortRun, client: CreekVaultClient
) -> CorpusSortRun:
    """Join a running row; if its driver is dead, take it over first."""
    if run.id is None or _is_live(run, datetime.now(UTC)):
        return run
    owner = await _claim(session, run.id)
    if owner is not None:
        _spawn(_factory_for(session), run.id, owner, client)
    await session.refresh(run)
    return run


async def _winner(session: AsyncSession, user_id: int) -> CorpusSortRun:
    """The run that won a single-flight race this request lost."""
    run = await latest_run(session, user_id)
    if run is None:
        raise _NoWinningRunError
    return run


async def _start(session: AsyncSession, user_id: int, client: CreekVaultClient) -> CorpusSortRun:
    """Record a new run and start its driver -- or, without a standing yes, record why not."""
    kind = await _lane_now(session, user_id)
    total = await count_unsorted(session, user_id)
    now = datetime.now(UTC)
    if not await _consent_granted(session, user_id):
        refused = CorpusSortRun(
            user_id=user_id,
            lane=kind.value,
            state=SortRunState.STOPPED.value,
            stop_reason=SortStopReason.NO_CONSENT.value,
            entries_total=total,
            finished_at=now,
        )
        session.add(refused)
        await session.commit()
        return refused
    owner = _new_owner()
    run = CorpusSortRun(
        user_id=user_id,
        lane=kind.value,
        state=SortRunState.RUNNING.value,
        entries_total=total,
        owner_id=owner,
        heartbeat_at=now,
    )
    session.add(run)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        return await _winner(session, user_id)
    if run.id is not None:
        _spawn(_factory_for(session), run.id, owner, client)
    return run


async def start_or_join(
    session: AsyncSession, *, user_id: int, client: CreekVaultClient
) -> CorpusSortRun:
    """Start this account's sort, or join the one already running.

    Returns the run either way, so pressing Sort twice is the same as pressing
    it once. ``client`` is the vault this request resolved; a vault-bound run
    sends through it, and an app-provider run never touches it.
    """
    running = await session.execute(
        select(CorpusSortRun).where(
            col(CorpusSortRun.user_id) == user_id,
            col(CorpusSortRun.state) == SortRunState.RUNNING.value,
        )
    )
    current = running.scalars().first()
    if current is not None:
        return await _join(session, current, client)
    return await _start(session, user_id, client)


async def _prepare(
    session: AsyncSession, *, run_id: int, owner: str, client: CreekVaultClient
) -> _Drive | None:
    """Read the run this driver was started for; ``None`` if it no longer holds it."""
    run = await session.get(CorpusSortRun, run_id)
    if run is None or run.state != SortRunState.RUNNING.value or run.owner_id != owner:
        return None
    kind = SortLane(run.lane)
    destination = None
    if kind is SortLane.VAULT_BOUND:
        destination = await resolved_vault_destination(session, run.user_id)
    return _Drive(
        run_id=run_id,
        user_id=run.user_id,
        owner=owner,
        kind=kind,
        client=client,
        destination=destination,
        offered=run.entries_offered,
        sorted=run.entries_sorted,
    )


async def _record(session: AsyncSession, drive: _Drive, step: _Step) -> None:
    """Count one entry's step and refresh the heartbeat, if this driver still holds the run.

    Written after every entry, offered or not, because it is the heartbeat as
    well as the progress the screen reads. A row that no longer matches -- its
    account erased, or a reclaim by another driver after this one stalled past
    :data:`STALE_AFTER` -- ends this driver quietly; the other one carries on.
    """
    drive.offered += int(step.offered)
    drive.sorted += int(step.sorted)
    result = await session.execute(
        update(CorpusSortRun)
        .where(
            col(CorpusSortRun.id) == drive.run_id,
            col(CorpusSortRun.owner_id) == drive.owner,
            col(CorpusSortRun.state) == SortRunState.RUNNING.value,
        )
        .values(
            entries_offered=drive.offered,
            entries_sorted=drive.sorted,
            heartbeat_at=datetime.now(UTC),
        )
        .returning(col(CorpusSortRun.id))
        .execution_options(synchronize_session=False)
    )
    held = result.scalar_one_or_none() is not None
    await session.commit()
    if not held:
        raise _LeaseLostError


async def _walk_batch(
    session: AsyncSession, drive: _Drive, ids: list[int]
) -> SortStopReason | None:
    """Offer one batch, entry by entry; the reason the run must stop, if it must."""
    for entry_id in ids:
        stop = await _stop_before_offering(session, drive.user_id, drive.kind)
        step = _Step(stop=stop) if stop is not None else await _offer(session, drive, entry_id)
        if step.stop is not None:
            return step.stop
        await _record(session, drive, step)
    return None


async def _walk(session: AsyncSession, drive: _Drive) -> SortStopReason | None:
    """Offer every pending entry once, highest id first; ``None`` when none is left."""
    cursor: int | None = None
    while ids := await _next_ids(session, drive, cursor):
        stop = await _walk_batch(session, drive, ids)
        if stop is not None:
            return stop
        cursor = ids[-1]
    return None


async def _nudge_the_vault(session: AsyncSession, drive: _Drive) -> None:
    """Ask the vault to classify what this run sent, once, now that the sends are done."""
    if drive.kind is SortLane.VAULT_BOUND and drive.sorted > 0:
        await corpus_vault_sort.nudge_vault_pipeline(session, drive.vault)


async def _receipt(session: AsyncSession, drive: _Drive) -> None:
    """File the app-provider reach as the bounded sweep does, so the export carries it."""
    change = await standing_consent_change(session, user_id=drive.user_id, source=INGEST_SOURCE)
    outcome = BackfillOutcome(
        entries_considered=drive.offered,
        fragments_added=drive.sorted,
        entries_remaining=await corpus_backfill.count_pending_entries(session, drive.user_id),
    )
    await corpus_backfill.record_sweep_receipt(
        session, user_id=drive.user_id, change=change, outcome=outcome
    )


async def _finish(
    session: AsyncSession, drive: _Drive, state: SortRunState, reason: SortStopReason | None
) -> None:
    """Close the run this driver holds, release its lease, and say how it ended."""
    await session.execute(
        update(CorpusSortRun)
        .where(col(CorpusSortRun.id) == drive.run_id, col(CorpusSortRun.owner_id) == drive.owner)
        .values(
            state=state.value,
            stop_reason=None if reason is None else reason.value,
            entries_offered=drive.offered,
            entries_sorted=drive.sorted,
            finished_at=datetime.now(UTC),
            owner_id=None,
            heartbeat_at=None,
        )
        .execution_options(synchronize_session=False)
    )
    if drive.kind is SortLane.APP_PROVIDER and state is not SortRunState.FAILED:
        await _receipt(session, drive)
    await session.commit()
    logger.info(
        FINISHED_EVENT,
        extra={
            "user_id": drive.user_id,
            "run_id": drive.run_id,
            "state": state.value,
            "stop_reason": None if reason is None else reason.value,
            "entries_offered": drive.offered,
            "entries_sorted": drive.sorted,
        },
    )


async def _settle(session: AsyncSession, drive: _Drive, stop: SortStopReason | None) -> None:
    """Close a run whose walk ended: completed if nothing stopped it, stopped if something did."""
    state = SortRunState.COMPLETED if stop is None else SortRunState.STOPPED
    await _finish(session, drive, state, stop)


async def _on_refusal(session: AsyncSession, drive: _Drive, refusal: HTTPException) -> None:
    """Answer the account barrier refusing this driver's egress.

    The barrier refuses for one of two reasons, and they leave different things
    behind. A 401 is the account erased mid-run: its run row went with it, so
    there is nothing to close and nothing to say. Anything else is the barrier
    unable to order egress at all (a 503 when its lock connection will not open,
    ``voice_draft_privacy.EGRESS_ORDERING_UNAVAILABLE``). Left running, that row
    went stale, was reclaimed by :func:`resume_corpus_sort_runs` and refused
    again, every few minutes and without a trace naming it (#3675). So the run
    fails -- the screen stops waiting and offers a fresh press, and recovery has
    nothing to retry -- after one line naming it.
    """
    if refusal.status_code == status.HTTP_401_UNAUTHORIZED:
        return
    await session.rollback()
    logger.warning(ORDERING_REFUSED_EVENT, extra={"user_id": drive.user_id, "run_id": drive.run_id})
    await _finish(session, drive, SortRunState.FAILED, None)


async def _drive(
    factory: async_sessionmaker[AsyncSession], *, run_id: int, owner: str, client: CreekVaultClient
) -> None:
    """Carry one run to its end, in a session of its own.

    Cancellation (a shutdown) is not caught, so the row stays running and is
    resumed. A lost lease ends this driver quietly: another one holds the run.
    A refusal from the account barrier is answered by :func:`_on_refusal`. Any
    other fault marks the run failed, so the screen stops waiting, and is
    re-raised for :func:`_forget` to note in ids only.
    """
    async with factory() as session:
        drive = await _prepare(session, run_id=run_id, owner=owner, client=client)
        if drive is None:
            return
        try:
            stop = await _walk(session, drive)
            await _nudge_the_vault(session, drive)
        except _LeaseLostError:
            return
        except HTTPException as refusal:
            await _on_refusal(session, drive, refusal)
            return
        except Exception:
            await session.rollback()
            await _finish(session, drive, SortRunState.FAILED, None)
            raise
        await _settle(session, drive, stop)


async def resume_corpus_sort_runs(
    factory: async_sessionmaker[AsyncSession], resolve_client: VaultClientResolver
) -> None:
    """Claim and restart every running row whose driver has gone stale.

    Called on the recovery loop, so a run a deploy interrupted finishes without
    anybody pressing Sort again. A row another worker is still driving has a
    fresh heartbeat and is left alone; two workers racing for one orphan meet in
    :func:`_claim`'s compare-and-swap, and only one starts a driver.
    """
    async with factory() as session:
        result = await session.execute(
            select(CorpusSortRun).where(
                col(CorpusSortRun.state) == SortRunState.RUNNING.value,
                or_(
                    col(CorpusSortRun.heartbeat_at).is_(None),
                    col(CorpusSortRun.heartbeat_at) <= datetime.now(UTC) - STALE_AFTER,
                ),
            )
        )
        for run in result.scalars().all():
            await _resume_one(session, factory, run, resolve_client)


async def _resume_one(
    session: AsyncSession,
    factory: async_sessionmaker[AsyncSession],
    run: CorpusSortRun,
    resolve_client: VaultClientResolver,
) -> None:
    """Claim one stale run and start its driver, if this worker wins the claim."""
    if run.id is None:
        return
    owner = await _claim(session, run.id)
    if owner is None:
        return
    client = await resolve_client(session, run.user_id)
    _spawn(factory, run.id, owner, client)


async def wait_for_corpus_sort_tasks() -> None:
    """Wait until no driver is running in this process; faults are noted, not raised."""
    while tasks := tuple(task for task in _TASKS.values() if not task.done()):
        await asyncio.gather(*tasks, return_exceptions=True)


async def close_corpus_sort_tasks() -> None:
    """Cancel this process's drivers on shutdown; their rows stay running and resumable."""
    tasks = tuple(_TASKS.values())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    _TASKS.clear()
