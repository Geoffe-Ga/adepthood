"""Wallet / usage router.

Every user gets ``BOTMASON_MONTHLY_CAP`` free message-credits per calendar month;
once spent, requests fall through to ``offering_balance`` (purchased / gifted
credits, no expiry). The conversational chat endpoints were retired in favour of
journal resonance — this router now only exposes the wallet surface
(``/user/balance``, ``/user/usage``, ``/user/balance/add``) that resonance and
its sibling features charge against. Wallet mechanics live in :mod:`services`.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from dependencies.auth import require_admin
from errors import forbidden
from models.user import User
from rate_limit import limiter
from routers.auth import get_current_user
from schemas.botmason import (
    BalanceAddRequest,
    BalanceAddResponse,
    BalanceResponse,
    UsageResponse,
)
from services import wallet as wallet_service
from services.usage import get_monthly_cap
from services.wallet import require_user_fresh, reset_monthly_usage_if_due

logger = logging.getLogger(__name__)

router = APIRouter(tags=["botmason"])


@router.get("/user/balance", response_model=BalanceResponse)
async def get_balance(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> BalanceResponse:
    """Return the current offering balance for the authenticated user."""
    user = await require_user_fresh(session, current_user)
    return BalanceResponse(balance=user.offering_balance)


@router.get("/user/usage", response_model=UsageResponse)
async def get_usage(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> UsageResponse:
    """Return the authenticated user's message-credit usage for the current month.

    BUG-BM-015: compute the monthly rollover without committing — a GET must not
    mutate persistent state. The UPDATE runs inside the session so the response
    reflects the post-reset values, but the transaction lifecycle stays
    consistent with the rest of the service (the rollover UPDATE is idempotent).
    """
    await reset_monthly_usage_if_due(session, current_user, datetime.now(UTC))
    # No session.commit() — BUG-BM-015.

    user = await require_user_fresh(session, current_user)
    cap = get_monthly_cap()
    return UsageResponse(
        monthly_messages_used=user.monthly_messages_used,
        monthly_messages_remaining=max(cap - user.monthly_messages_used, 0),
        monthly_cap=cap,
        monthly_reset_date=user.monthly_reset_date,
        offering_balance=user.offering_balance,
    )


@router.post("/user/balance/add", response_model=BalanceAddResponse)
@limiter.limit("5/minute")
async def add_balance(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: BalanceAddRequest,
    admin: Annotated[User, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> BalanceAddResponse:
    """Add credits to the calling admin's offering balance."""
    # ``require_admin`` only returns persisted rows, so ``admin.id`` is
    # guaranteed in practice. An ``assert`` would do, but CLAUDE.md forbids
    # bandit-S101 suppressions in production code -- this narrows the type for
    # mypy AND surfaces a clear error if the invariant ever breaks.
    if admin.id is None:
        msg = "require_admin returned an unpersisted user row"
        raise RuntimeError(msg)
    new_balance = await wallet_service.add_balance(
        session, admin.id, payload.amount, actor_user_id=admin.id
    )
    if new_balance is None:
        # TOCTOU: admin row existed when ``require_admin`` fetched it but was
        # deleted before the wallet UPDATE landed. Same failure mode as the
        # admin-gate, so the same status keeps the client's retry logic simple.
        raise forbidden("user_not_found")

    await session.commit()
    logger.info(
        "balance_added",
        extra={"admin_id": admin.id, "added": payload.amount, "new_balance": new_balance},
    )
    return BalanceAddResponse(balance=new_balance, added=payload.amount)
