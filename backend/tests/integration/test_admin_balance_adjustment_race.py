"""Admin wallet idempotency races through independent PostgreSQL sessions.

SQLite coverage proves the ordinary replay path. These tests force both HTTP
requests to complete the replay lookup before either may mutate, exercising
the unique-index recovery path against the same database concurrency model as
production.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from http import HTTPStatus
from time import monotonic
from typing import TYPE_CHECKING

import pytest
from httpx import Response
from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from bounds import INT32_MAX, INT32_MIN
from models.admin_balance_adjustment import AdminBalanceAdjustment
from models.user import User
from models.wallet_audit import REASON_ADMIN_ADJUSTMENT, WalletAudit
from routers import admin as admin_router
from services import account_deletion
from services.wallet import (
    WalletBalanceOutOfRangeError,
    claw_back_purchase_credit,
    grant_purchase_credit,
)
from tests.helpers.feedback_triage import Account, make_account

if TYPE_CHECKING:
    from tests.integration.session_per_request import SessionPerRequest

pytestmark = pytest.mark.integration

_IDEMPOTENCY_KEY = "admin-adjustment-race"
_PARTIES = 2
_RENDEZVOUS_SECONDS = 2.0
_ONE_ROW = 1
_PRE_CHECK = "_recorded_adjustment"
_ANONYMISE_SOURCES = "_anonymise_admin_adjustment_sources"
_APPLY_ADJUSTMENT = "_apply_balance_adjustment"
_LOCK_ADJUSTMENT_USERS = "_lock_adjustment_users"
_LOCK_WAIT_SECONDS = 2.0


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


async def _request_is_blocked_by(
    pair: SessionPerRequest,
    *,
    backend_pid: int,
    request: asyncio.Task[Response],
) -> bool:
    """Observe a real PostgreSQL lock wait, not timing alone."""
    deadline = monotonic() + _LOCK_WAIT_SECONDS
    while monotonic() < deadline:
        async with pair.factory() as observer:
            blocker_count = await observer.scalar(
                select(func.cardinality(func.pg_blocking_pids(backend_pid)))
            )
        if int(blocker_count or 0) > 0:
            return True
        if request.done():
            return False
        await asyncio.sleep(0.01)
    return False


@pytest.mark.asyncio
async def test_self_deleting_admin_cannot_insert_source_ip_after_redaction(
    pair: SessionPerRequest,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Erasure and adjustment serialize on the actor before source-IP redaction."""
    admin, target, _ = await _seed(pair)
    redaction_finished = asyncio.Event()
    release_deletion = asyncio.Event()
    adjustment_entered = asyncio.Event()
    adjustment_pid: list[int] = []

    real_anonymise: Callable[..., Awaitable[None]] = getattr(
        account_deletion,
        _ANONYMISE_SOURCES,
    )
    real_apply: Callable[..., Awaitable[object]] = getattr(
        admin_router,
        _APPLY_ADJUSTMENT,
    )

    async def _hold_after_redaction(*args: object, **kwargs: object) -> None:
        await real_anonymise(*args, **kwargs)
        redaction_finished.set()
        await release_deletion.wait()

    async def _observe_adjustment(session: AsyncSession, command: object) -> object:
        pid = await session.scalar(select(func.pg_backend_pid()))
        adjustment_pid.append(int(pid))
        adjustment_entered.set()
        return await real_apply(session, command)

    monkeypatch.setattr(
        account_deletion,
        _ANONYMISE_SOURCES,
        _hold_after_redaction,
    )
    monkeypatch.setattr(admin_router, _APPLY_ADJUSTMENT, _observe_adjustment)

    deleting = asyncio.create_task(
        pair.client.request(
            "DELETE",
            "/users/me",
            json={"confirm_email": admin.email},
            headers=admin.headers,
        )
    )
    await asyncio.wait_for(redaction_finished.wait(), timeout=_LOCK_WAIT_SECONDS)
    adjusting = asyncio.create_task(
        pair.client.post(
            f"/admin/users/{target.user_id}/tokens",
            json={"delta": 1, "reason": "race against operator erasure"},
            headers=admin.headers,
        )
    )
    await asyncio.wait_for(adjustment_entered.wait(), timeout=_LOCK_WAIT_SECONDS)

    blocked = await _request_is_blocked_by(
        pair,
        backend_pid=adjustment_pid[0],
        request=adjusting,
    )
    release_deletion.set()
    deleted, adjusted = await asyncio.gather(deleting, adjusting)

    assert blocked, "the adjustment never waited on the erasure's actor-row lock"
    assert deleted.status_code == HTTPStatus.OK
    assert adjusted.status_code == HTTPStatus.FORBIDDEN
    assert adjusted.json() == {"detail": "user_not_found"}
    async with pair.factory() as session:
        leaked = await session.scalar(
            select(func.count())
            .select_from(AdminBalanceAdjustment)
            .where(col(AdminBalanceAdjustment.target_user_id) == target.user_id)
        )
    assert int(leaked or 0) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("boundary", "mutation"),
    [
        (INT32_MAX, grant_purchase_credit),
        (INT32_MIN, claw_back_purchase_credit),
    ],
)
async def test_admin_boundary_cannot_poison_shared_wallet_mutations(
    pair: SessionPerRequest,
    boundary: int,
    mutation: Callable[..., Awaitable[int | None]],
) -> None:
    """Exact endpoint bounds remain stored while a later paid mutation refuses safely."""
    admin, target, _ = await _seed(pair)
    adjusted = await pair.client.post(
        f"/admin/users/{target.user_id}/tokens",
        json={"delta": boundary, "reason": "exercise the storage boundary"},
        headers=admin.headers,
    )
    assert adjusted.status_code == HTTPStatus.OK, adjusted.text
    assert adjusted.json()["balance"] == boundary

    async with pair.factory() as session:
        with pytest.raises(WalletBalanceOutOfRangeError):
            await mutation(session, target.user_id, 1)
        await session.rollback()

    async with pair.factory() as session:
        stored = await session.get(User, target.user_id)
        audit_count = await session.scalar(
            select(func.count())
            .select_from(WalletAudit)
            .where(col(WalletAudit.user_id) == target.user_id)
        )
    assert stored is not None
    assert stored.offering_balance == boundary
    assert int(audit_count or 0) == _ONE_ROW


