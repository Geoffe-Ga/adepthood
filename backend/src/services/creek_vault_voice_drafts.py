"""Mirroring of AI-authored Voice Drafts into Creek Vault, and their durable withdrawal.

Postgres remains the system of record. A generated essay gets one immediate,
capability-gated upsert into the writer's connected vault. A mirror failure
degrades after a content-free log record, so a vault can never cost the writer
their local draft; the mirror itself is not retried.

Withdrawal is not best-effort (#3060). Before the PUT is dialled, a content-free
:class:`~models.voice_draft_retraction.VoiceDraftRetraction` row records that
this essay was offered to this destination. An Intimate reclassification or a
journal deletion turns that row ``pending``, and it stays pending -- across
failed attempts, repeated requests and restarts -- until the destination that
received the copy confirms it absent. The request paths retry it every time;
:func:`resume_voice_draft_retractions` retries it in the background with a
bounded exponential backoff. An essay with no row was never offered to a vault
and is owed nothing, which is what keeps a never-mirrored essay from making
journal deletion fail forever against a vault that refuses unknown ids.

This is a dedicated capability rather than the document-upload path. Creek owns
the former's fixed ``ai-as-user`` attribution and zero voice weight; the latter
represents owner-supplied documents and would train the wrong voice.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

from fastapi import HTTPException
from sqlalchemy import ColumnElement, func, or_, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from domain.creek_vault import (
    CreekCapability,
    CreekVaultError,
    CreekVaultPipelineClient,
    CreekVaultVoiceDraftClient,
    VaultTierCeiling,
    VaultVoiceDraftRequest,
    tier_ceiling_for,
)
from domain.privacy_tier import egress_denied_clause
from models.journal_entry import JournalEntry
from models.journal_withdrawal_obligation import (
    OPEN_STATES,
    JournalWithdrawalObligation,
    JournalWithdrawalState,
)
from models.voice_draft_retraction import (
    RetractionFailureCode,
    VoiceDraftRetraction,
    VoiceDraftRetractionState,
)
from services.account_egress_barrier import ensure_account_live, hold_account
from services.corpus_ingest import withdraw_journal_entry as withdraw_local_journal_entry
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_upload import _expressible_on_the_wire
from services.creek_vault_withdraw import (
    CopyBinding,
    withdraw_journal_copy,
    withdraw_unconfirmed_copy,
)
from services.journal_withdrawal_obligation import open_obligation, settle_confirmed
from services.voice_draft_privacy import voice_draft_privacy

_LOGGER = logging.getLogger(__name__)

_EXTERNAL_ID_PREFIX = "adepthood-voicedraft-"
_EXTERNAL_ID_DIGEST_CHARS = 32
_IDENTITY_SEPARATOR = "\x00"

_MIRROR_DEGRADED_EVENT = "creek vault voice draft mirror degraded"
_MIRROR_STORED_EVENT = "creek vault voice draft mirrored"
_RETRACTION_DEGRADED_EVENT = "creek vault voice draft retraction degraded"
_RETRACTED_EVENT = "creek vault voice draft retracted"
RETRACTION_TRANSITION_EVENT = "creek vault voice draft obligation transition"
RETRACTION_BACKLOG_EVENT = "creek vault voice draft retraction backlog"
_SWEEP_SKIPPED_EVENT = "creek vault voice draft retraction sweep skipped"
_MIRROR_WITHHELD_EVENT = "creek vault voice draft mirror withheld"

#: Every ``extra`` key this module may log. Ids are opaque, states and codes are
#: closed vocabularies, counts and ages are integers: no essay, body, title,
#: vault URL, or credential can ride on any of them (B10 shared invariant).
RETRACTION_LOG_EXTRAS: Final = frozenset(
    {
        "external_id",
        "reason",
        "action",
        "obligation_id",
        "from_state",
        "to_state",
        "attempt_count",
        "safe_failure_code",
        "pending_count",
        "oldest_pending_age_seconds",
    }
)

#: The background sweep's bounded batch, and its exponential backoff: a row that
#: failed ``n`` times waits ``min(base * 2**(n-1), max)`` before the next try, so
#: a vault that refuses forever (a legacy essay it never held, #3060 escalation
#: 1) costs one DELETE an hour rather than one every recovery tick.
_SWEEP_BATCH: Final = 50
_SWEEP_BASE_BACKOFF_SECONDS: Final = 30
_SWEEP_MAX_BACKOFF_SECONDS: Final = 3600

_PENDING = VoiceDraftRetractionState.PENDING.value
_MIRROR_INTENT = VoiceDraftRetractionState.MIRROR_INTENT.value
_CONFIRMED = VoiceDraftRetractionState.CONFIRMED.value
_PENDING_DELETE = JournalWithdrawalState.PENDING_DELETE.value

VaultClientResolver = Callable[[AsyncSession, int], Awaitable[CreekVaultPipelineClient]]
DestinationResolver = Callable[[AsyncSession, int], Awaitable[str | None]]


def voice_draft_external_id(owner_user_id: int, marginalia_id: int) -> str:
    """Return the stable opaque Creek key for one user's expanded marginalia.

    Both local ids are identities rather than prose, but hashing them still
    prevents a vault URL or access log from revealing account and row numbers.
    The NUL separator makes the pair unambiguous before hashing, and 128 digest
    bits are ample for a personal corpus while keeping the URL compact.
    """
    identity = f"{owner_user_id}{_IDENTITY_SEPARATOR}{marginalia_id}".encode()
    digest = hashlib.sha256(identity).hexdigest()[:_EXTERNAL_ID_DIGEST_CHARS]
    return f"{_EXTERNAL_ID_PREFIX}{digest}"


async def _supports_voice_drafts(client: CreekVaultVoiceDraftClient) -> bool:
    """Negotiate once and report whether this vault can store Voice Drafts."""
    handshake = await client.handshake()
    return handshake.available and client.supports(CreekCapability.VOICE_DRAFTS)


@dataclass(frozen=True)
class VoiceDraftCopy:
    """One generated essay as the mirror sends it: whose, which note, what tier."""

    owner_user_id: int
    marginalia_id: int
    essay: str
    classification: str


@dataclass(frozen=True)
class EntryRef:
    """The (account, journal entry) pair an obligation belongs to."""

    user_id: int
    entry_id: int


async def mirror_voice_draft(
    client: CreekVaultVoiceDraftClient,
    draft: VoiceDraftCopy,
    *,
    record_intent: Callable[[], Awaitable[bool]] | None = None,
) -> None:
    """Make one upsert of a non-intimate generated essay, after recording the intent.

    The tier guard runs before the handshake so an intimate essay never reaches
    even a client method. An unavailable or unsupported vault is the ordinary
    local-only configuration and returns silently, with nothing recorded:
    nothing was offered, so nothing is owed. Once admitted, ``record_intent``
    durably records the offer *before* the PUT is dialled; it answers ``False``
    while an earlier withdrawal is still owed for this draft, and the PUT is
    then withheld rather than republishing over that obligation. A Creek fault
    or an unreadable success is recorded and dropped, never retried -- its
    intent row keeps any later withdrawal honest.
    """
    tier = tier_ceiling_for(draft.classification)
    if not _expressible_on_the_wire(tier) or not await _supports_voice_drafts(client):
        return
    external_id = voice_draft_external_id(draft.owner_user_id, draft.marginalia_id)
    if not await _intent_recorded(record_intent, external_id):
        return
    request = VaultVoiceDraftRequest(
        external_id=external_id,
        content=draft.essay,
        tier=tier,
        tier_ceiling=tier,
    )
    await _put_draft(client, request)


async def _intent_recorded(
    record_intent: Callable[[], Awaitable[bool]] | None, external_id: str
) -> bool:
    """Record the offer when a recorder is wired; ``False`` withholds the PUT."""
    if record_intent is None or await record_intent():
        return True
    _LOGGER.warning(
        _MIRROR_WITHHELD_EVENT,
        extra={"external_id": external_id, "reason": "withdrawal_outstanding"},
    )
    return False


async def _put_draft(client: CreekVaultVoiceDraftClient, request: VaultVoiceDraftRequest) -> None:
    """Attempt the one PUT, logging a content-free outcome; never raises a vault error."""
    external_id = request.external_id
    try:
        result = await client.upsert_voice_draft(request)
    except CreekVaultError:
        _LOGGER.warning(
            _MIRROR_DEGRADED_EVENT,
            extra={"external_id": external_id, "reason": "vault_error"},
        )
        return
    if not result.stored:
        _LOGGER.warning(
            _MIRROR_DEGRADED_EVENT,
            extra={"external_id": external_id, "reason": "not_stored"},
        )
        return
    _LOGGER.info(
        _MIRROR_STORED_EVENT,
        extra={"external_id": external_id, "action": result.action},
    )


async def _absence_answer(client: CreekVaultVoiceDraftClient) -> RetractionFailureCode | None:
    """Negotiate the DELETE; ``None`` means dial it, a code means it cannot be confirmed.

    A true local fallback has no remote destination, so it answers absent by
    returning a sentinel the caller reads as "confirmed without a dial".
    """
    try:
        handshake = await client.handshake()
    except CreekVaultError:
        return RetractionFailureCode.VAULT_UNAVAILABLE
    if not handshake.available:
        return RetractionFailureCode.VAULT_UNAVAILABLE
    if not client.supports(CreekCapability.VOICE_DRAFTS):
        return RetractionFailureCode.CAPABILITY_MISSING
    return None


async def retraction_failure(
    client: CreekVaultVoiceDraftClient,
    *,
    owner_user_id: int,
    marginalia_id: int,
) -> RetractionFailureCode | None:
    """Retract one mirrored draft; ``None`` when absence is confirmed, else a closed code.

    ``PERSONAL`` is the widest ceiling the remote wire admits, so it can delete
    either an open or a personal copy. The local essay is intentionally absent
    from this signature: an intimate reclassification must not resend the prose
    it is retracting. A true local fallback is absence-equivalent because this
    request has no remote destination. An unreachable connected adapter is not:
    it may still hold an earlier mirror. Nor is a connected capability
    downgrade: the vault may retain a draft written while that capability was
    previously advertised.
    """
    negotiation = await _absence_answer(client)
    if negotiation is not None:
        return None if type(client) is LocalFallbackCreekVaultClient else negotiation
    external_id = voice_draft_external_id(owner_user_id, marginalia_id)
    try:
        result = await client.delete_voice_draft(external_id, VaultTierCeiling.PERSONAL)
    except CreekVaultError:
        _LOGGER.warning(
            _RETRACTION_DEGRADED_EVENT,
            extra={"external_id": external_id, "reason": "vault_error"},
        )
        return RetractionFailureCode.VAULT_ERROR
    if not result.deleted:
        _LOGGER.warning(
            _RETRACTION_DEGRADED_EVENT,
            extra={"external_id": external_id, "reason": "not_deleted"},
        )
        return RetractionFailureCode.NOT_DELETED
    _LOGGER.info(_RETRACTED_EVENT, extra={"external_id": external_id})
    return None


async def retract_voice_draft(
    client: CreekVaultVoiceDraftClient,
    *,
    owner_user_id: int,
    marginalia_id: int,
) -> bool:
    """Retract one mirrored draft and report whether its absence is confirmed.

    The boolean form of :func:`retraction_failure`, for callers that need only
    the verdict.
    """
    failure = await retraction_failure(
        client, owner_user_id=owner_user_id, marginalia_id=marginalia_id
    )
    return failure is None


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(moment: datetime) -> datetime:
    """Read a stored timestamp as UTC; SQLite hands timezone-aware columns back naive."""
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)


def retraction_backoff(attempt_count: int) -> timedelta:
    """Return how long a row that has failed ``attempt_count`` times waits to retry."""
    exponent = max(attempt_count - 1, 0)
    seconds = min(_SWEEP_BASE_BACKOFF_SECONDS * 2**exponent, _SWEEP_MAX_BACKOFF_SECONDS)
    return timedelta(seconds=seconds)


def _log_transition(
    obligation_id: int | None,
    from_state: str | None,
    to_state: str,
    *,
    attempt_count: int = 0,
    safe_failure_code: str | None = None,
) -> None:
    """Record one content-free state transition of an obligation row."""
    _LOGGER.info(
        RETRACTION_TRANSITION_EVENT,
        extra={
            "obligation_id": obligation_id,
            "from_state": from_state,
            "to_state": to_state,
            "attempt_count": attempt_count,
            "safe_failure_code": safe_failure_code,
        },
    )


async def _intent_row(
    session: AsyncSession, *, user_id: int, marginalia_id: int
) -> VoiceDraftRetraction | None:
    result = await session.execute(
        select(VoiceDraftRetraction).where(
            VoiceDraftRetraction.user_id == user_id,
            VoiceDraftRetraction.marginalia_id == marginalia_id,
        )
    )
    return result.scalars().first()


def _may_rearm(row: VoiceDraftRetraction, destination: str | None) -> bool:
    """Whether an existing row may be reset to a fresh intent for ``destination``.

    A confirmed row owes nothing. An intent to the same destination is the same
    offer. Anything else -- a pending withdrawal, or an intent to another vault
    -- still describes a copy that must be withdrawn first.
    """
    if row.state == _CONFIRMED:
        return True
    return row.state == _MIRROR_INTENT and row.destination == destination


async def record_mirror_intent(
    session: AsyncSession,
    *,
    user_id: int,
    entry_id: int,
    marginalia_id: int,
    destination: str | None,
) -> bool:
    """Durably record that this essay is about to be offered to ``destination``.

    Commits before returning, so the PUT that follows holds no pooled
    connection and a crash after Creek stores the draft still leaves a local
    trace. Upserts rather than skipping: a confirmed row is re-armed, so a
    future re-mirror is never untracked. Returns ``False`` -- withhold the PUT
    -- while an earlier withdrawal for this draft is still owed.
    """
    row = await _intent_row(session, user_id=user_id, marginalia_id=marginalia_id)
    previous = None if row is None else row.state
    if row is None:
        row = VoiceDraftRetraction(
            user_id=user_id,
            journal_entry_id=entry_id,
            marginalia_id=marginalia_id,
            destination=destination,
        )
    elif not _may_rearm(row, destination):
        await session.commit()
        return False
    else:
        row.state = _MIRROR_INTENT
        row.journal_entry_id = entry_id
        row.destination = destination
        row.attempt_count = 0
        row.safe_failure_code = None
        row.next_attempt_at = None
        row.confirmed_at = None
        row.updated_at = _utcnow()
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        # A concurrent writer recorded this draft first; its row governs.
        await session.rollback()
        return False
    _log_transition(row.id, previous, _MIRROR_INTENT)
    return True


async def mark_entry_retractions_pending(
    session: AsyncSession, *, user_id: int, entry_id: int
) -> None:
    """Turn every recorded offer for this entry into an owed withdrawal. Does not commit.

    Called inside the same transaction that commits the Intimate tier or the
    deletion request, so the obligation exists before any network call.
    """
    result = await session.execute(
        select(VoiceDraftRetraction.id).where(
            VoiceDraftRetraction.user_id == user_id,
            VoiceDraftRetraction.journal_entry_id == entry_id,
            VoiceDraftRetraction.state == _MIRROR_INTENT,
        )
    )
    obligation_ids = tuple(result.scalars().all())
    if not obligation_ids:
        return
    await session.execute(
        update(VoiceDraftRetraction)
        .where(
            col(VoiceDraftRetraction.id).in_(obligation_ids),
            col(VoiceDraftRetraction.state) == _MIRROR_INTENT,
        )
        .values(state=_PENDING, next_attempt_at=None, updated_at=_utcnow())
    )
    for obligation_id in obligation_ids:
        _log_transition(obligation_id, _MIRROR_INTENT, _PENDING)


async def _settle(
    session: AsyncSession,
    *,
    obligation_id: int,
    attempt_count: int,
    failure: RetractionFailureCode | None,
    now: datetime,
) -> None:
    """Persist one attempt's outcome, only while the row is still pending, and commit."""
    guard = update(VoiceDraftRetraction).where(
        col(VoiceDraftRetraction.id) == obligation_id,
        col(VoiceDraftRetraction.state) == _PENDING,
    )
    if failure is None:
        values: dict[str, object] = {
            "state": _CONFIRMED,
            "confirmed_at": now,
            "safe_failure_code": None,
            "next_attempt_at": None,
            "updated_at": now,
        }
        _log_transition(obligation_id, _PENDING, _CONFIRMED, attempt_count=attempt_count)
    else:
        attempts = attempt_count + 1
        values = {
            "attempt_count": attempts,
            "safe_failure_code": failure.value,
            "next_attempt_at": now + retraction_backoff(attempts),
            "updated_at": now,
        }
        _log_transition(
            obligation_id,
            _PENDING,
            _PENDING,
            attempt_count=attempts,
            safe_failure_code=failure.value,
        )
    await session.execute(guard.values(**values))
    await session.commit()


