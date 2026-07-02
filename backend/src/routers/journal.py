"""Journal API — chat messages, tagging, search, and pagination."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from sqlalchemy import ColumnElement, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.ownership import require_owned_journal_entry
from dependencies.timezone import current_user_timezone
from domain.care import CarePayload, build_care_payload
from domain.contraction import (
    build_contraction_invitation,
    derive_highest_stage_reached,
    detect_contraction,
)
from domain.detection import CompletionDetected, detect_completions
from domain.practice_resolution import effective_config
from domain.resonance import MarginaliaAnchored, generate_essay, generate_marginalia
from domain.safety import assess_distress
from domain.stage_progress import get_user_progress
from errors import bad_gateway, conflict, not_found, unprocessable
from models.completion_suggestion import (
    CompletionSuggestion,
    CompletionTargetType,
    SuggestionStatus,
)
from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalClassification, JournalEntry, JournalTag
from models.marginalia import Marginalia, MarginaliaStatus
from models.practice import Practice
from models.practice_session import PracticeSession
from models.user_practice import UserPractice
from rate_limit import limiter
from routers.auth import get_current_user
from schemas.completion_suggestion import (
    AcceptSuggestionResponse,
    CompletionSuggestionListResponse,
    CompletionSuggestionResponse,
)
from schemas.journal import (
    JOURNAL_MESSAGE_MAX_LENGTH,
    JournalEntryUpdate,
    JournalListResponse,
    JournalMessageCreate,
    JournalMessageResponse,
)
from schemas.marginalia import (
    CareResourceResponse,
    CareResponse,
    ContractionReflectionResponse,
    MarginaliaListResponse,
    MarginaliaResponse,
    ResonanceResponse,
)
from security import TextTooLongError, sanitize_user_text
from services import journal_encryption
from services.botmason import LLMProviderError, resolve_chat_api_key
from services.checkin import CheckInContext, current_check_in, record_goal_completion
from services.completion_candidates import gather_candidates
from services.contraction import gather_contraction_aggregates
from services.marginalia import (
    BotmasonResonanceLLM,
    reanchor_entry_marginalia,
    reanchor_entry_suggestions,
)
from services.practice_session_idempotency import record_session, recorded_session_id
from services.usage import get_monthly_cap
from services.users import get_user_timezone
from services.wallet import SpendResult, preflight_deduction, require_user_fresh


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

    Ownership is verified by ``require_owned_journal_entry``: 404 when the row
    does not exist *or* belongs to another user (enumeration-safe, matching
    PATCH and DELETE).
    """
    return entry


async def _apply_message_edit(
    entry: JournalEntry, payload: JournalEntryUpdate, session: AsyncSession
) -> None:
    """Re-sanitize the body on edit and re-anchor marginalia + suggestions."""
    if payload.message is None:
        return
    old_message = entry.message
    new_message = _sanitize_message(payload.message)
    if new_message != old_message:
        entry.message = new_message
        await reanchor_entry_marginalia(entry, old_message, new_message, session)
        await reanchor_entry_suggestions(entry, new_message, session)


