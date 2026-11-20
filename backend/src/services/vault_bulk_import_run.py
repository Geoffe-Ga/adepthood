"""One full vault pass when a bulk upload drains, run in the background (#3773).

A bulk upload sends many documents under one ``upload_run`` id, and none of
them drives the vault's ontologization ladder inline any more: a minute-long
pass inside each of forty requests was forty passes nobody needed, and the
six-hour clustering window closed behind the first, so most of a morning's
import was not clustered that day. Instead the client presses
``POST /corpus/import/complete`` once when its queue drains, and this module
carries that press to its end.

**The run.** A background driver, off the request and holding no relayed key
(#3437):

1. handshakes the account's vault under the account barrier, recording a
   ``stopped`` run when the vault cannot be reached (#3679) or advertises no
   batch pipeline;
2. hands one ``bulk_import`` pass to the durable pipeline
   (:func:`services.creek_vault_pipeline.drive_vault_pipeline`): classification
   (Creek writes Praxis pages in that same pass), then temporal, embeddings,
   eddies and threads, every stage due whatever its window, each recorded in
   ``vaultpipelinerun``. The pipeline owns, heartbeats and resumes that pass;
   this run records that it was handed on (``dispatched_at``) so a resumed run
   never hands it on twice;
3. waits for this process's continuation to finish climbing;
4. starts or joins the corpus sweep (:mod:`services.corpus_sort_run`) when a
   standing yes covers it and some writing is still unsorted.

**Idempotent and single-flight.** One row per ``(account, batch)``, so a
second press of a batch joins its run; at most one ``running`` row per account,
enforced by the database, so a different batch pressed mid-run is recorded
``queued`` and promoted when the running one ends -- its documents landed after
the running pass's snapshot, so it is owed a pass of its own.

**Durable.** The running row carries a lease, refreshed by a heartbeat while
the driver waits. A run whose heartbeat goes stale is claimed by the next press
or by :func:`resume_bulk_import_runs` on the recovery loop. A shutdown cancels
drivers without marking anything, so their rows stay running and resumable.

**Never raises into a request, and content-free.** The route records a row and
returns; a stage's failure is the pipeline's own row, and any other fault marks
the run ``failed``. Rows and log lines carry ids, counts and closed words only.
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

from domain.creek_vault import CreekCapability, CreekVaultClient
from domain.dates import ensure_aware
from models.vault_bulk_import_run import (
    BulkImportRunState,
    BulkImportStopReason,
    VaultBulkImportRun,
)
from services import corpus_sort_run
from services.account_egress_barrier import ensure_account_live, hold_account
from services.corpus_consent import load_consent
from services.corpus_ingest import INGEST_SOURCE
from services.creek_vault_pipeline import (
    VaultPipelineTrigger,
    drive_vault_pipeline,
    wait_for_account_pipeline,
)
from services.creek_vault_relay import keyless_context

logger = logging.getLogger(__name__)

#: How long a running row's heartbeat may go unrefreshed before the run counts
#: as abandoned. The driver refreshes it every :data:`HEARTBEAT_SECONDS` while
#: it waits on the pipeline, and its own dials -- one handshake, one admission
#: commit -- are bounded by the vault adapter's whole-request deadline (30s), so
#: three minutes is several heartbeats before a live driver could be mistaken
#: for a dead one. The :mod:`services.corpus_sort_run` horizon, for the same
#: reasons.
STALE_AFTER: Final[timedelta] = timedelta(minutes=3)

#: How often a waiting driver proves it is alive.
HEARTBEAT_SECONDS: Final[float] = 30.0

#: The log lines a run writes: ids and the closed vocabulary only.
FINISHED_EVENT: Final[str] = "vault_bulk_import_run_finished"
FAULT_EVENT: Final[str] = "vault_bulk_import_run_fault"
ORDERING_REFUSED_EVENT: Final[str] = "vault_bulk_import_run_ordering_refused"

#: Builds a vault client for an account, for a run resumed off any request.
VaultClientResolver = Callable[[AsyncSession, int], Awaitable[CreekVaultClient]]

#: In-process drivers by run id, so a shutdown can stop them and a test can
#: wait for them. The row, not this map, is the source of truth for a run.
_TASKS: dict[int, asyncio.Task[None]] = {}


class _LeaseLostError(Exception):
    """The run's row is gone (its account was erased) or another driver holds it."""


