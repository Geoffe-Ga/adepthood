"""User-wallet mutations for BotMason metering.

The BotMason wallet has two buckets:

- ``monthly_messages_used`` / ``monthly_reset_date`` — a free allocation that
  rolls over at the start of every calendar month.
- ``offering_balance`` — paid / gifted credits with no expiry.

Every mutation in this module is expressed as a single atomic SQL statement
(``UPDATE … WHERE … RETURNING``) so concurrent requests can never overspend
either bucket.  The router layer is responsible for translating ``None``
returns into HTTP errors; the service only reports capacity outcomes.

Every mutation also stages a :class:`models.WalletAudit` row recording
``(actor_user_id, user_id, bucket, reason, delta, balance_before,
balance_after)`` (BUG-BM-011) so an operator can trace any change with
a single ``SELECT``.  The audit row is staged on the same session as
the mutation, so commit / rollback is atomic across both writes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from errors import bad_request, payment_required
from models.user import User
from models.wallet_audit import (
    BUCKET_MONTHLY,
    BUCKET_OFFERING,
    REASON_ADMIN_GRANT,
    REASON_SPEND_MONTHLY,
    REASON_SPEND_OFFERING,
    WalletAudit,
)
from services.usage import compute_next_reset, get_monthly_cap

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class _AuditEntry:
    """Bundled inputs for a single wallet-audit row.

    Grouping the seven scalar fields into one frozen dataclass keeps
    :func:`_stage_audit` under ruff's ``PLR0913`` argument-count cap
    while making each call site read like a structured record rather
    than a positional tuple.

    ``delta`` / ``balance_before`` / ``balance_after`` are typed
    :class:`Decimal` to match :class:`models.WalletAudit`'s ``NUMERIC``
    columns.  Today every wallet bucket is a whole-message count, so
    callers pass plain ``int`` literals — Python widens them to
    ``Decimal`` at construction without precision loss.  Typing the
    fields ``Decimal`` (rather than ``int``) means a future fractional-
    credit world cannot silently truncate at the dataclass boundary.
    """

    user_id: int
    actor_user_id: int
    bucket: str
    reason: str
    delta: Decimal
    balance_before: Decimal
    balance_after: Decimal


def _stage_audit(session: AsyncSession, entry: _AuditEntry) -> None:
    """Stage one ``WalletAudit`` row on the caller's session.

    The session.commit happens in the caller — the audit row lands in
    the same transaction as the bucket UPDATE so a rollback wipes
    both atomically.  ``Decimal`` values are stored verbatim because
    ``_AuditEntry`` already enforces the ``Decimal`` type at the
    dataclass boundary; the caller is responsible for constructing
    each value via ``Decimal(int)`` (no precision loss for whole
    numbers) or ``Decimal(str(...))`` (the only safe path for
    fractional inputs).
    """
    session.add(
        WalletAudit(
            user_id=entry.user_id,
            actor_user_id=entry.actor_user_id,
            bucket=entry.bucket,
            reason=entry.reason,
            delta=entry.delta,
            balance_before=entry.balance_before,
            balance_after=entry.balance_after,
        )
    )


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

    The reset event is logged for audit purposes (BUG-JOURNAL-018).
    """
    next_reset = compute_next_reset(now)
    result = await session.execute(
        update(User)
        .where(col(User.id) == user_id, col(User.monthly_reset_date) <= now)
        .values(monthly_messages_used=0, monthly_reset_date=next_reset)
    )
    if result.rowcount:  # type: ignore[attr-defined]
        logger.info(
            "Monthly usage reset for user_id=%s, next_reset=%s",
            user_id,
            next_reset.isoformat(),
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

    BUG-BM-011: every successful deduction stages a ``WalletAudit`` row on
    the same session so the spend is recoverable after the fact.  The
    actor is the same as ``user_id`` because spend always originates
    from the authenticated owner of the wallet.
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
        new_used, balance = int(monthly_row[0]), int(monthly_row[1])
        # ``new_used`` is the post-increment value, so the pre-mutation
        # count was ``new_used - 1``.  Recording the actual ``before`` /
        # ``after`` (rather than the delta only) means an operator
        # reconciling can spot a parallel write that interleaved
        # without re-deriving from arithmetic.
        _stage_audit(
            session,
            _AuditEntry(
                user_id=user_id,
                actor_user_id=user_id,
                bucket=BUCKET_MONTHLY,
                reason=REASON_SPEND_MONTHLY,
                delta=Decimal(1),
                balance_before=Decimal(new_used - 1),
                balance_after=Decimal(new_used),
            ),
        )
        return SpendResult(monthly_used=new_used, offering_balance=balance)

    balance_result = await session.execute(
        update(User)
        .where(col(User.id) == user_id, col(User.offering_balance) > 0)
        .values(offering_balance=col(User.offering_balance) - 1)
        .returning(col(User.monthly_messages_used), col(User.offering_balance))
    )
    balance_row = balance_result.first()
    if balance_row is not None:
        used, new_balance = int(balance_row[0]), int(balance_row[1])
        _stage_audit(
            session,
            _AuditEntry(
                user_id=user_id,
                actor_user_id=user_id,
                bucket=BUCKET_OFFERING,
                reason=REASON_SPEND_OFFERING,
                delta=Decimal(-1),
                balance_before=Decimal(new_balance + 1),
                balance_after=Decimal(new_balance),
            ),
        )
        return SpendResult(monthly_used=used, offering_balance=new_balance)

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


async def add_balance(
    session: AsyncSession,
    user_id: int,
    amount: int,
    *,
    actor_user_id: int | None = None,
) -> int | None:
    """Add ``amount`` credits to ``offering_balance`` and return the new total.

    The caller is expected to validate ``amount > 0`` so the service can stay
    focused on the DB mutation.  Returns ``None`` when the user does not exist
    so the caller can surface a 400.  Performs the addition in a single atomic
    SQL statement — no lost-update window between read and write.

    BUG-BM-011: a ``WalletAudit`` row is staged for every successful
    grant.  ``actor_user_id`` defaults to ``user_id`` for the legacy
    "user tops up their own wallet" path, but the admin endpoint
    overrides it with the granting admin's id so the audit row records
    the actor distinct from the recipient.
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
    new_balance_int = int(new_balance)
    _stage_audit(
        session,
        _AuditEntry(
            user_id=user_id,
            actor_user_id=actor_user_id if actor_user_id is not None else user_id,
            bucket=BUCKET_OFFERING,
            reason=REASON_ADMIN_GRANT,
            # ``balance_before`` is derived from the post-update value
            # (``new_balance_int - amount``).  This relies on the
            # ``UPDATE`` having applied the full ``amount`` -- which it
            # does, because there is no clamping in the SQL.
            delta=Decimal(amount),
            balance_before=Decimal(new_balance_int - amount),
            balance_after=Decimal(new_balance_int),
        ),
    )
    return new_balance_int
