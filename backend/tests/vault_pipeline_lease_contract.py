"""The same explicit lease SQL/CAS contract for SQLite and migrated Postgres.

Expected results describe ownership policy, independently of the SQL expression.
Every case evaluates the real predicate and then the real committing UPDATE;
rejected claims must leave the previous owner and timestamp untouched.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, tzinfo
from typing import Literal
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.user import User
from models.vault_pipeline_run import VaultPipelineOutcome as Outcome
from models.vault_pipeline_run import VaultPipelineRun
from services import creek_vault_pipeline_lease as lease
from services.creek_vault_pipeline_lease import LeaseTarget, claim_continuation_run
from services.creek_vault_pipeline_lease import (
    _continuation_claim_available as continuation_claim_available,
)
from services.creek_vault_pipeline_lease import (
    _later_unfinished_anchor as later_unfinished_anchor,
)

_NOW = datetime(2026, 10, 25, 8, tzinfo=UTC)
_STALE_AFTER = timedelta(minutes=2)
_CUTOFF = _NOW - _STALE_AFTER
_SELF = "11111111-1111-4111-8111-111111111111"
_FOREIGN = "22222222-2222-4222-8222-222222222222"
_LIVE = timedelta(microseconds=1)
_STALE = -_LIVE


class _FixedClock(datetime):
    @classmethod
    def now(cls, tz: tzinfo | None = None) -> _FixedClock:
        """Keep both predicate evaluation and CAS at the exact boundary."""
        return cls.fromtimestamp(_NOW.timestamp(), tz)


@dataclass(frozen=True)
class ClaimCase:
    """One target ownership/state and its manually specified admission decision."""

    name: str
    outcome: Outcome
    token: str | None
    age: timedelta | None
    allowed: bool
    later_anchor: bool = False
    target: Literal["correct", "other-user", "missing-run"] = "correct"


CLAIM_CASES = (
    ClaimCase("queued-unowned", Outcome.QUEUED, None, None, True),
    ClaimCase("attempted-unowned", Outcome.ATTEMPTED, None, None, True),
    ClaimCase("terminal-first-entry", Outcome.COMPLETED, None, None, True),
    ClaimCase("queued-current-owner", Outcome.QUEUED, _SELF, _LIVE, True),
    ClaimCase("attempted-current-owner", Outcome.ATTEMPTED, _SELF, _LIVE, True),
    ClaimCase("terminal-current-owner-beside-anchor", Outcome.COMPLETED, _SELF, _LIVE, True, True),
    ClaimCase("queued-foreign-live", Outcome.QUEUED, _FOREIGN, _LIVE, False),
    ClaimCase("attempted-foreign-live", Outcome.ATTEMPTED, _FOREIGN, _LIVE, False),
    ClaimCase("queued-foreign-stale", Outcome.QUEUED, _FOREIGN, _STALE, True),
    ClaimCase("attempted-foreign-stale", Outcome.ATTEMPTED, _FOREIGN, _STALE, True),
    ClaimCase("queued-cutoff-equal", Outcome.QUEUED, _FOREIGN, timedelta(), True),
    ClaimCase("attempted-cutoff-equal", Outcome.ATTEMPTED, _FOREIGN, timedelta(), True),
    ClaimCase("terminal-foreign-live", Outcome.COMPLETED, _FOREIGN, _LIVE, False),
    ClaimCase("terminal-foreign-stale", Outcome.COMPLETED, _FOREIGN, _STALE, False),
    ClaimCase("terminal-foreign-cutoff-equal", Outcome.COMPLETED, _FOREIGN, timedelta(), False),
    ClaimCase("failed-first-entry", Outcome.FAILED, None, None, True),
    ClaimCase("ambiguous-stale-token", Outcome.AMBIGUOUS, _FOREIGN, _STALE, False),
    ClaimCase("incomplete-current-owner", Outcome.INCOMPLETE, _SELF, _LIVE, True),
    ClaimCase("wrong-account", Outcome.ATTEMPTED, None, None, False, target="other-user"),
    ClaimCase("missing-run", Outcome.ATTEMPTED, None, None, False, target="missing-run"),
)


@dataclass(frozen=True)
class AnchorCase:
    """A neighboring row that may prevent a terminal first-entry split."""

    name: str
    outcome: Outcome
    token: str | None
    blocks: bool
    relation: Literal["later", "earlier", "other-user"] = "later"


ANCHOR_CASES = (
    AnchorCase("attempted-owned", Outcome.ATTEMPTED, _FOREIGN, True),
    AnchorCase("attempted-awaiting-recovery", Outcome.ATTEMPTED, None, True),
    AnchorCase("queued-owned", Outcome.QUEUED, _FOREIGN, True),
    AnchorCase("queued-unowned-adoptable", Outcome.QUEUED, None, False),
    AnchorCase("completed-owned", Outcome.COMPLETED, _FOREIGN, False),
    AnchorCase("failed-owned", Outcome.FAILED, _FOREIGN, False),
    AnchorCase("ambiguous-unowned", Outcome.AMBIGUOUS, None, False),
    AnchorCase("incomplete-owned", Outcome.INCOMPLETE, _FOREIGN, False),
    AnchorCase("earlier-active", Outcome.ATTEMPTED, _FOREIGN, False, "earlier"),
    AnchorCase("other-account-active", Outcome.ATTEMPTED, _FOREIGN, False, "other-user"),
)


async def _users(session: AsyncSession) -> tuple[int, int]:
    """Seed real accounts so account-scoped CAS runs under foreign keys."""
    users = [User(email=f"lease-{uuid4()}@example.test", password_hash="x") for _ in range(2)]
    session.add_all(users)
    await session.flush()
    first, second = (user.id for user in users)
    assert isinstance(first, int)
    assert isinstance(second, int)
    return first, second


def _row(user_id: int, case: ClaimCase, *, stage: str = "classify") -> VaultPipelineRun:
    """Build only valid lease pairs and lifecycle attempt counts."""
    return VaultPipelineRun(
        user_id=user_id,
        stage=stage,
        outcome=case.outcome.value,
        attempt_count=0 if case.outcome is Outcome.QUEUED else 1,
        resume_claim_id=case.token,
        resume_claimed_at=None if case.age is None else _CUTOFF + case.age,
        fragments_seen=0,
        fragments_touched=0,
        fragments_lost=0,
    )


async def _assert_cas(
    session: AsyncSession, row: VaultPipelineRun, target: LeaseTarget, *, allowed: bool
) -> None:
    """Inspect the actual UPDATE result, unchanged loser, and released transaction."""
    await session.refresh(row)
    original = row.resume_claim_id, row.resume_claimed_at
    assert await claim_continuation_run(session, target, _SELF, _STALE_AFTER) is allowed
    assert not session.in_transaction()
    await session.refresh(row)
    if allowed:
        assert row.resume_claim_id == _SELF
        assert row.resume_claimed_at is not None
        assert row.resume_claimed_at.replace(tzinfo=UTC) == _NOW
    else:
        assert (row.resume_claim_id, row.resume_claimed_at) == original
    await session.commit()
    assert not session.in_transaction()


async def assert_claim_contract(
    session: AsyncSession, case: ClaimCase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Test the SQL filter and its real exact-account/run CAS on either dialect."""
    monkeypatch.setattr(lease, "datetime", _FixedClock)
    user_id, other_user_id = await _users(session)
    row = _row(user_id, case)
    session.add(row)
    await session.flush()
    assert row.id is not None
    if case.later_anchor:
        session.add(
            _row(
                user_id,
                ClaimCase("anchor", Outcome.ATTEMPTED, _FOREIGN, _LIVE, False),
                stage="temporal",
            )
        )
    await session.commit()
    target = LeaseTarget(
        other_user_id if case.target == "other-user" else user_id,
        row.id + 1 if case.target == "missing-run" else row.id,
    )
    found = await session.scalar(
        select(col(VaultPipelineRun.id)).where(
            col(VaultPipelineRun.id) == target.run_id,
            col(VaultPipelineRun.user_id) == target.user_id,
            continuation_claim_available(target.user_id, target.run_id, _SELF, _CUTOFF),
        )
    )
    assert (found is not None) is case.allowed
    await _assert_cas(session, row, target, allowed=case.allowed)


async def assert_anchor_contract(
    session: AsyncSession, case: AnchorCase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Test the uncorrelated EXISTS and terminal CAS without bypassing model checks."""
    monkeypatch.setattr(lease, "datetime", _FixedClock)
    user_id, other_user_id = await _users(session)
    terminal = _row(user_id, ClaimCase("terminal", Outcome.COMPLETED, None, None, True))
    neighbor = _row(
        other_user_id if case.relation == "other-user" else user_id,
        ClaimCase("neighbor", case.outcome, case.token, _LIVE if case.token else None, False),
        stage="temporal",
    )
    ordered = [neighbor, terminal] if case.relation == "earlier" else [terminal, neighbor]
    for row in ordered:
        session.add(row)
        await session.flush()
    await session.commit()
    assert terminal.id is not None
    assert (
        await session.scalar(select(later_unfinished_anchor(user_id, terminal.id))) is case.blocks
    )
    await _assert_cas(session, terminal, LeaseTarget(user_id, terminal.id), allowed=not case.blocks)