async def retract_pending_voice_drafts(
    session: AsyncSession,
    client: CreekVaultVoiceDraftClient,
    target: EntryRef,
    *,
    destination: str | None,
    due_by: datetime | None = None,
) -> bool:
    """Attempt every owed withdrawal for one entry; ``True`` only when none remains.

    Projects ids only -- never essay text -- and commits before the first
    network call. A row bound to another destination is never dialled: it stays
    pending as ``destination_changed``. ``due_by`` restricts the attempt to rows
    whose backoff has elapsed (the background sweep); a request path passes
    ``None`` and retries every owed row, because the writer just asked. The
    sweep's ``due_by`` is also the clock its backoff is scheduled from.
    """
    rows = await _owed_rows(session, target, due_by)
    attempt = _AttemptContext(
        client=client,
        target=target,
        destination=destination,
        now=_utcnow() if due_by is None else due_by,
    )
    failures = [await _attempt_and_settle(session, attempt, row) for row in rows]
    return not any(failures) and not await _still_owed(session, target)


@dataclass(frozen=True)
class _AttemptContext:
    """What every row of one retry pass is attempted against."""

    client: CreekVaultVoiceDraftClient
    target: EntryRef
    destination: str | None
    now: datetime


async def _attempt_and_settle(
    session: AsyncSession,
    attempt: _AttemptContext,
    row: tuple[int, int, str | None, int],
) -> RetractionFailureCode | None:
    """Attempt one owed row and persist its outcome; return the failure, if any."""
    obligation_id, marginalia_id, recorded, attempt_count = row
    failure = await _attempt_one(
        attempt.client,
        owner_user_id=attempt.target.user_id,
        marginalia_id=marginalia_id,
        bound_elsewhere=recorded not in {None, attempt.destination},
    )
    await _settle(
        session,
        obligation_id=obligation_id,
        attempt_count=attempt_count,
        failure=failure,
        now=attempt.now,
    )
    return failure