class _NoBatchRunError(RuntimeError):
    """A press lost every insert race, yet no row for its batch exists."""

    def __init__(self) -> None:
        """Carry a static message; nothing about the account."""
        super().__init__("bulk import run conflict with no row for the batch")


@dataclass(frozen=True, slots=True)
class _Drive:
    """One driver's hold on one run."""

    run_id: int
    user_id: int
    owner: str
    dispatched: bool


@dataclass(frozen=True, slots=True)
class _Ending:
    """How a run ended, in the closed vocabulary."""

    state: BulkImportRunState
    reason: BulkImportStopReason | None = None


_COMPLETED: Final = _Ending(BulkImportRunState.COMPLETED)


def factory_for(session: AsyncSession) -> async_sessionmaker[AsyncSession]:
    """Background sessions against the same engine as ``session``."""
    if session.bind is None:
        msg = "vault bulk import run session is not bound"
        raise RuntimeError(msg)
    return async_sessionmaker(session.bind, class_=AsyncSession, expire_on_commit=False)


def _new_owner() -> str:
    """A fresh, opaque lease token."""
    return uuid.uuid4().hex


def _is_live(run: VaultBulkImportRun, now: datetime) -> bool:
    """Whether a running row's driver has proved itself alive recently enough."""
    return run.heartbeat_at is not None and ensure_aware(run.heartbeat_at) > now - STALE_AFTER


async def find_run(session: AsyncSession, user_id: int, batch_id: str) -> VaultBulkImportRun | None:
    """This account's run for ``batch_id``, or ``None`` if the batch was never pressed.

    Scoped by the account, so a batch id another account minted reads as never
    pressed -- the id is the client's own, never a handle on anybody else's run.
    """
    result = await session.execute(
        select(VaultBulkImportRun)
        .where(
            col(VaultBulkImportRun.user_id) == user_id,
            col(VaultBulkImportRun.batch_id) == batch_id,
        )
        .execution_options(populate_existing=True)
    )
    return result.scalars().first()


async def _claim(session: AsyncSession, run_id: int) -> str | None:
    """Take over a running row whose lease is stale; the new token, or ``None``.

    A compare-and-swap, so two claimants racing for one orphan cannot both win.
    The staleness test runs in SQL only, as in :mod:`services.corpus_sort_run`.
    """
    owner = _new_owner()
    now = datetime.now(UTC)
    result = await session.execute(
        update(VaultBulkImportRun)
        .where(
            col(VaultBulkImportRun.id) == run_id,
            col(VaultBulkImportRun.state) == BulkImportRunState.RUNNING.value,
            or_(
                col(VaultBulkImportRun.heartbeat_at).is_(None),
                col(VaultBulkImportRun.heartbeat_at) <= now - STALE_AFTER,
            ),
        )
        .values(owner_id=owner, heartbeat_at=now)
        .returning(col(VaultBulkImportRun.id))
        .execution_options(synchronize_session=False)
    )
    claimed = result.scalar_one_or_none() is not None
    await session.commit()
    return owner if claimed else None


async def _promote(session: AsyncSession, user_id: int) -> tuple[int, str] | None:
    """Start this account's oldest queued run, if none is running; its id and token.

    The single-flight index refuses the promotion while another row runs, and a
    refusal is simply "not yet": the running driver, or recovery, promotes it
    once that run ends.
    """
    oldest = await session.execute(
        select(col(VaultBulkImportRun.id))
        .where(
            col(VaultBulkImportRun.user_id) == user_id,
            col(VaultBulkImportRun.state) == BulkImportRunState.QUEUED.value,
        )
        .order_by(col(VaultBulkImportRun.id))
        .limit(1)
    )
    run_id = oldest.scalar_one_or_none()
    if run_id is None:
        await session.commit()
        return None
    owner = _new_owner()
    try:
        result = await session.execute(
            update(VaultBulkImportRun)
            .where(
                col(VaultBulkImportRun.id) == run_id,
                col(VaultBulkImportRun.state) == BulkImportRunState.QUEUED.value,
            )
            .values(
                state=BulkImportRunState.RUNNING.value,
                owner_id=owner,
                heartbeat_at=datetime.now(UTC),
            )
            .returning(col(VaultBulkImportRun.id))
            .execution_options(synchronize_session=False)
        )
        promoted = result.scalar_one_or_none() is not None
        await session.commit()
    except IntegrityError:
        await session.rollback()
        return None
    return (run_id, owner) if promoted else None


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


