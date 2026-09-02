"""Journal API — chat messages, tagging, search, and pagination."""

from __future__ import annotations

import logging
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Annotated, cast

from fastapi import Depends, Header, HTTPException, Query, Request, Response, status
from sqlalchemy import ColumnElement, Select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from bounds import INT32_MAX, MAX_PAGE_OFFSET, MIN_ROW_ID, RowIdPath
from database import get_session
from dependencies.creek_vault import get_creek_vault_client
from dependencies.ownership import (
    require_owned_journal_entry,
    resolve_owned_practice_session,
    resolve_owned_user_practice,
)
from dependencies.timezone import current_user_timezone
from domain.care import CarePayload, build_care_payload
from domain.contraction import build_contraction_invitation, detect_contraction
from domain.creek_vault import (
    CreekVaultCareEscalationError,
    CreekVaultClient,
)
from domain.detection import CompletionDetected, detect_completions
from domain.practice_resolution import effective_config
from domain.reflection_hierarchy import ReflectionLevel
from domain.resonance import (
    MarginaliaAnchored,
    MarginaliaOutcome,
    ResonanceLLM,
    explain_no_notes,
    generate_essay,
    generate_marginalia,
)
from domain.safety import assess_distress
from domain.stage_progress import get_user_progress, is_stage_unlocked
from error_responses import build_router
from errors import (
    bad_gateway,
    conflict,
    forbidden,
    not_found,
    unprocessable,
)
from models.completion_suggestion import (
    CompletionSuggestion,
    CompletionTargetType,
    SuggestionStatus,
)
from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalClassification, JournalEntry, JournalTag
from models.marginalia import Marginalia, MarginaliaKind, MarginaliaStatus
from models.practice import Practice
from models.practice_session import PracticeSession
from models.user import User
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
    RelatedEddyResponse,
    RelatedPraxisResponse,
    ResonanceResponse,
    VoiceDraftListResponse,
    VoiceDraftResponse,
)
from schemas.pagination import count_query_total, page_has_more
from security import TextTooLongError, sanitize_user_text
from services import journal_encryption
from services.botmason import (
    LLM_API_KEY_MAX_LENGTH,
    LLMCreditExhaustedError,
    LLMProviderError,
    credit_exhausted_error,
    resolve_chat_api_key,
)
from services.checkin import CheckInContext, current_check_in, record_goal_completion
from services.completion_candidates import gather_candidates
from services.contraction import gather_contraction_aggregates
from services.corpus_ingest import ingest_journal_entry, withdraw_journal_entry
from services.creek_vault_pipeline import VaultPipelineTrigger, drive_vault_pipeline
from services.creek_vault_reflect import (
    VaultRelatedSurfaces,
    related_surfaces,
    select_reflection_llm,
)
from services.creek_vault_write import (
    VaultWriteOutcome,
    VaultWriteStatus,
    store_and_classify,
)
from services.higher_self_grounding import Grounding, gather_grounding
from services.llm_usage import record_llm_usage
from services.marginalia import (
    BotmasonResonanceLLM,
    reanchor_entry_marginalia,
    reanchor_entry_promoted_quotes,
    reanchor_entry_suggestions,
)
from services.practice_session_idempotency import record_session, recorded_session_id
from services.usage import get_monthly_cap
from services.users import get_user_timezone
from services.wallet import (
    SpendResult,
    preflight_deduction,
    refund_one_message,
    require_user_fresh,
)


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


def _coerce_reflection_level(data: dict[str, object]) -> None:
    """Flatten a ``ReflectionLevel`` enum in a dumped payload to its plain value.

    ``model_dump`` yields the enum member; the ORM column is a plain string, so
    persisting the bare value keeps the partial unique index and the reflection
    grammar comparing ordinary strings rather than enum reprs.
    """
    level = data.get("reflection_level")
    if isinstance(level, ReflectionLevel):
        data["reflection_level"] = level.value


logger = logging.getLogger(__name__)

router = build_router(
    prefix="/journal",
    tags=["journal"],
    # 402 is the wallet's, on the metered reflection paths: ``preflight_deduction``
    # refuses a spend with no capacity, ``resolve_chat_api_key`` a call with no key.
    extra_statuses=(
        status.HTTP_402_PAYMENT_REQUIRED,
        status.HTTP_409_CONFLICT,
        status.HTTP_502_BAD_GATEWAY,
    ),
)


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
    practice_session_id: int | None = Query(default=None, ge=MIN_ROW_ID, le=INT32_MAX)
    limit: int = Query(default=50, ge=1, le=200)
    offset: int = Query(default=0, ge=0, le=MAX_PAGE_OFFSET)


# Noon is the midpoint of the UTC day, so a backdated entry stays on its intended
# calendar date across every real-world display timezone (~UTC-12..UTC+14): a
# morning-UTC stamp would render on the prior day for far-west zones and an
# evening-UTC stamp on the next day for far-east zones. Noon minimizes that
# off-by-one-day rendering.
BACKDATED_ENTRY_NOON_UTC_HOUR = 12