async def _owed_rows(
    session: AsyncSession, target: EntryRef, due_by: datetime | None
) -> tuple[tuple[int, int, str | None, int], ...]:
    """Project the owed rows' ids (never essay text), then end the transaction."""
    query = select(
        VoiceDraftRetraction.id,
        VoiceDraftRetraction.marginalia_id,
        VoiceDraftRetraction.destination,
        VoiceDraftRetraction.attempt_count,
    ).where(
        VoiceDraftRetraction.user_id == target.user_id,
        VoiceDraftRetraction.journal_entry_id == target.entry_id,
        VoiceDraftRetraction.state == _PENDING,
    )
    if due_by is not None:
        query = query.where(_is_due(due_by))
    result = await session.execute(query.order_by(col(VoiceDraftRetraction.id)))
    rows = tuple(
        (obligation_id, marginalia_id, recorded, attempt_count)
        for obligation_id, marginalia_id, recorded, attempt_count in result.all()
        if obligation_id is not None
    )
    await session.commit()
    return rows


async def _attempt_one(
    client: CreekVaultVoiceDraftClient,
    *,
    owner_user_id: int,
    marginalia_id: int,
    bound_elsewhere: bool,
) -> RetractionFailureCode | None:
    """Dial one owed DELETE, unless the copy lives in a vault other than this one.

    A row exists only because a copy was (or, for a pre-migration essay, may
    have been) offered to a vault, so the local fallback -- which dials
    nothing -- can never confirm one. A connected vault that resolves to the
    fallback right now (a DNS blip, a managed vault not yet ready) may still
    hold the copy. A legacy row with no recorded destination, on an account
    with no vault today, cannot say which vault received it. Both stay pending
    as ``vault_unavailable``; the legacy case joins owner escalation 2 (#3060).
    """
    if bound_elsewhere:
        return RetractionFailureCode.DESTINATION_CHANGED
    if type(client) is LocalFallbackCreekVaultClient:
        return RetractionFailureCode.VAULT_UNAVAILABLE
    return await retraction_failure(
        client, owner_user_id=owner_user_id, marginalia_id=marginalia_id
    )


