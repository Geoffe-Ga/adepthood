"""Private beta feedback intake: submit a report, look up its receipt.

Two routes and one table. What makes this module more than CRUD is the set of
things it deliberately does *not* do.

It does not accept a log bundle. The diagnostic envelope is an allowlist of
seven bounded fields declared in :mod:`schemas.feedback`, with
``extra="forbid"`` so an eighth key is a 422 rather than a silent trim.

It does not store the raw ``Idempotency-Key``. The header is reduced to the
shared SHA-256 digest from :mod:`security.idempotency` before it touches the
database, and the digest is dropped from the export archive.

It does not let a public reference become an oracle. ``GET`` resolves the report
by ``public_id`` with no owner filter and then answers a cross-tenant hit with
the *byte-identical* refusal a never-issued reference gets, after writing the
``resource_access_denied`` audit row -- so the caller learns nothing from the
response and the operator learns everything from the log.

And it does not repeat the account's prose anywhere. The one log line this
module emits names the report id, the category, the impact, the screen and the
build, and every ``raise`` carries a static capability code, because an
exception message is the one channel :mod:`sentry` cannot structurally scrub.
"""

from __future__ import annotations

import logging
from typing import Annotated, Final

from fastapi import Depends, Header, Path, Request, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.ownership import log_ownership_denied
from error_responses import build_router
from errors import not_found
from models.feedback import (
    PUBLIC_ID_MAX_LENGTH,
    PUBLIC_ID_PATTERN,
    FeedbackReport,
    mint_public_id,
)
from rate_limit import limiter
from rate_limit_keys import per_user_rate_limit_key
from routers.auth import get_current_user
from schemas.feedback import FeedbackCreate, FeedbackReceipt
from security.idempotency import IDEMPOTENCY_KEY_MAX_LENGTH, hash_idem_key

logger = logging.getLogger(__name__)

router = build_router(prefix="/feedback", tags=["feedback"])

# Two axes, both declared on the route rather than one of them inherited.
#
# The per-account budget is keyed on the JWT subject, so rotating addresses does
# not reset it: a person filing beta reports by hand does not reach ten an hour,
# and a client looping on a failed submit reaches ten in a second.
#
# The per-address budget is declared explicitly rather than inherited, and it
# stays that way. It was first written this way because the ambient
# ``default_limits`` genuinely did not reach any route mounted through
# ``include_router``: slowapi's middleware resolved a request to its handler by
# reading ``.endpoint`` off ``app.routes``, FastAPI 0.141 puts
# ``_IncludedRouter`` wrappers there that expose none, and a handler it could
# not resolve was treated as exempt. #2909 closed that -- the floor is now
# charged by ``AmbientRateLimitMiddleware`` before anything is resolved, so this
# route does inherit one.
#
# Inheriting it *instead of* this line would be a 180x loosening of exactly the
# axis that matters here: 60 requests per minute is 3600 an hour against a cap
# of 20, on an endpoint that writes four encrypted text columns per request. So
# the two compose rather than replace. The ambient floor is a floor -- it bounds
# the traffic that never reaches this handler at all, such as an unauthenticated
# or malformed flood, which no decorator on this function can see -- and the
# 20/hour below is the ceiling for the traffic that does reach it.
#
# Twice the per-account figure, so two testers behind one office address can
# both file a full budget and a third is refused, rather than the first tester
# quietly consuming everybody's.
_FEEDBACK_ACCOUNT_RATE_LIMIT: Final = "10/hour"
_FEEDBACK_ADDRESS_RATE_LIMIT: Final = "20/hour"

# Bounded so a database that somehow always raises surfaces as a 500 rather than
# hanging the request (the ``practice_share._insert_with_fresh_token`` shape).
_MAX_MINT_ATTEMPTS: Final = 5

# The resource name ``errors.not_found`` suffixes, so both halves of the receipt
# lookup send the byte-identical ``feedback_report_not_found``: a valid
# reference belonging to somebody else is indistinguishable from one never
# issued.
_REPORT_NOT_FOUND: Final = "feedback_report"

_PublicIdPath = Annotated[
    str,
    Path(pattern=PUBLIC_ID_PATTERN, max_length=PUBLIC_ID_MAX_LENGTH),
]


async def _recorded_report(
    session: AsyncSession, user_id: int, hashed: str
) -> FeedbackReport | None:
    """The report already stored for this ``(account, hashed key)`` pair, if any."""
    result = await session.execute(
        select(FeedbackReport).where(
            FeedbackReport.user_id == user_id,
            col(FeedbackReport.idem_key) == hashed,
        )
    )
    return result.scalars().first()