def _resolve_backdated_timestamp(entry_date: date | None) -> datetime | None:
    """Map an optional backdate ``entry_date`` to its stored noon-UTC ``timestamp``.

    Returns ``None`` when no date is supplied (the caller then leaves the column's
    ``default_factory`` to stamp the current instant). A supplied date must not be
    in the future (relative to today in UTC), else a 422 ``entry_date_in_future``
    is raised; otherwise it is anchored at noon UTC (see
    :data:`BACKDATED_ENTRY_NOON_UTC_HOUR`).
    """
    if entry_date is None:
        return None
    if entry_date > datetime.now(UTC).date():
        raise unprocessable("entry_date_in_future")
    return datetime(
        entry_date.year,
        entry_date.month,
        entry_date.day,
        BACKDATED_ENTRY_NOON_UTC_HOUR,
        tzinfo=UTC,
    )


# PATCH fields whose change re-sends the entry to the Creek Vault and re-writes
# its corpus fragment. A body edit ('message') or a privacy-tier change
# ('classification') alters what both should hold; a title/status/chord-only
# PATCH must issue zero vault calls and cost zero classifications.
_REINGEST_FIELDS = frozenset({"message", "classification"})


def _apply_vault_outcome(entry: JournalEntry, outcome: VaultWriteOutcome) -> bool:
    """Reconcile an entry's ``vault_ref`` / ``vault_tags`` columns to a write outcome.

    Returns whether a column actually changed, so the caller commits only then:

    - ``INGESTED`` writes the new ref + tags (a re-ingest overwrites any prior
      ref; tags are empty while per-entry vault classification is deferred).
    - ``SKIPPED_INTIMATE`` clears a prior non-intimate ref/tags, since an entry
      re-classified intimate must not retain a handle to plaintext it no longer
      consents to expose (the model documents these columns stay NULL for
      intimate entries). The vault still holds that plaintext until a retract
      capability exists -- see :mod:`services.creek_vault_write`.
    - ``DEGRADED`` / ``UNAVAILABLE`` are transient, so any existing ref is kept
      untouched rather than dropped on a passing network blip.
    """
    if outcome.status is VaultWriteStatus.INGESTED:
        entry.vault_ref = outcome.vault_ref
        entry.vault_tags = list(outcome.tags)
        return True
    if outcome.status is VaultWriteStatus.SKIPPED_INTIMATE and (
        entry.vault_ref is not None or entry.vault_tags is not None
    ):
        entry.vault_ref = None
        entry.vault_tags = None
        return True
    return False


async def _record_vault_outcome(
    session: AsyncSession, entry: JournalEntry, vault_client: CreekVaultClient
) -> None:
    """Store a committed entry via the Creek Vault, reconciling its ref columns.

    Best-effort: :func:`store_and_classify` never raises a vault error, so a
    missing, unreachable, or intimate-skipped write leaves the entry saved. An
    entry with no id yet returns immediately -- the vault keys its stored
    fragment off the stable entry id, so an unsaved draft has nothing to
    send. Column reconciliation lives in :func:`_apply_vault_outcome`; only a
    real column change re-commits, so the common no-op paths stay free of a
    redundant write.

    The pipeline call is last and is a non-event for this request: it degrades
    silently on a vault that never advertised the capability, stands down inside
    its own per-stage interval, runs only the two cheap stages from here, bounds
    itself in elapsed time, and never raises. It keeps the connection discipline
    described below rather than undoing it -- it commits before it dials, so no
    pooled connection is held across its network calls either. It is reached
    only on an ``INGESTED`` outcome, because a pass over a corpus that did not
    just gain a fragment has nothing new to classify.

    The commit below the id check is what keeps a pooled connection out of the
    network round trip. Callers reach here having already committed the entry,
    but each then calls ``session.refresh``, which opens a *fresh* transaction
    -- and an open transaction is a checked-out connection. Left in place it
    would be held for the whole vault request, so pool capacity would be
    governed by the vault's latency rather than our own query time: the pool is
    at SQLAlchemy's defaults (five plus ten overflow) and the vault's
    whole-request deadline is thirty seconds, so fifteen concurrent writes
    against a *slow* vault would starve every other database-backed endpoint. A
    vault that is down is already safe; this is about one that answers slowly.
    Ending the transaction here returns the connection immediately, and the
    session transparently checks out a new one for the outcome write below.
    """
    if entry.id is None:
        return
    await session.commit()
    outcome = await store_and_classify(
        vault_client,
        entry_id=entry.id,
        body=entry.message,
        classification=entry.classification,
        created_at=entry.timestamp,
    )
    if _apply_vault_outcome(entry, outcome):
        session.add(entry)
        await session.commit()
        await session.refresh(entry)
    if outcome.status is VaultWriteStatus.INGESTED:
        await drive_vault_pipeline(
            session,
            vault_client,
            user_id=entry.user_id,
            trigger=VaultPipelineTrigger.JOURNAL_WRITE,
        )


async def _record_corpus_fragment(session: AsyncSession, entry: JournalEntry) -> None:
    """Write the committed entry into its account's corpus, if it may be.

    Best-effort and deliberately last. The entry is already committed by the
    time this runs, so a classification that is slow, refused or unavailable
    can cost latency but can never cost somebody their writing —
    :func:`services.corpus_ingest.ingest_journal_entry` returns ``None`` for
    every one of those outcomes rather than raising, and the one outcome it does
    raise, a provider that refused to bill, is suppressed here for the same
    reason. This is one entry, so there is no batch to stop; the account was
    already named in the WARNING the ingest spine wrote on the way past, and
    turning it into a failed journal write would cost somebody their writing
    over a bill only an operator can settle.

    An account that has not consented never reaches a provider at all, which is
    why the ordinary path here is one indexed read and no network call. The
    commit is unconditional because that read opens a transaction either way,
    and ending it here returns the pooled connection rather than holding it for
    the remainder of the request — and it is outside the suppression so that a
    refusal still returns the connection.
    """
    if entry.id is None:
        return
    with suppress(LLMCreditExhaustedError):
        await ingest_journal_entry(session, entry)
    await session.commit()