async def _take_over(
    session: AsyncSession, run: VaultBulkImportRun, client: CreekVaultClient
) -> None:
    """Claim a running row whose driver is dead, and carry it on from here."""
    if run.id is None or _is_live(run, datetime.now(UTC)):
        return
    owner = await _claim(session, run.id)
    if owner is not None:
        _spawn(factory_for(session), run.id, owner, client)


async def _start_if_its_turn(
    session: AsyncSession, run: VaultBulkImportRun, client: CreekVaultClient
) -> None:
    """Start the account's oldest queued run, if nothing is running any more."""
    promoted = await _promote(session, run.user_id)
    if promoted is not None:
        _spawn(factory_for(session), *promoted, client)


#: What joining a batch's run does, by the state it is in. A finished run is
#: simply answered.
_JOINERS: Final = {
    BulkImportRunState.RUNNING.value: _take_over,
    BulkImportRunState.QUEUED.value: _start_if_its_turn,
}


async def _join(
    session: AsyncSession, run: VaultBulkImportRun, client: CreekVaultClient
) -> VaultBulkImportRun:
    """Join a batch's run; take over a dead driver, or start a queued run whose turn came."""
    joiner = _JOINERS.get(run.state)
    if joiner is not None:
        await joiner(session, run, client)
    await session.refresh(run)
    return run


async def _insert(session: AsyncSession, run: VaultBulkImportRun) -> bool:
    """Commit a new row; ``False`` when a uniqueness rule refused it."""
    session.add(run)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        return False
    return True


@dataclass(frozen=True, slots=True)
class _Batch:
    """One press: whose batch, which one, and how much of it landed."""

    user_id: int
    batch_id: str
    landed: int


async def _start_running(
    session: AsyncSession, batch: _Batch, client: CreekVaultClient
) -> VaultBulkImportRun | None:
    """Record the batch as the account's running run and start its driver; ``None`` if one runs."""
    owner = _new_owner()
    running = VaultBulkImportRun(
        user_id=batch.user_id,
        batch_id=batch.batch_id,
        landed=batch.landed,
        state=BulkImportRunState.RUNNING.value,
        owner_id=owner,
        heartbeat_at=datetime.now(UTC),
    )
    if not await _insert(session, running):
        return None
    if running.id is not None:
        _spawn(factory_for(session), running.id, owner, client)
    return running


async def _queue_behind(session: AsyncSession, batch: _Batch) -> VaultBulkImportRun:
    """Record the batch queued behind the run going -- or answer the press that beat this one."""
    if await find_run(session, batch.user_id, batch.batch_id) is None:
        queued = VaultBulkImportRun(
            user_id=batch.user_id,
            batch_id=batch.batch_id,
            landed=batch.landed,
            state=BulkImportRunState.QUEUED.value,
        )
        if await _insert(session, queued):
            return queued
    winner = await find_run(session, batch.user_id, batch.batch_id)
    if winner is None:
        raise _NoBatchRunError
    return winner


async def _start(
    session: AsyncSession, batch: _Batch, client: CreekVaultClient
) -> VaultBulkImportRun:
    """Record a new run and start its driver -- or queue it behind the one running."""
    started = await _start_running(session, batch, client)
    if started is not None:
        return started
    return await _queue_behind(session, batch)


async def start_or_join(
    session: AsyncSession,
    *,
    user_id: int,
    batch_id: str,
    landed: int,
    client: CreekVaultClient,
) -> VaultBulkImportRun:
    """Start the vault pass this drained batch is owed, or join the one already recorded.

    Returns the run either way, so pressing twice is pressing once. ``client``
    is the vault this request resolved; the driver dials only through it.
    """
    existing = await find_run(session, user_id, batch_id)
    if existing is not None:
        return await _join(session, existing, client)
    return await _start(session, _Batch(user_id, batch_id, landed), client)


async def _prepare(session: AsyncSession, *, run_id: int, owner: str) -> _Drive | None:
    """Read the run this driver was started for; ``None`` if it no longer holds it."""
    run = await session.get(VaultBulkImportRun, run_id)
    if run is None or run.state != BulkImportRunState.RUNNING.value or run.owner_id != owner:
        await session.commit()
        return None
    drive = _Drive(
        run_id=run_id,
        user_id=run.user_id,
        owner=owner,
        dispatched=run.dispatched_at is not None,
    )
    await session.commit()
    return drive


