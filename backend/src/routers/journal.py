"""Journal API — chat messages, tagging, search, and pagination."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from sqlalchemy import ColumnElement, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.ownership import require_owned_journal_entry
from domain.resonance import MarginaliaAnchored, generate_marginalia
from errors import not_found, unprocessable
from models.journal_entry import JournalEntry, JournalTag
from models.marginalia import Marginalia, MarginaliaStatus
from rate_limit import limiter
from routers.auth import get_current_user
from schemas.journal import (
    JOURNAL_MESSAGE_MAX_LENGTH,
    JournalBotMessageCreate,
    JournalEntryUpdate,
    JournalListResponse,
    JournalMessageCreate,
    JournalMessageResponse,
)
from schemas.marginalia import (
    MarginaliaListResponse,
    MarginaliaResponse,
    ResonanceResponse,
)
from security import TextTooLongError, sanitize_user_text
from services import journal_encryption
from services.botmason import LLMProviderError, resolve_chat_api_key
from services.marginalia import BotmasonResonanceLLM, reanchor_entry_marginalia
from services.usage import get_monthly_cap
from services.wallet import preflight_deduction, require_user_fresh


def _sanitize_message(message: str) -> str:
    """Apply :func:`sanitize_user_text` and translate overflow to HTTP 422.

    Pydantic's ``max_length`` already caps raw input at
    :data:`JOURNAL_MESSAGE_MAX_LENGTH`, but NFC normalization can in rare
    cases (Hangul jamo, Tibetan stacks) leave the post-normalization length
    *above* the cap.  Re-checking after sanitization closes that gap; we
    raise 422 (rather than the 500 we would otherwise return on an
    unhandled domain error) so the client sees a uniform length-violation
    shape regardless of which layer rejected the value.
    """
    try:
        return sanitize_user_text(message, max_len=JOURNAL_MESSAGE_MAX_LENGTH)
    except TextTooLongError as exc:
        raise unprocessable("message_too_long") from exc


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/journal", tags=["journal"])


# BUG-JOURNAL-009: ``search`` is run as ``ILIKE '%term%'`` against an
# uncapped column; without a length bound a 5MB query can pin a worker.
# A min-length of 3 also guards against substring-search noise (a single
# ``%a%`` matches almost every row in a chatty user's history) and keeps
# the cardinality of the LIKE plan reasonable.
JOURNAL_SEARCH_MIN_LENGTH = 3
JOURNAL_SEARCH_MAX_LENGTH = 64

# Encrypted search scans a user's entries in memory (ciphertext can't be ILIKE'd).
# Fine for a personal journal (~3 entries/day over a 36-week program ≈ 750 rows);
# warn past this so a future blind-index/FTS need is observable, not a surprise.
_ENCRYPTED_SCAN_WARN_THRESHOLD = 2000


@dataclass
class _ListFilters:
    """Query parameters for listing journal entries."""

    search: str | None = Query(
        default=None,
        min_length=JOURNAL_SEARCH_MIN_LENGTH,
        max_length=JOURNAL_SEARCH_MAX_LENGTH,
    )
    tag: JournalTag | None = None
    practice_session_id: int | None = Query(default=None)
    limit: int = Query(default=50, ge=1, le=200)
    offset: int = Query(default=0, ge=0)


@router.post("/", response_model=JournalMessageResponse, status_code=status.HTTP_201_CREATED)
async def create_journal_entry(
    payload: JournalMessageCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> JournalEntry:
    """Create a journal message for the authenticated user.

    The message body is sanitized at the router boundary
    (BUG-JOURNAL-003) so the row that lands in the DB has no control
    characters, zero-width, or bidi-override codepoints — defense
    against stored-XSS payloads in journal renderers and Trojan-Source
    smuggling in log viewers.
    """
    data = payload.model_dump()
    data["message"] = _sanitize_message(data["message"])
    entry = JournalEntry(sender="user", user_id=current_user, **data)
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    logger.info("journal_entry_created", extra={"user_id": current_user, "entry_id": entry.id})
    return entry


def _escape_like(value: str) -> str:
    r"""Escape SQL LIKE wildcards so literal ``%``, ``_``, ``\\`` are matched.

    Uses ``\\`` as the escape character, which must be declared via
    ``escape="\\\\"`` on the ``.ilike()`` call (BUG-JOURNAL-013).
    """
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _non_search_conditions(filters: _ListFilters) -> list[ColumnElement[bool]]:
    """Tag / practice-session filters that work as plain column equality."""
    conditions: list[ColumnElement[bool]] = []
    if filters.tag is not None:
        conditions.append(col(JournalEntry.tag) == filters.tag.value)
    if filters.practice_session_id is not None:
        conditions.append(col(JournalEntry.practice_session_id) == filters.practice_session_id)
    return conditions


def _build_filter_conditions(filters: _ListFilters) -> list[ColumnElement[bool]]:
    """All where-clauses, including a SQL ILIKE keyword search (plaintext path)."""
    conditions = _non_search_conditions(filters)
    if filters.search is not None:
        escaped = _escape_like(filters.search)
        conditions.append(col(JournalEntry.message).ilike(f"%{escaped}%", escape="\\"))
    return conditions


async def _encrypted_search_page(
    session: AsyncSession, user_id: int, filters: _ListFilters, *, search: str
) -> JournalListResponse:
    """Keyword search when messages are encrypted at rest (audit-destub-05c).

    Ciphertext can't be ILIKE'd, so the non-search filters run in SQL and the
    substring match is applied in Python after the ORM transparently decrypts.
    Scoped to one user's own (non-deleted) entries, so the corpus is small.
    """
    query = (
        select(JournalEntry)
        .where(
            JournalEntry.user_id == user_id,
            col(JournalEntry.deleted_at).is_(None),
            *_non_search_conditions(filters),
        )
        .order_by(col(JournalEntry.id).desc())
    )
    rows = list((await session.execute(query)).scalars().all())
    if len(rows) > _ENCRYPTED_SCAN_WARN_THRESHOLD:
        # In-memory scan is fine for a personal journal; warn before it isn't, so
        # a future blind-index/FTS need is observable rather than a surprise.
        logger.warning("encrypted_search_large_scan", extra={"user_id": user_id, "rows": len(rows)})
    needle = search.lower()
    matched = [row for row in rows if needle in row.message.lower()]
    page = matched[filters.offset : filters.offset + filters.limit]
    return JournalListResponse(
        items=[JournalMessageResponse.model_validate(e, from_attributes=True) for e in page],
        total=len(matched),
        has_more=(filters.offset + filters.limit) < len(matched),
    )


@router.get("/", response_model=JournalListResponse)
@limiter.limit("30/minute")
async def list_journal_entries(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    filters: Annotated[_ListFilters, Depends()],
) -> JournalListResponse:
    """List journal entries for the current user with optional filtering.

    BUG-JOURNAL-007: soft-deleted entries (``deleted_at IS NOT NULL``) are
    excluded so the list surface never resurfaces deleted content.
    """
    # Keyword search ILIKEs the message column, which is Fernet ciphertext when
    # encryption is on — so route encrypted search through a decrypt-then-filter
    # path in Python (audit-destub-05c) instead of the SQL ILIKE.
    if filters.search is not None and journal_encryption.is_enabled():
        return await _encrypted_search_page(session, current_user, filters, search=filters.search)
    conditions = _build_filter_conditions(filters)
    query = select(JournalEntry).where(
        JournalEntry.user_id == current_user,
        col(JournalEntry.deleted_at).is_(None),  # BUG-JOURNAL-007: exclude soft-deleted
        *conditions,
    )

    # Count total before pagination
    count_query = select(func.count()).select_from(query.subquery())
    total = (await session.execute(count_query)).scalar() or 0

    # Fetch paginated results, newest first
    query = query.order_by(col(JournalEntry.id).desc()).offset(filters.offset).limit(filters.limit)
    result = await session.execute(query)
    items = list(result.scalars().all())

    return JournalListResponse(
        items=[JournalMessageResponse.model_validate(e, from_attributes=True) for e in items],
        total=total,
        has_more=(filters.offset + filters.limit) < total,
    )


@router.get("/{entry_id}", response_model=JournalMessageResponse)
async def get_journal_entry(
    entry: Annotated[JournalEntry, Depends(require_owned_journal_entry)],
) -> JournalEntry:
    """Return a single journal entry by ID, scoped to the authenticated user.

    Ownership is verified by ``require_owned_journal_entry``: 404 when the
    row does not exist, 403 when it exists but belongs to another user.
    """
    return entry


async def _apply_entry_update(
    entry: JournalEntry, payload: JournalEntryUpdate, session: AsyncSession
) -> None:
    """Apply the provided fields to ``entry``, re-anchoring marginalia on a body edit."""
    if payload.message is not None:
        old_message = entry.message
        new_message = _sanitize_message(payload.message)
        if new_message != old_message:
            entry.message = new_message
            await reanchor_entry_marginalia(entry, old_message, new_message, session)
    if payload.title is not None:
        entry.title = payload.title
    if payload.status is not None:
        entry.status = payload.status
    # ``updated_at`` is bumped by the column's ``onupdate`` only when a value
    # actually changes, so a same-value PATCH doesn't move it.


@router.patch("/{entry_id}", response_model=JournalMessageResponse)
async def update_journal_entry(
    entry_id: int,
    payload: JournalEntryUpdate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> JournalEntry:
    """Patch ``message`` / ``title`` / ``status`` on the caller's own entry.

    Scoped to the caller's non-deleted rows: a missing id, a soft-deleted row, or
    another user's entry all resolve to 404 (enumeration-safe). Editing the body
    re-sanitizes it and invokes the marginalia re-anchor seam; ``updated_at`` is
    refreshed.
    """
    result = await session.execute(
        select(JournalEntry).where(
            JournalEntry.id == entry_id,
            JournalEntry.user_id == current_user,
            JournalEntry.sender == "user",  # bot-authored entries are not user-editable
            col(JournalEntry.deleted_at).is_(None),
        )
    )
    entry = result.scalars().first()
    if entry is None:
        raise not_found("journal_entry")
    await _apply_entry_update(entry, payload, session)
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    logger.info("journal_entry_updated", extra={"user_id": current_user, "entry_id": entry_id})
    return entry


_RESONANCE_PRIOR_LIMIT = 3


async def _load_user_entry(
    session: AsyncSession, entry_id: int, user_id: int
) -> JournalEntry | None:
    """Load the caller's own non-deleted entry, or None (404-scoped)."""
    result = await session.execute(
        select(JournalEntry).where(
            JournalEntry.id == entry_id,
            JournalEntry.user_id == user_id,
            col(JournalEntry.deleted_at).is_(None),
        )
    )
    return result.scalars().first()