async def _still_owed(session: AsyncSession, target: EntryRef) -> bool:
    """Whether any withdrawal for this entry is still pending (e.g. one backed off)."""
    result = await session.execute(
        select(func.count())
        .select_from(VoiceDraftRetraction)
        .where(
            VoiceDraftRetraction.user_id == target.user_id,
            VoiceDraftRetraction.journal_entry_id == target.entry_id,
            VoiceDraftRetraction.state == _PENDING,
        )
    )
    owed = int(result.scalar_one())
    await session.commit()
    return owed > 0


def _is_due(moment: datetime) -> ColumnElement[bool]:
    """Match pending rows whose backoff has elapsed by ``moment`` (never-tried rows included)."""
    next_attempt = col(VoiceDraftRetraction.next_attempt_at)
    return or_(next_attempt.is_(None), next_attempt <= moment)


class JournalRetrySchedule:
    """Per-process backoff for the background journal-copy retry.

    The journal copy's durable marker is ``JournalEntry.vault_ref`` /
    ``vault_destination``, which carries no attempt count. Rather than widen a
    hot table, the sweep spaces its retries here with the same exponential
    curve as the essay rows. A restart forgets the schedule, which costs one
    early retry -- never a dropped obligation, because the marker is durable.
    """

    def __init__(self) -> None:
        """Start with no recorded failures: every entry is due."""
        self._failures: dict[int, tuple[int, datetime]] = {}

    def due(self, entry_id: int, moment: datetime) -> bool:
        """Whether ``entry_id``'s backoff has elapsed by ``moment``."""
        record = self._failures.get(entry_id)
        return record is None or record[1] <= moment

    def backed_off(self, moment: datetime) -> frozenset[int]:
        """Entry ids still inside their backoff window at ``moment``."""
        return frozenset(
            entry_id for entry_id, (_attempts, due) in self._failures.items() if due > moment
        )

    def record(self, entry_id: int, moment: datetime, *, confirmed: bool) -> None:
        """Forget a confirmed entry, or push a failed one's next attempt out."""
        if confirmed:
            self._failures.pop(entry_id, None)
            return
        attempts = self._failures.get(entry_id, (0, moment))[0] + 1
        self._failures[entry_id] = (attempts, moment + retraction_backoff(attempts))


