"""User-wallet mutations for BotMason metering.

The BotMason wallet has two buckets:

- ``monthly_messages_used`` / ``monthly_reset_date`` — a free allocation that
  rolls over at the start of every calendar month.
- ``offering_balance`` — paid / gifted credits with no expiry.

The spend and grant mutations are each expressed as a single atomic SQL
statement (``UPDATE … WHERE … RETURNING``) so concurrent requests can never
overspend either bucket.  The monthly-usage reset is the exception: it reads
the row first (to snapshot the pre-reset count for the audit log) and then
issues a guarded ``UPDATE … WHERE monthly_reset_date <= now`` without a
``RETURNING`` clause — the ``WHERE`` predicate still makes the reset
exactly-once.  The router layer is responsible for translating ``None``
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
from typing import Any, cast

from sqlalchemy import CursorResult, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from errors import bad_request, payment_required
from models.user import User
from models.wallet_audit import (
    BUCKET_MONTHLY,
    BUCKET_OFFERING,
    REASON_ADMIN_GRANT,
    REASON_GUMROAD_PURCHASE,
    REASON_GUMROAD_REFUND,
    REASON_MONTHLY_RESET,
    REASON_REFUND_NO_NOTES,
    REASON_SELF_GRANT,
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

    ``bucket`` records which side of the wallet actually paid
    (``BUCKET_MONTHLY`` or ``BUCKET_OFFERING``).  It exists because a refund
    cannot re-derive it: the spend drains monthly first, so a caller at their
    monthly cap paid with a credit while their monthly counter is *also*
    non-zero, and a refund guessing from the balances alone would hand back a
    free slot instead of the credit it took.
    """

    monthly_used: int
    offering_balance: int
    bucket: str


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

    The reset event is logged for audit purposes (BUG-JOURNAL-018) and
    -- when it actually fires -- staged as a ``WalletAudit`` row with
    reason ``REASON_MONTHLY_RESET`` so the every-wallet-mutation-audited
    contract holds across rollover boundaries.  We snapshot
    ``monthly_messages_used`` *before* the ``UPDATE`` so the audit row
    can record the pre-reset count without a second round-trip.  A
    concurrent spender between the read and the update at most
    under-reports ``balance_before`` by one — acceptable for a
    forensic log; the ``UPDATE``'s WHERE predicate still ensures the
    reset itself is exactly-once.
    """
    pre_reset = await get_user_fresh(session, user_id)
    if pre_reset is None:
        return
    # Snapshot the pre-reset count into a primitive *before* the
    # ``UPDATE`` runs.  SQLAlchemy's identity-map auto-refresh would
    # otherwise overwrite ``pre_reset.monthly_messages_used`` with the
    # post-update value (0) before we get to use it for the audit row.
    before = int(pre_reset.monthly_messages_used)
    next_reset = compute_next_reset(now)
    # ``synchronize_session=False`` skips SQLAlchemy's Python-side
    # WHERE evaluator.  Loading ``pre_reset`` puts the row in the
    # session's identity map; without this flag the evaluator would
    # run the ``monthly_reset_date <= now`` comparison against the
    # in-memory object, which on SQLite raises
    # ``can't compare offset-naive and offset-aware datetimes`` because
    # the persisted column is timezone-naive there.  ``False`` tells
    # SA to issue the UPDATE through SQL only — exactly what the
    # idempotent ``WHERE`` predicate already provides.
    result = await session.execute(
        update(User)
        .where(col(User.id) == user_id, col(User.monthly_reset_date) <= now)
        .values(monthly_messages_used=0, monthly_reset_date=next_reset)
        .execution_options(synchronize_session=False)
    )
    if not cast("CursorResult[Any]", result).rowcount:
        return
    logger.info(
        "Monthly usage reset for user_id=%s, next_reset=%s",
        user_id,
        next_reset.isoformat(),
    )
    _stage_audit(
        session,
        _AuditEntry(
            user_id=user_id,
            actor_user_id=user_id,
            bucket=BUCKET_MONTHLY,
            reason=REASON_MONTHLY_RESET,
            # ``delta`` is the negative drop in ``monthly_messages_used``
            # (post = 0; pre = ``before``).  Recording it as a negative
            # number keeps reconcilers' arithmetic uniform with the
            # spend rows (which are positive deltas on the same bucket).
            delta=Decimal(-before),
            balance_before=Decimal(before),
            balance_after=Decimal(0),
        ),
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
        return SpendResult(monthly_used=new_used, offering_balance=balance, bucket=BUCKET_MONTHLY)

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
        return SpendResult(monthly_used=used, offering_balance=new_balance, bucket=BUCKET_OFFERING)

    return None


async def _reverse_monthly_spend(session: AsyncSession, user_id: int) -> SpendResult | None:
    """Give one monthly slot back, or ``None`` when there is none to give back.

    The ``> 0`` predicate is what keeps the counter off negative numbers: a
    refund is only ever a reversal, so a caller holding a stale
    :class:`SpendResult` (or one whose spend was already rolled back) buys
    nothing rather than manufacturing free capacity.
    """
    result = await session.execute(
        update(User)
        .where(col(User.id) == user_id, col(User.monthly_messages_used) > 0)
        .values(monthly_messages_used=col(User.monthly_messages_used) - 1)
        .returning(col(User.monthly_messages_used), col(User.offering_balance))
    )
    row = result.first()
    if row is None:
        return None
    new_used, balance = int(row[0]), int(row[1])
    _stage_audit(
        session,
        _AuditEntry(
            user_id=user_id,
            actor_user_id=user_id,
            bucket=BUCKET_MONTHLY,
            reason=REASON_REFUND_NO_NOTES,
            # The monthly bucket counts *up*, so returning a slot is a
            # negative delta and the spend/refund pair sums to zero.
            delta=Decimal(-1),
            balance_before=Decimal(new_used + 1),
            balance_after=Decimal(new_used),
        ),
    )
    return SpendResult(monthly_used=new_used, offering_balance=balance, bucket=BUCKET_MONTHLY)


async def _reverse_offering_spend(session: AsyncSession, user_id: int) -> SpendResult | None:
    """Put one paid credit back, or ``None`` when the user row is gone."""
    result = await session.execute(
        update(User)
        .where(col(User.id) == user_id)
        .values(offering_balance=col(User.offering_balance) + 1)
        .returning(col(User.monthly_messages_used), col(User.offering_balance))
    )
    row = result.first()
    if row is None:
        return None
    used, new_balance = int(row[0]), int(row[1])
    _stage_audit(
        session,
        _AuditEntry(
            user_id=user_id,
            actor_user_id=user_id,
            bucket=BUCKET_OFFERING,
            reason=REASON_REFUND_NO_NOTES,
            delta=Decimal(1),
            balance_before=Decimal(new_balance - 1),
            balance_after=Decimal(new_balance),
        ),
    )
    return SpendResult(monthly_used=used, offering_balance=new_balance, bucket=BUCKET_OFFERING)


async def refund_one_message(
    session: AsyncSession, user_id: int, spent: SpendResult
) -> SpendResult:
    """Reverse ``spent`` into the bucket it actually came from.

    Used when a metered pass completes but delivers the writer nothing they
    can read: the provider call really happened and really cost us, yet the
    person on the other side got silence, and billing them for that is the one
    outcome with no defence.  Deliberately does NOT commit — the caller owns
    the transaction boundary, which is what lets the reversal land atomically
    beside the usage record and any rows the same pass did produce (a plain
    ``rollback`` would erase those too, including our own record of what the
    provider charged us).

    Returns the post-refund balances, or ``spent`` unchanged when there was
    nothing to reverse (the row vanished, or the counter is already at zero) —
    a refund that cannot happen must never invent capacity, and the caller's
    response then simply reports the balances it already had.
    """
    reverse = _reverse_monthly_spend if spent.bucket == BUCKET_MONTHLY else _reverse_offering_spend
    refunded = await reverse(session, user_id)
    if refunded is None:
        logger.warning("wallet_refund_noop", extra={"user_id": user_id, "bucket": spent.bucket})
        return spent
    return refunded


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

    Pre-flight for the metered LLM write paths — the BotMason reflection
    ``/resonance`` endpoint in :mod:`routers.journal` and the stateless
    single-page transcription endpoint in :mod:`routers.transcription`.
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


async def _credit_offering(
    session: AsyncSession,
    user_id: int,
    amount: int,
    *,
    reason: str,
    actor_user_id: int,
) -> int | None:
    """Add ``amount`` to ``offering_balance`` and stage the matching audit row.

    The shared atomic body behind every offering-bucket credit: one
    ``UPDATE ... RETURNING`` (no lost-update window between read and
    write) plus one staged ``WalletAudit``.  Deliberately does NOT
    commit — the caller owns the transaction boundary, which is what
    lets a credit land atomically alongside whatever else it guards.

    Returns the post-credit balance, or ``None`` when no row matched
    ``user_id`` (in which case nothing is staged).
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
            actor_user_id=actor_user_id,
            bucket=BUCKET_OFFERING,
            reason=reason,
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
    grant.  ``actor_user_id`` defaults to ``user_id``, so the only
    production caller -- an admin topping up their own wallet -- records
    a ``self_grant`` (actor == recipient).  A distinct actor would be
    logged as ``admin_grant``, a forward-looking seam reserved for a
    future cross-user grant path (e.g. a Stripe webhook or referral
    credit); no such caller exists yet.
    """
    # ``actor`` defaults to ``user_id`` so a self-grant (legacy or future
    # non-admin caller) does not look like an admin-initiated mutation
    # in the audit log.  Picking ``admin_grant`` only when the actor is
    # *different* from the recipient keeps the reason semantically
    # honest if a Stripe webhook or referral-credit path ever calls in.
    actor = actor_user_id if actor_user_id is not None else user_id
    reason = REASON_ADMIN_GRANT if actor != user_id else REASON_SELF_GRANT
    return await _credit_offering(session, user_id, amount, reason=reason, actor_user_id=actor)


async def grant_purchase_credit(session: AsyncSession, user_id: int, amount: int) -> int | None:
    """Credit ``amount`` bought credits to ``user_id`` and return the new total.

    The wallet half of a Gumroad token-pack purchase.  The buyer is their
    own actor -- nobody granted these credits, they paid for them -- so
    the audit row records ``actor_user_id == user_id`` with reason
    ``gumroad_purchase``, keeping revenue-backed credits distinguishable
    from courtesy top-ups.

    Returns ``None`` (staging no audit row) when the user has vanished, so
    the caller can abandon the surrounding claim rather than record a
    credit nobody received.  Does not commit: the caller owns the
    transaction so the credit and its exactly-once guard land together.
    """
    return await _credit_offering(
        session,
        user_id,
        amount,
        reason=REASON_GUMROAD_PURCHASE,
        actor_user_id=user_id,
    )


async def claw_back_purchase_credit(
    session: AsyncSession,
    user_id: int,
    amount: int,
) -> int | None:
    """Debit a refunded Gumroad purchase's ``amount`` and return the new total.

    The exact inverse of :func:`grant_purchase_credit`: ``amount`` is passed
    in positive and applied as ``-amount``, so the audit pair for a refunded
    pack sums to zero.  The buyer is their own actor again -- their
    chargeback moved the wallet, nobody granted or confiscated anything by
    hand.

    **The resulting balance may be negative, and that is the point.**
    ``_credit_offering`` does no clamping, so a buyer who spent half a pack
    before disputing the charge is left overdrawn rather than keeping the
    messages they spent.  Clamping at zero would make spending first a way to
    get the credits for free.  A negative balance is still unspendable:
    :func:`spend_one_message` guards its offering branch with
    ``WHERE offering_balance > 0``, so the buyer simply has no paid capacity
    until the shortfall is made good.  The audit arithmetic needs no special
    case either -- ``balance_before = new_balance - amount`` is already
    correct for a negative ``amount``.

    Returns ``None`` (staging no audit row) when the user has vanished, so
    the caller can log the orphaned reversal rather than record a debit
    against nobody.  Does not commit: the caller owns the transaction so the
    debit lands with whatever claim guards it.
    """
    return await _credit_offering(
        session,
        user_id,
        -amount,
        reason=REASON_GUMROAD_REFUND,
        actor_user_id=user_id,
    )