async def _touch(session: AsyncSession, drive: _Drive, **values: object) -> None:
    """Write to the run this driver holds, refreshing its heartbeat; lose quietly if not held."""
    result = await session.execute(
        update(VaultBulkImportRun)
        .where(
            col(VaultBulkImportRun.id) == drive.run_id,
            col(VaultBulkImportRun.owner_id) == drive.owner,
            col(VaultBulkImportRun.state) == BulkImportRunState.RUNNING.value,
        )
        .values(heartbeat_at=datetime.now(UTC), **values)
        .returning(col(VaultBulkImportRun.id))
        .execution_options(synchronize_session=False)
    )
    held = result.scalar_one_or_none() is not None
    await session.commit()
    if not held:
        raise _LeaseLostError


async def _beat(factory: async_sessionmaker[AsyncSession], drive: _Drive) -> None:
    """Refresh the heartbeat while the driver waits; stop once the lease is gone."""
    async with factory() as session:
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            try:
                await _touch(session, drive)
            except _LeaseLostError:
                return


async def _hand_on(
    session: AsyncSession, drive: _Drive, client: CreekVaultClient
) -> _Ending | None:
    """Handshake, then hand one bulk pass to the durable pipeline; why not, if it could not.

    Inside the account barrier, as every dial to this account's vault is: the
    handshake is a dial, and the pass is admitted to the queue under it. The
    climb itself is the pipeline's keyless continuation, which orders each of
    its own dials.
    """
    async with hold_account(session, drive.user_id):
        await ensure_account_live(session, drive.user_id)
        handshake = await client.handshake()
        if not handshake.available:
            return _Ending(BulkImportRunState.STOPPED, BulkImportStopReason.VAULT_UNAVAILABLE)
        if not client.supports(CreekCapability.PIPELINE):
            return _Ending(BulkImportRunState.STOPPED, BulkImportStopReason.PIPELINE_UNSUPPORTED)
        await drive_vault_pipeline(
            session, client, user_id=drive.user_id, trigger=VaultPipelineTrigger.BULK_IMPORT
        )
    await _touch(session, drive, dispatched_at=datetime.now(UTC))
    return None


async def _start_the_sweep(session: AsyncSession, user_id: int, client: CreekVaultClient) -> None:
    """Start or join the corpus sweep, when a standing yes covers it and writing waits.

    Guarded here rather than left to the sweep: without a yes it would record a
    refused sort the person never asked for, and with nothing pending it would
    record an empty one.
    """
    if not (await load_consent(session, user_id=user_id, source=INGEST_SOURCE)).granted:
        await session.commit()
        return
    if await corpus_sort_run.count_unsorted(session, user_id) == 0:
        await session.commit()
        return
    await corpus_sort_run.start_or_join(session, user_id=user_id, client=client)


async def _carry(session: AsyncSession, drive: _Drive, client: CreekVaultClient) -> _Ending:
    """Hand the pass on unless a previous driver already did, wait for it, then sweep."""
    if not drive.dispatched:
        ending = await _hand_on(session, drive, client)
        if ending is not None:
            return ending
    await wait_for_account_pipeline(drive.user_id)
    await _start_the_sweep(session, drive.user_id, client)
    return _COMPLETED


async def _finish(session: AsyncSession, drive: _Drive, ending: _Ending) -> None:
    """Close the run this driver holds, release its lease, and say how it ended."""
    await session.execute(
        update(VaultBulkImportRun)
        .where(
            col(VaultBulkImportRun.id) == drive.run_id,
            col(VaultBulkImportRun.owner_id) == drive.owner,
        )
        .values(
            state=ending.state.value,
            stop_reason=None if ending.reason is None else ending.reason.value,
            finished_at=datetime.now(UTC),
            owner_id=None,
            heartbeat_at=None,
        )
        .execution_options(synchronize_session=False)
    )
    await session.commit()
    logger.info(
        FINISHED_EVENT,
        extra={
            "user_id": drive.user_id,
            "run_id": drive.run_id,
            "state": ending.state.value,
            "stop_reason": None if ending.reason is None else ending.reason.value,
        },
    )