async def _insert_with_fresh_public_id(
    session: AsyncSession,
    report: FeedbackReport,
    *,
    hashed: str | None,
) -> FeedbackReport:
    """Insert ``report``, re-minting its public reference on a collision.

    The table carries two unique constraints -- ``public_id``, and the partial
    UNIQUE on ``(user_id, idem_key)`` -- so an ``IntegrityError`` here has two
    possible causes and they call for opposite responses. Resolving it by
    re-reading ``(user_id, idem_key)`` is right for the keyed case and
    catastrophic for the unkeyed one: ``col(X.idem_key) == None`` compiles to
    ``idem_key IS NULL``, which matches the caller's *earlier unkeyed reports*,
    so an unguarded re-read would discard the new submission and hand back a
    receipt for something they wrote weeks ago.

    Hence the guard. The re-read happens only when a key was actually presented;
    otherwise, and whenever that read comes back empty, the collision is treated
    as what it almost certainly is -- a minted reference that already exists --
    and a fresh one is minted.
    """
    last_error: IntegrityError | None = None
    for _ in range(_MAX_MINT_ATTEMPTS):
        report.public_id = mint_public_id()
        session.add(report)
        try:
            await session.commit()
        except IntegrityError as exc:
            await session.rollback()
            last_error = exc
            if hashed is not None:
                winner = await _recorded_report(session, report.user_id, hashed)
                if winner is not None:
                    return winner
            continue
        await session.refresh(report)
        return report
    msg = "failed to mint a unique feedback public reference after retries"
    raise RuntimeError(msg) from last_error


def _to_report(payload: FeedbackCreate, user_id: int, hashed: str | None) -> FeedbackReport:
    """Build the row from the validated request, field by named field.

    Written out rather than ``**payload.model_dump()`` (BUG-PRACTICE-002): a
    field added to the request schema that happened to share a name with a
    server-controlled column would otherwise flow straight through to the ORM.
    """
    context = payload.context
    return FeedbackReport(
        user_id=user_id,
        public_id="",
        category=payload.category.value,
        impact=payload.impact.value,
        platform=context.platform.value,
        viewport_class=context.viewport_class.value,
        summary=payload.summary,
        intent=payload.intent,
        expected=payload.expected,
        actual=payload.actual,
        screen=context.screen,
        control=context.control,
        app_build=context.app_build,
        locale=context.locale,
        correlation_id=None if context.correlation_id is None else str(context.correlation_id),
        idem_key=hashed,
    )


@router.post("/", response_model=FeedbackReceipt, status_code=status.HTTP_201_CREATED)
# The order of these two is load-bearing, not cosmetic. Decorators register
# bottom-up, ``slowapi`` evaluates a route's limits in registration order, and
# ``__evaluate_limits`` bills each bucket with ``hit()`` until one refuses and
# then breaks -- so whichever axis is evaluated first is charged for requests the
# second axis is about to reject. Account-first means an account that has spent
# its own budget stops costing the budget it shares with everyone else on that
# address; address-first would let one client's retry loop take a whole office
# offline. ``test_a_refused_retry_does_not_spend_the_shared_address_budget``
# fails if these two are ever swapped back.
@limiter.limit(_FEEDBACK_ADDRESS_RATE_LIMIT)
@limiter.limit(_FEEDBACK_ACCOUNT_RATE_LIMIT, key_func=per_user_rate_limit_key)
async def submit_feedback(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: FeedbackCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    idempotency_key: Annotated[
        str | None,
        Header(alias="Idempotency-Key", max_length=IDEMPOTENCY_KEY_MAX_LENGTH),
    ] = None,
) -> FeedbackReport:
    """Record one beta report and return its public reference.

    A repeated tap carrying the same ``Idempotency-Key`` resolves to the report
    already stored for this account under that key: one row, one reference. An
    unkeyed submission is always a new report -- two people describing two
    different things must never be collapsed just because neither client sent a
    header.
    """
    hashed = hash_idem_key(current_user, idempotency_key) if idempotency_key else None
    if hashed is not None:
        replayed = await _recorded_report(session, current_user, hashed)
        if replayed is not None:
            return replayed

    report = await _insert_with_fresh_public_id(
        session, _to_report(payload, current_user, hashed), hashed=hashed
    )
    logger.info(
        "feedback_submitted",
        extra={
            "report_id": report.id,
            "public_id": report.public_id,
            "category": report.category,
            "impact": report.impact,
            "screen": report.screen,
            "app_build": report.app_build,
        },
    )
    return report


@router.get("/{public_id}/receipt", response_model=FeedbackReceipt)
async def read_feedback_receipt(
    public_id: _PublicIdPath,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> FeedbackReport:
    """Return the receipt for one of the caller's own reports.

    A reference that belongs to another account answers with the same refusal,
    byte for byte, as one that was never issued. The collapse is deliberate and
    is the fourth such case in this application (goals, marginalia and journal
    entries are the others): the reference is the only handle on the resource,
    so a 403 here would confirm that a guessed reference is real -- which is
    precisely the enumeration a 403 exists to make auditable elsewhere. The
    audit row is written regardless, so the distinction survives in the log.
    """
    result = await session.execute(
        select(FeedbackReport).where(col(FeedbackReport.public_id) == public_id)
    )
    report = result.scalars().first()
    if report is None:
        raise not_found(_REPORT_NOT_FOUND)
    if report.user_id != current_user:
        # A row that came back from a SELECT always carries its key; the ``or 0``
        # satisfies the ``int | None`` the ORM declares and, if it were somehow
        # reached, writes a sentinel into the audit rather than skipping the
        # audit — a cross-tenant probe recorded against the wrong id is
        # recoverable, one that was never recorded at all is not.
        log_ownership_denied("feedback_report", report.id or 0, current_user)
        raise not_found(_REPORT_NOT_FOUND)
    return report
