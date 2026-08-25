"""Gumroad ping webhook.

Gumroad POSTs a form-encoded "ping" for every sale-related event. The shared
secret in the ``secret`` query parameter is checked (constant time) BEFORE the
body is read, so an unauthenticated caller can never drive the parser. Valid
pings are persisted verbatim into :class:`~models.gumroad_sale.GumroadSale`,
idempotently keyed by ``sale_id``.

Each event type this router understands is routed through ``_EVENT_HANDLERS``,
the single table that also defines what counts as a known event.

A ``sale`` event dispatches two side effects guarded by disjoint product
allowlists, so at most one fires: the buyer's ``course_access`` entitlement
for an APTITUDE product, and a BotMason wallet credit for a token pack. Both
are idempotent, so replays stay safe. The credited amount comes solely from
the operator-configured pack-size map — never from a payload field, which a
forged ping would control.

The reversal events unwind that delivery. ``refund`` and ``dispute`` return
the money; ``cancellation`` and ``subscription_ended`` only stop the
renewals. All four compete for one exactly-once claim on the stored sale (see
:mod:`services.gumroad_revocation`), and all four read every fact they act on
off that stored row rather than off the ping.

Secrets discipline: the webhook secret, buyer email, and raw payload never
appear in log text — only static markers and non-PII metadata do.
"""

from __future__ import annotations

import hmac
import logging
import os
from collections.abc import Awaitable, Callable
from typing import Annotated
from urllib.parse import parse_qsl

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from domain.entitlements import (
    REASON_WEBHOOK_SALE,
    grant_course_access,
    is_aptitude_product_id,
    is_token_pack_product_id,
    token_pack_size,
)
from errors import bad_request
from models.gumroad_sale import SALE_RESOURCE_NAME, GumroadSale
from models.user import User
from services.gumroad_revocation import process_cancellation, process_refund
from services.token_packs import credit_token_pack_sale

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks/gumroad", tags=["gumroad"])

# Gumroad posts booleans as the form strings "true"/"false".
_TRUE_FORM_VALUE = "true"

# Payload keys this router reads by name more than once.
_PRODUCT_ID_FIELD = "product_id"
_EMAIL_FIELD = "email"
_REFUNDED_FIELD = "refunded"

# Structured-log reason codes for the sale-dispatch outcomes an operator
# needs to be able to grep for. Each marks a ping that was accepted and
# stored but deliberately moved nothing.
_REASON_UNKNOWN_PRODUCT = "unknown_product"
_REASON_REFUNDED_SALE = "refunded_sale"
_REASON_PREVIOUSLY_REVERSED = "sale_previously_reversed"
_REASON_SIZE_UNCONFIGURED = "token_pack_size_unconfigured"
_REASON_PACK_CREDITED = "token_pack_credited"


def _require_valid_secret(provided: str | None) -> None:
    """Reject the request (401) unless the shared secret matches.

    ``GUMROAD_WEBHOOK_SECRET`` is read at request time so rotation needs no
    restart; the comparison is constant-time via :func:`hmac.compare_digest`.
    An unset secret fails closed — every request is rejected.
    """
    expected = os.getenv("GUMROAD_WEBHOOK_SECRET", "")
    supplied = provided or ""
    if not expected or not hmac.compare_digest(supplied.encode(), expected.encode()):
        # Static text only — never echo the supplied or expected secret.
        logger.warning("gumroad_webhook_rejected reason_code=invalid_signature")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_signature")


async def _read_ping_payload(request: Request) -> dict[str, str]:
    """Read the form body verbatim as str -> str; 400 when ``sale_id`` is absent.

    ``sale_id`` is the idempotency key — without it a ping cannot be stored
    or deduplicated, so the payload is rejected as malformed.
    """
    # Parsed with the stdlib rather than Starlette's form reader on purpose.
    # Gumroad pings are ``application/x-www-form-urlencoded``, which
    # ``parse_qsl`` handles natively -- while Starlette's reader requires a
    # third-party parser this app deliberately does not depend on, because that
    # parser spools request bodies to disk and ``test_transcription_privacy``
    # forbids the whole surface. Reaching for it here would have pulled a
    # disk-spooling body parser back in to serve a payload that never needed one.
    try:
        raw = (await request.body()).decode("utf-8")
    except UnicodeDecodeError:
        logger.warning("gumroad_webhook_rejected reason_code=malformed_payload")
        raise bad_request("malformed_payload") from None
    # Last-value-wins for duplicated keys: Gumroad pings send each field once,
    # so collapsing to a plain str -> str dict is intentional, not lossy.
    payload = dict(parse_qsl(raw, keep_blank_values=True))
    if not payload.get("sale_id"):
        logger.warning("gumroad_webhook_rejected reason_code=malformed_payload")
        raise bad_request("malformed_payload")
    return payload