async def _authorize_practice_links(
    session: AsyncSession, payload: JournalMessageCreate, current_user: int
) -> None:
    """Verify the caller owns every practice row the new entry links to.

    Both ids arrive in the request *body*, and FastAPI's DI cannot extract
    body fields into sub-dependencies, so the path-parameter ownership
    dependencies never see them; the rule has to be invoked by hand here.
    Each non-null id is checked unconditionally -- there is no "unchanged, so
    skip" shortcut, because that is precisely the reasoning that lets a forged
    link through.  Raises 404 for an id that exists for nobody and 403 for one
    belonging to another user, matching the canonical order elsewhere.
    """
    if payload.user_practice_id is not None:
        await resolve_owned_user_practice(session, payload.user_practice_id, current_user)
    if payload.practice_session_id is not None:
        await resolve_owned_practice_session(session, payload.practice_session_id, current_user)


@router.post("/", response_model=JournalMessageResponse, status_code=status.HTTP_201_CREATED)
async def create_journal_entry(
    payload: JournalMessageCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    vault_client: Annotated[CreekVaultClient, Depends(get_creek_vault_client)],
) -> JournalEntry:
    """Create a journal message for the authenticated user.

    The message body is sanitized at the router boundary
    (BUG-JOURNAL-003) so the row that lands in the DB has no control
    characters, zero-width, or bidi-override codepoints — defense
    against stored-XSS payloads in journal renderers and Trojan-Source
    smuggling in log viewers.

    ``user_practice_id`` and ``practice_session_id`` are authorized before the
    row is constructed: an id that exists for nobody is a 404, another user's
    id is a 403, and neither can reach the session, so no forged link is ever
    persisted.
    """
    await _authorize_practice_links(session, payload, current_user)
    data = payload.model_dump()
    # ``entry_date`` is not a column: resolve it to a stored ``timestamp`` (or,
    # when absent, leave it out so the model's default_factory stamps "now").
    backdated = _resolve_backdated_timestamp(data.pop("entry_date"))
    if backdated is not None:
        data["timestamp"] = backdated
    data["message"] = _sanitize_message(data["message"])
    _coerce_reflection_level(data)
    entry = JournalEntry(sender="user", user_id=current_user, **data)
    session.add(entry)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        # A partial unique index guards one live entry per (user, scope); only a
        # scoped write can trip it, so a scopeless collision is a real bug to raise.
        if data.get("reflection_scope_key") is not None:
            raise conflict("reflection_scope_taken") from exc
        raise
    await session.refresh(entry)
    await _record_vault_outcome(session, entry, vault_client)
    await _record_corpus_fragment(session, entry)
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
        .order_by(col(JournalEntry.timestamp).desc(), col(JournalEntry.id).desc())
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
        has_more=page_has_more(filters.offset, filters.limit, len(matched)),
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
    total = await count_query_total(session, query)

    # Fetch paginated results, newest first. Order by timestamp DESC so a
    # backdated entry (higher id, earlier timestamp) lands by its date; id DESC
    # breaks ties so identical timestamps page stably.
    query = (
        query.order_by(col(JournalEntry.timestamp).desc(), col(JournalEntry.id).desc())
        .offset(filters.offset)
        .limit(filters.limit)
    )
    result = await session.execute(query)
    items = list(result.scalars().all())

    return JournalListResponse(
        items=[JournalMessageResponse.model_validate(e, from_attributes=True) for e in items],
        total=total,
        has_more=page_has_more(filters.offset, filters.limit, total),
    )


def _expanded_drafts_query(user_id: int) -> Select[tuple[Marginalia]]:
    """Select ``user_id``'s expanded margin notes whose parent entry is live.

    The single source of truth for what counts as a Voice Draft.  Three
    predicates carry invariants that are easy to re-derive wrongly:

    * ``JournalEntry.user_id == user_id`` alongside the denormalized
      ``Marginalia.user_id``.  The model defers enforcement of that
      denormalized column to the endpoint layer, so the parent entry's owner
      is the authoritative one and both are asserted (the same defence in
      depth ``list_marginalia`` already writes).
    * ``JournalEntry.deleted_at IS NULL`` (BUG-JOURNAL-007).  Soft deletion
      stamps the entry only — marginalia rows survive it, since just a hard
      ``DELETE`` cascades — so a listing scoped by ``Marginalia.user_id``
      alone would republish essays about writing the user deleted.
    * ``Marginalia.essay IS NOT NULL``.  This is genuine SQL, not an
      in-memory scan: ``EncryptedString`` binds ``None`` to ``None``, so
      NULL-ness survives encryption and no decrypt-then-filter detour is
      needed.
    """
    return (
        select(Marginalia)
        .join(JournalEntry, col(Marginalia.journal_entry_id) == col(JournalEntry.id))
        .where(
            Marginalia.user_id == user_id,
            JournalEntry.user_id == user_id,
            col(JournalEntry.deleted_at).is_(None),
            col(Marginalia.essay).is_not(None),
        )
    )


