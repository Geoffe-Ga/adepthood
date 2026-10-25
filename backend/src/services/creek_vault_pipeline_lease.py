"""Content-free durable ownership for a vault pipeline continuation.

A UUID grants one poller/climber the chain, independently of process-local task
maps. Callers supply the existing stale/heartbeat policy explicitly. This leaf
knows only account/run targets, enum state, timestamps and opaque tokens; it
never imports the pipeline orchestrator or accepts provider credentials.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import and_, or_, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import col, select

from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class LeaseTarget:
    """One exact account/run pair a continuation may own."""

    user_id: int
    run_id: int


class ContinuationOwnershipLostError(Exception):
    """Another recovery worker owns this continuation's durable chain."""


@dataclass(frozen=True)
class ContinuationLease:
    """Content-free ownership of the current row in one background chain."""

    user_id: int
    run_id: int
    claim_id: str


_CONTINUATION_LEASE: ContextVar[ContinuationLease | None] = ContextVar(
    "creek_vault_pipeline_continuation_lease", default=None
)


def ensure_owned_run(run: VaultPipelineRun) -> None:
    """A copied ORM row cannot grant or restore background ownership."""
    owned = _CONTINUATION_LEASE.get()
    if owned is not None and (
        run.user_id != owned.user_id or run.resume_claim_id != owned.claim_id
    ):
        raise ContinuationOwnershipLostError


async def refresh_owned_run(session: AsyncSession, run: VaultPipelineRun) -> None:
    """Inspect fresh persisted ownership before changing retry metadata."""
    await session.refresh(run)
    ensure_owned_run(run)


def track_owned_run(run: VaultPipelineRun) -> None:
    """Move the already-owned chain's anchor to a newly recorded rung."""
    owned = _CONTINUATION_LEASE.get()
    if owned is not None and run.id is not None:
        _CONTINUATION_LEASE.set(replace(owned, run_id=run.id))


async def verify_continuation_lease(session: AsyncSession) -> bool:
    """Release the ownership read before a dial, or stand down on a lost lease."""
    owned = _CONTINUATION_LEASE.get()
    if owned is None:
        return True
    found = await session.scalar(
        select(col(VaultPipelineRun.id)).where(
            col(VaultPipelineRun.id) == owned.run_id,
            col(VaultPipelineRun.user_id) == owned.user_id,
            col(VaultPipelineRun.resume_claim_id) == owned.claim_id,
        )
    )
    await session.commit()
    if found is None:
        raise ContinuationOwnershipLostError
    return True


async def release_resume_claim(
    factory: async_sessionmaker[AsyncSession],
    claim_id: str,
) -> None:
    """Best-effort release of every row in one owned recovery chain."""
    try:
        async with factory() as session:
            await session.execute(
                update(VaultPipelineRun)
                .where(col(VaultPipelineRun.resume_claim_id) == claim_id)
                .values(resume_claim_id=None, resume_claimed_at=None)
            )
            await session.commit()
    except SQLAlchemyError:
        _LOGGER.warning("creek vault pipeline could not release its startup claim")


async def heartbeat_resume_claim(
    factory: async_sessionmaker[AsyncSession],
    claim_id: str,
    interval: float,
) -> None:
    """Keep every row in a live recovery chain newer than the stale horizon."""
    while True:
        await asyncio.sleep(interval)
        try:
            async with factory() as session:
                await session.execute(
                    update(VaultPipelineRun)
                    .where(col(VaultPipelineRun.resume_claim_id) == claim_id)
                    .values(resume_claimed_at=datetime.now(UTC))
                )
                await session.commit()
        except SQLAlchemyError:
            _LOGGER.warning("creek vault pipeline could not renew its startup claim")


def _lease_available(stale_before: datetime) -> ColumnElement[bool]:
    """The existing bounded lease policy, shared by startup and normal handoff."""
    return or_(
        col(VaultPipelineRun.resume_claimed_at).is_(None),
        col(VaultPipelineRun.resume_claimed_at) <= stale_before,
    )


def _later_unfinished_anchor(user_id: int, run_id: int) -> ColumnElement[bool]:
    """A delayed terminal snapshot must not bypass a later active owner or attempt."""
    return (
        select(col(VaultPipelineRun.id))
        .where(
            col(VaultPipelineRun.user_id) == user_id,
            col(VaultPipelineRun.id) > run_id,
            col(VaultPipelineRun.outcome).in_(
                (VaultPipelineOutcome.QUEUED.value, VaultPipelineOutcome.ATTEMPTED.value)
            ),
            or_(
                col(VaultPipelineRun.outcome) == VaultPipelineOutcome.ATTEMPTED.value,
                col(VaultPipelineRun.resume_claim_id).is_not(None),
            ),
        )
        .correlate(None)
        .exists()
    )