_JOURNAL_RETRIES = JournalRetrySchedule()


@dataclass(frozen=True)
class _SweepPass:
    """What one background pass resolves each account through, and its clock."""

    resolve_client: VaultClientResolver
    resolve_destination: DestinationResolver
    moment: datetime
    journal_retries: JournalRetrySchedule


def _journal_marker_present() -> ColumnElement[bool]:
    return or_(
        col(JournalEntry.vault_ref).is_not(None),
        col(JournalEntry.vault_destination).is_not(None),
    )


async def _due_entries(session: AsyncSession, sweep: _SweepPass) -> tuple[tuple[int, int], ...]:
    """Snapshot the (account, entry) pairs with work due, then end the transaction."""
    essays = await session.execute(
        select(VoiceDraftRetraction.user_id, VoiceDraftRetraction.journal_entry_id)
        .where(VoiceDraftRetraction.state == _PENDING, _is_due(sweep.moment))
        .order_by(col(VoiceDraftRetraction.id))
        .limit(_SWEEP_BATCH)
    )
    pairs: dict[tuple[int, int], None] = dict.fromkeys(
        (user_id, entry_id) for user_id, entry_id in essays.all()
    )
    journals = await session.execute(
        select(JournalEntry.user_id, JournalEntry.id)
        .where(
            egress_denied_clause(col(JournalEntry.classification)),
            col(JournalEntry.deleted_at).is_(None),
            _journal_marker_present(),
            col(JournalEntry.id).not_in(sweep.journal_retries.backed_off(sweep.moment)),
        )
        .order_by(col(JournalEntry.id))
        .limit(_SWEEP_BATCH)
    )
    for user_id, entry_id in journals.all():
        if entry_id is not None:
            pairs.setdefault((user_id, entry_id))
    owed = await session.execute(
        select(JournalWithdrawalObligation.user_id, JournalWithdrawalObligation.journal_entry_id)
        .where(
            col(JournalWithdrawalObligation.state).in_(OPEN_STATES),
            col(JournalWithdrawalObligation.journal_entry_id).not_in(
                sweep.journal_retries.backed_off(sweep.moment)
            ),
        )
        .order_by(col(JournalWithdrawalObligation.id))
        .limit(_SWEEP_BATCH)
    )
    for user_id, entry_id in owed.all():
        pairs.setdefault((user_id, entry_id))
    await session.commit()
    return tuple(pairs)