@pytest.mark.asyncio
async def test_admins_adjusting_each_other_lock_users_in_the_same_order(
    pair: SessionPerRequest,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reciprocal adjustments both commit instead of forming a circular row-lock wait."""
    async with pair.factory() as session:
        first = await make_account(session, "balance-cross-first@example.com", admin=True)
        second = await make_account(session, "balance-cross-second@example.com", admin=True)

    real_lock: Callable[..., Awaitable[None]] = getattr(
        admin_router,
        _LOCK_ADJUSTMENT_USERS,
    )
    arrived = 0
    both_started = asyncio.Event()

    async def _start_together(*args: object, **kwargs: object) -> None:
        nonlocal arrived
        arrived += 1
        if arrived == _PARTIES:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), timeout=_RENDEZVOUS_SECONDS)
        await real_lock(*args, **kwargs)

    monkeypatch.setattr(admin_router, _LOCK_ADJUSTMENT_USERS, _start_together)

    first_response, second_response = await asyncio.wait_for(
        asyncio.gather(
            pair.client.post(
                f"/admin/users/{second.user_id}/tokens",
                json={"delta": 11, "reason": "first operator corrects second"},
                headers=first.headers,
            ),
            pair.client.post(
                f"/admin/users/{first.user_id}/tokens",
                json={"delta": 7, "reason": "second operator corrects first"},
                headers=second.headers,
            ),
        ),
        timeout=_LOCK_WAIT_SECONDS * 3,
    )

    assert first_response.status_code == HTTPStatus.OK, first_response.text
    assert second_response.status_code == HTTPStatus.OK, second_response.text
    assert await _counts(pair, first.user_id) == (_ONE_ROW, _ONE_ROW)
    assert await _counts(pair, second.user_id) == (_ONE_ROW, _ONE_ROW)
    async with pair.factory() as session:
        rows = await session.execute(
            select(User.id, User.offering_balance)
            .where(col(User.id).in_([first.user_id, second.user_id]))
            .order_by(col(User.id))
        )
        balances = {int(user_id): int(balance) for user_id, balance in rows.tuples().all()}
    assert balances == {first.user_id: 7, second.user_id: 11}


@pytest.mark.asyncio
async def test_role_revoked_after_dependency_load_is_refused_under_lock(
    pair: SessionPerRequest,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The lock query refreshes cached authority before any wallet mutation."""
    admin, target, _ = await _seed(pair)
    apply_entered = asyncio.Event()
    continue_apply = asyncio.Event()
    real_apply: Callable[..., Awaitable[object]] = getattr(
        admin_router,
        _APPLY_ADJUSTMENT,
    )

    async def _pause_after_dependency_load(*args: object, **kwargs: object) -> object:
        apply_entered.set()
        await continue_apply.wait()
        return await real_apply(*args, **kwargs)

    monkeypatch.setattr(admin_router, _APPLY_ADJUSTMENT, _pause_after_dependency_load)
    adjusting = asyncio.create_task(
        pair.client.post(
            f"/admin/users/{target.user_id}/tokens",
            json={"delta": 9, "reason": "must recheck current authority"},
            headers=admin.headers,
        )
    )
    await asyncio.wait_for(apply_entered.wait(), timeout=_LOCK_WAIT_SECONDS)
    async with pair.factory() as revoker:
        await revoker.execute(
            update(User).where(col(User.id) == admin.user_id).values(is_admin=False)
        )
        await revoker.commit()
    continue_apply.set()
    response = await asyncio.wait_for(adjusting, timeout=_LOCK_WAIT_SECONDS)

    assert response.status_code == HTTPStatus.FORBIDDEN
    assert response.json() == {"detail": "admin_required"}
    async with pair.factory() as session:
        stored = await session.get(User, target.user_id)
        audit_count = await session.scalar(
            select(func.count())
            .select_from(WalletAudit)
            .where(col(WalletAudit.user_id) == target.user_id)
        )
    assert stored is not None
    assert stored.offering_balance == 0
    assert int(audit_count or 0) == 0
