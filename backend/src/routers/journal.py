"""Journal API — chat messages, tagging, search, and pagination."""

from __future__ import annotations

import enum
import logging
from collections.abc import Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Annotated, cast

from fastapi import Body, Depends, Header, HTTPException, Query, Request, Response, status
from sqlalchemy import ColumnElement, Select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from bounds import INT32_MAX, MAX_PAGE_OFFSET, MIN_ROW_ID, RowIdPath
from database import get_session
from dependencies.creek_vault import (
    get_creek_vault_client,
    get_reflection_boundary,
    resolved_vault_destination,
)
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
    CreekVaultPipelineClient,
    VaultTierCeiling,
    tier_ceiling_for,
)
from domain.dates import (
    MAX_BACKFILL_DAYS,
    day_window_verdict,
    to_user_date_bucket,
    today_in_tz,
)
from domain.depth_preferences import DepthRing, load_enabled_rings
from domain.detection import CompletionDetected, DetectionCandidate, detect_completions
from domain.detection_facts import DetectionClock
from domain.practice_resolution import effective_config
from domain.reflection_hierarchy import ReflectionLevel
from domain.resonance import (
    PRIOR_DRAFT_CHARS,
    PRIOR_DRAFT_LIMIT,
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
    service_unavailable,
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
from models.wallet_audit import (
    REASON_REFUND_DEMO,
    REASON_REFUND_FAILED_ESSAY,
    REASON_REFUND_FAILED_RESONANCE,
    REASON_REFUND_NO_ESSAY,
)
from rate_limit import limiter
from routers.auth import get_current_user
from schemas.completion_suggestion import (
    AcceptSuggestionResponse,
    CompletionDetectionResponse,
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
    EssayRequest,
    EssayResponse,
    MarginaliaListResponse,
    MarginaliaResponse,
    PassProvenance,
    RelatedEddyResponse,
    RelatedPraxisResponse,
    ResonanceResponse,
    VoiceDraftListResponse,
    VoiceDraftResponse,
)
from schemas.pagination import count_query_total, page_has_more
from security import TextTooLongError, sanitize_user_text
from security.idempotency import IDEMPOTENCY_KEY_MAX_LENGTH, hash_idem_key
from services import journal_encryption
from services.account_egress_barrier import ensure_account_live, hold_account
from services.botmason import (
    LLM_API_KEY_MAX_LENGTH,
    LLMCreditExhaustedError,
    LLMProviderError,
    LLMResponse,
    credit_exhausted_error,
    resolve_chat_api_key,
)
from services.checkin import (
    CheckInCommand,
    CheckInContext,
    current_check_in,
    record_goal_completion,
)
from services.completion_candidates import gather_candidates
from services.contraction import gather_contraction_aggregates
from services.corpus_ingest import (
    ingest_journal_entry,
)
from services.corpus_ingest import (
    withdraw_journal_entry as withdraw_local_journal_entry,
)
from services.corpus_invitation import record_completed_pass
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_pipeline import VaultPipelineTrigger, drive_vault_pipeline
from services.creek_vault_reflect import (
    VaultRelatedSurfaces,
    reflection_receipt,
    related_surfaces,
    select_reflection_llm,
)
from services.creek_vault_voice_drafts import (
    EntryRef,
    VoiceDraftCopy,
    mark_entry_retractions_pending,
    mirror_voice_draft,
    record_mirror_intent,
    retract_pending_voice_drafts,
)
from services.creek_vault_withdraw import withdraw_journal_copy
from services.creek_vault_write import (
    VaultWriteOutcome,
    VaultWriteStatus,
    store_and_classify,
)
from services.generation_guardrails import (
    consume_generation_minute,
    generation_slot,
    require_generation_minute_available,
)
from services.higher_self_grounding import Grounding, gather_grounding
from services.inference_provenance import (
    PassReceipts,
    detection_receipt,
    is_demo,
    pass_provenance,
    source_value,
    stamp_letter,
    stamp_note,
)
from services.llm_usage import (
    GenerationFeature,
    GenerationKey,
    GenerationOutcome,
    GenerationSettlement,
    GenerationUsage,
    log_generation_settled,
    record_llm_usage,
    summarize_usage,
)
from services.marginalia import (
    BotmasonResonanceLLM,
    InferenceReceipt,
    reanchor_entry_marginalia,
    reanchor_entry_promoted_quotes,
    reanchor_entry_suggestions,
    receipt_since,
)
from services.practice_session_idempotency import record_session, recorded_session_id
from services.reflection_boundary import (
    REFLECTION_SOURCE_UNAVAILABLE,
    ReflectionBoundary,
    VaultSourceUnavailableError,
    VaultSourceUnavailableReason,
    app_provider_llm,
    require_app_provider_llm,
)
from services.usage import get_monthly_cap
from services.users import get_user_timezone
from services.voice_draft_privacy import journal_vault_mutations, voice_draft_privacy
from services.wallet import (
    SpendResult,
    StagedRefund,
    log_committed_refund,
    preflight_deduction,
    refund_one_message,
    require_user_fresh,
    reset_monthly_usage_if_due,
)


def _sanitize_message(message: str) -> str:
    """Return one non-empty sanitized journal body or a stable HTTP 422.

    Pydantic's ``max_length`` already caps raw input at
    :data:`JOURNAL_MESSAGE_MAX_LENGTH`, but NFC normalization can in rare
    cases (Hangul jamo, Tibetan stacks) leave the post-normalization length
    *above* the cap.  Re-checking after sanitization closes that gap; we
    raise 422 (rather than the 500 we would otherwise return on an
    unhandled domain error) so the client sees a uniform length-violation
    shape regardless of which layer rejected the value.

    Raw ``min_length`` validation cannot see that stripping whitespace,
    controls, and zero-width codepoints may leave nothing. Reject that state
    here, before a row or any downstream journal work exists, and use the same
    helper on reflective reads so rows written before this boundary landed are
    never handed to a provider.
    """
    try:
        sanitized = sanitize_user_text(message, max_len=JOURNAL_MESSAGE_MAX_LENGTH)
    except TextTooLongError as exc:
        raise unprocessable("message_too_long") from exc
    if not sanitized:
        raise unprocessable("journal_message_empty")
    return sanitized


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
    # 429 is the generation guardrails' (#623): the per-user minute bucket, the
    # concurrent slot, and the wallet's daily ceiling.
    extra_statuses=(
        status.HTTP_402_PAYMENT_REQUIRED,
        status.HTTP_409_CONFLICT,
        status.HTTP_429_TOO_MANY_REQUESTS,
        status.HTTP_502_BAD_GATEWAY,
        status.HTTP_503_SERVICE_UNAVAILABLE,
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
    - ``SKIPPED_INTIMATE`` leaves a prior ref untouched. That ref is the durable
      proof that a remote copy still needs withdrawal; only Creek's confirmed,
      content-free destructive inverse may clear it.
    - ``DEGRADED`` / ``UNAVAILABLE`` are transient, so any existing ref is kept
      untouched rather than dropped on a passing network blip.
    """
    if outcome.status is VaultWriteStatus.INGESTED:
        entry.vault_ref = outcome.vault_ref
        entry.vault_tags = list(outcome.tags)
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
    binding = await _bind_vault_destination(session, entry, vault_client)
    if binding is _Binding.WITHHOLD:
        return
    await session.commit()
    outcome = await store_and_classify(
        vault_client,
        entry_id=entry.id,
        body=entry.message,
        classification=entry.classification,
        created_at=entry.timestamp,
    )
    # Bitwise ``|``, not ``or``: both helpers mutate ``entry`` and must both run.
    if _apply_vault_outcome(entry, outcome) | _unbind_if_nothing_sent(entry, binding, outcome):
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


class _Binding(enum.Enum):
    """What staging a vault destination decided about one write."""

    WITHHOLD = "withhold"  # an earlier copy is owed to another vault: do not offer
    UNCHANGED = "unchanged"  # proceed; the recorded destination is already right
    BOUND = "bound"  # proceed; this write staged a new destination


#: Write outcomes that provably dialled no ingest: nothing reached any vault.
_NOTHING_SENT = frozenset({VaultWriteStatus.SKIPPED_INTIMATE, VaultWriteStatus.UNAVAILABLE})


async def _bind_vault_destination(
    session: AsyncSession, entry: JournalEntry, vault_client: CreekVaultClient
) -> _Binding:
    """Record which vault is about to be offered this entry, or withhold the offer.

    Staged before the ingest dial (and committed with the caller's pre-dial
    commit), so a crash or a lost acknowledgement after Creek stores the entry
    still leaves a durable withdrawal marker bound to that vault. Nothing is
    staged when nothing can be sent: a local fallback dials nothing, and an
    Intimate entry is withheld from the wire before any dial. An entry whose
    earlier copy is owed to a *different* vault keeps that marker and is not
    offered to the new one: a single marker cannot describe two copies, and
    the owed one wins.

    The fingerprint comes from the same config read that built the request's
    client (:func:`resolved_vault_destination`), so a reconnect landing after
    that read cannot bind this write to a vault it does not dial.
    """
    undialled = _binding_without_a_dial(entry, vault_client)
    if undialled is not None:
        return undialled
    destination = await resolved_vault_destination(session, entry.user_id)
    if entry.vault_destination not in {None, destination}:
        logger.warning(
            "journal_vault_write_withheld",
            extra={"entry_id": entry.id, "reason": "destination_changed"},
        )
        return _Binding.WITHHOLD
    if entry.vault_destination is not None or destination is None:
        return _Binding.UNCHANGED
    entry.vault_destination = destination
    session.add(entry)
    return _Binding.BOUND


def _binding_without_a_dial(entry: JournalEntry, vault_client: CreekVaultClient) -> _Binding | None:
    """Decide the writes that can send nothing, so they stage nothing; ``None`` otherwise."""
    if type(vault_client) is LocalFallbackCreekVaultClient:
        return _Binding.UNCHANGED if entry.vault_destination is None else _Binding.WITHHOLD
    if tier_ceiling_for(entry.classification) is VaultTierCeiling.INTIMATE:
        return _Binding.UNCHANGED
    return None


def _unbind_if_nothing_sent(
    entry: JournalEntry, binding: _Binding, outcome: VaultWriteOutcome
) -> bool:
    """Drop a destination this write staged when the write provably sent nothing.

    A handshake that turned the write away, or an Intimate skip, dialled no
    ingest; leaving the marker would make the entry owe a withdrawal for a
    copy that does not exist. A degraded ingest *was* dialled and keeps it.
    """
    if binding is not _Binding.BOUND or outcome.status not in _NOTHING_SENT:
        return False
    entry.vault_destination = None
    return True


async def _withdraw_remote_copies(
    session: AsyncSession,
    entry: JournalEntry,
    vault_client: CreekVaultPipelineClient,
) -> bool:
    """Attempt every owed withdrawal for ``entry``; ``True`` only when all are confirmed.

    Both the essay withdrawals and the journal copy are attempted every time,
    so one failing never hides the other. Each is bound to the destination that
    received it: a replaced or removed connection leaves the copy pending
    rather than trusting the new vault's "unknown id, withdrawn". Callers have
    already committed the stricter local state, so a ``False`` here costs the
    writer nothing but a stable 503 and a retry.
    """
    entry_id = cast("int", entry.id)
    destination = await resolved_vault_destination(session, entry.user_id)
    drafts_withdrawn = await retract_pending_voice_drafts(
        session,
        vault_client,
        EntryRef(user_id=entry.user_id, entry_id=entry_id),
        destination=destination,
    )
    journal_withdrawn = await withdraw_journal_copy(
        session, entry, vault_client, destination=destination
    )
    return drafts_withdrawn and journal_withdrawn


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

    It is no longer the commit that keeps the connection out of the provider
    call, which it never could be: it runs after the ingest, so on the path that
    does classify it was returning a connection the classification had already
    held. :func:`services.corpus_ingest._classify_and_record` commits before it
    dials for that reason, and this commit now lands only what happened after —
    the fragment, or nothing.
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


async def _keyed_entry(session: AsyncSession, user_id: int, hashed: str) -> JournalEntry | None:
    """The entry this account already created under ``hashed``, if any.

    Scoped by ``user_id`` as well as the digest: the digest is already
    account-prefixed, and filtering on the owner too means no reading of this
    function can ever hand one account's writing to another.

    A recorded entry that has since been soft-deleted is a 404, never the entry
    and never a fresh write. The key stays spent (the unique index is not
    partial on ``deleted_at``), so a retry arriving after a delete cannot bring
    the deleted words back, and it cannot quietly write them a second time
    either: from the client's side that is the same resurrection.
    """
    result = await session.execute(
        select(JournalEntry).where(
            col(JournalEntry.user_id) == user_id,
            col(JournalEntry.idem_key) == hashed,
        )
    )
    entry = result.scalars().first()
    if entry is not None and entry.deleted_at is not None:
        raise not_found("journal_entry")
    return entry


async def _replay_hit(
    session: AsyncSession, user_id: int, hashed: str | None
) -> JournalEntry | None:
    """The pre-insert replay read: the stored entry for a presented key, else ``None``.

    An unkeyed create never replays -- two unkeyed writes are two entries, and
    reading ``idem_key IS NULL`` would match every earlier unkeyed one.
    """
    if hashed is None:
        return None
    return await _keyed_entry(session, user_id, hashed)


def _build_entry(payload: JournalMessageCreate, user_id: int, hashed: str | None) -> JournalEntry:
    """The row a create writes: sanitized body, resolved date, digest of its key."""
    data = payload.model_dump()
    # ``entry_date`` is not a column: resolve it to a stored ``timestamp`` (or,
    # when absent, leave it out so the model's default_factory stamps "now").
    backdated = _resolve_backdated_timestamp(data.pop("entry_date"))
    if backdated is not None:
        data["timestamp"] = backdated
    data["message"] = _sanitize_message(data["message"])
    _coerce_reflection_level(data)
    return JournalEntry(sender="user", user_id=user_id, idem_key=hashed, **data)


async def _commit_new_entry(
    session: AsyncSession, entry: JournalEntry, user_id: int, *, hashed: str | None
) -> tuple[JournalEntry, bool]:
    """Insert ``entry``; answer ``(row, created)``.

    ``created`` is ``False`` only when a concurrent request under the same key
    won the insert: the winner's row is returned and it, not this request, owns
    the vault write, the corpus ingest and the ``journal_entry_created`` event.
    """
    scoped = entry.reflection_scope_key is not None
    session.add(entry)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        # This row has to exist before the barrier in the handler can key the
        # entry serializer on its id, so the commit above is the one statement
        # in the create that runs *outside* the ordering. On PostgreSQL
        # ``journalentry.user_id`` is a real foreign key, so an erasure that
        # linearized first turns this insert into a foreign-key violation rather
        # than into a row the liveness read then refuses -- the same refusal,
        # arriving through the database. Answer it the same way, before any
        # collision branch, because a violation is not a collision.
        await ensure_account_live(session, user_id)
        # A keyed collision is a concurrent retry of this very write; resolve it
        # to the stored row. Checked before the scope 409 because a retried
        # scoped write collides on both indexes. Only when a key was presented:
        # re-reading an absent key would match ``idem_key IS NULL`` rows.
        if hashed is not None:
            winner = await _keyed_entry(session, user_id, hashed)
            if winner is not None:
                return winner, False
        # A partial unique index guards one live entry per (user, scope); only a
        # scoped write can trip it, so a scopeless collision is a real bug to raise.
        if scoped:
            raise conflict("reflection_scope_taken") from exc
        raise
    await session.refresh(entry)
    return entry, True


@router.post("/", response_model=JournalMessageResponse, status_code=status.HTTP_201_CREATED)
async def create_journal_entry(
    payload: JournalMessageCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    vault_client: Annotated[CreekVaultPipelineClient, Depends(get_creek_vault_client)],
    idempotency_key: Annotated[
        str | None,
        Header(alias="Idempotency-Key", max_length=IDEMPOTENCY_KEY_MAX_LENGTH),
    ] = None,
) -> JournalEntry:
    """Create a journal message for the authenticated user.

    The message body is sanitized at the router boundary
    (BUG-JOURNAL-003) so the row that lands in the DB has no control
    characters, zero-width, or bidi-override codepoints — defense
    against stored-XSS payloads in journal renderers and Trojan-Source
    smuggling in log viewers.

    ``user_practice_id`` and ``practice_session_id`` are authorized before the
    row is constructed -- and before any replay is looked up, so a replay can
    never be used to skip the check: an id that exists for nobody is a 404,
    another user's id is a 403, and neither can reach the session, so no
    forged link is ever persisted.

    A create carrying an ``Idempotency-Key`` this account has already used is
    answered with the entry that key created (#2936): one row, 201, and no
    second vault write, corpus ingest or ``journal_entry_created`` event. The
    body of the retry is not compared -- a client whose retry carries newer text
    must PATCH it -- and a key whose entry was since deleted is a 404. An
    unkeyed create is always a new entry.
    """
    await _authorize_practice_links(session, payload, current_user)
    hashed = hash_idem_key(current_user, idempotency_key) if idempotency_key else None
    replayed = await _replay_hit(session, current_user, hashed)
    if replayed is not None:
        return replayed
    entry, created = await _commit_new_entry(
        session, _build_entry(payload, current_user, hashed), current_user, hashed=hashed
    )
    if not created:
        return entry
    entry_id = cast("int", entry.id)
    # Account barrier outermost, entry serializer innermost — the fixed nesting
    # everywhere the two meet. Taken exactly once in this handler: the locks are
    # not reentrant, so a second acquire anywhere below would hang every write.
    async with (
        hold_account(session, current_user),
        journal_vault_mutations.hold(session, entry_id),
    ):
        # A concurrent ``DELETE /users/me`` that linearized first has already
        # taken this account's writing with it, so there is nothing left to hand
        # outward and no live caller to answer 201 to.
        await ensure_account_live(session, current_user)
        # The row became visible before this lock because its id had to be
        # committed first. A concurrent delete or privacy PATCH may therefore
        # have completed while this request waited. Reload inside the critical
        # section and never send the stale pre-lock object to Creek.
        current = await _load_user_entry(session, entry_id, current_user)
        if current is not None:
            entry = current
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


def _prior_letters_query(user_id: int, exclude_entry_id: int) -> Select[tuple[Marginalia]]:
    """Narrow the Voice-Draft predicate to the letters that may leave for a provider.

    Built by calling :func:`_expanded_drafts_query` and adding to it, never by
    re-deriving its clauses. Owner scope on *both* the note and its parent entry,
    ``JournalEntry.deleted_at IS NULL`` (BUG-JOURNAL-007) and
    ``Marginalia.essay IS NOT NULL`` are therefore **inherited, not restated**:
    a hand-copied set could lose one silently, and a letter about an entry the
    account deleted would then be sent back out to a third party.
    ``tests/test_prior_letters_grounding.py::test_the_egress_query_inherits_every_listing_predicate``
    asserts that inheritance per clause, so it stays structural rather than
    coincidental.

    Exactly three predicates are added here, and the first is the reason this
    function exists at all:

    * ``classification != INTIMATE``. The listing predicate deliberately
      *includes* Intimate-parent drafts -- see :func:`list_voice_drafts`, which
      explains that returning a writer their own letter is retrieval, not
      egress. This is egress, so it needs the opposite answer, and it must be
      taken **here**: migrating an egress filter onto the shared query, or
      adding a flag to it, would narrow that listing route to hide a writer's
      own letter from them. The shape mirrors
      ``services.higher_self_grounding._recent_entry_bodies``, which added the
      same predicate for entry bodies when issue #895 closed.
    * ``JournalEntry.id != exclude_entry_id``. The page being read is not its
      own prior context. **Documented cost:** the exclusion is uniform on both
      routes and keyed on the entry, so two letters about *different* spans of
      the same page are not deduplicated against each other -- arguably the most
      repetitive case on the essay route. That is a deliberate narrowing (one
      predicate, no ``| None`` branch, strictly less egress); a follow-up may
      widen it on purpose.
    * Newest first, bounded by ``PRIOR_DRAFT_LIMIT`` -- the same constant that
      bounds the prompt-side slice in ``domain.resonance._prior_letters_parts``,
      so what is fetched and what is sent cannot drift apart.
    """
    return (
        _expanded_drafts_query(user_id)
        .where(
            col(JournalEntry.classification) != JournalClassification.INTIMATE,
            col(JournalEntry.id) != exclude_entry_id,
        )
        .order_by(col(Marginalia.essay_generated_at).desc(), col(Marginalia.id).desc())
        .limit(PRIOR_DRAFT_LIMIT)
    )


async def _prior_letter_essays(
    session: AsyncSession, *, user_id: int, exclude_entry_id: int
) -> list[str]:
    """Return the letters that may ride along as content-only anti-repetition context.

    The thin executor over :func:`_prior_letters_query`, which carries the whole
    egress predicate and the reasoning for it. Each essay is truncated to
    ``PRIOR_DRAFT_CHARS`` so the row bound is a token bound too.
    """
    rows = (await session.execute(_prior_letters_query(user_id, exclude_entry_id))).scalars().all()
    return [cast("str", note.essay)[:PRIOR_DRAFT_CHARS] for note in rows]


def _voice_draft(note: Marginalia) -> VoiceDraftResponse:
    """Project one expanded margin note onto its Voice Draft shape."""
    return VoiceDraftResponse(
        marginalia_id=cast("int", note.id),
        journal_entry_id=note.journal_entry_id,
        kind=MarginaliaKind(note.kind),
        anchor_text=note.anchor_text,
        essay=cast("str", note.essay),
        essay_generated_at=cast("datetime", note.essay_generated_at),
        essay_source=note.essay_source,
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
        await reanchor_entry_marginalia(
            entry, session, old_message=old_message, new_message=new_message
        )
        await reanchor_entry_suggestions(
            entry, session, old_message=old_message, new_message=new_message
        )
        await reanchor_entry_promoted_quotes(
            entry, session, old_message=old_message, new_message=new_message
        )


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
    vault_client: Annotated[CreekVaultPipelineClient, Depends(get_creek_vault_client)],
) -> JournalEntry:
    """Patch ``message`` / ``title`` / ``status`` on the caller's own entry.

    Scoped to the caller's non-deleted rows: a missing id, a soft-deleted row, or
    another user's entry all resolve to 404 (enumeration-safe). Editing the body
    re-sanitizes it and invokes the marginalia re-anchor seam; ``updated_at`` is
    refreshed.

    The account barrier is taken on the re-ingesting branch alone. The other
    branch changes a title or a status and dials nothing, so ordering it against
    an erasure would buy no confidentiality and would put a lock on the cheapest
    PATCH the client makes.
    """
    reingests = bool(payload.model_fields_set & _REINGEST_FIELDS)
    if not reingests:
        entry = await _persist_entry_update(
            entry_id,
            payload,
            current_user,
            session,
        )
    else:
        # One per-entry order spans the committed local update and every Creek
        # mutation. A concurrent PUT therefore finishes before this privacy
        # transition withdraws it, or begins after and observes the intimate
        # row; it cannot land stale plaintext after a successful response.
        # Around it, the account barrier — outermost, as everywhere the two meet.
        async with (
            hold_account(session, current_user),
            journal_vault_mutations.hold(session, entry_id),
        ):
            await ensure_account_live(session, current_user)
            entry = await _persist_entry_update(
                entry_id,
                payload,
                current_user,
                session,
            )
            if entry.classification == JournalClassification.INTIMATE:
                await _apply_intimate_update(
                    session,
                    entry,
                    vault_client,
                    chose_intimate="classification" in payload.model_fields_set,
                )
            else:
                await _record_vault_outcome(session, entry, vault_client)
                await _record_corpus_fragment(session, entry)
    logger.info("journal_entry_updated", extra={"user_id": current_user, "entry_id": entry_id})
    return entry


async def _apply_intimate_update(
    session: AsyncSession,
    entry: JournalEntry,
    vault_client: CreekVaultPipelineClient,
    *,
    chose_intimate: bool,
) -> None:
    """Keep an Intimate entry out of the corpus and, when it was chosen, withdraw its copies.

    Every PATCH that sets Intimate -- including a repeat of the same value --
    owes and retries every withdrawal, so "choose Intimate again" is a real
    retry. The tier is committed first and never reverted; a 503 reports only
    that remote cleanup is pending. A body edit or Finish on an entry that is
    already Intimate never dials: it saves, and any owed withdrawal is left to
    the background sweep, so a vault that can never confirm (#3060 escalation
    1) cannot hold the writer's own page hostage.
    """
    entry_id = cast("int", entry.id)
    await withdraw_local_journal_entry(session, user_id=entry.user_id, entry_id=entry_id)
    if chose_intimate:
        await mark_entry_retractions_pending(session, user_id=entry.user_id, entry_id=entry_id)
    await session.commit()
    if chose_intimate and not await _withdraw_remote_copies(session, entry, vault_client):
        raise service_unavailable("vault_withdrawal_pending")


async def _persist_entry_update(
    entry_id: int,
    payload: JournalEntryUpdate,
    current_user: int,
    session: AsyncSession,
) -> JournalEntry:
    """Load, apply, and commit one owned update inside any caller-held privacy lock."""
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


async def _require_user_entry(session: AsyncSession, entry_id: int, user_id: int) -> JournalEntry:
    """Load the caller's own non-deleted entry, or raise the uniform 404."""
    entry = await _load_user_entry(session, entry_id, user_id)
    if entry is None:
        raise not_found("journal_entry")
    return entry


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
    session: AsyncSession,
    entry_id: int,
    user_id: int,
    anchored: list[MarginaliaAnchored],
    *,
    receipt: InferenceReceipt | None,
) -> list[Marginalia]:
    """Stage one Marginalia row per anchored note (active, no essay yet), stamped with its source.

    ``receipt`` is required by keyword so no writer can stage a note without
    deciding what it records about who answered (#3062).
    """
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
    for row in rows:
        stamp_note(row, receipt)
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
        # Habit-only, satisfying ``ck_completion_suggestion_facts_habit_only``.
        # This guard is load-bearing, not belt-and-braces. Only the AMOUNT is
        # self-limiting: ``normalise_unit`` refuses every practice amount
        # because a practice tracks no unit. The DAY is resolved without
        # consulting the unit at all, so detection really does hand a practice
        # hit a ``completed_on`` -- which the CHECK would reject inside
        # ``_persist_settle_commit``, turning a best-effort extra into a 500 on
        # the writer's reflection. ``_accept_pending_practice`` backdates
        # nothing, so dropping the day here loses nothing real.
        completed_units=hit.completed_units if is_habit else None,
        completed_on=hit.completed_on if is_habit else None,
        status=SuggestionStatus.PENDING,
    )


@dataclass(frozen=True, slots=True)
class _DetectionAttempt:
    """What detection found, whether it returned, and whether it sent anything at all."""

    hits: list[CompletionDetected]
    checked: bool
    dialled: bool = False


@dataclass(frozen=True, slots=True)
class DetectionInputs:
    """The candidates one detection pass may offer, plus the days it resolves against.

    Bundled rather than passed as two arguments for the same reason
    ``_ReflectionClients`` exists three hundred lines below: the handler
    signatures in this module are already at their argument budget, and a
    sixth parameter on any of them fails lint. The clock *replaces* the
    ``candidates`` parameter everywhere it travels, so nothing grows.
    """

    candidates: Sequence[DetectionCandidate]
    clock: DetectionClock


def _log_detection_checked(
    hits: Sequence[CompletionDetected], *, user_id: int, entry_id: int
) -> None:
    """Record that a real detection round trip happened, and what it yielded.

    Ids and counts only — never a quote, a unit word, a ``when`` phrase or any
    body text. Journal writing is encrypted at rest precisely so it never
    reaches an operator's log file, and a detected fact is a direct quotation
    of it.

    Emitted only after a provider actually answered, never on the
    empty-candidate short-circuit, so ``hits_with_units`` over ``hits`` stays a
    meaningful ratio — and it is the only operational signal that the unit
    alias table is too narrow for what people really write.
    """
    logger.info(
        "journal_detection_checked",
        extra={
            "user_id": user_id,
            "entry_id": entry_id,
            "hits": len(hits),
            "hits_with_units": sum(1 for hit in hits if hit.completed_units is not None),
            "hits_with_day": sum(1 for hit in hits if hit.completed_on is not None),
        },
    )


async def _detect_hits_with_status(
    message: str,
    *,
    inputs: DetectionInputs,
    llm: BotmasonResonanceLLM | None,
    user_id: int,
    entry_id: int,
) -> _DetectionAttempt:
    """Best-effort completion detection against the pre-read candidates.

    ``llm`` is ``None`` when the caller's boundary is vault-bound: a vault has no
    detection capability, so detection is skipped and reported unchecked rather
    than sent to the app provider (#3061). This is the one place that decision
    is read, for both routes that detect.

    Runs with no transaction open — the candidates were read and committed
    before the first dial, so the provider round trip holds no pooled
    connection. Empty candidates short-circuit with no LLM call (cost guard).
    A provider error is swallowed (returns ``[]``) so the literary pass and the
    wallet charge are never disturbed — detection is strictly additive. A spent
    balance is swallowed on the same terms but logged with its ``provider``: it
    is permanent where a dropped socket is transient, and the account is the
    only thing an operator can act on.
    """
    if llm is None:
        return _DetectionAttempt(hits=[], checked=False)
    if not inputs.candidates:
        return _DetectionAttempt(hits=[], checked=True)
    try:
        hits = await detect_completions(
            message, candidates=inputs.candidates, llm=llm, clock=inputs.clock
        )
    except LLMCreditExhaustedError as exc:
        logger.warning(
            "journal_detection_failed",
            extra={"user_id": user_id, "entry_id": entry_id, "provider": exc.provider},
        )
        return _DetectionAttempt(hits=[], checked=False, dialled=True)
    except LLMProviderError:
        logger.warning("journal_detection_failed", extra={"user_id": user_id, "entry_id": entry_id})
        return _DetectionAttempt(hits=[], checked=False, dialled=True)
    _log_detection_checked(hits, user_id=user_id, entry_id=entry_id)
    return _DetectionAttempt(hits=hits, checked=True, dialled=True)


def _stage_suggestions(
    session: AsyncSession, entry_id: int, user_id: int, hits: list[CompletionDetected]
) -> list[CompletionSuggestion]:
    """Stage one PENDING suggestion row per detected hit."""
    rows = [_suggestion_from_hit(entry_id, user_id, hit) for hit in hits]
    session.add_all(rows)
    return rows


def _log_resonance_outcome(
    outcome: MarginaliaOutcome,
    receipts: PassReceipts,
    *,
    user_id: int,
    entry_id: int,
    count: int,
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
    encrypted at rest. The two sources are closed-vocabulary words (#3062); the
    self-reported model string is never logged.
    """
    extra: dict[str, object] = {
        "user_id": user_id,
        "entry_id": entry_id,
        "count": count,
        "notes_source": source_value(receipts.notes),
        "detection_source": source_value(receipts.detection),
        **outcome.as_log_extra(),
    }
    logger.info("journal_resonance_generated", extra=extra)
    if outcome.produced_nothing_usable:
        logger.warning("journal_resonance_all_drafts_discarded", extra=extra)


@dataclass(frozen=True, slots=True)
class _ResonancePassContext:
    """What the literary pass needs beyond the prompt itself.

    ``byok`` records whose key paid for the call, which is what decides how a
    spent provider balance is reported — a bill the caller can settle, or one
    only an operator can. ``care`` is the standby surface a distress-flagged
    entry falls back to when the pass fails, so care never depends on the LLM.
    ``spent`` is the optional deduction a failure path must compensate. It is
    ``None`` when the caller's own key pays, otherwise it committed before the
    dial so a rollback can no longer un-charge it. ``user_id`` is whose wallet
    the compensating credit lands in when there was a deduction. ``trace`` is
    the pass's generation, so a failure settles with its one settlement line.
    """

    session: AsyncSession
    care: CareResponse | None
    byok: bool
    user_id: int
    spent: SpendResult | None
    trace: _FailedGeneration


@dataclass(frozen=True, slots=True)
class _FailedGeneration:
    """What a failed generation's settlement line reports (#623 PR3).

    ``usage`` is the adapter's live ``usage`` list, read when the failure
    settles, so it holds every call that returned before the failure.
    ``attempts`` is the pass's reported attempt count, or 0 when the pass
    settled before reporting one (a provider error, a withdrawn entry, a care
    escalation); an essay always makes exactly one attempt.
    """

    feature: GenerationFeature
    key: GenerationKey
    usage: Sequence[LLMResponse]
    attempts: int = 0


async def _refund_failed_pass(
    session: AsyncSession,
    user_id: int,
    spent: SpendResult | None,
    *,
    reason: str = REASON_REFUND_FAILED_RESONANCE,
    trace: _FailedGeneration | None = None,
) -> None:
    """Roll back a failed generation's writes and compensate any deduction.

    A server-paid deduction is already durable before the first dial, so a
    rollback cannot un-charge it; that generation is settled with a
    compensating credit. BYOK carries ``spent=None`` and needs only the
    rollback. In both cases ``rollback()`` first clears whatever failed
    transaction and staged rows the failure left behind. ``reason`` names the
    generation in the audit trail: a resonance pass by default, an essay's own
    token when the essay seam settles through here.

    This is the one place every resonance and essay failure settles, so it is
    where a failed generation's ``llm_generation_settled`` line is written
    (#623 PR3): ``refunded_failed``, charged only when a server-paid deduction
    committed, and only once the compensating credit (if any) is durable. A
    caller with no generation to report passes no ``trace``.
    """
    await session.rollback()
    if spent is not None:
        refund = await refund_one_message(session, user_id, spent, reason=reason)
        await session.commit()
        log_committed_refund(refund)
    if trace is not None:
        log_generation_settled(
            GenerationSettlement(
                feature=trace.feature,
                user_id=user_id,
                key=trace.key,
                bucket=None if spent is None else spent.bucket,
                outcome=GenerationOutcome.REFUNDED_FAILED,
                attempts=trace.attempts,
                usage=summarize_usage(trace.usage),
            )
        )


async def _generate_marginalia_or_error(
    message: str,
    llm: ResonanceLLM,
    prior: list[str],
    context: _ResonancePassContext,
    prior_drafts: list[str],
) -> MarginaliaOutcome:
    """Run the literary pass; a provider error settles any BotMason charge and fails.

    This is the only LLM call that can draw from BotMason. A server-paid failure
    must settle the already committed deduction with a compensating credit; a
    caller-key failure has no deduction to reverse. The detection pass that
    follows is best-effort and never touches the wallet.

    A spent balance is caught first because it subclasses the generic provider
    error: it is permanent, so it earns the status whose remedy the caller can
    actually act on rather than a 502 that invites a retry forever.
    """
    try:
        return await generate_marginalia(
            message, llm=llm, prior_entries=prior, prior_drafts=prior_drafts
        )
    except LLMCreditExhaustedError as exc:
        await _refund_failed_pass(
            context.session, context.user_id, context.spent, trace=context.trace
        )
        raise credit_exhausted_error(exc, byok=context.byok) from exc
    except LLMProviderError as exc:
        await _refund_failed_pass(
            context.session, context.user_id, context.spent, trace=context.trace
        )
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
        title=payload.title,
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
    """Resonance response for an intimate entry: no model call, no net charge.

    An ``intimate`` entry is never sent to a language model (issue #895), so this
    is returned *before* any LLM construction: no marginalia, no suggestions,
    unspent balances (read fresh, like :func:`_care_only_response`), and the
    non-shaming private message. On the usual path it is returned before any
    wallet deduction too. When the entry only became intimate while the pass
    waited for the account barrier, :func:`_withdrawn_under_hold` has already
    refunded the committed deduction before calling this, so the balances it
    reads are unspent on that path as well (#2998).

    ``care`` is the locally-screened surface (never None-forced): a distressed
    intimate entry still points to human/professional support, with no cloud
    call, charge, or usage-log — the privacy floor never suppresses crisis care.
    """
    user = await require_user_fresh(session, user_id)
    return _unspent_resonance(
        user, care=care, private=True, private_message=_INTIMATE_PRIVATE_MESSAGE
    )


async def _withdrawn_under_hold(
    session: AsyncSession,
    entry: JournalEntry,
    *,
    spent: SpendResult | None,
    trace: _FailedGeneration | None,
) -> bool:
    """Re-read the entry under the pass's hold; settle and report whether it is withdrawn.

    The pass reads the intimate floor before it charges and before it waits
    for :func:`hold_account`. ``PATCH /journal/{entry_id}`` carrying
    ``classification`` takes that same exclusive hold, so a PATCH that queues
    first completes in full and answers 200 before the pass gets in. A dial
    made from the pre-hold reading would then hand a now-intimate body to a
    language model (#2998). The essay route re-reads under its hold for the
    same reason (#623).

    * A row deleted while the pass waited is gone, not private: any committed
      BotMason unit is refunded and the caller gets the uniform 404.
    * A row now ``intimate`` stops the whole pass: no vault, no cloud
      reflection, no completion detection. Any committed unit is refunded and
      this returns ``True``, so the caller answers with
      :func:`_private_response` -- still carrying ``care``, because the privacy
      floor never suppresses crisis support.

    Otherwise this returns ``False`` and the refreshed ``entry.classification``
    is what the caller binds. The fresh value is used as-is, never the wider
    of the two readings: a lower classification maps to a narrower vault
    ceiling, so a writer who narrows the tier mid-pass gets the narrower read.
    Tiers here only ever tighten what is sent.

    Completion detection (``POST /journal/{entry_id}/suggestions/detect``) is
    the second caller (#3008). It waits for the same hold behind the same
    PATCH and DELETE, but it is uncharged, so it passes ``spent=None`` and the
    "refund" is a bare rollback. On ``True`` it answers
    ``{items: [], checked: false}`` rather than :func:`_private_response`.

    Every path out of here has released the pooled connection -- the commit
    after the refresh, or the refund's own rollback and commit -- so nothing
    is held across the dials that follow.
    """
    await session.refresh(entry)
    await session.commit()
    if entry.deleted_at is not None:
        await _refund_failed_pass(session, entry.user_id, spent, trace=trace)
        raise not_found("journal_entry")
    if entry.classification == JournalClassification.INTIMATE:
        await _refund_failed_pass(session, entry.user_id, spent, trace=trace)
        return True
    return False


async def _body_under_hold(
    session: AsyncSession,
    entry: JournalEntry,
    *,
    spent: SpendResult | None,
    trace: _FailedGeneration,
) -> tuple[str, CareResponse | None]:
    """The body every dial of a resonance pass carries, and its care verdict, from the fresh row.

    Called once :func:`_withdrawn_under_hold` has refreshed ``entry`` under the
    pass's hold and found it still readable. ``PATCH /journal/{entry_id}``
    carrying only ``message`` takes the same exclusive hold, so an edit that
    queued first has already answered 200; a body sanitized before the wait
    would hand the vault, the reflection and completion detection the words the
    writer had just removed (#3008). All three dials use what this returns.

    The local care screen re-runs on that body rather than reusing the pre-wait
    verdict. It is pure and local, so re-running it costs nothing and sends
    nothing, and the verdict decides more than the surface: a flagged entry
    never reaches the vault. A verdict kept from a calm pre-wait body would
    answer an edit into crisis with no care and route it to the vault.

    A row that now sanitizes to nothing answers the route's own 422. The
    server-paid unit committed before the wait, so it is refunded first --
    the rollback inside the refund also leaves no connection held.
    """
    try:
        message = _sanitize_message(entry.message)
    except HTTPException:
        await _refund_failed_pass(session, entry.user_id, spent, trace=trace)
        raise
    return message, _care_response(_care_for(message))


async def _pass_context_under_hold(
    session: AsyncSession, user_id: int, entry_id: int
) -> tuple[Grounding, list[str]]:
    """Gather the other writing a pass carries, under its hold, then release the connection.

    The pass hands a model more than its own entry: up to
    ``GROUNDING_LIMIT`` pieces of the writer's other writing as ``<prior>``
    context, and excerpts of earlier letters as ``<prior_letters>`` (#2574).
    Both are gathered *here*, under :func:`hold_account`, and never before the
    wait for it. ``PATCH /journal/{entry_id}`` making *another* entry intimate,
    and ``DELETE /journal/{entry_id}``, take the same exclusive hold and, inside
    it, withdraw that entry's local corpus copy and stamp its row. A read taken
    before the wait would still hold that entry's body, or a letter about it,
    after a request withdrawing it had answered 200 -- an intimate entry handed
    to a language model, which #895 forbids whoever pays.

    Re-gathering rather than re-checking what was gathered earlier is the sound
    choice, for two reasons. The eligibility rule keeps exactly one derivation
    each -- the corpus store's tier barriers plus ``exclude_entry_id`` on one
    side, :func:`_prior_letters_query` on the other -- instead of a second,
    by-id reading that could drift from them. And a corpus fragment from an
    upload or an import has no entry to re-check at all; the corpus copy the
    mutation withdrew is simply no longer there to retrieve.

    The commit releases the pooled connection these reads opened, so none is
    held across the dials that follow.
    """
    grounding = await _grounding_for(session, user_id, entry_id)
    prior_letters = await _prior_letter_essays(session, user_id=user_id, exclude_entry_id=entry_id)
    await session.commit()
    return grounding, prior_letters


async def _care_only_response(
    session: AsyncSession, user_id: int, care: CareResponse
) -> ResonanceResponse:
    """Care surface with no reflection, for the paths that reach care instead of one.

    Used when an elevated entry's LLM pass fails, when a connected vault
    answers with its care escalation, and when a vault-bound entry is flagged
    locally and so asks no model at all. Every time, the marginalia charge has
    already been settled — by a compensating credit when BotMason paid, or
    with no wallet work for BYOK — so the fresh read below reports unchanged
    balances. We surface the human + professional pointers regardless, because
    care must never depend on the reflection succeeding (NORTH-STAR §10).
    """
    user = await require_user_fresh(session, user_id)
    return _unspent_resonance(user, care=care)


async def _refresh_persisted(
    session: AsyncSession, rows: list[Marginalia], suggestions: list[CompletionSuggestion]
) -> None:
    """Reload every committed row so the response carries its server-assigned fields."""
    for row in (*rows, *suggestions):
        await session.refresh(row)


@dataclass(frozen=True, slots=True)
class _CareInstead:
    """A pass that ended in care rather than a reflection, already settled.

    Returned rather than answered by the helper that decided it, so the handler
    reads the fresh balances and returns in one place -- with the read on the
    path that leaves, never on one a static walk could believe continues to a
    dial.
    """

    care: CareResponse


async def _escalated_care(
    session: AsyncSession, user_id: int, spent: SpendResult | None, trace: _FailedGeneration
) -> _CareInstead:
    """Settle a vault care escalation and answer it with adepthood's own care surface.

    The vault's care guard declined to produce a reflection because the writing
    signalled acute distress, so what the caller gets back is a way to reach a
    human rather than an error or a cloud answer — falling back would hand them
    exactly the model prose that guard refused.

    The refund is load-bearing when BotMason paid: ``preflight_deduction``'s
    charge has already committed, and returning without compensation would
    charge a person in distress for a reflection they never received. BYOK has
    no BotMason charge, and the same helper safely performs only its rollback.

    The care payload is built fresh rather than threaded in from the handler's own
    screen, and that is provably right: a vault-bound entry adepthood flagged
    locally is answered with care before the vault is selected, and an
    app-provider-bound one never selects the vault at all, so ``care`` is always
    ``None`` on this path. The copy is adepthood's own reviewed
    surface — Creek's reason, message, and resource list are Creek's writing and
    are dropped at the adapter.
    """
    await _refund_failed_pass(session, user_id, spent, trace=trace)
    return _CareInstead(_care_surface(build_care_payload()))


async def _resonance_pass_or_care(
    message: str,
    llm: ResonanceLLM,
    prior: list[str],
    context: _ResonancePassContext,
    prior_drafts: list[str],
) -> MarginaliaOutcome | None:
    """Run the literary pass; on an LLM failure return ``None`` iff care can stand in.

    A flagged entry swallows the provider failure (any committed charge was
    already settled by a compensating refund in
    :func:`_generate_marginalia_or_error`'s except arms) and yields ``None``
    so the caller can return a care-only response — care
    must never depend on the LLM succeeding. An ordinary entry re-raises,
    preserving today's behavior exactly.
    """
    try:
        return await _generate_marginalia_or_error(message, llm, prior, context, prior_drafts)
    except HTTPException:
        if context.care is not None:
            return None
        raise


@dataclass(frozen=True, slots=True)
class _ReflectionRequest:
    """One admitted pass's body and the other writing it carries, all read under the hold."""

    entry_id: int
    message: str
    classification: str
    prior: list[str]
    prior_letters: list[str]


def _metered_usage(app_llm: BotmasonResonanceLLM | None) -> Sequence[LLMResponse]:
    """The live usage list a pass settles with: the app provider's, or nothing.

    Live rather than copied, so a failure settled midway reports every call that
    had returned. A vault-bound pass dials no app provider and meters nothing.
    """
    return () if app_llm is None else app_llm.usage


async def _reflection_source(
    vault_client: CreekVaultClient,
    app_llm: BotmasonResonanceLLM | None,
    request: _ReflectionRequest,
) -> ResonanceLLM:
    """The one source this pass may be answered by, chosen by the boundary alone.

    The app provider when the boundary allowed one (``app_llm`` present), and
    then the vault is not even probed. Otherwise the vault, through
    :func:`select_reflection_llm`, which raises rather than ever answering with
    anything else.
    """
    if app_llm is not None:
        return app_llm
    return await select_reflection_llm(
        vault_client, body=request.message, classification=request.classification
    )


async def _fail_closed_unavailable(
    context: _ResonancePassContext, *, entry_id: int, reason: VaultSourceUnavailableReason
) -> HTTPException:
    """Settle a vault-bound pass its vault could not answer, and name the refusal.

    The committed deduction is refunded (BYOK only rolls back) and the pass
    settles as failed, exactly as a provider failure does -- but it answers a
    retryable 503 under its own token rather than the provider's 502, because
    nothing upstream of a model failed: the one source this writer's pass may
    use was not there, and no other was asked.

    One WARNING, in a closed vocabulary: ids and this module's own reason word,
    never the body, a prompt, a key, or anything the vault said.
    """
    await _refund_failed_pass(context.session, context.user_id, context.spent, trace=context.trace)
    logger.warning(
        REFLECTION_SOURCE_UNAVAILABLE,
        extra={"user_id": context.user_id, "entry_id": entry_id, "reason": reason.value},
    )
    return service_unavailable(REFLECTION_SOURCE_UNAVAILABLE)


async def _reflect_or_answer(
    request: _ReflectionRequest,
    vault_client: CreekVaultClient,
    app_llm: BotmasonResonanceLLM | None,
    context: _ResonancePassContext,
) -> tuple[MarginaliaOutcome, ResonanceLLM] | _CareInstead:
    """Run the literary pass on its one source, or settle it as care instead.

    Returns the outcome and the source that produced it, or the care surface to
    answer with when the pass ended in care (already settled). A vault-bound
    pass whose vault cannot answer raises the settled 503 from
    :func:`_fail_closed_unavailable`; it is never re-asked of the app provider
    (#3061).
    """
    try:
        reflection_llm = await _reflection_source(vault_client, app_llm, request)
        anchored = await _resonance_pass_or_care(
            request.message, reflection_llm, request.prior, context, request.prior_letters
        )
    except CreekVaultCareEscalationError:
        # The vault's care guard fired: answer with adepthood's own care
        # surface instead of a reflection, and settle any committed charge.
        return await _escalated_care(context.session, context.user_id, context.spent, context.trace)
    except VaultSourceUnavailableError as exc:
        raise await _fail_closed_unavailable(
            context, entry_id=request.entry_id, reason=exc.reason
        ) from None
    if anchored is None:
        # The reflection failed but the entry is flagged: surface care anyway.
        return _CareInstead(cast("CareResponse", context.care))
    return anchored, reflection_llm


@dataclass(frozen=True, slots=True)
class _PassSettlementInput:
    """Inputs to the post-dial settlement transaction.

    Everything here was produced with no transaction open: ``anchored`` by the
    reflection dial and ``hits`` by the detection dial. ``spent`` is the
    server-paid deduction that committed before either, or ``None`` for BYOK.
    ``usage`` is every app-provider response the pass metered, recorded beside
    the rows it stages; it is empty when no app provider was dialled at all.
    ``key`` is the pass's generation, stamped on every usage row it meters.
    ``receipt`` is which side answered the notes, stamped on every row (#3062).
    """

    entry_id: int
    user_id: int
    spent: SpendResult | None
    anchored: MarginaliaOutcome
    hits: list[CompletionDetected]
    usage: Sequence[LLMResponse]
    key: GenerationKey
    receipt: InferenceReceipt | None


@dataclass(frozen=True, slots=True)
class _WalletSnapshot:
    """Wallet values returned after settlement, whether or not it was charged."""

    monthly_used: int
    offering_balance: int


@dataclass(frozen=True, slots=True)
class _SettledPass:
    """What the committed settlement hands back to the response builder."""

    rows: list[Marginalia]
    suggestions: list[CompletionSuggestion]
    wallet: _WalletSnapshot
    no_notes_message: str | None
    reset_date: datetime
    outcome: GenerationOutcome


def _log_settled_pass(
    prepared: _PassSettlementInput, usage: GenerationUsage, outcome: GenerationOutcome
) -> None:
    """Write a committed pass's one settlement line (#623 PR3).

    ``prepared.spent`` -- the deduction as it was taken -- names the bucket,
    never the post-refund balances an empty pass rebinds ``spent`` to.
    """
    log_generation_settled(
        GenerationSettlement(
            feature=GenerationFeature.RESONANCE,
            user_id=prepared.user_id,
            key=prepared.key,
            bucket=None if prepared.spent is None else prepared.spent.bucket,
            outcome=outcome,
            attempts=prepared.anchored.attempts,
            usage=usage,
        )
    )


async def _persist_settle_commit(
    session: AsyncSession, prepared: _PassSettlementInput
) -> _SettledPass:
    """Open the post-dial transaction: stage, settle, record usage, commit.

    Every dial is already behind us. The completed-pass count the corpus
    invitation runs on is staged in this same transaction (#2407): only a pass
    that commits here is one the writer actually received, so only it is
    counted. If anything fails before the commit, ``finally`` settles the
    optional BotMason deduction; BYOK rolls back without inventing a refund.
    ``spent`` is rebound by empty-pass settlement before commit, and the leading
    rollback inside :func:`_refund_failed_pass` discards any staged refund so a
    compensating credit can never double up.

    Compensation without an idempotency key is ambiguous in *both* directions:
    if the commit raises after the database durably applied it (a lost ack),
    the ``finally`` still refunds — the writer keeps a delivered pass free,
    and an already-landed empty-pass refund gains a second credit. That
    low-probability over-refund is accepted alongside the crash window that
    over-charges; the audit trail records every entry either way.
    """
    committed = False
    spent = prepared.spent
    try:
        # Independent detection and the full resonance path can race after
        # reading the same candidates. They share this row lock and post-dial
        # recheck so exactly one response stages each entry/target offer while
        # the pass still settles its usage and optional wallet charge normally.
        fresh_hits = await _lock_and_filter_suggestion_hits(
            session,
            entry_id=prepared.entry_id,
            user_id=prepared.user_id,
            hits=prepared.hits,
        )
        rows = _persist_marginalia(
            session,
            prepared.entry_id,
            prepared.user_id,
            prepared.anchored.notes,
            receipt=prepared.receipt,
        )
        suggestions = _stage_suggestions(session, prepared.entry_id, prepared.user_id, fresh_hits)
        spent, no_notes_message, refund = await _settle_empty_pass(
            session, prepared.user_id, spent, prepared.anchored
        )
        outcome = _pass_outcome(no_notes_message, demo=is_demo(prepared.receipt))
        if outcome is GenerationOutcome.REFUNDED_DEMO and spent is not None:
            refund = await refund_one_message(
                session, prepared.user_id, spent, reason=REASON_REFUND_DEMO
            )
            spent = refund.balances
        # A completed pass -- notes or a refunded no-notes 200 alike -- is the
        # moment the corpus invitation's cooldown counts (#2407). Staged here so
        # the count lands with this commit and is rolled back with a failure.
        await record_completed_pass(session, user_id=prepared.user_id)
        spent_user = await require_user_fresh(session, prepared.user_id)
        usage = await record_llm_usage(
            session,
            user_id=prepared.user_id,
            journal_entry_id=prepared.entry_id,
            responses=prepared.usage,
            generation=prepared.key,
        )
        await session.commit()
        committed = True
        log_committed_refund(refund)
    finally:
        if not committed:
            await _refund_failed_pass(
                session,
                prepared.user_id,
                spent,
                trace=_FailedGeneration(
                    feature=GenerationFeature.RESONANCE,
                    key=prepared.key,
                    usage=prepared.usage,
                    attempts=prepared.anchored.attempts,
                ),
            )
    _log_settled_pass(prepared, usage, outcome)
    return _SettledPass(
        rows=rows,
        suggestions=suggestions,
        wallet=_WalletSnapshot(
            monthly_used=spent_user.monthly_messages_used,
            offering_balance=spent_user.offering_balance,
        ),
        no_notes_message=no_notes_message,
        reset_date=spent_user.monthly_reset_date,
        outcome=outcome,
    )


def _pass_outcome(no_notes_message: str | None, *, demo: bool) -> GenerationOutcome:
    """Classify a committed pass: empty, a demo, or kept.

    Empty wins over demo: a stub pass that kept no notes is refunded once, as
    an empty pass, under the reason the writer is told. A demo that kept notes
    is delivered but handed back (#3062) -- canned text is never billed as a
    reflection.
    """
    if no_notes_message is not None:
        return GenerationOutcome.REFUNDED_EMPTY
    return GenerationOutcome.REFUNDED_DEMO if demo else GenerationOutcome.KEPT


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

    It names a thinning *habit* foundation, so a user who declined the habits
    ring is never shown it (#3073): the read-only ring check runs first and
    short-circuits before any habit signal is gathered.
    """
    if DepthRing.HABITS not in await load_enabled_rings(session, user_id):
        return None
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

    ``provenance`` is which side answered each operation and who paid (#3062).
    """

    care: CareResponse | None
    contraction: ContractionReflectionResponse | None = None
    no_notes_message: str | None = None
    related: VaultRelatedSurfaces = field(default_factory=VaultRelatedSurfaces)
    provenance: PassProvenance | None = None


def _resonance_response(
    rows: list[Marginalia],
    suggestions: list[CompletionSuggestion],
    wallet: _WalletSnapshot,
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
        remaining_messages=max(get_monthly_cap() - wallet.monthly_used, 0),
        remaining_balance=wallet.offering_balance,
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
        provenance=surfaces.provenance,
    )


async def _settle_empty_pass(
    session: AsyncSession, user_id: int, spent: SpendResult | None, outcome: MarginaliaOutcome
) -> tuple[SpendResult | None, str | None, StagedRefund | None]:
    """Explain a pass that kept no notes, and hand any BotMason charge back.

    The two halves are deliberately one call. A writer told "this pass wasn't
    charged" while the charge stands is worse than the silence this replaced, so
    the sentence and the reversal are decided from the same value rather than
    from two independent reads of the outcome that could drift apart.

    Returns the balances to report, the sentence to show and the staged refund,
    or the untouched balances and two ``None`` when the pass produced notes.
    The refund is only staged: the caller logs it once its commit lands.
    """
    message = explain_no_notes(outcome)
    if message is None:
        return spent, None, None
    if spent is None:
        return None, message, None
    refund = await refund_one_message(session, user_id, spent)
    return refund.balances, message, refund


@dataclass(frozen=True)
class _ReflectionClients:
    """The two reflection backends, and the server-derived boundary choosing between them.

    ``api_key`` is the caller's optional BYOK key for the app provider;
    ``vault_client`` is the optional Creek Vault client; ``boundary`` is which of
    them this caller's AI operations may use (see
    :func:`~dependencies.creek_vault.resolve_reflection_boundary`), never taken
    from the request. Bundling them into one injected value keeps the handler's
    dependency signature small.
    """

    api_key: str | None = field(repr=False)
    vault_client: CreekVaultClient
    boundary: ReflectionBoundary


def _reflection_clients(
    vault_client: Annotated[CreekVaultClient, Depends(get_creek_vault_client)],
    boundary: Annotated[ReflectionBoundary, Depends(get_reflection_boundary)],
    x_llm_api_key: Annotated[
        str | None, Header(alias="X-LLM-API-Key", max_length=LLM_API_KEY_MAX_LENGTH)
    ] = None,
) -> _ReflectionClients:
    """Bundle the BYOK key, the vault client and the boundary for the resonance handler.

    A thin dependency that resolves both reflection backends together. The nested
    :func:`get_creek_vault_client` and :func:`get_reflection_boundary`
    dependencies stay independently overridable, so a test can swap either
    through ``dependency_overrides``.
    """
    return _ReflectionClients(api_key=x_llm_api_key, vault_client=vault_client, boundary=boundary)


async def _resonance_payment(
    session: AsyncSession, user_id: int, supplied_key: str | None
) -> tuple[str | None, SpendResult | None]:
    """Resolve the payer, charging BotMason only when no BYOK key was supplied."""
    byok_key = resolve_chat_api_key(supplied_key)
    if byok_key is not None:
        return byok_key, None
    return None, await preflight_deduction(session, user_id)


@router.post("/{entry_id}/resonance", response_model=ResonanceResponse)
@limiter.limit("10/minute")
async def run_resonance(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    entry_id: RowIdPath,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    clients: Annotated[_ReflectionClients, Depends(_reflection_clients)],
) -> ResonanceResponse:
    """Run a resonance pass, charging BotMason only when it pays the provider.

    A validated caller-owned key bypasses both BotMason wallet buckets. Without
    one, wallet pre-flight deducts one message (402 when out of capacity). That
    deduction commits with every read the pass depends on before the first
    outbound call, so no pooled connection is held across the vault probe,
    reflection pass, or completion detection. A failed server-paid pass is
    settled by a compensating credit; a failed BYOK pass merely rolls back its
    staged writes because there is no wallet spend to reverse.

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

    Which model may answer is decided once, server-side, by the caller's
    boundary (#3061). With no vault, the app provider answers the reflection and
    completion detection exactly as before. With a vault -- connected, still
    provisioning, or currently undialable -- the vault answers the reflection or
    nothing does: a vault with nothing to say is a refunded zero-note pass, a
    vault that cannot answer is a refunded, retryable 503
    ``reflection_source_unavailable``, a locally flagged entry gets the care
    surface alone, and completion detection is skipped (``checked`` false on the
    standalone route). None of those reaches the app provider, whatever key the
    request carries.

    The context that accompanies the entry is chosen by
    :func:`~services.higher_self_grounding.gather_grounding` — the account's own
    ontologized corpus where it holds anything, the recency window where it does
    not. Only the app provider's prompt carries it; a vault builds its own.

    A vault may answer that request with its own care escalation, meaning its
    care guard read acute distress in writing adepthood's local screen did not
    flag. That is a 200 carrying adepthood's own reviewed care surface and no
    reflection — never a 502, and never the cloud's answer, since falling back
    would hand the writer exactly the model prose the guard refused. The
    any committed BotMason deduction is refunded, so the pass costs them nothing.
    """
    entry = await _require_user_entry(session, entry_id, current_user)
    message = _sanitize_message(entry.message)
    # Privacy floor (issue #895): an intimate entry is NEVER sent to a language
    # model, whoever pays. Decided from the *persisted* classification (never
    # client-supplied) and returned here — before wallet charge, LLM construction,
    # or usage-log write — and checked again under the account hold below, where
    # a PATCH that won the barrier may have made the entry intimate (#2998). The LOCAL care
    # screen (pure; no cloud/charge/log) still runs, so the privacy floor never
    # suppresses crisis support (NORTH-STAR §10). An admitted pass re-derives
    # both the body and this screen from the row it re-reads under the hold
    # (#3008); this reading serves only the 422 and intimate fast paths.
    if entry.classification == JournalClassification.INTIMATE:
        return await _private_response(session, current_user, _care_response(_care_for(message)))
    # A generation is about to happen: the per-user guardrails (#623) admit it
    # here, after every free exit above. The minute peek is a cheap 429 before
    # any slot or charge; the slot is held until the pass settles.
    require_generation_minute_available(current_user)
    async with generation_slot(session, current_user):
        return await _run_admitted_resonance(session, current_user, entry, clients)


def _pass_receipts(
    notes: InferenceReceipt | None,
    detection_usage: Sequence[LLMResponse],
    attempt: _DetectionAttempt,
    *,
    api_key: str | None,
) -> PassReceipts:
    """Gather one pass's receipts: the reflection's, and detection's own (#3062).

    ``detection_usage`` is only the responses metered after the reflection, so
    the reflection's answer can never be read as detection's.
    """
    return PassReceipts(
        notes=notes,
        detection=detection_receipt(
            receipt_since(detection_usage), dialled=attempt.dialled, api_key=api_key
        ),
        detection_checked=attempt.checked,
    )


def _charge_kept(spent: SpendResult | None, settled: _SettledPass) -> bool:
    """Whether the pass's wallet deduction was taken and still stands after settlement."""
    return spent is not None and settled.outcome is GenerationOutcome.KEPT


async def _run_admitted_resonance(
    session: AsyncSession,
    current_user: int,
    entry: JournalEntry,
    clients: _ReflectionClients,
) -> ResonanceResponse:
    """Charge, dial and settle one resonance pass the guardrails admitted.

    The second half of :func:`run_resonance`, split out so the guardrail slot
    wraps exactly the work that can generate. ``entry`` is the caller's own,
    non-intimate entry, already authorized. Its body and care verdict are not
    taken from the caller's pre-wait reading: both are re-derived from the row
    re-read under the account hold (#3008).
    """
    entry_id = cast("int", entry.id)
    # Resolve who pays before touching either BotMason bucket. A valid caller
    # key pays the provider directly; only the server-key/vault path draws from
    # the deployment-configured allowance or purchased offerings.
    byok_key, spent = await _resonance_payment(session, current_user, clients.api_key)
    key = GenerationKey.for_spend(spent)
    # The atomic minute hit, after payment is staged so a 402 or a daily 429
    # never spends it, and before the commit so its refusal leaves the staged
    # spend for the slot's rollback to discard.
    consume_generation_minute(current_user)
    detection = await _detection_inputs(session, entry=entry)
    # The only app-provider adapter this pass may hold, and none at all when the
    # caller is vault-bound: a BYOK key pays for a call, it does not consent to one.
    app_llm = app_provider_llm(clients.boundary, byok_key)
    usage = _metered_usage(app_llm)
    trace = _FailedGeneration(feature=GenerationFeature.RESONANCE, key=key, usage=usage)
    # Any deduction is durable: release the pooled connection before waiting.
    await session.commit()
    # The account barrier opens here rather than at the top of the handler: the
    # deduction is already committed, so the wait for it holds no pooled
    # connection, and an erasure racing this pass waits only for the outbound
    # half rather than for the wallet arithmetic. Everything a dial carries that
    # a privacy mutation can withdraw -- the entry itself, the other writing it
    # is grounded in, the earlier letters -- is read under the hold (#2998).
    async with hold_account(session, current_user):
        await ensure_account_live(session, current_user)
        if await _withdrawn_under_hold(session, entry, spent=spent, trace=trace):
            # A deliberate departure from _body_under_hold, which sanitizes first:
            # the raw refreshed body is screened as-is. Nothing leaves the process
            # on this path, assess_distress normalizes its own input, and this
            # private answer must never 422: a blank body still answers private,
            # and a body an edit made both intimate and distressed still gets care.
            return await _private_response(
                session, current_user, _care_response(_care_for(entry.message))
            )
        message, care = await _body_under_hold(session, entry, spent=spent, trace=trace)
        if app_llm is None and care is not None:
            # Vault-bound and flagged locally: adepthood's care surface alone. No
            # vault and no model is asked, and the committed charge is refunded.
            await _refund_failed_pass(session, current_user, spent, trace=trace)
            return await _care_only_response(session, current_user, care)
        grounding, prior_letters = await _pass_context_under_hold(session, current_user, entry_id)
        reflected = await _reflect_or_answer(
            _ReflectionRequest(
                entry_id=entry_id,
                message=message,
                classification=entry.classification,
                prior=list(grounding.bodies),
                prior_letters=prior_letters,
            ),
            clients.vault_client,
            app_llm,
            _ResonancePassContext(
                session=session,
                care=care,
                byok=byok_key is not None,
                user_id=current_user,
                spent=spent,
                trace=trace,
            ),
        )
        if isinstance(reflected, _CareInstead):
            return await _care_only_response(session, current_user, reflected.care)
        anchored, reflection_llm = reflected
        notes_receipt = reflection_receipt(reflection_llm, usage)
        detection_mark = len(usage)
        attempt = await _detect_hits_with_status(
            message, inputs=detection, llm=app_llm, user_id=current_user, entry_id=entry_id
        )
        receipts = _pass_receipts(notes_receipt, usage[detection_mark:], attempt, api_key=byok_key)
        settled = await _persist_settle_commit(
            session,
            _PassSettlementInput(
                entry_id=entry_id,
                user_id=current_user,
                spent=spent,
                anchored=anchored,
                hits=attempt.hits,
                usage=usage,
                key=key,
                receipt=notes_receipt,
            ),
        )
        await _refresh_persisted(session, settled.rows, settled.suggestions)
    _log_resonance_outcome(
        anchored, receipts, user_id=current_user, entry_id=entry_id, count=len(settled.rows)
    )
    contraction = await _contraction_reflection(session, current_user)
    surfaces = _ResonanceSurfaces(
        care=care,
        contraction=contraction,
        no_notes_message=settled.no_notes_message,
        related=related_surfaces(reflection_llm),
        provenance=pass_provenance(
            receipts, byok=byok_key is not None, charge_kept=_charge_kept(spent, settled)
        ),
    )
    return _resonance_response(
        settled.rows, settled.suggestions, settled.wallet, settled.reset_date, surfaces
    )


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


async def _existing_suggestion_targets(
    session: AsyncSession, entry_id: int, user_id: int
) -> set[tuple[str, int]]:
    """Targets this entry has already offered, including decided suggestions."""
    result = await session.execute(
        select(CompletionSuggestion).where(
            CompletionSuggestion.journal_entry_id == entry_id,
            CompletionSuggestion.user_id == user_id,
        )
    )
    targets: set[tuple[str, int]] = set()
    for row in result.scalars().all():
        target_id = (
            row.goal_id if row.target_type == CompletionTargetType.HABIT else row.user_practice_id
        )
        if target_id is not None:
            targets.add((row.target_type, target_id))
    return targets


async def _lock_detection_entry(session: AsyncSession, entry_id: int, user_id: int) -> None:
    """Serialize post-provider suggestion writes for one owned journal entry."""
    await session.execute(
        select(col(JournalEntry.id))
        .where(JournalEntry.id == entry_id, JournalEntry.user_id == user_id)
        .with_for_update()
    )


async def _lock_and_filter_suggestion_hits(
    session: AsyncSession,
    *,
    entry_id: int,
    user_id: int,
    hits: Sequence[CompletionDetected],
) -> list[CompletionDetected]:
    """Serialize offer writes and discard targets another request already staged."""
    await _lock_detection_entry(session, entry_id, user_id)
    existing = await _existing_suggestion_targets(session, entry_id, user_id)
    return [hit for hit in hits if (hit.target_type, hit.target_id) not in existing]


async def _persist_detected_suggestions(
    session: AsyncSession,
    *,
    entry_id: int,
    user_id: int,
    hits: Sequence[CompletionDetected],
    llm: BotmasonResonanceLLM,
) -> CompletionDetectionResponse:
    """Persist only offers this entry has not already made."""
    # Provider calls run without a transaction. Once they return, lock the
    # entry before rechecking: concurrent tabs then take turns and the follower
    # sees the first request's committed targets instead of inserting twins.
    fresh_hits = await _lock_and_filter_suggestion_hits(
        session, entry_id=entry_id, user_id=user_id, hits=hits
    )
    rows = _stage_suggestions(session, entry_id, user_id, fresh_hits)
    # Standalone detection charges nobody: its rows are keyed as an uncharged
    # generation, so the p95 charged-generation metric never samples them.
    await record_llm_usage(
        session,
        user_id=user_id,
        journal_entry_id=entry_id,
        responses=llm.usage,
        generation=GenerationKey.uncharged(),
    )
    await session.commit()
    await _refresh_persisted(session, [], rows)
    return CompletionDetectionResponse(
        items=[
            CompletionSuggestionResponse.model_validate(row, from_attributes=True) for row in rows
        ],
        checked=True,
    )


async def _unoffered_candidates(
    session: AsyncSession, *, entry_id: int, user_id: int
) -> list[DetectionCandidate]:
    """Return only tracked targets this entry has never offered before."""
    candidates = await gather_candidates(session, user_id, include_practices=True)
    existing = await _existing_suggestion_targets(session, entry_id, user_id)
    return [
        candidate
        for candidate in candidates
        if (candidate.target_type, candidate.target_id) not in existing
    ]


async def _detection_inputs(session: AsyncSession, *, entry: JournalEntry) -> DetectionInputs:
    """Everything one detection pass needs from the database, read in one place.

    Both routes call this before their deliberate pre-dial commit, so the
    timezone read lands on the correct side of the connection release by
    construction rather than by a reviewer noticing.

    The entry's day comes from ``to_user_date_bucket``, never bare
    ``to_user_date``: the latter refuses naive datetimes, and SQLite hands
    back exactly those for a timezone-aware column.
    """
    candidates = await _unoffered_candidates(
        session, entry_id=cast("int", entry.id), user_id=entry.user_id
    )
    user_tz = await get_user_timezone(session, entry.user_id)
    return DetectionInputs(
        candidates=candidates,
        clock=DetectionClock(
            entry_day=to_user_date_bucket(entry.timestamp, user_tz),
            today=today_in_tz(user_tz),
            max_backfill_days=MAX_BACKFILL_DAYS,
        ),
    )


async def _detect_fresh_suggestions(
    session: AsyncSession,
    *,
    entry: JournalEntry,
    inputs: DetectionInputs,
    caller: _DetectionCaller,
) -> CompletionDetectionResponse:
    """Dial without a transaction, then persist a concurrency-safe fresh subset.

    The dial carries this account's *stored* entry body to a
    cloud provider, which is the same egress the vault sites take the account
    barrier for, by a different transport. Ordering it against erasure is
    therefore the same rule, not a new one; the only reason this site went
    unbarriered is that the route resolves no vault client and the site walk
    looked for vault clients.

    The barrier opens *after* the commit above and before the dial, so the wait
    holds no pooled connection and an erasure racing this pass waits only for
    the outbound half. The persistence stays inside it for the same reason the
    liveness read exists at all: a suggestion row written for an account that
    has already been erased is a ghost row nobody owns.

    The tier and the body are re-read *under* the hold, after the liveness read
    (so an erased account still answers 401). ``PATCH /journal/{entry_id}`` --
    reclassifying or editing the body -- and ``DELETE`` take the same exclusive
    hold and can answer 200 while this pass waits. A row now intimate sends
    nothing, neither its body nor the names of the writer's habits and
    practices, and answers ``checked: false``; a deleted row answers the uniform
    404; otherwise the body dialled is the refreshed one. The re-read commits,
    so no connection is held across the dial (#3008).

    Reached only for an app-provider-bound caller: the route answered a
    vault-bound one before reading any candidate. The adapter is still taken
    through :func:`~services.reflection_boundary.require_app_provider_llm`, so
    losing that check would refuse here rather than dial (#3061).
    """
    llm = require_app_provider_llm(caller.boundary, resolve_chat_api_key(caller.api_key))
    await session.commit()
    async with hold_account(session, entry.user_id):
        await ensure_account_live(session, entry.user_id)
        if await _withdrawn_under_hold(session, entry, spent=None, trace=None):
            return CompletionDetectionResponse(items=[], checked=False)
        return await _detect_and_persist(
            session,
            entry=entry,
            message=_sanitize_message(entry.message),
            inputs=inputs,
            llm=llm,
        )


async def _detect_and_persist(
    session: AsyncSession,
    *,
    entry: JournalEntry,
    message: str,
    inputs: DetectionInputs,
    llm: BotmasonResonanceLLM,
) -> CompletionDetectionResponse:
    """The dial and its persistence, both inside the caller's account barrier."""
    attempt = await _detect_hits_with_status(
        message,
        inputs=inputs,
        llm=llm,
        user_id=entry.user_id,
        entry_id=cast("int", entry.id),
    )
    if not attempt.checked:
        return CompletionDetectionResponse(items=[], checked=False)
    return await _persist_detected_suggestions(
        session,
        entry_id=cast("int", entry.id),
        user_id=entry.user_id,
        hits=attempt.hits,
        llm=llm,
    )


@dataclass(frozen=True)
class _DetectionCaller:
    """Who is asking for standalone detection: their optional BYOK key and their boundary.

    Bundled for the same argument-budget reason as :class:`_ReflectionClients`.
    ``boundary`` is server-derived, never taken from the request.
    """

    api_key: str | None = field(repr=False)
    boundary: ReflectionBoundary


def _detection_caller(
    boundary: Annotated[ReflectionBoundary, Depends(get_reflection_boundary)],
    x_llm_api_key: Annotated[
        str | None, Header(alias="X-LLM-API-Key", max_length=LLM_API_KEY_MAX_LENGTH)
    ] = None,
) -> _DetectionCaller:
    """Bundle the BYOK header and the caller's boundary for the detection handler.

    The header is carried unvalidated: it is resolved only once the route knows
    it is going to dial, so a vault-bound caller or an entry with nothing new to
    offer never needs a key.
    """
    return _DetectionCaller(api_key=x_llm_api_key, boundary=boundary)


@router.post("/{entry_id}/suggestions/detect", response_model=CompletionDetectionResponse)
@limiter.limit("10/minute")
async def detect_entry_suggestions(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    entry_id: RowIdPath,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    caller: Annotated[_DetectionCaller, Depends(_detection_caller)],
) -> CompletionDetectionResponse:
    """Check an entry for completed habits independently of literary resonance.

    This route is intentionally uncharged and never calls Creek: a short body or
    a literary-reflection refusal must not prevent the writer from receiving a
    habit/practice offer. Intimate entries keep their privacy floor and never
    leave the process. Provider failures remain best-effort, with ``checked``
    telling the client whether an empty result really means "no match".

    The INTIMATE check here is only the cheap fast path: the authoritative
    floor is re-read under the account hold, just before the dial (#3008).

    A vault-bound caller answers ``checked: false`` before any candidate is
    read: a vault has no detection capability, and the app provider is not
    theirs to be sent to (#3061).
    """
    entry = await _load_user_entry(session, entry_id, current_user)
    if entry is None:
        raise not_found("journal_entry")
    # Validation only: a legacy row whose body sanitizes to nothing answers 422
    # before any candidate or provider work. The body actually dialled is
    # re-derived from the row re-read under the hold.
    _sanitize_message(entry.message)
    if entry.classification == JournalClassification.INTIMATE:
        return CompletionDetectionResponse(items=[], checked=False)
    if caller.boundary is ReflectionBoundary.VAULT_BOUND:
        await session.commit()
        return CompletionDetectionResponse(items=[], checked=False)

    inputs = await _detection_inputs(session, entry=entry)
    if not inputs.candidates:
        # There is nothing new to send and therefore no reason to require a key,
        # expose the journal body, or pay for a known-no-op provider call. An
        # empty candidate set is a completed check, not a provider failure.
        await session.commit()
        return CompletionDetectionResponse(items=[], checked=True)
    return await _detect_fresh_suggestions(
        session,
        entry=entry,
        inputs=inputs,
        caller=caller,
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


def _in_window_day(
    suggestion: CompletionSuggestion, user_tz: str, as_of: date | None = None
) -> date | None:
    """The suggested day if it was loggable on ``as_of``, else ``None`` (meaning today).

    A suggestion may be detected on one day and accepted much later, so the
    day it carries can fall outside the backfill window by the time it is
    used -- or ahead of today, once a user moves their timezone westward.
    Either way the accept must succeed: a writer offered a check-off cannot be
    refused it over a date they never typed.

    This is a *pre-check*, deliberately not a caught ``HTTPException``.
    Wrapping ``record_goal_completion`` in ``try/except`` would swallow every
    other refusal on that path too. Returning ``None`` *is* the fallback --
    ``_resolve_target_day(None, tz)`` already means "the user's today" -- so
    there is no second copy of that rule here.

    ``as_of`` defaults to the user's today, which is what the accept itself
    wants. A *replay* must pass the day the accept happened instead: the
    window slides, so a day that was inside it then can be outside it now, and
    answering against today would report a day the completion was never on.

    Logs ids and the verdict enum only; never the date, which is derived from
    journal content.
    """
    completed_on = suggestion.completed_on
    if completed_on is None:
        return None
    verdict = day_window_verdict(
        completed_on,
        today=as_of or today_in_tz(user_tz),
        max_backfill_days=MAX_BACKFILL_DAYS,
    )
    if verdict == "ok":
        return completed_on
    logger.info(
        "suggestion_day_out_of_window",
        extra={"suggestion_id": suggestion.id, "verdict": verdict},
    )
    return None


def _resolve_accept_day(suggestion: CompletionSuggestion, user_tz: str) -> date:
    """The one day a habit accept logs against: in-window detected day, else today.

    Resolved once, here, and handed to both writes -- the completion's
    ``local_day`` (as an explicit ``completed_on``) and the suggestion's
    ``logged_on`` -- so the two cannot disagree (#2905). Passing ``None`` and
    letting ``_resolve_target_day`` read the clock again would let an accept
    that straddles local midnight record one day on the suggestion and log
    the next.
    """
    return _in_window_day(suggestion, user_tz) or today_in_tz(user_tz)


# Operation-key namespace for a habit accept. One suggestion is one logical
# accept, so the row id is the whole identity. Parallel to the practice
# branch's ``accept-suggestion:practice:{id}``; the two never collide.
_ACCEPT_HABIT_OPERATION_PREFIX = "accept-suggestion:goal:"


async def _accept_pending_habit(
    session: AsyncSession,
    suggestion: CompletionSuggestion,
    current_user: int,
    user_tz: str,
) -> AcceptSuggestionResponse:
    """Log a pending habit suggestion's completion and flip it to accepted.

    Logs the amount and the user-local day detection extracted from the
    attesting span when it found them, falling back to the goal's target on
    today when it did not. An amount lands as a signed *delta* on that day,
    matching ``POST /goal_completions/``: a day that already has a row
    accumulates rather than being replaced.

    That delta is claimed under an operation key derived from the suggestion,
    because one suggestion is one logical accept however many times it is
    asked for. Nothing else de-duplicates it: the natural-key no-op inside
    ``record_goal_completion`` stands down as soon as ``completed_units`` is
    non-null, the status guard is read before the flip rather than under it,
    and the habit lock orders concurrent accepts without collapsing them.
    Mirrors the practice branch, which has always keyed its own write.
    """
    goal, habit = await _resolve_suggestion_goal(session, suggestion, current_user)
    ctx = CheckInContext(goal=goal, habit=habit, user_id=current_user, user_timezone=user_tz)
    logged_on = _resolve_accept_day(suggestion, user_tz)
    # Nothing of this request is staged yet, and nothing may be: a replayed
    # claim rolls the session back before returning, which would discard it.
    # Keep every write on this path after this call.
    check_in = await record_goal_completion(
        session,
        ctx,
        CheckInCommand(
            completed_on=logged_on,
            completed_units=suggestion.completed_units,
            idempotency_key=f"{_ACCEPT_HABIT_OPERATION_PREFIX}{suggestion.id}",
        ),
    )
    suggestion.status = SuggestionStatus.ACCEPTED
    suggestion.accepted_at = datetime.now(UTC)
    suggestion.logged_on = logged_on
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


def _logged_day(suggestion: CompletionSuggestion, user_tz: str) -> date | None:
    """The day the accept actually logged against, re-derived for a replay.

    The legacy-row path only: a habit accepted since #2905 records the day in
    ``logged_on``, which :func:`_replay_day` prefers. This re-derivation
    buckets ``accepted_at`` with the user's *current* timezone, so it can
    drift after a timezone change -- the reason the day is now recorded.

    Reproduces the accept's own window decision by asking it again as of the
    day the accept happened (``accepted_at``), which is exactly what "today"
    meant in that request. Falls back to the live reading for a suggestion
    with no ``accepted_at`` -- which the status guard means we never reach,
    but which keeps this total.
    """
    accepted_at = suggestion.accepted_at
    if accepted_at is None:
        return _in_window_day(suggestion, user_tz)
    return _in_window_day(suggestion, user_tz, to_user_date_bucket(accepted_at, user_tz))


def _replay_day(suggestion: CompletionSuggestion, user_tz: str) -> date | None:
    """The day a replay reports: the recorded ``logged_on``, else re-derived.

    The recorded day is a fact and survives a later timezone change or a
    slid window; the re-derivation is kept only for rows accepted before the
    day was recorded (no backfill, #2905).
    """
    return suggestion.logged_on or _logged_day(suggestion, user_tz)


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
    # The day the accept recorded (or, for a legacy row, the same resolution
    # asked as of the day the accept happened), so the replay reports the day
    # that was actually logged rather than today's (empty) total.
    check_in = await current_check_in(session, ctx, _replay_day(suggestion, user_tz))
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


# Economy seam (#623): a note's first essay costs one wallet unit, reopening a
# cached one is free, and a failed or empty letter is refunded. Ratified by the
# owner on 2026-09-05; the verbatim decision and its line-by-line code map live
# in ``prompts/claude-comms/2026-09-05-resonance-economy-decision.md``. The
# charge itself is taken in :func:`_cache_essay`, the only place it can be.
ESSAY_PRICE_UNITS = 1
# The wallet spends exactly one unit per call (``spend_one_message``). A price
# of 0 disables the charge; anything above one would need a multi-unit wallet
# primitive that does not exist, so it is refused at import rather than
# silently charged as one.
_WALLET_UNIT = 1
if ESSAY_PRICE_UNITS not in {0, _WALLET_UNIT}:  # pragma: no cover — config guard
    _essay_price_msg = f"ESSAY_PRICE_UNITS must be 0 or {_WALLET_UNIT}, got {ESSAY_PRICE_UNITS}"
    raise RuntimeError(_essay_price_msg)
# The 409 detail a server-paid first letter gets when the request does not say
# the writer saw its price -- see :class:`schemas.marginalia.EssayRequest`.
ESSAY_PRICE_UNACKNOWLEDGED = "essay_price_unacknowledged"


@dataclass(frozen=True)
class _EssayClients:
    """What the caller brings to essay expansion besides the note id.

    The cloud credential and optional vault, plus ``price_acknowledged``: the
    caller's word that the writer saw the letter's price before asking (#623).
    """

    api_key: str | None = field(repr=False)
    vault_client: CreekVaultPipelineClient
    price_acknowledged: bool = False


def _essay_clients(
    vault_client: Annotated[CreekVaultPipelineClient, Depends(get_creek_vault_client)],
    x_llm_api_key: Annotated[
        str | None, Header(alias="X-LLM-API-Key", max_length=LLM_API_KEY_MAX_LENGTH)
    ] = None,
    payload: Annotated[EssayRequest | None, Body()] = None,
) -> _EssayClients:
    """Bundle the essay backends and the optional body without widening the route."""
    return _EssayClients(
        api_key=x_llm_api_key,
        vault_client=vault_client,
        price_acknowledged=payload is not None and payload.price_acknowledged,
    )


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


@router.post("/marginalia/{marginalia_id}/essay", response_model=EssayResponse)
@limiter.limit("10/minute")
async def expand_marginalia_essay(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    marginalia_id: RowIdPath,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    clients: Annotated[_EssayClients, Depends(_essay_clients)],
) -> EssayResponse:
    """Lazily generate (and cache) a longer essay expanding one margin note.

    Idempotent: once ``essay`` is set the cached value is returned without another
    LLM call or charge. Ownership is enforced via the marginalia's own
    ``user_id`` (404 otherwise). A server-paid first letter costs
    ``ESSAY_PRICE_UNITS`` wallet unit and must carry ``price_acknowledged``
    (409 otherwise, before any charge); a failed or empty letter is refunded.

    A note with no ``essay`` on the response is the no-letter state, not an
    error: the entry is intimate, or the provider's completion was not a letter
    (:func:`domain.resonance.generate_essay`). Either way nothing is cached and
    the writer can ask again. Every answer carries the wallet balances.
    """
    note = await _expand_essay(session, marginalia_id, current_user, clients)
    return await _essay_response(session, note)


async def _essay_response(session: AsyncSession, note: Marginalia) -> EssayResponse:
    """Wrap ``note`` with the owner's balances, computed as ``/user/usage`` does.

    A read only: the monthly rollover is applied inside the session so a stale
    counter is never reported, but it is not committed here -- the same
    discipline as ``GET /user/usage`` (BUG-BM-015).
    """
    await reset_monthly_usage_if_due(session, note.user_id, datetime.now(UTC))
    user = await require_user_fresh(session, note.user_id)
    return EssayResponse(
        **MarginaliaResponse.model_validate(note, from_attributes=True).model_dump(),
        remaining_messages=max(get_monthly_cap() - user.monthly_messages_used, 0),
        remaining_balance=user.offering_balance,
        monthly_reset_date=user.monthly_reset_date,
    )


# Where a cached letter was found (#623 PR3). ``pre_barrier`` is the ordinary
# reopen; ``in_barrier`` is a concurrent first ask whose letter landed while
# this request waited for the account hold.
_CACHE_HIT_PRE_BARRIER = "pre_barrier"
_CACHE_HIT_IN_BARRIER = "in_barrier"


def _log_essay_cache_hit(note: Marginalia, stage: str) -> None:
    """Record a free reopen of a letter already bought: ids and the stage only.

    The ratified record asks for cache hits to be instrumented (§1:
    "instrument actual input/output tokens, model, cost estimate, refunds, and
    cache hits"). The stage rides in the message as well as in ``extra``
    because the production formatter drops extras. Never the letter's text,
    for the reason ``marginalia_essay_generated`` gives.
    """
    logger.info(
        "marginalia_essay_cache_hit stage=%s",
        stage,
        extra={"user_id": note.user_id, "id": note.id, "stage": stage},
    )


def _require_price_acknowledged(clients: _EssayClients) -> None:
    """Refuse a server-paid first letter the writer was not shown the price of.

    Runs before the barrier and before any charge, so a stale client that
    still asks on open is answered 409 with nothing spent and nothing dialled.
    A valid BYOK key pays its own provider and is never charged here.
    """
    if not ESSAY_PRICE_UNITS or clients.price_acknowledged:
        return
    if resolve_chat_api_key(clients.api_key) is None:
        raise conflict(ESSAY_PRICE_UNACKNOWLEDGED)


async def _expand_essay(
    session: AsyncSession,
    marginalia_id: int,
    user_id: int,
    clients: _EssayClients,
) -> Marginalia:
    """Authorize, apply the privacy floor and the price gate, then generate."""
    note = await _load_user_marginalia(session, marginalia_id, user_id)
    if note is None:
        raise not_found("marginalia")
    if note.essay is not None:
        _log_essay_cache_hit(note, _CACHE_HIT_PRE_BARRIER)
        return note
    entry = await _load_user_entry(session, note.journal_entry_id, user_id)
    if entry is None:  # pragma: no cover — marginalia FK guarantees the parent
        raise not_found("journal_entry")
    # Privacy floor (issue #895): an intimate entry is NEVER sent to a cloud LLM,
    # so skip essay generation entirely and return the note (no essay) unchanged.
    # Decided from the *persisted* classification, before the LLM is constructed.
    # Read again inside the barrier below, because this reading can go stale
    # while the request waits for it — see ``_cache_and_mirror_essay``.
    if entry.classification == JournalClassification.INTIMATE:
        return note
    _require_price_acknowledged(clients)
    # A first letter is about to be asked for: the per-user guardrails (#623)
    # admit it only now, after the cached, intimate, 404 and 409 exits above.
    require_generation_minute_available(user_id)
    async with generation_slot(session, user_id):
        return await _cache_and_mirror_essay(session, note=note, entry=entry, clients=clients)


async def _cache_and_mirror_essay(
    session: AsyncSession,
    *,
    note: Marginalia,
    entry: JournalEntry,
    clients: _EssayClients,
) -> Marginalia:
    """Generate and cache the essay, then mirror it once if there is one.

    Split out of :func:`expand_marginalia_essay` so that route keeps only the
    authorization and privacy decisions; the mirror's ordering rationale is long
    enough on its own that interleaving the two made neither readable.

    **This route makes two dials, and the barrier is taken once per dial rather
    than once across both.** :func:`_cache_essay` hands the stored entry body
    *and every prior letter essay on this account* to a cloud provider; the
    mirror that follows sends the model's answer to Creek. Both are this
    account's stored content leaving the process, so both must be ordered
    against erasure -- but ordering them under *one* hold would also serialize
    the window between them, and that window is load-bearing: a privacy PATCH or
    a journal DELETE that lands while a slow model is still composing is exactly
    what stops the mirror from happening at all. Holding across both would make
    that mutation wait, let the mirror go out first, and leave the PATCH to
    retract an intimate essay Creek had already seen. Two short holds keep the
    erasure ordering and keep the entry-level race reachable.

    An erasure that lands *in* the gap is refused by the second hold's own
    liveness read, so nothing is lost by releasing: each dial is ordered, which
    is the whole claim. It is the same per-dial reasoning the detached
    ontologization ladder uses for the same reason.

    **The note is read again inside the first hold too.** The caller's cached
    letter check runs before the barrier, so a second first-ask for the same
    note passes it while the first is still composing and then queues here. A
    note whose letter landed while this request waited is a cached reopen: it
    returns without a charge or a dial, rather than buying and overwriting a
    second letter (#623).

    **Both the tier and the body are read again inside the first hold**, and
    liveness is not enough on its own. An exclusive barrier held across a dial
    does not merely delay a competing mutation, it reorders it to *before* the
    dial: ``PATCH /journal/{entry_id}`` carrying ``classification`` takes this
    same hold, so a PATCH that queues first is guaranteed to complete in full --
    setting INTIMATE, withdrawing the local entry, retracting the voice drafts,
    withdrawing the remote copy -- and answer 200, after which a dial carrying a
    reading taken before the wait would hand the now-intimate body to the cloud.
    The rule is general and the caller's pre-hold check is the cheap half of it:
    every piece of state a dial's legitimacy rests on is re-read under the same
    ordering that stops the dial, or the hold is too narrow to go stale.

    A row the writer has since deleted stops here for the same reason, which is
    where that check belonged all along -- the mirror below could only decline to
    send the letter *after* the cloud had already composed it from the body.

    The commit below releases the pooled connection the route's two ownership
    reads opened, so the wait for the barrier holds nothing.
    """
    await session.commit()
    async with hold_account(session, entry.user_id):
        await ensure_account_live(session, entry.user_id)
        await session.refresh(entry)
        await session.refresh(note)
        await session.commit()
        if note.essay is not None:
            # A concurrent first ask for this note won the barrier and cached
            # its letter while this one waited: a cached reopen, not a second
            # purchase -- no charge, no dial, no overwrite (#623).
            _log_essay_cache_hit(note, _CACHE_HIT_IN_BARRIER)
            return note
        if entry.deleted_at is not None or entry.classification == JournalClassification.INTIMATE:
            return note
        cached = await _cache_essay(
            session, note, _sanitize_message(entry.message), clients.api_key
        )
    # The provider answered with something that was not a letter, so there is no
    # letter: the note comes back with ``essay`` unset -- the same no-letter
    # state the privacy floor returns -- and nothing is mirrored, because
    # mirroring a refusal would put it in the vault the cache refused it from.
    essay = cached.essay
    if essay is None:
        return cached
    return await _mirror_cached_essay(
        session, entry=entry, cached=cached, essay=essay, clients=clients
    )


async def _mirror_cached_essay(
    session: AsyncSession,
    *,
    entry: JournalEntry,
    cached: Marginalia,
    essay: str,
    clients: _EssayClients,
) -> Marginalia:
    """Mirror one generated essay, ordered against both erasure and the entry.

    Generation may outlive a concurrent privacy PATCH or journal DELETE.
    Serialize the final liveness/tier read and mirror: an already-completed
    deletion skips; an INTIMATE transition is refused by ``mirror_voice_draft``;
    and if this PUT linearized first, the competing mutation waits and retracts
    it. The content-free intent row -- bound to the destination being dialled --
    is committed before the PUT, so even a lost acknowledgement leaves the
    withdrawal that mutation owes on record. The request transaction is
    committed before Creek I/O; PostgreSQL holds the cross-worker lock on a
    non-pooled, dedicated connection rather than consuming the application
    pool. Account outermost, entry innermost -- the
    fixed nesting everywhere the two meet.
    """
    async with (
        hold_account(session, entry.user_id),
        voice_draft_privacy.hold(session, cast("int", entry.id)),
    ):
        await ensure_account_live(session, entry.user_id)
        await session.refresh(entry)
        await session.commit()
        if entry.deleted_at is not None:
            return cached
        marginalia_id = cast("int", cached.id)
        destination = await resolved_vault_destination(session, entry.user_id)

        async def _record_intent() -> bool:
            return await record_mirror_intent(
                session,
                user_id=entry.user_id,
                entry_id=cast("int", entry.id),
                marginalia_id=marginalia_id,
                destination=destination,
            )

        await mirror_voice_draft(
            clients.vault_client,
            VoiceDraftCopy(
                owner_user_id=entry.user_id,
                marginalia_id=marginalia_id,
                essay=essay,
                classification=entry.classification,
            ),
            record_intent=_record_intent,
        )
    return cached


async def _essay_charge(
    session: AsyncSession, user_id: int, byok_key: str | None
) -> SpendResult | None:
    """Take the first letter's one unit, or ``None`` when nobody is charged.

    A BYOK key pays its own provider, and a zero price charges nobody. Raises
    ``402 insufficient_offerings`` when both wallet buckets are empty -- before
    the dial, so an empty wallet never reaches the provider.
    """
    if byok_key is not None or not ESSAY_PRICE_UNITS:
        return None
    return await preflight_deduction(session, user_id)


async def _cache_essay(
    session: AsyncSession, note: Marginalia, body: str, api_key: str | None
) -> Marginalia:
    """Charge, generate the essay via the cloud LLM, cache it on the note, and persist.

    Returns the note unchanged when the domain refuses the completion as not a
    letter: the row keeps ``essay IS NULL``, which is what lets the writer ask
    again and what keeps a refusal out of the prior-letters context and the
    voice-draft mirror. Caching the refusal instead is the #2435 / #1504 shape
    this must not regress.

    **The charge lives here and nowhere else (#623).** This seam runs inside
    the account barrier, after :func:`_cache_and_mirror_essay` re-read the
    entry's tier and liveness, so a cached, intimate, deleted or foreign note
    can never reach it. The unit is deducted *before* the commit that releases
    the pooled connection, so the charge is durable before the dial and no
    connection is held across it. From there every exit settles it exactly
    once: a letter keeps it; a refused or blank letter is refunded in the same
    transaction as its usage row (no rollback, so the metering survives); and
    anything else -- a provider error, a spent provider balance, a failed
    write -- is refunded by the ``finally`` guard, which mirrors the pass's own.

    The caller has already loaded and authorized both the note and its parent
    entry, then applied the persisted INTIMATE privacy floor. Neither object has
    been mutated, so committing that transaction here makes nothing partially
    durable. A transient provider error maps to 502; a spent balance maps to its
    own permanent status, checked first because it subclasses the generic type.

    The prior letters are fetched *above* that commit, while the pooled
    connection is still held: they are a read the dial depends on, and the
    commit is what releases the connection before it. ``note.user_id`` is the
    owner ``expand_marginalia_essay`` already authorized this row against, and
    ``_prior_letters_query`` re-asserts ownership on the parent entry besides.
    """
    prior_letters = await _prior_letter_essays(
        session, user_id=note.user_id, exclude_entry_id=note.journal_entry_id
    )
    byok_key = resolve_chat_api_key(api_key)
    spent = await _essay_charge(session, note.user_id, byok_key)
    # The minute hit, after the charge is staged and before it commits: a
    # refusal leaves the staged charge for the guardrail slot's rollback.
    consume_generation_minute(note.user_id)
    await session.commit()
    # Pure constructors, hoisted so the failure guard can report the calls
    # that returned and the generation they belong to (#623 PR3).
    llm = BotmasonResonanceLLM(byok_key)
    charge = _EssayCharge(spent=spent, key=GenerationKey.for_spend(spent))
    settled = False
    try:
        essay = await _dial_essay(llm, note, body, prior_letters, byok=byok_key is not None)
        await _settle_essay(session, note, essay, llm, charge)
        settled = True
    finally:
        if not settled:
            await _refund_failed_pass(
                session,
                note.user_id,
                spent,
                reason=REASON_REFUND_FAILED_ESSAY,
                trace=_FailedGeneration(
                    feature=GenerationFeature.ESSAY,
                    key=charge.key,
                    usage=llm.usage,
                    attempts=_ESSAY_ATTEMPTS,
                ),
            )
    if essay is not None:
        # Outside the guard on purpose: the letter is committed, so it is
        # bought, and a failure re-reading it must not refund a stored letter.
        await session.refresh(note)
        logger.info(
            "marginalia_essay_generated",
            # A count, never the letters themselves: the same rule
            # ``_grounding_for`` writes, since a log line carrying essay text
            # would put the writing the ``essay`` column is encrypted to protect
            # straight back into plaintext.
            extra={
                "user_id": note.user_id,
                "id": note.id,
                "prior_draft_count": len(prior_letters),
            },
        )
    return note


async def _dial_essay(
    llm: BotmasonResonanceLLM,
    note: Marginalia,
    body: str,
    prior_letters: list[str],
    *,
    byok: bool,
) -> str | None:
    """Ask the provider for the letter, mapping its failures to HTTP errors.

    Raises before anything is staged, so the caller's ``finally`` refunds the
    charge; ``None`` is the domain's "not a letter" verdict.
    """
    try:
        return await generate_essay(
            llm=llm,
            body=body,
            note=MarginaliaAnchored(
                kind=note.kind,
                anchor_start=note.anchor_start,
                anchor_end=note.anchor_end,
                anchor_text=note.anchor_text,
                note=note.note,
            ),
            prior_drafts=prior_letters,
        )
    except LLMCreditExhaustedError as exc:
        raise credit_exhausted_error(exc, byok=byok) from exc
    except LLMProviderError as exc:
        raise bad_gateway("llm_provider_error") from exc


# An essay is one dial: ``generate_essay`` has no corrective retry.
_ESSAY_ATTEMPTS = 1


@dataclass(frozen=True, slots=True)
class _EssayCharge:
    """A first letter's deduction (``None`` when nobody paid) and its generation."""

    spent: SpendResult | None
    key: GenerationKey


def _log_settled_essay(
    note: Marginalia, charge: _EssayCharge, usage: GenerationUsage, outcome: GenerationOutcome
) -> None:
    """Write a committed essay's one settlement line (#623 PR3)."""
    log_generation_settled(
        GenerationSettlement(
            feature=GenerationFeature.ESSAY,
            user_id=note.user_id,
            key=charge.key,
            bucket=None if charge.spent is None else charge.spent.bucket,
            outcome=outcome,
            attempts=_ESSAY_ATTEMPTS,
            usage=usage,
        )
    )


async def _settle_essay(
    session: AsyncSession,
    note: Marginalia,
    essay: str | None,
    llm: BotmasonResonanceLLM,
    charge: _EssayCharge,
) -> None:
    """Meter the call, then cache the letter or refund the non-letter; commit.

    Metered either way: the call happened and its tokens were spent, so a
    refused completion still owes the ledger a row. Stub responses are skipped
    inside ``record_llm_usage`` (zero real tokens), as they always were. The
    refund for a non-letter is staged beside that row and committed with it --
    a rollback here would erase our only record of what the provider charged.
    """
    usage = await record_llm_usage(
        session,
        user_id=note.user_id,
        journal_entry_id=note.journal_entry_id,
        responses=llm.usage,
        generation=charge.key,
    )
    if essay is None:
        refund = None
        if charge.spent is not None:
            refund = await refund_one_message(
                session, note.user_id, charge.spent, reason=REASON_REFUND_NO_ESSAY
            )
        await session.commit()
        log_committed_refund(refund)
        _log_settled_essay(note, charge, usage, GenerationOutcome.REFUSED)
        # Counted, never quoted: the refused text is the prompt (or something
        # else unpublishable), and logging it would leak exactly what the
        # refusal exists to withhold.
        logger.warning(
            "marginalia_essay_refused",
            extra={"user_id": note.user_id, "id": note.id},
        )
        return
    outcome = await _keep_letter(session, note, essay, receipt_since(llm.usage), charge)
    _log_settled_essay(note, charge, usage, outcome)


async def _keep_letter(
    session: AsyncSession,
    note: Marginalia,
    essay: str,
    receipt: InferenceReceipt | None,
    charge: _EssayCharge,
) -> GenerationOutcome:
    """Cache the letter with its source; hand a demo letter's unit back in the same commit.

    The letter's source is stamped beside the letter itself, so the two can
    never be committed apart. A stub letter is still cached -- the writer asked
    for it and sees it labelled as a demo -- but it is never billed (#3062).
    Returns the outcome the settlement line reports.
    """
    note.essay = essay
    note.essay_generated_at = datetime.now(UTC)
    stamp_letter(note, receipt)
    demo = is_demo(receipt)
    refund = None
    if demo and charge.spent is not None:
        refund = await refund_one_message(
            session, note.user_id, charge.spent, reason=REASON_REFUND_DEMO
        )
    await session.commit()
    log_committed_refund(refund)
    return GenerationOutcome.REFUNDED_DEMO if demo else GenerationOutcome.KEPT


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_journal_entry(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    entry: Annotated[JournalEntry, Depends(require_owned_journal_entry)],
    vault_client: Annotated[CreekVaultPipelineClient, Depends(get_creek_vault_client)],
) -> Response:
    """Soft-delete a journal entry (BUG-JOURNAL-007).

    Stamps ``deleted_at = utcnow()`` instead of issuing a hard ``DELETE``.
    This preserves the ``LLMUsageLog.journal_entry_id`` FK reference so the
    usage audit trail is never orphaned, and allows recovery within the
    configurable retention window.  Soft-deleted rows are invisible to all
    read paths (list, get, ``load_recent_conversation``) which filter
    ``deleted_at IS NULL``.
    """
    entry_id = cast("int", entry.id)
    # The ownership dependency's read opened a transaction. End it before
    # waiting for the cross-worker mutation lock so neither the wait nor Creek's
    # bounded DELETE occupies a pooled application connection.
    await session.commit()
    async with (
        hold_account(session, current_user),
        journal_vault_mutations.hold(session, entry_id),
    ):
        await ensure_account_live(session, current_user)
        current = await _load_user_entry(session, entry_id, current_user)
        if current is None or current.sender != "user":
            raise not_found("journal_entry")
        # The local corpus stops circulating the entry as soon as deletion is
        # requested. The row itself remains live, with its remote handle intact,
        # until Creek confirms absence so the identical DELETE stays retryable.
        await withdraw_local_journal_entry(
            session,
            user_id=current_user,
            entry_id=entry_id,
        )
        await mark_entry_retractions_pending(session, user_id=current_user, entry_id=entry_id)
        await session.commit()
        if not await _withdraw_remote_copies(session, current, vault_client):
            raise service_unavailable("vault_withdrawal_pending")
        current.deleted_at = datetime.now(UTC)
        session.add(current)
        await session.commit()
    logger.info(
        "journal_entry_soft_deleted",
        extra={"user_id": current_user, "entry_id": entry_id},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