def _continuation_claim_available(
    user_id: int, run_id: int, claim_id: str, stale_before: datetime
) -> ColumnElement[bool]:
    """Only active rows can be reclaimed; terminal history grants no stale token."""
    return or_(
        col(VaultPipelineRun.resume_claim_id) == claim_id,
        and_(
            col(VaultPipelineRun.outcome).in_(
                (VaultPipelineOutcome.QUEUED.value, VaultPipelineOutcome.ATTEMPTED.value)
            ),
            _lease_available(stale_before),
        ),
        and_(
            col(VaultPipelineRun.resume_claim_id).is_(None),
            ~_later_unfinished_anchor(user_id, run_id),
        ),
    )


async def claim_continuation_run(
    session: AsyncSession, target: LeaseTarget, claim_id: str, stale_after: timedelta
) -> bool:
    """CAS one exact owned-account row, including a terminal pending continuation."""
    now = datetime.now(UTC)
    result = await session.execute(
        update(VaultPipelineRun)
        .where(
            col(VaultPipelineRun.id) == target.run_id,
            col(VaultPipelineRun.user_id) == target.user_id,
            _continuation_claim_available(
                target.user_id, target.run_id, claim_id, now - stale_after
            ),
        )
        .values(resume_claim_id=claim_id, resume_claimed_at=now)
        .returning(col(VaultPipelineRun.id))
    )
    claimed = result.scalar_one_or_none() is not None
    await session.commit()
    return claimed


async def continuation_lease_present(
    session: AsyncSession, target: LeaseTarget, claim_id: str | None
) -> bool:
    """Validate a token already granted by a startup or handoff CAS."""
    if claim_id is None:
        return False
    run_id = await session.scalar(
        select(col(VaultPipelineRun.id)).where(
            col(VaultPipelineRun.id) == target.run_id,
            col(VaultPipelineRun.user_id) == target.user_id,
            col(VaultPipelineRun.resume_claim_id) == claim_id,
        )
    )
    await session.commit()
    return run_id is not None


async def claim_one_resumable_run(
    session: AsyncSession, stale_after: timedelta
) -> VaultPipelineRun | None:
    """Atomically lease the oldest unowned or stale persisted run."""
    now = datetime.now(UTC)
    stale_before = now - stale_after
    claim_id = str(uuid4())
    candidate = (
        select(col(VaultPipelineRun.id))
        .where(*_resumable_run_conditions(stale_before))
        .order_by(col(VaultPipelineRun.id))
        .limit(1)
        .scalar_subquery()
    )
    result = await session.execute(
        update(VaultPipelineRun)
        .where(col(VaultPipelineRun.id) == candidate)
        .where(*_resumable_run_conditions(stale_before))
        .values(resume_claim_id=claim_id, resume_claimed_at=now)
        .returning(VaultPipelineRun)
    )
    run = result.scalars().one_or_none()
    await session.commit()
    return run


def _resumable_run_conditions(stale_before: datetime) -> tuple[ColumnElement[bool], ...]:
    """Return the eligibility predicate shared by the candidate read and CAS."""
    return (
        col(VaultPipelineRun.outcome).in_(
            (
                VaultPipelineOutcome.QUEUED.value,
                VaultPipelineOutcome.ATTEMPTED.value,
            )
        ),
        col(VaultPipelineRun.trigger).is_not(None),
        _lease_available(stale_before),
    )


async def resumable_run_exists(session: AsyncSession, stale_after: timedelta) -> bool:
    """Distinguish an empty queue from losing one compare-and-swap race."""
    stale_before = datetime.now(UTC) - stale_after
    result = await session.execute(
        select(col(VaultPipelineRun.id)).where(*_resumable_run_conditions(stale_before)).limit(1)
    )
    exists = result.scalar_one_or_none() is not None
    await session.commit()
    return exists


def current_continuation_lease() -> ContinuationLease | None:
    """Return only the token already granted to the current background chain."""
    return _CONTINUATION_LEASE.get()


def move_owned_anchor(run_id: int) -> None:
    """Advance the same owned token to an adopted successor."""
    owned = _CONTINUATION_LEASE.get()
    if owned is not None:
        _CONTINUATION_LEASE.set(replace(owned, run_id=run_id))


@contextmanager
def owning_continuation(lease: ContinuationLease) -> Iterator[None]:
    """Install an already-granted token only for this background chain's lifetime."""
    token = _CONTINUATION_LEASE.set(lease)
    try:
        yield
    finally:
        _CONTINUATION_LEASE.reset(token)
