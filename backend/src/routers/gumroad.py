"""Gumroad ping webhook.

Gumroad POSTs a form-encoded "ping" for every sale-related event. The shared
secret in the ``secret`` query parameter is checked (constant time) BEFORE the
body is read, so an unauthenticated caller can never drive the parser. Valid
pings are persisted verbatim into :class:`~models.gumroad_sale.GumroadSale`,
idempotently keyed by ``sale_id`` — persistence only, no grant or credit side
effects (those belong to later features reading the stored rows).

Secrets discipline: the webhook secret, buyer email, and raw payload never
appear in log text — only static markers and non-PII metadata do.
"""

from __future__ import annotations

import hmac
import logging
import os
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from errors import bad_request
from models.gumroad_sale import GumroadSale

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks/gumroad", tags=["gumroad"])

# resource_name values Gumroad documents for ping webhooks. Anything else is
# still persisted (verbatim capture) but flagged with
# ``reason_code=unhandled_event`` so operators notice new event types.
KNOWN_RESOURCE_NAMES = frozenset(
    {"sale", "refund", "dispute", "cancellation", "subscription_ended"}
)

# Gumroad posts booleans as the form strings "true"/"false".
_TRUE_FORM_VALUE = "true"


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
    form = await request.form()
    payload = {key: value for key, value in form.multi_items() if isinstance(value, str)}
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
        product_id=payload.get("product_id", ""),
        email=payload.get("email", ""),
        resource_name=payload.get("resource_name", ""),
        is_recurring_charge=_coerce_form_flag(payload, "is_recurring_charge"),
        refunded=_coerce_form_flag(payload, "refunded"),
        raw_payload=payload,
    )
    session.add(sale)
    try:
        await session.commit()
    except IntegrityError:
        # Lost a race with a concurrent replay of the same sale_id — the row
        # already exists, which is exactly the state we wanted.
        await session.rollback()


@router.post("/ping")
async def receive_ping(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    secret: str | None = None,
) -> dict[str, str]:
    """Persist one Gumroad ping, idempotently keyed by ``sale_id``.

    Always answers 200 on an authenticated, well-formed ping — including
    replays and unknown event types — so Gumroad never re-queues an event we
    have already captured.
    """
    _require_valid_secret(secret)
    payload = await _read_ping_payload(request)
    resource_name = payload.get("resource_name", "")
    if resource_name not in KNOWN_RESOURCE_NAMES:
        # Persisted anyway (verbatim capture), but flagged for operators.
        logger.info("gumroad_webhook_event reason_code=unhandled_event")
    if not await _sale_already_recorded(session, payload["sale_id"]):
        await _persist_sale(session, payload)
    logger.info(
        "gumroad_webhook_accepted",
        extra={"reason_code": "accepted", "resource_name": resource_name},
    )
    return {"status": "ok"}