def _coerce_form_flag(payload: dict[str, str], key: str) -> bool:
    """Coerce Gumroad's "true"/"false" form strings to a bool (absent -> False)."""
    return payload.get(key, "").strip().lower() == _TRUE_FORM_VALUE


async def _sale_already_recorded(session: AsyncSession, sale_id: str) -> bool:
    """Return True when this ``gumroad_sale_id`` was already persisted (replay)."""
    result = await session.execute(
        select(GumroadSale).where(GumroadSale.gumroad_sale_id == sale_id)
    )
    return result.scalar_one_or_none() is not None


async def _persist_sale(session: AsyncSession, payload: dict[str, str]) -> None:
    """Insert the GumroadSale row; a concurrent replay collapses to a no-op."""
    sale = GumroadSale(
        gumroad_sale_id=payload["sale_id"],
        product_id=payload.get(_PRODUCT_ID_FIELD, ""),
        email=payload.get(_EMAIL_FIELD, ""),
        resource_name=payload.get("resource_name", ""),
        is_recurring_charge=_coerce_form_flag(payload, "is_recurring_charge"),
        refunded=_coerce_form_flag(payload, _REFUNDED_FIELD),
        raw_payload=payload,
    )
    session.add(sale)
    try:
        await session.commit()
    except IntegrityError:
        # Lost a race with a concurrent replay of the same sale_id — the row
        # already exists, which is exactly the state we wanted.
        await session.rollback()


async def _find_user_by_email(session: AsyncSession, email: str) -> User | None:
    """Return the account registered under ``email``, matched case-insensitively.

    Gumroad reports the buyer's address as they typed it while accounts are
    stored normalized, so every lookup from a ping has to fold case. A blank
    address short-circuits rather than matching a row with an empty email.
    """
    normalized = email.strip().lower()
    if not normalized:
        return None
    result = await session.execute(select(User).where(func.lower(User.email) == normalized))
    return result.scalars().first()


async def _grant_for_sale(session: AsyncSession, payload: dict[str, str]) -> None:
    """Grant course access for a sale ping when the buyer already signed up.

    Grants only for a sale of an APTITUDE product (the ping's ``product_id``
    must be on ``GUMROAD_APTITUDE_PRODUCT_IDS`` — the same allowlist the signup
    path enforces), so a future non-APTITUDE product sold on the same Gumroad
    account never silently grants course access. With no matching user the
    sale row alone is the outcome (the buyer's later license-gated signup
    converges by linking to it). The grant is idempotent, so webhook replays
    never duplicate an entitlement.

    Requires the stored sale to be unreversed: a sale whose reversal claim is
    already spent grants nothing, however many times Gumroad redelivers it.
    """
    if not is_aptitude_product_id(payload.get(_PRODUCT_ID_FIELD)):
        return
    user = await _find_user_by_email(session, payload.get(_EMAIL_FIELD, ""))
    if user is None:
        return
    sale_result = await session.execute(
        select(GumroadSale)
        .where(GumroadSale.gumroad_sale_id == payload["sale_id"])
        # A reversal writes the claim through SQL alone, so an instance this
        # session already holds would still read as unreversed; the guard
        # below has to see the row as the database has it.
        .execution_options(populate_existing=True)
    )
    sale = sale_result.scalars().first()
    if sale is not None and sale.revocation_processed_at is not None:
        # A reversal is permanent for the sale that funded the access, and it
        # deliberately leaves the buyer with no active entitlement. Since the
        # grant is only idempotent against a live one, a stale redelivery of
        # the original purchase would mint a fresh grant and hand a refunded
        # buyer back the access they were charged back for. The token-pack
        # side needs no twin of this guard: ``token_pack_credited_at`` is a
        # permanent one-way gate that no reversal ever clears.
        logger.info("gumroad_webhook_event", extra={"reason_code": _REASON_PREVIOUSLY_REVERSED})
        return
    await grant_course_access(session, user, sale=sale, reason_code=REASON_WEBHOOK_SALE)


def _token_pack_credit_amount(payload: dict[str, str]) -> int | None:
    """Return how many credits this ping should mint, or ``None`` for none.

    Three gates, each failing closed: the product must be an allowlisted
    token pack, the sale must not be refunded, and the pack must have a
    configured size. The amount comes from that configured size alone —
    never from ``price``, ``quantity``, or any other payload field, all of
    which a forged ping would control.
    """
    product_id = payload.get(_PRODUCT_ID_FIELD)
    if not is_token_pack_product_id(product_id):
        return None
    if _coerce_form_flag(payload, _REFUNDED_FIELD):
        logger.info("gumroad_token_pack_skipped", extra={"reason_code": _REASON_REFUNDED_SALE})
        return None
    amount = token_pack_size(product_id)
    if amount is None:
        logger.info("gumroad_token_pack_skipped", extra={"reason_code": _REASON_SIZE_UNCONFIGURED})
    return amount


