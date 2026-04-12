"""User-wallet mutations for BotMason metering.

The BotMason wallet has two buckets:

- ``monthly_messages_used`` / ``monthly_reset_date`` — a free allocation that
  rolls over at the start of every calendar month.
- ``offering_balance`` — paid / gifted credits with no expiry.

Every mutation in this module is expressed as a single atomic SQL statement
(``UPDATE … WHERE … RETURNING``) so concurrent requests can never overspend
either bucket.  The router layer is responsible for translating ``None``
returns into HTTP errors; the service only reports capacity outcomes.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from errors import bad_request, payment_required
from models.user import User
from services.usage import compute_next_reset, get_monthly_cap


@dataclass(frozen=True)
class SpendResult:
    """Outcome of a successful wallet deduction.

    ``monthly_used`` is the post-update value of ``monthly_messages_used``
    (useful for computing ``remaining_messages``); ``offering_balance`` is the
    post-update paid-credit balance.  Both fields are stable references to the
    row as seen by the spending transaction — concurrent spenders observe
    their own totals, never someone else's mid-flight value.
    """

    monthly_used: int
    offering_balance: int


async def get_user_fresh(session: AsyncSession, user_id: int) -> User | None:
    """Return the user row, always reading fresh from the database.

    ``populate_existing=True`` forces SQLAlchemy to refresh any cached instance
    on the session so callers that need post-commit values (e.g. the updated
    ``monthly_reset_date`` after a rollover) always see the latest row.
    Returns ``None`` when the user does not exist so callers can decide how
    to shape the HTTP response.
    """
    result = await session.execute(
        select(User).where(User.id == user_id).execution_options(populate_existing=True)
    )
    return result.scalars().first()


async def reset_monthly_usage_if_due(
    session: AsyncSession,
    user_id: int,
    now: datetime,
) -> None:
    """Atomically roll the monthly counter over when the reset date has passed.

    The conditional WHERE clause makes this idempotent under concurrency: if
    two requests race through the boundary, the second one's predicate no
    longer matches (the first request has already advanced
    ``monthly_reset_date`` to next month) and the second UPDATE is a no-op.
    """
    next_reset = compute_next_reset(now)
    await session.execute(
        update(User)
        .where(col(User.id) == user_id, col(User.monthly_reset_date) <= now)
        .values(monthly_messages_used=0, monthly_reset_date=next_reset)
    )


async def spend_one_message(
    session: AsyncSession,
    user_id: int,
    monthly_cap: int,
) -> SpendResult | None:
    """Consume exactly one BotMason message from whichever wallet has capacity.

    Returns a :class:`SpendResult` after the deduction, or ``None`` when both
    wallets are empty (caller should return 402).  The free monthly allocation
    is drained first; only once it is at the cap do we touch the paid
    ``offering_balance``.  Each branch is a single atomic
    ``UPDATE … WHERE … RETURNING`` so concurrent requests can never overspend.
    """
    monthly_result = await session.execute(
        update(User)
        .where(
            col(User.id) == user_id,
            col(User.monthly_messages_used) < monthly_cap,
        )
        .values(monthly_messages_used=col(User.monthly_messages_used) + 1)
        .returning(col(User.monthly_messages_used), col(User.offering_balance))
    )
    monthly_row = monthly_result.first()
    if monthly_row is not None:
        return SpendResult(monthly_used=int(monthly_row[0]), offering_balance=int(monthly_row[1]))

    balance_result = await session.execute(
        update(User)
        .where(col(User.id) == user_id, col(User.offering_balance) > 0)
        .values(offering_balance=col(User.offering_balance) - 1)
        .returning(col(User.monthly_messages_used), col(User.offering_balance))
    )
    balance_row = balance_result.first()
    if balance_row is not None:
        return SpendResult(monthly_used=int(balance_row[0]), offering_balance=int(balance_row[1]))

    return None


async def require_user_fresh(session: AsyncSession, user_id: int) -> User:
    """Return the user row or raise ``400 user_not_found``.

    Convenience wrapper over :func:`get_user_fresh` for HTTP endpoints that
    treat a missing user row as a 400 (the authenticated identity should
    always resolve to a real row — a ``None`` here means the account was
    deleted mid-request).
    """
    user = await get_user_fresh(session, user_id)
    if user is None:
        raise bad_request("user_not_found")
    return user


async def preflight_deduction(session: AsyncSession, user_id: int) -> SpendResult:
    """Roll over the monthly counter and deduct one BotMason message.

    Shared pre-flight for the streaming and non-streaming chat endpoints.
    Raises ``400 user_not_found`` if the authenticated user disappeared
    between auth and spend and ``402 insufficient_offerings`` when neither
    wallet has capacity.  Returns the post-deduction :class:`SpendResult`
    otherwise.
    """
    await reset_monthly_usage_if_due(session, user_id, datetime.now(UTC))

    spent = await spend_one_message(session, user_id, get_monthly_cap())
    if spent is not None:
        return spent

    if await get_user_fresh(session, user_id) is None:
        raise bad_request("user_not_found")
    raise payment_required("insufficient_offerings")


async def add_balance(session: AsyncSession, user_id: int, amount: int) -> int | None:
    """Add ``amount`` credits to ``offering_balance`` and return the new total.

    The caller is expected to validate ``amount > 0`` so the service can stay
    focused on the DB mutation.  Returns ``None`` when the user does not exist
    so the caller can surface a 400.  Performs the addition in a single atomic
    SQL statement — no lost-update window between read and write.
    """
    result = await session.execute(
        update(User)
        .where(col(User.id) == user_id)
        .values(offering_balance=col(User.offering_balance) + amount)
        .returning(col(User.offering_balance))
    )
    new_balance = result.scalar()
    if new_balance is None:
        return None
    return int(new_balance)