async def _on_refusal(session: AsyncSession, drive: _Drive, refusal: HTTPException) -> None:
    """Answer the account barrier refusing this driver, as the sort run does (#3675).

    A 401 is the account erased: its row went with it, and there is nothing to
    say. Anything else is the barrier unable to order egress, and the run fails
    after one line naming it, rather than going stale and being retried silently.
    """
    if refusal.status_code == status.HTTP_401_UNAUTHORIZED:
        return
    await session.rollback()
    logger.warning(ORDERING_REFUSED_EVENT, extra={"user_id": drive.user_id, "run_id": drive.run_id})
    await _finish(session, drive, _Ending(BulkImportRunState.FAILED))


async def _drive_one(
    factory: async_sessionmaker[AsyncSession],
    *,
    run_id: int,
    owner: str,
    client: CreekVaultClient,
) -> int | None:
    """Carry one run to its end in a session of its own; the account, once it has ended.

    Cancellation (a shutdown) is not caught, so the row stays running and is
    resumed. A lost lease ends this driver quietly. Any other fault marks the
    run failed and is re-raised for :func:`_forget` to note in ids only.
    """
    async with factory() as session:
        drive = await _prepare(session, run_id=run_id, owner=owner)
        if drive is None:
            return None
        heartbeat = asyncio.create_task(_beat(factory, drive))
        try:
            ending = await _carry(session, drive, client)
        except _LeaseLostError:
            return None
        except HTTPException as refusal:
            await _on_refusal(session, drive, refusal)
            return drive.user_id
        except Exception:
            await session.rollback()
            await _finish(session, drive, _Ending(BulkImportRunState.FAILED))
            raise
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
        await _finish(session, drive, ending)
        return drive.user_id


async def _drive(
    factory: async_sessionmaker[AsyncSession],
    *,
    run_id: int,
    owner: str,
    client: CreekVaultClient,
) -> None:
    """Carry one run to its end, then start the account's next queued run, if any."""
    user_id = await _drive_one(factory, run_id=run_id, owner=owner, client=client)
    if user_id is None:
        return
    async with factory() as session:
        promoted = await _promote(session, user_id)
    if promoted is not None:
        _spawn(factory, *promoted, client)


async def _resume_stale(
    session: AsyncSession,
    factory: async_sessionmaker[AsyncSession],
    resolve_client: VaultClientResolver,
) -> None:
    """Claim and restart every running row whose driver has gone stale."""
    result = await session.execute(
        select(VaultBulkImportRun).where(
            col(VaultBulkImportRun.state) == BulkImportRunState.RUNNING.value,
            or_(
                col(VaultBulkImportRun.heartbeat_at).is_(None),
                col(VaultBulkImportRun.heartbeat_at) <= datetime.now(UTC) - STALE_AFTER,
            ),
        )
    )
    for run in result.scalars().all():
        if run.id is None:
            continue
        owner = await _claim(session, run.id)
        if owner is not None:
            _spawn(factory, run.id, owner, await resolve_client(session, run.user_id))


async def _promote_waiting(
    session: AsyncSession,
    factory: async_sessionmaker[AsyncSession],
    resolve_client: VaultClientResolver,
) -> None:
    """Start the oldest queued run of every account that has none running."""
    result = await session.execute(
        select(col(VaultBulkImportRun.user_id))
        .where(col(VaultBulkImportRun.state) == BulkImportRunState.QUEUED.value)
        .distinct()
    )
    for user_id in result.scalars().all():
        promoted = await _promote(session, user_id)
        if promoted is not None:
            _spawn(factory, *promoted, await resolve_client(session, user_id))


async def resume_bulk_import_runs(
    factory: async_sessionmaker[AsyncSession], resolve_client: VaultClientResolver
) -> None:
    """Resume every run a dead worker left, and start every run whose turn has come.

    Called on the recovery loop, so a pass a deploy interrupted is finished
    without anybody uploading again. Two workers racing for one row meet in the
    compare-and-swaps of :func:`_claim` and :func:`_promote`; one wins.
    """
    async with factory() as session:
        await _resume_stale(session, factory, resolve_client)
        await _promote_waiting(session, factory, resolve_client)


async def wait_for_bulk_import_tasks() -> None:
    """Wait until no driver is running in this process; faults are noted, not raised."""
    while tasks := tuple(task for task in _TASKS.values() if not task.done()):
        await asyncio.gather(*tasks, return_exceptions=True)


async def close_bulk_import_tasks() -> None:
    """Cancel this process's drivers on shutdown; their rows stay running and resumable."""
    tasks = tuple(_TASKS.values())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    _TASKS.clear()