async def _apply_entry_update(
    entry: JournalEntry, payload: JournalEntryUpdate, session: AsyncSession
) -> None:
    """Apply the provided fields to ``entry``, re-anchoring marginalia on a body edit."""
    await _apply_message_edit(entry, payload, session)
    if payload.title is not None:
        entry.title = payload.title
    if payload.status is not None:
        entry.status = payload.status
    if payload.classification is not None:
        entry.classification = payload.classification
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
    """The caller's most recent other entry bodies, for connection context.

    Intimate entries (issue #895) are excluded: these bodies are embedded in the
    resonance prompt and sent to the cloud LLM, so an intimate entry must never
    reach the cloud even as *prior context* for a newer non-intimate entry's
    pass. The classification is read off the persisted row (never client-supplied
    at resonance time), mirroring the per-entry privacy floor in ``run_resonance``.
    """
    result = await session.execute(
        select(JournalEntry)
        .where(
            JournalEntry.user_id == user_id,
            JournalEntry.id != exclude_id,
            col(JournalEntry.deleted_at).is_(None),
            col(JournalEntry.classification) != JournalClassification.INTIMATE,
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


def _suggestion_from_hit(
    entry_id: int, user_id: int, hit: CompletionDetected
) -> CompletionSuggestion:
    """Map a detection hit to a PENDING CompletionSuggestion row.

    The polymorphic FK is selected by ``target_type`` to satisfy the model's
    target-fk-matches CHECK (habit → goal_id, practice → user_practice_id).
    """
    is_habit = hit.target_type == CompletionTargetType.HABIT
    return CompletionSuggestion(
        journal_entry_id=entry_id,
        user_id=user_id,
        target_type=hit.target_type,
        goal_id=hit.target_id if is_habit else None,
        user_practice_id=None if is_habit else hit.target_id,
        label=hit.label,
        anchor_start=hit.anchor_start,
        anchor_end=hit.anchor_end,
        anchor_text=hit.anchor_text,
        status=SuggestionStatus.PENDING,
    )


async def _detect_and_persist_suggestions(
    session: AsyncSession, entry_id: int, message: str, user_id: int, llm: BotmasonResonanceLLM
) -> list[CompletionSuggestion]:
    """Best-effort completion detection on the same pass; stage PENDING rows.

    Empty candidates short-circuit with no LLM call (cost guard). A provider error
    is swallowed (returns ``[]``) so the literary pass, the wallet charge, and the
    commit are never rolled back — detection is strictly additive.
    """
    candidates = await gather_candidates(session, user_id, include_practices=True)
    if not candidates:
        return []
    try:
        hits = await detect_completions(message, candidates=candidates, llm=llm)
    except LLMProviderError:
        logger.warning("journal_detection_failed", extra={"user_id": user_id, "entry_id": entry_id})
        return []
    rows = [_suggestion_from_hit(entry_id, user_id, hit) for hit in hits]
    session.add_all(rows)
    return rows


async def _generate_marginalia_or_502(
    message: str, llm: BotmasonResonanceLLM, prior: list[str], session: AsyncSession
) -> list[MarginaliaAnchored]:
    """Run the literary pass; a provider error rolls back the charge and 502s.

    This is the only charged LLM call — a failure here must un-deduct the wallet
    so a failed pass never charges (the detection pass that follows is best-effort
    and never triggers a rollback).
    """
    try:
        return await generate_marginalia(message, llm=llm, prior_entries=prior)
    except LLMProviderError as exc:
        await session.rollback()
        raise bad_gateway("llm_provider_error") from exc


def _care_for(body: str) -> CarePayload | None:
    """Screen ``body`` and return the care payload on an elevated signal, else None.

    Pure and local (no network/LLM): :func:`assess_distress` cannot fail the
    request, and the payload is built from reviewable constants — derived from
    this entry alone, so it can never leak across users.
    """
    if assess_distress(body).level == "elevated":
        return build_care_payload()
    return None


def _care_response(payload: CarePayload | None) -> CareResponse | None:
    """Map a care payload to its response DTO, or ``None`` when not flagged."""
    if payload is None:
        return None
    return CareResponse(
        message=payload.message,
        resources=[
            CareResourceResponse(
                kind=resource.kind,
                name=resource.name,
                contact=resource.contact,
                what_it_is=resource.what_it_is,
            )
            for resource in payload.resources
        ],
    )


# Non-shaming copy shown when an intimate entry is kept off the cloud (issue #895).
# The exact string is contract with the client and the RED tests — one named
# constant so the wording lives in a single place.
_INTIMATE_PRIVATE_MESSAGE = (
    "This entry stays private — it's not sent to any AI. Change its privacy to enable reflection."
)


async def _private_response(session: AsyncSession, user_id: int) -> ResonanceResponse:
    """Resonance response for an intimate entry: no cloud call, no charge.

    An ``intimate`` entry is never sent to a cloud LLM (issue #895), so this is
    returned *before* any wallet deduction or LLM construction: no marginalia,
    no suggestions, unspent balances (read fresh, like :func:`_care_only_response`,
    with no ``preflight_deduction``), and the non-shaming private message.
    """
    user = await require_user_fresh(session, user_id)
    return ResonanceResponse(
        marginalia=[],
        suggestions=[],
        remaining_messages=max(get_monthly_cap() - user.monthly_messages_used, 0),
        remaining_balance=user.offering_balance,
        monthly_reset_date=user.monthly_reset_date,
        care=None,
        private=True,
        private_message=_INTIMATE_PRIVATE_MESSAGE,
    )


async def _care_only_response(
    session: AsyncSession, user_id: int, care: CareResponse
) -> ResonanceResponse:
    """Care surface with no reflection, used when an elevated entry's LLM pass fails.

    The marginalia charge was already rolled back, so the wallet is unspent; we
    surface the human + professional pointers regardless, because care must never
    depend on the LLM succeeding (NORTH-STAR §10).
    """
    user = await require_user_fresh(session, user_id)
    return ResonanceResponse(
        marginalia=[],
        suggestions=[],
        remaining_messages=max(get_monthly_cap() - user.monthly_messages_used, 0),
        remaining_balance=user.offering_balance,
        monthly_reset_date=user.monthly_reset_date,
        care=care,
    )


async def _resonance_pass_or_care(
    message: str,
    llm: BotmasonResonanceLLM,
    prior: list[str],
    session: AsyncSession,
    care: CareResponse | None,
) -> list[MarginaliaAnchored] | None:
    """Run the literary pass; on an LLM failure return ``None`` iff care can stand in.

    A flagged entry swallows the 502 (the charge was already rolled back) and
    yields ``None`` so the caller can return a care-only response — care must
    never depend on the LLM succeeding. An ordinary entry re-raises the 502,
    preserving today's behavior exactly.
    """
    try:
        return await _generate_marginalia_or_502(message, llm, prior, session)
    except HTTPException:
        if care is not None:
            return None
        raise


async def _persist_resonance(
    session: AsyncSession,
    entry: JournalEntry,
    user_id: int,
    llm: BotmasonResonanceLLM,
    anchored: list[MarginaliaAnchored],
) -> tuple[list[Marginalia], list[CompletionSuggestion]]:
    """Stage the anchored notes and best-effort completion suggestions for an entry."""
    entry_id = cast("int", entry.id)
    rows = _persist_marginalia(session, entry_id, user_id, anchored)
    suggestions = await _detect_and_persist_suggestions(
        session, entry_id, entry.message, user_id, llm
    )
    return rows, suggestions


# A user with no StageProgress row yet is treated as the earliest reach: stage 1,
# nothing completed, first cycle. This keeps the contraction gate on the simple
# ease-off variant rather than the deeper Return, which is correct for someone
# who has not begun the staged arc.
_DEFAULT_CURRENT_STAGE = 1
_DEFAULT_CYCLE_NUMBER = 1


async def _contraction_reflection(
    session: AsyncSession, user_id: int
) -> ContractionReflectionResponse | None:
    """Compute the warm, declinable contraction reflection, or ``None`` if healthy.

    Read-only and deterministic: it gathers the user's habit-foundation signals,
    detects a sustained contraction, and — only when flagged — gates the copy by
    the highest stage the user has ever reached. It never writes and never touches
    progression, so it is safe to run on the resonance happy path.
    """
    user_timezone = await get_user_timezone(session, user_id)
    aggregates = await gather_contraction_aggregates(session, user_id, user_timezone)
    signal = detect_contraction(aggregates)
    if signal is None:
        return None
    progress = await get_user_progress(session, user_id)
    if progress is None:
        highest_stage = derive_highest_stage_reached(
            _DEFAULT_CURRENT_STAGE, [], _DEFAULT_CYCLE_NUMBER
        )
    else:
        highest_stage = derive_highest_stage_reached(
            progress.current_stage, progress.completed_stages, progress.cycle_number
        )
    invitation = build_contraction_invitation(signal, highest_stage)
    return ContractionReflectionResponse(variant=invitation.variant, message=invitation.message)


@dataclass(frozen=True)
class _ResonanceSurfaces:
    """The optional reflection surfaces layered onto a resonance response.

    ``care`` is the acute-distress support surface; ``contraction`` is the warm,
    declinable naming of a thinned foundation. Both are ``None`` for an ordinary,
    healthy pass, and bundling them keeps the response builder's signature small.
    """

    care: CareResponse | None
    contraction: ContractionReflectionResponse | None = None


def _resonance_response(
    rows: list[Marginalia],
    suggestions: list[CompletionSuggestion],
    spent: SpendResult,
    reset_date: datetime,
    surfaces: _ResonanceSurfaces,
) -> ResonanceResponse:
    """Build the success response: notes, suggestions, refreshed balances, surfaces."""
    return ResonanceResponse(
        marginalia=[MarginaliaResponse.model_validate(r, from_attributes=True) for r in rows],
        suggestions=[
            CompletionSuggestionResponse.model_validate(s, from_attributes=True)
            for s in suggestions
        ],
        remaining_messages=max(get_monthly_cap() - spent.monthly_used, 0),
        remaining_balance=spent.offering_balance,
        monthly_reset_date=reset_date,
        care=surfaces.care,
        contraction=surfaces.contraction,
    )


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

    The entry is first screened for an acute-distress signal with a pure, local
    check; on an elevated signal the response carries a ``care`` surface (human +
    professional support) that accompanies — never replaces — the reflection, and
    is returned even if the LLM pass fails, so care never depends on the LLM
    (NORTH-STAR §10). An ordinary entry behaves exactly as before (``care`` None).

    After the pass commits, a read-only, deterministic contraction check may add a
    warm, declinable reflection when the habit foundation has thinned. It runs
    only on this non-intimate happy path — never for an intimate entry, whose
    privacy floor returns above — and never mutates progression.
    """
    entry = await _load_user_entry(session, entry_id, current_user)
    if entry is None:
        raise not_found("journal_entry")
    # Privacy floor (issue #895): an intimate entry is NEVER sent to a cloud LLM.
    # Decided from the *persisted* classification (never client-supplied) and
    # returned here — before any care screen, wallet charge, LLM construction, or
    # usage-log write — so the cloud is provably unreachable for intimate entries.
    if entry.classification == JournalClassification.INTIMATE:
        return await _private_response(session, current_user)
    # Screen first, with a pure/local check that can't fail the request, so the
    # care surface is decided independently of the LLM (NORTH-STAR §10).
    care = _care_response(_care_for(entry.message))
    spent = await preflight_deduction(session, current_user)
    prior = await _recent_prior_bodies(session, current_user, entry_id)
    llm = BotmasonResonanceLLM(resolve_chat_api_key(x_llm_api_key))
    anchored = await _resonance_pass_or_care(entry.message, llm, prior, session, care)
    if anchored is None:
        # The reflection failed but the entry is flagged: surface care regardless.
        return await _care_only_response(session, current_user, cast("CareResponse", care))
    rows, suggestions = await _persist_resonance(session, entry, current_user, llm, anchored)
    spent_user = await require_user_fresh(session, current_user)
    await session.commit()
    for row in (*rows, *suggestions):
        await session.refresh(row)
    logger.info(
        "journal_resonance_generated",
        extra={"user_id": current_user, "entry_id": entry_id, "count": len(rows)},
    )
    contraction = await _contraction_reflection(session, current_user)
    surfaces = _ResonanceSurfaces(care=care, contraction=contraction)
    return _resonance_response(rows, suggestions, spent, spent_user.monthly_reset_date, surfaces)


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


@router.get("/{entry_id}/suggestions", response_model=CompletionSuggestionListResponse)
async def list_suggestions(
    entry_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    suggestion_status: Annotated[
        SuggestionStatus | None,
        Query(alias="status", description="Filter to a single status; omit for all."),
    ] = None,
) -> CompletionSuggestionListResponse:
    """List the caller's completion suggestions for an entry, ordered by anchor.

    Ownership-scoped: a missing, soft-deleted, or foreign entry resolves to 404
    (enumeration-safe, matching the marginalia list). ``user_id`` is never
    returned. The optional ``status`` query param narrows to a single lifecycle
    state (e.g. ``?status=pending``); omitting it returns every status.
    """
    entry = await _load_user_entry(session, entry_id, current_user)
    if entry is None:
        raise not_found("journal_entry")
    query = (
        select(CompletionSuggestion)
        .where(
            CompletionSuggestion.journal_entry_id == entry_id,
            CompletionSuggestion.user_id == current_user,  # defense-in-depth
        )
        .order_by(col(CompletionSuggestion.anchor_start))
    )
    if suggestion_status is not None:
        query = query.where(CompletionSuggestion.status == suggestion_status)
    result = await session.execute(query)
    rows = result.scalars().all()
    return CompletionSuggestionListResponse(
        items=[CompletionSuggestionResponse.model_validate(r, from_attributes=True) for r in rows]
    )


async def _load_user_suggestion(
    session: AsyncSession, suggestion_id: int, user_id: int
) -> CompletionSuggestion | None:
    """Load the caller's own suggestion, or None (404-scoped, enumeration-safe)."""
    result = await session.execute(
        select(CompletionSuggestion).where(
            CompletionSuggestion.id == suggestion_id,
            CompletionSuggestion.user_id == user_id,
        )
    )
    return result.scalars().first()


async def _resolve_suggestion_goal(
    session: AsyncSession, suggestion: CompletionSuggestion, user_id: int
) -> tuple[Goal, Habit]:
    """Resolve a habit suggestion's goal + parent habit, ownership-checked (404-mask)."""
    goal = await session.get(Goal, suggestion.goal_id) if suggestion.goal_id is not None else None
    if goal is None:
        raise not_found("goal")
    habit = await session.get(Habit, goal.habit_id)
    if habit is None or habit.user_id != user_id:
        raise not_found("goal")
    return goal, habit


def _suggestion_response(suggestion: CompletionSuggestion) -> CompletionSuggestionResponse:
    """Map a suggestion row to its user_id-free response model."""
    return CompletionSuggestionResponse.model_validate(suggestion, from_attributes=True)


async def _accept_pending_habit(
    session: AsyncSession,
    suggestion: CompletionSuggestion,
    current_user: int,
    user_tz: str,
) -> AcceptSuggestionResponse:
    """Log today's completion for a pending habit suggestion and flip it to accepted."""
    goal, habit = await _resolve_suggestion_goal(session, suggestion, current_user)
    ctx = CheckInContext(goal=goal, habit=habit, user_id=current_user, user_timezone=user_tz)
    check_in = await record_goal_completion(session, ctx, did_complete=True)
    suggestion.status = SuggestionStatus.ACCEPTED
    suggestion.accepted_at = datetime.now(UTC)
    session.add(suggestion)
    await session.commit()
    await session.refresh(suggestion)
    return AcceptSuggestionResponse(suggestion=_suggestion_response(suggestion), check_in=check_in)


# Positive fallback so a journal-attested session (no recorded duration) still
# counts toward weekly totals when the resolved config carries no duration.
_JOURNAL_ATTESTED_FALLBACK_MINUTES = 1.0


async def _resolve_suggestion_practice(
    session: AsyncSession, suggestion: CompletionSuggestion, current_user: int
) -> tuple[UserPractice, Practice]:
    """Load the suggestion's UserPractice (ownership-scoped) + its catalog Practice."""
    user_practice = await session.get(UserPractice, suggestion.user_practice_id)
    if user_practice is None or user_practice.user_id != current_user:
        raise not_found("completion_suggestion")
    practice = await session.get(Practice, user_practice.practice_id)
    if practice is None:
        raise not_found("completion_suggestion")
    return user_practice, practice


def _attested_duration(practice: Practice, user_practice: UserPractice) -> float:
    """Resolved-config duration if positive, else a positive fallback."""
    duration = getattr(effective_config(practice, user_practice), "duration_minutes", None)
    if isinstance(duration, (int, float)) and duration > 0:
        return float(duration)
    return _JOURNAL_ATTESTED_FALLBACK_MINUTES


async def _accept_pending_practice(
    session: AsyncSession, suggestion: CompletionSuggestion, current_user: int
) -> AcceptSuggestionResponse:
    """Log a journal-attested PracticeSession for a pending practice suggestion.

    Idempotent via the practice-session spend layer keyed
    ``accept-suggestion:practice:{id}`` (already recorded ⇒ no second session),
    backstopping the suggestion-status guard. Practices carry no streak, so
    ``check_in`` is ``None``.
    """
    user_practice, practice = await _resolve_suggestion_practice(session, suggestion, current_user)
    key = f"accept-suggestion:practice:{suggestion.id}"
    if await recorded_session_id(session, current_user, key) is None:
        practice_session = PracticeSession(
            user_id=current_user,
            user_practice_id=cast("int", user_practice.id),
            duration_minutes=_attested_duration(practice, user_practice),
            mode=practice.mode,
            mode_metadata={"attested_via": "journal", "mode": practice.mode},
            completed=True,
        )
        session.add(practice_session)
        await session.flush()
        await record_session(session, current_user, key, cast("int", practice_session.id))
    suggestion.status = SuggestionStatus.ACCEPTED
    suggestion.accepted_at = datetime.now(UTC)
    session.add(suggestion)
    await session.commit()
    await session.refresh(suggestion)
    return AcceptSuggestionResponse(suggestion=_suggestion_response(suggestion), check_in=None)


async def _already_accepted_response(
    session: AsyncSession, suggestion: CompletionSuggestion, current_user: int, user_tz: str
) -> AcceptSuggestionResponse:
    """Idempotent response for an already-accepted suggestion (no new write).

    Habits re-derive the current streak; practices have none (``check_in=None``).
    """
    if suggestion.target_type == CompletionTargetType.PRACTICE:
        return AcceptSuggestionResponse(suggestion=_suggestion_response(suggestion), check_in=None)
    goal, habit = await _resolve_suggestion_goal(session, suggestion, current_user)
    ctx = CheckInContext(goal=goal, habit=habit, user_id=current_user, user_timezone=user_tz)
    check_in = await current_check_in(session, ctx)
    return AcceptSuggestionResponse(suggestion=_suggestion_response(suggestion), check_in=check_in)


@router.post("/suggestions/{suggestion_id}/accept", response_model=AcceptSuggestionResponse)
async def accept_suggestion(
    suggestion_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> AcceptSuggestionResponse:
    """Accept a pending suggestion: log the completion + flip to accepted.

    Ownership-scoped (404). A habit logs today's completion via the shared
    ``record_goal_completion`` (idempotent per goal/day) and returns its streak; a
    practice logs a journal-attested ``PracticeSession`` (idempotent, no streak).
    Re-accepting an accepted one is an idempotent no-op; accepting a dismissed one
    is a 409 illegal transition.
    """
    suggestion = await _load_user_suggestion(session, suggestion_id, current_user)
    if suggestion is None:
        raise not_found("completion_suggestion")
    if suggestion.status == SuggestionStatus.DISMISSED:
        raise conflict("suggestion_dismissed")
    if suggestion.status == SuggestionStatus.ACCEPTED:
        return await _already_accepted_response(session, suggestion, current_user, user_tz)
    if suggestion.target_type == CompletionTargetType.PRACTICE:
        return await _accept_pending_practice(session, suggestion, current_user)
    return await _accept_pending_habit(session, suggestion, current_user, user_tz)


@router.post("/suggestions/{suggestion_id}/dismiss", response_model=CompletionSuggestionResponse)
async def dismiss_suggestion(
    suggestion_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> CompletionSuggestionResponse:
    """Dismiss a pending suggestion (idempotent). Dismissing an accepted one is 409."""
    suggestion = await _load_user_suggestion(session, suggestion_id, current_user)
    if suggestion is None:
        raise not_found("completion_suggestion")
    if suggestion.status == SuggestionStatus.ACCEPTED:
        raise conflict("suggestion_accepted")
    if suggestion.status == SuggestionStatus.PENDING:
        suggestion.status = SuggestionStatus.DISMISSED
        session.add(suggestion)
        await session.commit()
        await session.refresh(suggestion)
    return _suggestion_response(suggestion)


# Economy seam: essay expansion is free by default. A future pricing pass would
# charge here (and gate generation on capacity) — kept as a single named knob so
# the policy lives in one place rather than scattered through the handler.
ESSAY_PRICE_UNITS = 0


async def _load_user_marginalia(
    session: AsyncSession, marginalia_id: int, user_id: int
) -> Marginalia | None:
    """Load the caller's own marginalia row by id (denormalized user_id scope)."""
    result = await session.execute(
        select(Marginalia).where(
            Marginalia.id == marginalia_id,
            Marginalia.user_id == user_id,
        )
    )
    return result.scalars().first()


@router.post("/marginalia/{marginalia_id}/essay", response_model=MarginaliaResponse)
@limiter.limit("10/minute")
async def expand_marginalia_essay(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    marginalia_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    x_llm_api_key: Annotated[str | None, Header(alias="X-LLM-API-Key")] = None,
) -> Marginalia:
    """Lazily generate (and cache) a longer essay expanding one margin note.

    Idempotent: once ``essay`` is set the cached value is returned without another
    LLM call. Ownership is enforced via the marginalia's own ``user_id`` (404
    otherwise). Essay generation is free by default (see ``ESSAY_PRICE_UNITS``).
    """
    note = await _load_user_marginalia(session, marginalia_id, current_user)
    if note is None:
        raise not_found("marginalia")
    if note.essay is not None:
        return note
    entry = await _load_user_entry(session, note.journal_entry_id, current_user)
    if entry is None:  # pragma: no cover — marginalia FK guarantees the parent
        raise not_found("journal_entry")
    # Privacy floor (issue #895): an intimate entry is NEVER sent to a cloud LLM,
    # so skip essay generation entirely and return the note (no essay) unchanged.
    # Decided from the *persisted* classification, before the LLM is constructed.
    if entry.classification == JournalClassification.INTIMATE:
        return note
    return await _cache_essay(session, note, entry.message, x_llm_api_key)


async def _cache_essay(
    session: AsyncSession, note: Marginalia, body: str, api_key: str | None
) -> Marginalia:
    """Generate the essay via the cloud LLM, cache it on the note, and persist.

    A provider error maps to 502 with no write. Called only for non-intimate
    entries — the intimate guard in :func:`expand_marginalia_essay` returns before
    this seam, so the cloud is never reached for an intimate entry's essay.
    """
    llm = BotmasonResonanceLLM(resolve_chat_api_key(api_key))
    try:
        essay = await generate_essay(
            llm=llm,
            body=body,
            anchor_text=note.anchor_text,
            kind=note.kind,
            note=note.note,
        )
    except LLMProviderError as exc:
        raise bad_gateway("llm_provider_error") from exc
    note.essay = essay
    note.essay_generated_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(note)
    logger.info("marginalia_essay_generated", extra={"user_id": note.user_id, "id": note.id})
    return note


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