async def _log_backlog(session: AsyncSession, moment: datetime) -> None:
    """Report how many withdrawals are owed and how old the oldest is, content-free."""
    result = await session.execute(
        select(func.count(), func.min(VoiceDraftRetraction.created_at)).where(
            VoiceDraftRetraction.state == _PENDING
        )
    )
    pending_count, oldest = result.one()
    await session.commit()
    if not pending_count or oldest is None:
        return
    _LOGGER.info(
        RETRACTION_BACKLOG_EVENT,
        extra={
            "pending_count": int(pending_count),
            "oldest_pending_age_seconds": int((moment - _aware(oldest)).total_seconds()),
        },
    )


@dataclass(frozen=True)
class _JournalAttempt:
    """One entry's journal-copy retry: whose it is, where it may go, and what else is owed."""

    target: EntryRef
    destination: str | None
    drafts_withdrawn: bool


async def _retry_journal_copy(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    sweep: _SweepPass,
    attempt: _JournalAttempt,
) -> None:
    """Finish an owed deletion or unconfirmed withdrawal, else retry an Intimate copy.

    An entry with an open :class:`JournalWithdrawalObligation` is worked from
    that durable marker whatever its classification (#3098); one without is
    retried only while it is Intimate and still holds its vault marker, exactly
    as before. A live, non-Intimate page nobody asked to delete is never dialled.
    """
    target = attempt.target
    obligation = await open_obligation(session, user_id=target.user_id, entry_id=target.entry_id)
    if obligation is None:
        await _retry_intimate_copy(
            session, client, sweep, entry_id=target.entry_id, destination=attempt.destination
        )
        return
    if not sweep.journal_retries.due(target.entry_id, sweep.moment):
        await session.commit()
        return
    confirmed = await _finish_obligation(
        session,
        client,
        attempt,
        owed=_OwedCopy(state=obligation.state, recorded=obligation.destination),
        moment=sweep.moment,
    )
    sweep.journal_retries.record(target.entry_id, sweep.moment, confirmed=confirmed)


