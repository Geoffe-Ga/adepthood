"""Admin wallet idempotency races through independent PostgreSQL sessions.

SQLite coverage proves the ordinary replay path. These tests force both HTTP
requests to complete the replay lookup before either may mutate, exercising
the unique-index recovery path against the same database concurrency model as
production.
"""

from __future__ import annotations

import asyncio
from http import HTTPStatus
from typing import TYPE_CHECKING

import pytest
from sqlalchemy import func
from sqlmodel import col, select

from models.admin_balance_adjustment import AdminBalanceAdjustment
from models.user import User
from models.wallet_audit import REASON_ADMIN_ADJUSTMENT, WalletAudit
from routers import admin as admin_router
from tests.helpers.feedback_triage import Account, make_account

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from tests.integration.session_per_request import SessionPerRequest

pytestmark = pytest.mark.integration

_IDEMPOTENCY_KEY = "admin-adjustment-race"
_PARTIES = 2
_RENDEZVOUS_SECONDS = 2.0
_ONE_ROW = 1
_PRE_CHECK = "_recorded_adjustment"


def _hold_completed_pre_checks(
    monkeypatch: pytest.MonkeyPatch,
) -> list[AdminBalanceAdjustment | None]:
    """Hold the first two completed replay reads until both have missed."""
    real: Callable[..., Awaitable[AdminBalanceAdjustment | None]] = getattr(
        admin_router,
        _PRE_CHECK,
    )
    results: list[AdminBalanceAdjustment | None] = []
    arrived = 0
    both_missed = asyncio.Event()

    async def _held(*args: object, **kwargs: object) -> AdminBalanceAdjustment | None:
        nonlocal arrived
        found = await real(*args, **kwargs)
        arrived += 1
        results.append(found)
        if arrived <= _PARTIES:
            if arrived == _PARTIES:
                both_missed.set()
            await asyncio.wait_for(both_missed.wait(), timeout=_RENDEZVOUS_SECONDS)
        return found

    monkeypatch.setattr(admin_router, _PRE_CHECK, _held)
    return results


async def _seed(pair: SessionPerRequest) -> tuple[Account, Account, Account]:
    """Create one operator and two arbitrary targets outside request sessions."""
    async with pair.factory() as session:
        admin = await make_account(session, "balance-race-admin@example.com", admin=True)
        first = await make_account(session, "balance-race-first@example.com")
        second = await make_account(session, "balance-race-second@example.com")
    return admin, first, second


def _headers(admin: Account) -> dict[str, str]:
    return {**admin.headers, "X-Idempotency-Key": _IDEMPOTENCY_KEY}


async def _counts(pair: SessionPerRequest, admin_id: int) -> tuple[int, int]:
    async with pair.factory() as session:
        wallet = await session.scalar(
            select(func.count())
            .select_from(WalletAudit)
            .where(
                col(WalletAudit.actor_user_id) == admin_id,
                col(WalletAudit.reason) == REASON_ADMIN_ADJUSTMENT,
            )
        )
        adjustment = await session.scalar(
            select(func.count())
            .select_from(AdminBalanceAdjustment)
            .where(col(AdminBalanceAdjustment.actor_admin_id) == admin_id)
        )
    return int(wallet or 0), int(adjustment or 0)


@pytest.mark.asyncio
async def test_same_key_and_fingerprint_race_moves_wallet_once(
    pair: SessionPerRequest,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both requests succeed with one stable result and exactly one audit pair."""
    admin, target, _ = await _seed(pair)
    pre_checks = _hold_completed_pre_checks(monkeypatch)
    payload = {"delta": 7, "reason": "restore credits after duplicate debit"}

    first, second = await asyncio.gather(
        pair.client.post(
            f"/admin/users/{target.user_id}/tokens",
            json=payload,
            headers=_headers(admin),
        ),
        pair.client.post(
            f"/admin/users/{target.user_id}/tokens",
            json=payload,
            headers=_headers(admin),
        ),
    )

    assert [first.status_code, second.status_code] == [HTTPStatus.OK, HTTPStatus.OK]
    expected = {"user_id": target.user_id, "balance": 7}
    assert first.json() == second.json() == expected
    assert pre_checks[:_PARTIES] == [None] * _PARTIES
    async with pair.factory() as session:
        stored = await session.get(User, target.user_id)
        assert stored is not None
        assert stored.offering_balance == 7
    assert await _counts(pair, admin.user_id) == (_ONE_ROW, _ONE_ROW)


@pytest.mark.asyncio
async def test_same_key_different_target_race_conflicts_without_partial_movement(
    pair: SessionPerRequest,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One operation wins; the conflicting target and both audit tables stay atomic."""
    admin, first_target, second_target = await _seed(pair)
    pre_checks = _hold_completed_pre_checks(monkeypatch)
    payload = {"delta": 5, "reason": "resolve one support case"}

    responses = await asyncio.gather(
        pair.client.post(
            f"/admin/users/{first_target.user_id}/tokens",
            json=payload,
            headers=_headers(admin),
        ),
        pair.client.post(
            f"/admin/users/{second_target.user_id}/tokens",
            json=payload,
            headers=_headers(admin),
        ),
    )

    assert sorted(response.status_code for response in responses) == [
        HTTPStatus.OK,
        HTTPStatus.CONFLICT,
    ]
    assert pre_checks[:_PARTIES] == [None] * _PARTIES
    winner = next(response for response in responses if response.status_code == HTTPStatus.OK)
    loser = next(response for response in responses if response.status_code == HTTPStatus.CONFLICT)
    assert loser.json()["detail"] == "idempotency_key_reused"
    winning_id = int(winner.json()["user_id"])
    async with pair.factory() as session:
        balance_rows = await session.execute(
            select(User.id, User.offering_balance).where(
                col(User.id).in_([first_target.user_id, second_target.user_id])
            )
        )
        balances: dict[int, int] = {
            int(user_id): int(balance) for user_id, balance in balance_rows.tuples().all()
        }
    assert balances[winning_id] == 5
    losing_id = (
        second_target.user_id if winning_id == first_target.user_id else first_target.user_id
    )
    assert balances[losing_id] == 0
    assert await _counts(pair, admin.user_id) == (_ONE_ROW, _ONE_ROW)