async def _recent_prior_bodies(session: AsyncSession, user_id: int, exclude_id: int) -> list[str]:
    """The caller's most recent other entry bodies, for connection context."""
    result = await session.execute(
        select(JournalEntry)
        .where(
            JournalEntry.user_id == user_id,
            JournalEntry.id != exclude_id,
            col(JournalEntry.deleted_at).is_(None),
        )
        .order_by(col(JournalEntry.id).desc())
        .limit(_RESONANCE_PRIOR_LIMIT)
    )
    return [row.message for row in result.scalars().all()]


def _persist_marginalia(
    session: AsyncSession, entry_id: int, user_id: int, anchored: list[MarginaliaAnchored]
) -> list[Marginalia]:
    """Stage one Marginalia row per anchored note (active, no essay yet)."""
    rows = [
        Marginalia(
            journal_entry_id=entry_id,
            user_id=user_id,
            kind=note.kind,
            anchor_start=note.anchor_start,
            anchor_end=note.anchor_end,
            anchor_text=note.anchor_text,
            note=note.note,
            status=MarginaliaStatus.ACTIVE,
        )
        for note in anchored
    ]
    session.add_all(rows)
    return rows


@router.post("/{entry_id}/resonance", response_model=ResonanceResponse)
@limiter.limit("10/minute")
async def run_resonance(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    entry_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    x_llm_api_key: Annotated[str | None, Header(alias="X-LLM-API-Key")] = None,
) -> ResonanceResponse:
    """Run a resonance pass over the caller's entry, persist notes, charge one unit.

    Wallet pre-flight deducts one message (402 when out of capacity). The LLM
    pass + persistence + the charge commit atomically; any provider error rolls
    the deduction back so a failed pass never charges (502 ``llm_provider_error``).
    """
    entry = await _load_user_entry(session, entry_id, current_user)
    if entry is None:
        raise not_found("journal_entry")
    spent = await preflight_deduction(session, current_user)
    prior = await _recent_prior_bodies(session, current_user, entry_id)
    llm = BotmasonResonanceLLM(resolve_chat_api_key(x_llm_api_key))
    try:
        anchored = await generate_marginalia(entry.message, llm=llm, prior_entries=prior)
    except LLMProviderError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="llm_provider_error"
        ) from exc
    rows = _persist_marginalia(session, entry_id, current_user, anchored)
    user = await require_user_fresh(session, current_user)
    reset_date = user.monthly_reset_date
    await session.commit()
    for row in rows:
        await session.refresh(row)
    logger.info(
        "journal_resonance_generated",
        extra={"user_id": current_user, "entry_id": entry_id, "count": len(rows)},
    )
    return ResonanceResponse(
        marginalia=[MarginaliaResponse.model_validate(r, from_attributes=True) for r in rows],
        remaining_messages=max(get_monthly_cap() - spent.monthly_used, 0),
        remaining_balance=spent.offering_balance,
        monthly_reset_date=reset_date,
    )