@dataclass(frozen=True)
class _OwedCopy:
    """What an open obligation says about the copy: its state and its recorded vault."""

    state: str
    recorded: str | None


async def _entry_row(session: AsyncSession, target: EntryRef) -> JournalEntry | None:
    """The obligation's entry, live or soft-deleted; ``None`` once purged."""
    result = await session.execute(
        select(JournalEntry).where(
            JournalEntry.id == target.entry_id,
            JournalEntry.user_id == target.user_id,
        )
    )
    return result.scalars().first()


async def _finish_obligation(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    attempt: _JournalAttempt,
    *,
    owed: _OwedCopy,
    moment: datetime,
) -> bool:
    """Drive one open obligation to confirmed when its vault confirms; report whether it did.

    ``pending_delete``: the page is still live, so its own marker is withdrawn
    (bound to the vault that received it) and, once every essay withdrawal is
    confirmed too, the deletion the writer asked for is stamped. ``unconfirmed``
    (or a purged page): the page is already gone here, so only the recorded
    vault's confirmation can clear the row.
    """
    target = attempt.target
    entry = await _entry_row(session, target)
    if owed.state == _PENDING_DELETE and entry is not None:
        confirmed = await _finish_pending_delete(session, client, attempt, entry, moment=moment)
    else:
        confirmed = await withdraw_unconfirmed_copy(
            session,
            entry,
            client,
            binding=CopyBinding(
                entry_id=target.entry_id, recorded=owed.recorded, current=attempt.destination
            ),
        )
    if not confirmed:
        return False
    await settle_confirmed(session, user_id=target.user_id, entry_id=target.entry_id)
    await session.commit()
    return True


async def _finish_pending_delete(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    attempt: _JournalAttempt,
    entry: JournalEntry,
    *,
    moment: datetime,
) -> bool:
    """Finish a requested deletion once every copy of the page is confirmed gone.

    The local half of the deletion is repeated first -- the corpus withdrawal
    and the essay retraction marking -- so a fragment or an essay mirror that
    appeared after the DELETE (a write that raced the obligation, a restore)
    never outlives it. Then the page's own copy is withdrawn and every owed
    essay withdrawal, including any just marked, must be confirmed before
    ``deleted_at`` is stamped.
    """
    target = attempt.target
    await withdraw_local_journal_entry(session, user_id=target.user_id, entry_id=target.entry_id)
    await mark_entry_retractions_pending(session, user_id=target.user_id, entry_id=target.entry_id)
    await session.commit()
    journal_withdrawn = await withdraw_journal_copy(
        session, entry, client, destination=attempt.destination
    )
    drafts_withdrawn = await retract_pending_voice_drafts(
        session, client, target, destination=attempt.destination, due_by=moment
    )
    if not (journal_withdrawn and drafts_withdrawn):
        return False
    if entry.deleted_at is None:
        entry.deleted_at = moment
        session.add(entry)
    return True


async def _retry_intimate_copy(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    sweep: _SweepPass,
    *,
    entry_id: int,
    destination: str | None,
) -> None:
    """Retry an Intimate entry's journal withdrawal when its marker is still held."""
    result = await session.execute(
        select(JournalEntry).where(
            JournalEntry.id == entry_id,
            egress_denied_clause(col(JournalEntry.classification)),
            col(JournalEntry.deleted_at).is_(None),
            _journal_marker_present(),
        )
    )
    entry = result.scalars().first()
    if entry is None or not sweep.journal_retries.due(entry_id, sweep.moment):
        await session.commit()
        return
    confirmed = await withdraw_journal_copy(session, entry, client, destination=destination)
    sweep.journal_retries.record(entry_id, sweep.moment, confirmed=confirmed)