def _voice_draft(note: Marginalia) -> VoiceDraftResponse:
    """Project one expanded margin note onto its Voice Draft shape."""
    return VoiceDraftResponse(
        marginalia_id=cast("int", note.id),
        journal_entry_id=note.journal_entry_id,
        kind=MarginaliaKind(note.kind),
        anchor_text=note.anchor_text,
        essay=cast("str", note.essay),
        essay_generated_at=cast("datetime", note.essay_generated_at),
    )


@router.get("/voice-drafts", response_model=VoiceDraftListResponse)
@limiter.limit("30/minute")
async def list_voice_drafts(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0, le=MAX_PAGE_OFFSET)] = 0,
) -> VoiceDraftListResponse:
    """List the caller's expanded marginalia essays, newest letter first.

    A read-only shelf.  Nothing is generated on read — no regeneration path,
    no invitation and no nudge; NORTH-STAR §3 ("you choose your depth") and §6
    govern invitations, and this is retrieval, not an invitation.

    Soft-deleted parent entries are excluded (BUG-JOURNAL-007), as
    ``delete_journal_entry`` promises of every read path.

    Drafts whose parent entry is INTIMATE are *included*.  This is retrieval
    to the owner, not egress: an intimate entry never has an essay generated
    (the essay path returns before the LLM), so the pair exists only where the
    entry was reclassified after generation, and ``GET /{entry_id}/marginalia``
    already returns that same essay to its owner today.  Withholding it here
    would hide the writer's own letter from the writer while leaving it
    reachable one route over.  The egress filter belongs to a future vault
    mirror, never as a flag on this predicate.

    Ordering is ``essay_generated_at DESC`` with ``id DESC`` as the tiebreak,
    mirroring ``list_journal_entries``.  The paired-nullability CHECK makes
    ``essay_generated_at`` non-null on every returned row, so the ordering is
    total with no NULLS-placement hazard.

    This route is declared before ``GET /{entry_id}``: Starlette matches in
    registration order on the raw path, so a later declaration would be
    shadowed by the ``RowIdPath`` converter and answer 422.
    """
    query = _expanded_drafts_query(current_user)
    total = await count_query_total(session, query)
    page = (
        query.order_by(col(Marginalia.essay_generated_at).desc(), col(Marginalia.id).desc())
        .offset(offset)
        .limit(limit)
    )
    notes = list((await session.execute(page)).scalars().all())
    return VoiceDraftListResponse(
        items=[_voice_draft(note) for note in notes],
        total=total,
        has_more=page_has_more(offset, limit, total),
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
    """Re-sanitize the body on edit and re-anchor marginalia, suggestions, and quotes."""
    if payload.message is None:
        return
    old_message = entry.message
    new_message = _sanitize_message(payload.message)
    if new_message != old_message:
        entry.message = new_message
        await reanchor_entry_marginalia(entry, new_message, session)
        await reanchor_entry_suggestions(entry, new_message, session)
        await reanchor_entry_promoted_quotes(entry, new_message, session)


def _apply_chord_update(entry: JournalEntry, payload: JournalEntryUpdate) -> None:
    """Apply the chord (primary/secondary Aspect) as one atomic pair.

    Sending either field marks the whole chord provided: both are written, so a
    primary-only PATCH resets a stale secondary to ``None`` (the schema default),
    keeping the persisted pair a valid chord shape.
    """
    chord_fields = {"primary_aspect", "secondary_aspect"}
    if payload.model_fields_set & chord_fields:
        entry.primary_aspect = payload.primary_aspect
        entry.secondary_aspect = payload.secondary_aspect


def _apply_scope_update(entry: JournalEntry, payload: JournalEntryUpdate) -> None:
    """Apply the reflection-scope (level/key) as one atomic pair.

    Touching either field writes both, mirroring the chord update: the schema
    validator already guarantees both-or-neither plus a well-formed key, so the
    persisted pair stays a valid, in-lock-step reflection scope.
    """
    scope_fields = {"reflection_level", "reflection_scope_key"}
    if payload.model_fields_set & scope_fields:
        level = payload.reflection_level
        entry.reflection_level = level.value if level is not None else None
        entry.reflection_scope_key = payload.reflection_scope_key


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
    _apply_chord_update(entry, payload)
    _apply_scope_update(entry, payload)
    # ``updated_at`` is bumped by the column's ``onupdate`` only when a value
    # actually changes, so a same-value PATCH doesn't move it.


@router.patch("/{entry_id}", response_model=JournalMessageResponse)
async def update_journal_entry(
    entry_id: RowIdPath,
    payload: JournalEntryUpdate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    vault_client: Annotated[CreekVaultClient, Depends(get_creek_vault_client)],
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
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        # The partial unique index only fires on a scoped write; a scopeless
        # PATCH tripping it would be a real bug, so re-raise those.
        if payload.reflection_scope_key is not None:
            raise conflict("reflection_scope_taken") from exc
        raise
    await session.refresh(entry)
    # Re-ingest only when the body or privacy tier changed; a title/status/chord
    # PATCH leaves the vault's copy and the corpus fragment untouched (and
    # issues zero vault calls and zero classifications).
    if payload.model_fields_set & _REINGEST_FIELDS:
        await _record_vault_outcome(session, entry, vault_client)
        await _record_corpus_fragment(session, entry)
    logger.info("journal_entry_updated", extra={"user_id": current_user, "entry_id": entry_id})
    return entry


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


async def _grounding_for(session: AsyncSession, user_id: int, entry_id: int) -> Grounding:
    """Gather the reflection's context and record which source answered.

    The record is ids and counts only. Naming the fragments is what makes a
    given reflection attributable months later; printing their contents would
    put the writing this whole path exists to protect into an operator's log
    file, where none of the encryption or tier rules reach.
    """
    grounding = await gather_grounding(session, user_id=user_id, exclude_entry_id=entry_id)
    logger.info(
        "journal_resonance_grounded",
        extra={
            "user_id": user_id,
            "entry_id": entry_id,
            "grounding_source": grounding.source.value,
            "grounding_count": len(grounding.bodies),
            "fragment_ids": list(grounding.fragment_ids),
        },
    )
    return grounding


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
    commit are never rolled back — detection is strictly additive. A spent balance
    is swallowed on the same terms but logged with its ``provider``: it is permanent
    where a dropped socket is transient, and the account is the only thing an
    operator can act on.
    """
    candidates = await gather_candidates(session, user_id, include_practices=True)
    if not candidates:
        return []
    try:
        hits = await detect_completions(message, candidates=candidates, llm=llm)
    except LLMCreditExhaustedError as exc:
        logger.warning(
            "journal_detection_failed",
            extra={"user_id": user_id, "entry_id": entry_id, "provider": exc.provider},
        )
        return []
    except LLMProviderError:
        logger.warning("journal_detection_failed", extra={"user_id": user_id, "entry_id": entry_id})
        return []
    rows = [_suggestion_from_hit(entry_id, user_id, hit) for hit in hits]
    session.add_all(rows)
    return rows


def _log_resonance_outcome(
    outcome: MarginaliaOutcome, *, user_id: int, entry_id: int, count: int
) -> None:
    """Record what the pass produced and, when nothing survived, that it did not.

    ``count=0`` alone states an outcome and never a cause: a model that returned
    nothing, a completion that would not parse, and a model whose every quote was
    paraphrased past the verbatim anchor all looked identical, and to the writer
    all three look like a button that does nothing. The tally rides on the
    existing record so the cause is in the same line as the outcome, and a
    distinct WARNING fires for the one shape worth alerting on -- the model
    proposed notes and the writer received none of them.

    Counts and ids only. Never a quote, a note, or any part of the body: the same
    reason the grounding path logs ids and counts, since journal text is
    encrypted at rest.
    """
    extra: dict[str, object] = {
        "user_id": user_id,
        "entry_id": entry_id,
        "count": count,
        **outcome.as_log_extra(),
    }
    logger.info("journal_resonance_generated", extra=extra)
    if outcome.produced_nothing_usable:
        logger.warning("journal_resonance_all_drafts_discarded", extra=extra)


@dataclass(frozen=True, slots=True)
class _ResonancePassContext:
    """What the charged literary pass needs beyond the prompt itself.

    ``byok`` records whose key paid for the call, which is what decides how a
    spent provider balance is reported — a bill the caller can settle, or one
    only an operator can. ``care`` is the standby surface a distress-flagged
    entry falls back to when the pass fails, so care never depends on the LLM.
    """

    session: AsyncSession
    care: CareResponse | None
    byok: bool


async def _generate_marginalia_or_error(
    message: str, llm: ResonanceLLM, prior: list[str], context: _ResonancePassContext
) -> MarginaliaOutcome:
    """Run the literary pass; a provider error rolls back the charge and fails.

    This is the only charged LLM call — a failure here must un-deduct the wallet
    so a failed pass never charges (the detection pass that follows is best-effort
    and never triggers a rollback).

    A spent balance is caught first because it subclasses the generic provider
    error: it is permanent, so it earns the status whose remedy the caller can
    actually act on rather than a 502 that invites a retry forever.
    """
    try:
        return await generate_marginalia(message, llm=llm, prior_entries=prior)
    except LLMCreditExhaustedError as exc:
        await context.session.rollback()
        raise credit_exhausted_error(exc, byok=context.byok) from exc
    except LLMProviderError as exc:
        await context.session.rollback()
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


def _care_surface(payload: CarePayload) -> CareResponse:
    """Map a care payload onto its response DTO.

    Split out from :func:`_care_response` so the paths that already know they
    have a payload — the vault's care escalation among them — can build the
    surface without a cast through an optional.
    """
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


def _care_response(payload: CarePayload | None) -> CareResponse | None:
    """Map a care payload to its response DTO, or ``None`` when not flagged."""
    return None if payload is None else _care_surface(payload)


# Non-shaming copy shown when an intimate entry is kept off the cloud (issue #895).
# The exact string is contract with the client and the RED tests — one named
# constant so the wording lives in a single place.
_INTIMATE_PRIVATE_MESSAGE = (
    "This entry stays private — it's not sent to any AI. Change its privacy to enable reflection."
)


def _unspent_resonance(
    user: User,
    *,
    care: CareResponse | None,
    private: bool = False,
    private_message: str | None = None,
) -> ResonanceResponse:
    """Build a no-reflection response over the caller's *unspent* wallet balances.

    Shared skeleton for the two paths that return before any charge lands: the
    intimate/private path and the care-only fallback when an elevated entry's
    LLM pass fails. Both surface empty marginalia + suggestions
    and read the wallet fresh (no ``preflight_deduction``), differing only in
    the ``care`` payload and the private-message fields.
    """
    return ResonanceResponse(
        marginalia=[],
        suggestions=[],
        remaining_messages=max(get_monthly_cap() - user.monthly_messages_used, 0),
        remaining_balance=user.offering_balance,
        monthly_reset_date=user.monthly_reset_date,
        care=care,
        private=private,
        private_message=private_message,
    )


async def _private_response(
    session: AsyncSession, user_id: int, care: CareResponse | None
) -> ResonanceResponse:
    """Resonance response for an intimate entry: no cloud call, no charge.

    An ``intimate`` entry is never sent to a cloud LLM (issue #895), so this is
    returned *before* any wallet deduction or LLM construction: no marginalia,
    no suggestions, unspent balances (read fresh, like :func:`_care_only_response`,
    with no ``preflight_deduction``), and the non-shaming private message.

    ``care`` is the locally-screened surface (never None-forced): a distressed
    intimate entry still points to human/professional support, with no cloud
    call, charge, or usage-log — the privacy floor never suppresses crisis care.
    """
    user = await require_user_fresh(session, user_id)
    return _unspent_resonance(
        user, care=care, private=True, private_message=_INTIMATE_PRIVATE_MESSAGE
    )


async def _care_only_response(
    session: AsyncSession, user_id: int, care: CareResponse
) -> ResonanceResponse:
    """Care surface with no reflection, for the two paths that reach care instead of one.

    Used when an elevated entry's LLM pass fails, and when a connected vault
    answers with its care escalation. Either way the marginalia charge has
    already been rolled back, so the wallet is unspent; we surface the human +
    professional pointers regardless, because care must never depend on the
    reflection succeeding (NORTH-STAR §10).
    """
    user = await require_user_fresh(session, user_id)
    return _unspent_resonance(user, care=care)


async def _refresh_persisted(
    session: AsyncSession, rows: list[Marginalia], suggestions: list[CompletionSuggestion]
) -> None:
    """Reload every committed row so the response carries its server-assigned fields."""
    for row in (*rows, *suggestions):
        await session.refresh(row)


async def _escalated_care_response(session: AsyncSession, user_id: int) -> ResonanceResponse:
    """Answer a vault care escalation with adepthood's own care surface, uncharged.

    The vault's care guard declined to produce a reflection because the writing
    signalled acute distress, so what the caller gets back is a way to reach a
    human rather than an error or a cloud answer — falling back would hand them
    exactly the model prose that guard refused.

    The rollback is load-bearing: ``preflight_deduction`` has already staged one
    message against the wallet, and returning without it would charge a person in
    distress for a reflection they never received.

    The care payload is built fresh rather than threaded in from the handler's own
    screen, and that is provably right: an entry adepthood flagged locally
    short-circuits in ``select_reflection_llm`` and never reaches the vault, so
    ``care`` is always ``None`` on this path. The copy is adepthood's own reviewed
    surface — Creek's reason, message, and resource list are Creek's writing and
    are dropped at the adapter.
    """
    await session.rollback()
    return await _care_only_response(session, user_id, _care_surface(build_care_payload()))


async def _resonance_pass_or_care(
    message: str, llm: ResonanceLLM, prior: list[str], context: _ResonancePassContext
) -> MarginaliaOutcome | None:
    """Run the literary pass; on an LLM failure return ``None`` iff care can stand in.

    A flagged entry swallows the provider failure (the charge was already rolled
    back) and yields ``None`` so the caller can return a care-only response — care
    must never depend on the LLM succeeding. An ordinary entry re-raises,
    preserving today's behavior exactly.
    """
    try:
        return await _generate_marginalia_or_error(message, llm, prior, context)
    except HTTPException:
        if context.care is not None:
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


# A user with no StageProgress row yet has never reached any stage, so their
# lifetime high-water mark is the earliest reach. This keeps the contraction gate
# on the simple ease-off variant rather than the deeper Return, which is correct
# for someone who has not begun the staged arc.
_NO_PROGRESS_HIGHEST_STAGE = 1


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
    highest_stage = (
        _NO_PROGRESS_HIGHEST_STAGE if progress is None else progress.highest_stage_reached
    )
    invitation = build_contraction_invitation(highest_stage)
    return ContractionReflectionResponse(variant=invitation.variant, message=invitation.message)


@dataclass(frozen=True)
class _ResonanceSurfaces:
    """The optional reflection surfaces layered onto a resonance response.

    ``care`` is the acute-distress support surface; ``contraction`` is the warm,
    declinable naming of a thinned foundation. Both are ``None`` for an ordinary,
    healthy pass, and bundling them keeps the response builder's signature small.

    ``no_notes_message`` is the sentence explaining a pass that produced no
    margin notes; ``None`` whenever notes were kept. It rides here rather than
    being re-derived in the builder because the same value decides whether the
    charge is reversed, and those two must never disagree — a writer told the
    pass was not charged while the charge stands is a worse bug than silence.

    ``related`` is the writer's own compiled vault pages this pass surfaced, read
    off the reflection source rather than re-derived: empty for every pass a
    vault did not answer, which is what a cloud reflection, a degraded vault and
    a vault with no pages all report.
    """

    care: CareResponse | None
    contraction: ContractionReflectionResponse | None = None
    no_notes_message: str | None = None
    related: VaultRelatedSurfaces = field(default_factory=VaultRelatedSurfaces)


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
        no_notes_message=surfaces.no_notes_message,
        related_praxis=[
            RelatedPraxisResponse.model_validate(praxis, from_attributes=True)
            for praxis in surfaces.related.praxis
        ],
        related_eddies=[
            RelatedEddyResponse.model_validate(eddy, from_attributes=True)
            for eddy in surfaces.related.eddies
        ],
    )


async def _settle_empty_pass(
    session: AsyncSession, user_id: int, spent: SpendResult, outcome: MarginaliaOutcome
) -> tuple[SpendResult, str | None]:
    """Explain a pass that kept no notes, and hand its charge back.

    The two halves are deliberately one call. A writer told "this pass wasn't
    charged" while the charge stands is worse than the silence this replaced, so
    the sentence and the reversal are decided from the same value rather than
    from two independent reads of the outcome that could drift apart.

    Returns the balances to report and the sentence to show, or the untouched
    balances and ``None`` when the pass produced notes.
    """
    message = explain_no_notes(outcome)
    if message is None:
        return spent, None
    return await refund_one_message(session, user_id, spent), message


@dataclass(frozen=True)
class _ReflectionClients:
    """The two reflection backends the resonance handler selects between.

    ``api_key`` is the caller's optional BYOK key for the local cloud LLM;
    ``vault_client`` is the optional Creek Vault client. Bundling the pair into
    one injected value keeps the handler's dependency signature small while the
    routing choice between them stays in :func:`select_reflection_llm`.
    """

    api_key: str | None = field(repr=False)
    vault_client: CreekVaultClient


def _reflection_clients(
    vault_client: Annotated[CreekVaultClient, Depends(get_creek_vault_client)],
    x_llm_api_key: Annotated[
        str | None, Header(alias="X-LLM-API-Key", max_length=LLM_API_KEY_MAX_LENGTH)
    ] = None,
) -> _ReflectionClients:
    """Bundle the BYOK key and the vault client for the resonance handler.

    A thin dependency that resolves both reflection backends together. The nested
    :func:`get_creek_vault_client` dependency stays independently overridable, so
    a test can still swap the vault client through ``dependency_overrides``.
    """
    return _ReflectionClients(api_key=x_llm_api_key, vault_client=vault_client)


@router.post("/{entry_id}/resonance", response_model=ResonanceResponse)
@limiter.limit("10/minute")
async def run_resonance(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    entry_id: RowIdPath,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    clients: Annotated[_ReflectionClients, Depends(_reflection_clients)],
) -> ResonanceResponse:
    """Run a resonance pass over the caller's entry, persist notes, charge one unit.

    Wallet pre-flight deducts one message (402 when out of capacity). The LLM
    pass + persistence + the charge commit atomically; any provider error rolls
    the deduction back so a failed pass never charges (502 ``llm_provider_error``).

    A pass that *succeeds* and still persists no notes is neither an error nor a
    non-event: it is a writer who waited and received nothing. Those get the
    server's own explanation in ``no_notes_message`` — never an empty 200 the
    client has to interpret — and the deduction is reversed in the bucket it
    came from, so silence costs the writer nothing. The reversal is a crediting
    entry rather than a rollback on purpose: the provider call really happened,
    and rolling back would erase the usage record of what it cost us along with
    any completion suggestions the same pass legitimately found.

    The entry is first screened for an acute-distress signal with a pure, local
    check; on an elevated signal the response carries a ``care`` surface (human +
    professional support) that accompanies — never replaces — the reflection, and
    is returned even if the LLM pass fails, so care never depends on the LLM
    (NORTH-STAR §10). An ordinary entry behaves exactly as before (``care`` None).

    After the pass commits, a read-only, deterministic contraction check may add a
    warm, declinable reflection when the habit foundation has thinned. It runs
    only on this non-intimate happy path — never for an intimate entry, whose
    privacy floor returns above — and never mutates progression.

    When a vault is connected and the entry is neither intimate nor
    distress-flagged, the reflection routes to that vault's own corpus; otherwise
    it is generated by the local cloud LLM exactly as before.

    The context that accompanies the entry is chosen by
    :func:`~services.higher_self_grounding.gather_grounding` — the account's own
    ontologized corpus where it holds anything, the recency window where it does
    not. It is gathered on every pass, vault or not: a vault that degrades hands
    the prompt to the cloud fallback, which is the path this context is for.

    A vault may answer that request with its own care escalation, meaning its
    care guard read acute distress in writing adepthood's local screen did not
    flag. That is a 200 carrying adepthood's own reviewed care surface and no
    reflection — never a 502, and never the cloud's answer, since falling back
    would hand the writer exactly the model prose the guard refused. The staged
    deduction is rolled back, so the pass costs them nothing.
    """
    entry = await _load_user_entry(session, entry_id, current_user)
    if entry is None:
        raise not_found("journal_entry")
    # Privacy floor (issue #895): an intimate entry is NEVER sent to a cloud LLM.
    # Decided from the *persisted* classification (never client-supplied) and
    # returned here — before wallet charge, LLM construction, or usage-log write —
    # so the cloud is provably unreachable for intimate entries. The LOCAL care
    # screen (pure; no cloud/charge/log) still runs, so the privacy floor never
    # suppresses crisis support (NORTH-STAR §10) — the same screen feeds both
    # the intimate and non-intimate paths.
    care = _care_response(_care_for(entry.message))
    if entry.classification == JournalClassification.INTIMATE:
        return await _private_response(session, current_user, care)
    spent = await preflight_deduction(session, current_user)
    grounding = await _grounding_for(session, current_user, entry_id)
    byok_key = resolve_chat_api_key(clients.api_key)
    llm = BotmasonResonanceLLM(byok_key)
    reflection_llm = await select_reflection_llm(
        clients.vault_client,
        body=entry.message,
        classification=entry.classification,
        care_flagged=care is not None,
        fallback=llm,
    )
    try:
        anchored = await _resonance_pass_or_care(
            entry.message,
            reflection_llm,
            list(grounding.bodies),
            _ResonancePassContext(session=session, care=care, byok=byok_key is not None),
        )
    except CreekVaultCareEscalationError:
        # The vault's care guard fired: answer with adepthood's own care surface
        # instead of a reflection, and roll the staged charge back.
        return await _escalated_care_response(session, current_user)
    if anchored is None:
        # The reflection failed but the entry is flagged: surface care regardless.
        return await _care_only_response(session, current_user, cast("CareResponse", care))
    rows, suggestions = await _persist_resonance(session, entry, current_user, llm, anchored.notes)
    spent, no_notes_message = await _settle_empty_pass(session, current_user, spent, anchored)
    spent_user = await require_user_fresh(session, current_user)
    await record_llm_usage(
        session,
        user_id=current_user,
        journal_entry_id=cast("int", entry.id),
        responses=llm.usage,
    )
    await session.commit()
    await _refresh_persisted(session, rows, suggestions)
    _log_resonance_outcome(anchored, user_id=current_user, entry_id=entry_id, count=len(rows))
    contraction = await _contraction_reflection(session, current_user)
    surfaces = _ResonanceSurfaces(
        care=care,
        contraction=contraction,
        no_notes_message=no_notes_message,
        related=related_surfaces(reflection_llm),
    )
    return _resonance_response(rows, suggestions, spent, spent_user.monthly_reset_date, surfaces)


@router.get("/{entry_id}/marginalia", response_model=MarginaliaListResponse)
async def list_marginalia(
    entry_id: RowIdPath,
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
    entry_id: RowIdPath,
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
    session: AsyncSession, suggestion: CompletionSuggestion, current_user: int, user_tz: str
) -> AcceptSuggestionResponse:
    """Log a journal-attested PracticeSession for a pending practice suggestion.

    Idempotent via the practice-session spend layer keyed
    ``accept-suggestion:practice:{id}`` (already recorded ⇒ no second session),
    backstopping the suggestion-status guard. Practices carry no streak, so
    ``check_in`` is ``None``.

    A practice may be *assigned* to a future stage for forward planning, but
    planning is not access: attesting a real session via the journal is gated
    by the same timezone-aware stage-unlock check the session endpoint applies,
    so a suggestion for a locked stage is rejected (403) before any write.
    """
    user_practice, practice = await _resolve_suggestion_practice(session, suggestion, current_user)
    progress = await get_user_progress(session, current_user)
    if not is_stage_unlocked(user_practice.stage_number, progress, tz=user_tz):
        raise forbidden("stage_locked")
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
    suggestion_id: RowIdPath,
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
        return await _accept_pending_practice(session, suggestion, current_user, user_tz)
    return await _accept_pending_habit(session, suggestion, current_user, user_tz)


@router.post("/suggestions/{suggestion_id}/dismiss", response_model=CompletionSuggestionResponse)
async def dismiss_suggestion(
    suggestion_id: RowIdPath,
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
    marginalia_id: RowIdPath,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    x_llm_api_key: Annotated[
        str | None, Header(alias="X-LLM-API-Key", max_length=LLM_API_KEY_MAX_LENGTH)
    ] = None,
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

    A transient provider error maps to 502 with no write; a spent balance maps to
    its own permanent status, checked first because it subclasses the generic
    type. Called only for non-intimate entries — the intimate guard in
    :func:`expand_marginalia_essay` returns before this seam, so the cloud is
    never reached for an intimate entry's essay.
    """
    byok_key = resolve_chat_api_key(api_key)
    llm = BotmasonResonanceLLM(byok_key)
    try:
        essay = await generate_essay(
            llm=llm,
            body=body,
            anchor_text=note.anchor_text,
            kind=note.kind,
            note=note.note,
        )
    except LLMCreditExhaustedError as exc:
        raise credit_exhausted_error(exc, byok=byok_key is not None) from exc
    except LLMProviderError as exc:
        raise bad_gateway("llm_provider_error") from exc
    note.essay = essay
    note.essay_generated_at = datetime.now(UTC)
    await record_llm_usage(
        session,
        user_id=note.user_id,
        journal_entry_id=note.journal_entry_id,
        responses=llm.usage,
    )
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
    if entry_id is not None:
        # The corpus copy goes with the entry. A fragment that outlived a
        # delete would keep the deleted writing in circulation as context for
        # newer reflections -- soft-deletion hides an entry from every read
        # path, and the corpus is a read path.
        await withdraw_journal_entry(session, user_id=current_user, entry_id=entry_id)
    await session.commit()
    logger.info(
        "journal_entry_soft_deleted",
        extra={"user_id": current_user, "entry_id": entry_id},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