@router.get("/{entry_id}/marginalia", response_model=MarginaliaListResponse)
async def list_marginalia(
    entry_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> MarginaliaListResponse:
    """List the caller's marginalia for an entry, ordered by anchor position."""
    entry = await _load_user_entry(session, entry_id, current_user)
    if entry is None:
        raise not_found("journal_entry")
    result = await session.execute(
        select(Marginalia)
        .where(
            Marginalia.journal_entry_id == entry_id,
            Marginalia.user_id == current_user,  # defense-in-depth alongside the entry check
        )
        .order_by(col(Marginalia.anchor_start))
    )
    rows = result.scalars().all()
    return MarginaliaListResponse(
        items=[MarginaliaResponse.model_validate(r, from_attributes=True) for r in rows]
    )


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_journal_entry(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    entry: Annotated[JournalEntry, Depends(require_owned_journal_entry)],
) -> Response:
    """Soft-delete a journal entry (BUG-JOURNAL-007).

    Stamps ``deleted_at = utcnow()`` instead of issuing a hard ``DELETE``.
    This preserves the ``LLMUsageLog.journal_entry_id`` FK reference so the
    usage audit trail is never orphaned, and allows recovery within the
    configurable retention window.  Soft-deleted rows are invisible to all
    read paths (list, get, ``load_recent_conversation``) which filter
    ``deleted_at IS NULL``.
    """
    entry_id = entry.id
    entry.deleted_at = datetime.now(UTC)
    session.add(entry)
    await session.commit()
    logger.info(
        "journal_entry_soft_deleted",
        extra={"user_id": current_user, "entry_id": entry_id},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/bot-response",
    response_model=JournalMessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_bot_response(
    payload: JournalBotMessageCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> JournalEntry:
    """Store a BotMason AI response (internal endpoint for AI integration layer).

    ``user_id`` is sourced from the authenticated user — never from the request
    body — to prevent cross-user injection (BUG-JOURNAL-002).

    The bot message is also passed through :func:`sanitize_user_text`
    (BUG-JOURNAL-003 / BUG-BM-004): a model-generated reflection of an
    attacker's prompt-injection attempt could otherwise reintroduce control
    characters or bidi overrides into the journal stream.
    """
    data = payload.model_dump()
    data["message"] = _sanitize_message(data["message"])
    entry = JournalEntry(sender="bot", user_id=current_user, **data)
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    logger.info(
        "journal_bot_response_created", extra={"user_id": current_user, "entry_id": entry.id}
    )
    return entry