async def _resume_entry(session: AsyncSession, sweep: _SweepPass, target: EntryRef) -> None:
    """Retry one entry's owed withdrawals under the same locks as the request paths.

    Account barrier outermost, entry serializer innermost -- the fixed nesting
    everywhere the two meet -- so a concurrent PATCH, DELETE, mirror, or
    another worker's sweep runs strictly before or after this, never between a
    read and its settle. An erased (or erasing) account answers 401 from
    :func:`ensure_account_live`; that is a skip for this one account, never an
    exception that would end the shared recovery task.
    """
    try:
        async with (
            hold_account(session, target.user_id),
            voice_draft_privacy.hold(session, target.entry_id),
        ):
            await ensure_account_live(session, target.user_id)
            client = await sweep.resolve_client(session, target.user_id)
            destination = await sweep.resolve_destination(session, target.user_id)
            drafts_withdrawn = await retract_pending_voice_drafts(
                session, client, target, destination=destination, due_by=sweep.moment
            )
            await _retry_journal_copy(
                session,
                client,
                sweep,
                _JournalAttempt(
                    target=target, destination=destination, drafts_withdrawn=drafts_withdrawn
                ),
            )
    except HTTPException:
        _LOGGER.info(_SWEEP_SKIPPED_EVENT, extra={"reason": "account_unavailable"})


async def resume_voice_draft_retractions(
    factory: async_sessionmaker[AsyncSession],
    resolve_client: VaultClientResolver,
    resolve_destination: DestinationResolver,
    *,
    now: datetime | None = None,
    journal_retries: JournalRetrySchedule | None = None,
) -> None:
    """Retry owed withdrawals in the background, without any user action.

    Run from the application's recovery loop. Each pass snapshots a bounded
    batch of due work in one short transaction, then handles each entry on its
    own session so one slow vault holds no pooled connection for the others.
    ``journal_retries`` defaults to this process's schedule; a caller that
    wants an isolated backoff (a test) passes its own.
    """
    sweep = _SweepPass(
        resolve_client=resolve_client,
        resolve_destination=resolve_destination,
        moment=now if now is not None else _utcnow(),
        journal_retries=journal_retries if journal_retries is not None else _JOURNAL_RETRIES,
    )
    async with factory() as session:
        targets = await _due_entries(session, sweep)
        await _log_backlog(session, sweep.moment)
    for user_id, entry_id in targets:
        await _resume_isolated(factory, sweep, EntryRef(user_id=user_id, entry_id=entry_id))


#: Faults one account's work may raise that must not end the pass for everyone
#: else: an undecryptable stored credential, a database error, a socket error.
_ENTRY_FAULTS = (RuntimeError, SQLAlchemyError, OSError)


async def _resume_isolated(
    factory: async_sessionmaker[AsyncSession], sweep: _SweepPass, target: EntryRef
) -> None:
    """Resume one entry; a fault there is logged, backed off, and never ends the pass.

    Without this, one account whose vault credential can no longer be
    decrypted would raise out of the loop on every pass, and -- its rows never
    settled, so always due and always first -- starve every other account.
    """
    try:
        async with factory() as session:
            await _resume_entry(session, sweep, target)
    except _ENTRY_FAULTS:
        _LOGGER.warning(_SWEEP_SKIPPED_EVENT, extra={"reason": "entry_failed"})
        await _defer_entry(factory, sweep, target)


async def _defer_entry(
    factory: async_sessionmaker[AsyncSession], sweep: _SweepPass, target: EntryRef
) -> None:
    """Push a faulting entry's due rows (and journal retry) out by their backoff."""
    sweep.journal_retries.record(target.entry_id, sweep.moment, confirmed=False)
    try:
        async with factory() as session:
            rows = await _owed_rows(session, target, sweep.moment)
            for obligation_id, _marginalia_id, _recorded, attempt_count in rows:
                await _settle(
                    session,
                    obligation_id=obligation_id,
                    attempt_count=attempt_count,
                    failure=RetractionFailureCode.VAULT_UNAVAILABLE,
                    now=sweep.moment,
                )
    except _ENTRY_FAULTS:
        _LOGGER.warning(_SWEEP_SKIPPED_EVENT, extra={"reason": "defer_failed"})