async def _credit_token_pack_for_sale(session: AsyncSession, payload: dict[str, str]) -> None:
    """Credit the buyer's wallet for a sized, non-refunded token-pack sale.

    With no account for the buyer's email yet the sale simply stays
    unclaimed; the signup sweep delivers the credits when they register. The
    credit itself is exactly-once per sale, so a replayed ping moves nothing.
    """
    amount = _token_pack_credit_amount(payload)
    if amount is None:
        return
    user = await _find_user_by_email(session, payload.get(_EMAIL_FIELD, ""))
    if user is None or user.id is None:
        return
    credited = await credit_token_pack_sale(
        session, sale_id=payload["sale_id"], user_id=user.id, amount=amount
    )
    if credited is not None:
        logger.info(
            "gumroad_token_pack_credited",
            extra={
                "reason_code": _REASON_PACK_CREDITED,
                "user_id": user.id,
                "amount": amount,
            },
        )


def _log_if_unknown_product(payload: dict[str, str]) -> None:
    """Flag a sale whose product is on neither allowlist, since it is inert.

    Both allowlists are operator configuration, so a product on neither is
    either a new SKU nobody wired up or a rotation that dropped an id. The
    ping is still stored verbatim; the log line is what makes the silence
    noticeable.
    """
    product_id = payload.get(_PRODUCT_ID_FIELD)
    if is_aptitude_product_id(product_id) or is_token_pack_product_id(product_id):
        return
    logger.info("gumroad_webhook_event", extra={"reason_code": _REASON_UNKNOWN_PRODUCT})


async def _dispatch_sale(session: AsyncSession, payload: dict[str, str]) -> None:
    """Run every side effect a ``sale`` ping carries, in order.

    Classification first, so an unrecognised product is flagged even though
    nothing follows it; then the course grant; then the token-pack credit.
    The two grants are guarded by disjoint allowlists, so at most one fires.
    """
    _log_if_unknown_product(payload)
    await _grant_for_sale(session, payload)
    await _credit_token_pack_for_sale(session, payload)


# Every ping event type this webhook acts on, and the coroutine that owns it.
# A refund and a dispute are the same reversal (the money went back); a
# cancellation and a subscription ending are the same lapse. One table means
# the routing and the "do we recognise this event?" question can never drift
# apart.
_EVENT_HANDLERS: dict[str, Callable[[AsyncSession, dict[str, str]], Awaitable[None]]] = {
    SALE_RESOURCE_NAME: _dispatch_sale,
    "refund": process_refund,
    "dispute": process_refund,
    "cancellation": process_cancellation,
    "subscription_ended": process_cancellation,
}

# resource_name values Gumroad documents for ping webhooks — derived from the
# handler table so adding an event registers it in both senses at once.
# Anything else is still persisted (verbatim capture) but flagged with
# ``reason_code=unhandled_event`` so operators notice new event types.
KNOWN_RESOURCE_NAMES = frozenset(_EVENT_HANDLERS)


@router.post("/ping")
async def receive_ping(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    secret: str | None = None,
) -> dict[str, str]:
    """Persist one Gumroad ping, idempotently keyed by ``sale_id``.

    Always answers 200 on an authenticated, well-formed ping — including
    replays and unknown event types — so Gumroad never re-queues an event we
    have already captured. Recognised events then run their handler from
    ``_EVENT_HANDLERS``: a sale dispatches its (idempotent) entitlement grant
    and token-pack credit, a reversal unwinds them exactly once.

    The row is persisted before the handler runs, so an orphan reversal ping
    is captured even though it reverses nothing.
    """
    _require_valid_secret(secret)
    payload = await _read_ping_payload(request)
    resource_name = payload.get("resource_name", "")
    if resource_name not in KNOWN_RESOURCE_NAMES:
        # Persisted anyway (verbatim capture), but flagged for operators.
        logger.info("gumroad_webhook_event reason_code=unhandled_event")
    if not await _sale_already_recorded(session, payload["sale_id"]):
        await _persist_sale(session, payload)
    handler = _EVENT_HANDLERS.get(resource_name)
    if handler is not None:
        await handler(session, payload)
    logger.info(
        "gumroad_webhook_accepted",
        extra={"reason_code": "accepted", "resource_name": resource_name},
    )
    return {"status": "ok"}
