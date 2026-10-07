"""Background recovery of owed Voice Draft and journal withdrawals (#3060, #3077).

A pending obligation must complete without the writer acting again: after a
restart (a fresh session factory), with backoff against a vault that refuses
forever, past an erased account, and alongside a concurrent PATCH. Its log
records stay content-free.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultPipelineClient,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultIngestAction,
    VaultJournalWithdrawResult,
    VaultTierCeiling,
    VaultVoiceDraftDeleteResult,
    VaultVoiceDraftRequest,
    VaultVoiceDraftResult,
)
from main import app
from models.journal_entry import JournalClassification, JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from models.voice_draft_retraction import VoiceDraftRetraction, VoiceDraftRetractionState
from services import creek_vault_voice_drafts as drafts
from services import creek_vault_withdraw as withdraw_module
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_voice_drafts import (
    RETRACTION_BACKLOG_EVENT,
    RETRACTION_LOG_EXTRAS,
    RETRACTION_TRANSITION_EVENT,
    JournalRetrySchedule,
    VoiceDraftCopy,
    mirror_voice_draft,
    record_mirror_intent,
    resume_voice_draft_retractions,
    voice_draft_external_id,
)

_PASSWORD = "secret12345"  # pragma: allowlist secret
_BODY = "SENTINEL_RECOVERY_BODY the river bent"
_ESSAY = "SENTINEL_RECOVERY_ESSAY a warm letter"
_T0 = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
_INSIDE_BACKOFF = timedelta(seconds=1)
_PAST_BACKOFF = timedelta(hours=2)
_TWO_ATTEMPTS = 2
_STUCK_ENTRIES = 51

#: Attributes every ``logging.LogRecord`` carries, plus the request trace id the
#: application's own log filter stamps on every record (``observability``) once
#: any test has installed it; anything else came from the caller's ``extra``.
_STANDARD_RECORD_KEYS = frozenset(
    logging.LogRecord("n", logging.INFO, "p", 1, "m", None, None).__dict__
) | {"message", "asctime", "taskName", "trace_id"}


class _DraftVault(LocalFallbackCreekVaultClient):
    """A connected vault with Voice Drafts and journal withdrawal, scripted to fail or not."""

    def __init__(self, *, fail: bool = False) -> None:
        super().__init__()
        self.fail = fail
        self.deletes: list[str] = []
        self.withdrawals: list[int] = []

    async def handshake(self) -> HandshakeResult:
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="aptitude-wavelength/2026-05-23",
            capabilities=frozenset(
                {CreekCapability.VOICE_DRAFTS, CreekCapability.JOURNAL_WITHDRAW}
            ),
            attestation=None,
        )

    def supports(self, capability: CreekCapability, /) -> bool:
        return capability in {CreekCapability.VOICE_DRAFTS, CreekCapability.JOURNAL_WITHDRAW}

    async def delete_voice_draft(
        self, external_id: str, _tier_ceiling: VaultTierCeiling, /
    ) -> VaultVoiceDraftDeleteResult:
        self.deletes.append(external_id)
        if self.fail:
            raise CreekVaultUnavailableError("synthetic privacy_refused")
        return VaultVoiceDraftDeleteResult(deleted=True)

    async def withdraw_journal_entry(self, entry_id: int, /) -> VaultJournalWithdrawResult:
        self.withdrawals.append(entry_id)
        if self.fail:
            raise CreekVaultUnavailableError("synthetic withdraw outage")
        return VaultJournalWithdrawResult(withdrawn=True)


def _factory(session: AsyncSession) -> async_sessionmaker[AsyncSession]:
    """Independent sessions over the test engine: the restarted worker's view."""
    assert session.bind is not None
    return async_sessionmaker(session.bind, class_=AsyncSession, expire_on_commit=False)


async def _sweep(
    session: AsyncSession,
    vault: LocalFallbackCreekVaultClient,
    moment: datetime,
    *,
    destination: str | None = None,
    schedule: JournalRetrySchedule | None = None,
) -> None:
    async def _client(_session: AsyncSession, _user_id: int) -> CreekVaultPipelineClient:
        return vault

    async def _destination(_session: AsyncSession, _user_id: int) -> str | None:
        return destination

    await resume_voice_draft_retractions(
        _factory(session),
        _client,
        _destination,
        now=moment,
        journal_retries=schedule if schedule is not None else JournalRetrySchedule(),
    )


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    response = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _PASSWORD},
    )
    assert response.status_code == HTTPStatus.OK
    payload = response.json()
    return {"Authorization": f"Bearer {payload['token']}"}, int(payload["user_id"])


async def _seed_pending(
    session: AsyncSession,
    user_id: int,
    *,
    state: VoiceDraftRetractionState = VoiceDraftRetractionState.PENDING,
    classification: JournalClassification = JournalClassification.INTIMATE,
    destination: str | None = None,
) -> tuple[int, int]:
    """Seed an entry, an expanded note, and its obligation row in ``state``."""
    entry = JournalEntry(
        sender="user", user_id=user_id, message=_BODY, classification=classification
    )
    session.add(entry)
    await session.flush()
    assert entry.id is not None
    note = Marginalia(
        journal_entry_id=entry.id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=8,
        anchor_text="SENTINEL",
        note="A note.",
        essay=_ESSAY,
        essay_generated_at=_T0,
    )
    session.add(note)
    await session.flush()
    assert note.id is not None
    session.add(
        VoiceDraftRetraction(
            user_id=user_id,
            journal_entry_id=entry.id,
            marginalia_id=note.id,
            state=state.value,
            destination=destination,
        )
    )
    await session.commit()
    return entry.id, note.id


async def _row(session: AsyncSession, note_id: int) -> VoiceDraftRetraction:
    result = await session.execute(
        select(VoiceDraftRetraction)
        .where(col(VoiceDraftRetraction.marginalia_id) == note_id)
        .execution_options(populate_existing=True)
    )
    row = result.scalar_one()
    await session.commit()
    return row


@pytest.mark.asyncio
async def test_pending_retraction_is_resumed_after_restart(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A fresh worker confirms the owed DELETE once, then has nothing left to send."""
    _headers, user_id = await _signup(async_client, "recovery_restart")
    _entry_id, note_id = await _seed_pending(db_session, user_id)
    vault = _DraftVault()

    await _sweep(db_session, vault, _T0)

    assert vault.deletes == [voice_draft_external_id(user_id, note_id)]
    row = await _row(db_session, note_id)
    assert row.state == VoiceDraftRetractionState.CONFIRMED
    assert row.confirmed_at is not None

    await _sweep(db_session, vault, _T0 + _PAST_BACKOFF)

    assert len(vault.deletes) == 1


@pytest.mark.asyncio
async def test_sweep_backs_off_a_permanently_refused_row(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A vault that refuses forever costs one DELETE per backoff window, not one per tick."""
    _headers, user_id = await _signup(async_client, "recovery_backoff")
    _entry_id, note_id = await _seed_pending(db_session, user_id)
    vault = _DraftVault(fail=True)

    await _sweep(db_session, vault, _T0)
    await _sweep(db_session, vault, _T0 + _INSIDE_BACKOFF)

    assert len(vault.deletes) == 1
    row = await _row(db_session, note_id)
    assert row.state == VoiceDraftRetractionState.PENDING
    assert row.attempt_count == 1
    assert row.safe_failure_code == "vault_error"

    await _sweep(db_session, vault, _T0 + _PAST_BACKOFF)

    assert len(vault.deletes) == _TWO_ATTEMPTS, "backoff spaces retries; it never abandons the row"


@pytest.mark.asyncio
async def test_sweep_never_retracts_an_unowed_intent(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A ``mirror_intent`` row on a live, non-Intimate entry is not a withdrawal request."""
    _headers, user_id = await _signup(async_client, "recovery_intent_only")
    _entry_id, note_id = await _seed_pending(
        db_session,
        user_id,
        state=VoiceDraftRetractionState.MIRROR_INTENT,
        classification=JournalClassification.PERSONAL,
    )
    vault = _DraftVault()

    await _sweep(db_session, vault, _T0)

    assert vault.deletes == []
    assert (await _row(db_session, note_id)).state == VoiceDraftRetractionState.MIRROR_INTENT


@pytest.mark.asyncio
async def test_sweep_retries_the_intimate_journal_copy(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An Intimate entry still holding its vault marker is withdrawn by the sweep too."""
    _headers, user_id = await _signup(async_client, "recovery_journal")
    entry = JournalEntry(
        sender="user",
        user_id=user_id,
        message=_BODY,
        classification=JournalClassification.INTIMATE,
        vault_ref="vault-ref-legacy",
    )
    db_session.add(entry)
    await db_session.commit()
    assert entry.id is not None
    entry_id = entry.id
    vault = _DraftVault()

    await _sweep(db_session, vault, _T0)

    assert vault.withdrawals == [entry_id]
    await db_session.refresh(entry)
    assert entry.vault_ref is None


@pytest.mark.asyncio
async def test_sweep_skips_erased_account_without_killing_recovery(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An erased account is skipped; the next account's obligation still completes."""
    _headers_x, erased_id = await _signup(async_client, "recovery_erased")
    _headers_y, live_id = await _signup(async_client, "recovery_live")
    _erased_entry, erased_note = await _seed_pending(db_session, erased_id)
    _live_entry, live_note = await _seed_pending(db_session, live_id)
    erased = await db_session.get(User, erased_id)
    assert erased is not None
    erased.deleted_at = _T0
    db_session.add(erased)
    await db_session.commit()
    vault = _DraftVault()

    await _sweep(db_session, vault, _T0)

    assert vault.deletes == [voice_draft_external_id(live_id, live_note)]
    assert (await _row(db_session, live_note)).state == VoiceDraftRetractionState.CONFIRMED
    assert (await _row(db_session, erased_note)).state == VoiceDraftRetractionState.PENDING


@pytest.mark.asyncio
@pytest.mark.integration
async def test_concurrent_patch_and_sweep_issue_no_lost_obligation(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A PATCH and a sweep racing on one entry serialize; the row ends confirmed."""
    headers, user_id = await _signup(concurrent_async_client, "recovery_race")
    async with concurrent_session_factory() as session:
        entry_id, note_id = await _seed_pending(session, user_id)
    vault = _DraftVault()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault

    async def _client(_session: AsyncSession, _user_id: int) -> CreekVaultPipelineClient:
        return vault

    async def _destination(_session: AsyncSession, _user_id: int) -> str | None:
        return None

    patched, _swept = await asyncio.gather(
        concurrent_async_client.patch(
            f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
        ),
        resume_voice_draft_retractions(concurrent_session_factory, _client, _destination, now=_T0),
    )

    assert patched.status_code in {HTTPStatus.OK, HTTPStatus.SERVICE_UNAVAILABLE}
    async with concurrent_session_factory() as session:
        row = await _row(session, note_id)
    assert row.state == VoiceDraftRetractionState.CONFIRMED
    assert len(vault.deletes) == 1, "the loser of the race finds nothing left to send"


@pytest.mark.asyncio
async def test_retraction_telemetry_is_content_free(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Every record names only allowlisted keys and carries no prose, URL, or key."""
    headers, user_id = await _signup(async_client, "recovery_telemetry")
    entry_id, _note_id = await _seed_pending(
        db_session,
        user_id,
        state=VoiceDraftRetractionState.MIRROR_INTENT,
        classification=JournalClassification.PERSONAL,
    )
    _second_entry, _second_note = await _seed_pending(db_session, user_id)
    vault = _DraftVault(fail=True)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    caplog.set_level(logging.DEBUG, logger=drafts.__name__)

    failed = await async_client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )
    await _sweep(db_session, vault, _T0)

    assert failed.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    records = [record for record in caplog.records if record.name == drafts.__name__]
    assert records, "the obligation lifecycle must be observable"
    forbidden = (_BODY, _ESSAY, "SENTINEL", "https://", "api_key")
    for record in records:
        extras = set(record.__dict__) - _STANDARD_RECORD_KEYS
        assert extras <= RETRACTION_LOG_EXTRAS, (record.getMessage(), extras)
        rendered = f"{record.getMessage()} {[record.__dict__[key] for key in extras]}"
        assert not any(marker in rendered for marker in forbidden), rendered
    transitions = [r for r in records if r.getMessage() == RETRACTION_TRANSITION_EVENT]
    assert {(r.__dict__["from_state"], r.__dict__["to_state"]) for r in transitions} >= {
        ("mirror_intent", "pending"),
        ("pending", "pending"),
    }
    backlog = [r for r in records if r.getMessage() == RETRACTION_BACKLOG_EVENT]
    assert backlog
    assert isinstance(backlog[0].__dict__["oldest_pending_age_seconds"], int)
    assert backlog[0].__dict__["pending_count"] >= 1


# --- Crash-injection matrix (AC23) -------------------------------------------
# Each boundary between a local commit and a remote call is crashed once; a
# later PATCH or sweep must still drive the obligation to confirmed. The
# "PUT committed, acknowledgement lost" boundary is covered by
# ``test_voice_draft_mirroring.py::test_mirror_intent_is_committed_before_the_put``
# and the journal ingest's by
# ``test_vault_destination_binding.py::test_ingest_ack_lost_still_leaves_a_withdrawal_marker``.


class _CrashError(BaseException):
    """A process death injected at one commit boundary.

    A ``BaseException`` so that, like a real crash, no per-entry fault
    isolation in the sweep can absorb it.
    """


@pytest.mark.asyncio
async def test_crash_after_intent_commit_before_put_is_still_withdrawn(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Intent committed, process dies before the PUT: the Intimate PATCH still retracts it."""
    headers, user_id = await _signup(async_client, "crash_intent_put")
    entry_id, note_id = await _seed_pending(
        db_session,
        user_id,
        state=VoiceDraftRetractionState.MIRROR_INTENT,
        classification=JournalClassification.PERSONAL,
    )
    vault = _DraftVault()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault

    patched = await async_client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )

    assert patched.status_code == HTTPStatus.OK
    assert vault.deletes == [voice_draft_external_id(user_id, note_id)]
    assert (await _row(db_session, note_id)).state == VoiceDraftRetractionState.CONFIRMED


@pytest.mark.asyncio
async def test_crash_after_pending_flip_before_delete_is_resumed(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Pending committed, process dies before the DELETE: the sweep sends it."""
    _headers, user_id = await _signup(async_client, "crash_pending_delete")
    _entry_id, note_id = await _seed_pending(db_session, user_id)
    vault = _DraftVault()

    await _sweep(db_session, vault, _T0)

    assert vault.deletes == [voice_draft_external_id(user_id, note_id)]
    assert (await _row(db_session, note_id)).state == VoiceDraftRetractionState.CONFIRMED


class _CrashAfterDeleteVault(_DraftVault):
    """Delete the slot remotely, then die before the confirmation is committed."""

    def __init__(self) -> None:
        super().__init__()
        self.crash = True

    async def delete_voice_draft(
        self, external_id: str, tier_ceiling: VaultTierCeiling, /
    ) -> VaultVoiceDraftDeleteResult:
        result = await super().delete_voice_draft(external_id, tier_ceiling)
        if self.crash:
            raise _CrashError
        return result


@pytest.mark.asyncio
async def test_crash_after_delete_before_confirm_commit_is_reconciled(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Creek deleted, local confirm lost: the row stays pending and the retry confirms.

    The retry re-sends the DELETE, so it converges only against a vault whose
    DELETE is idempotent for an absent slot -- this double is. Creek today
    answers ``privacy_refused`` there (#3060 escalation 1), which leaves such a
    row honestly pending rather than falsely confirmed.
    """
    _headers, user_id = await _signup(async_client, "crash_delete_confirm")
    _entry_id, note_id = await _seed_pending(db_session, user_id)
    vault = _CrashAfterDeleteVault()
    with pytest.raises(_CrashError):
        await _sweep(db_session, vault, _T0)
    vault.crash = False

    assert (await _row(db_session, note_id)).state == VoiceDraftRetractionState.PENDING

    await _sweep(db_session, vault, _T0 + _INSIDE_BACKOFF)

    assert len(vault.deletes) == _TWO_ATTEMPTS
    assert (await _row(db_session, note_id)).state == VoiceDraftRetractionState.CONFIRMED


@pytest.mark.asyncio
async def test_crash_after_journal_withdraw_before_clear_is_reconciled(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Creek withdrew the entry and the local clear was lost: the retry clears the marker."""
    _headers, user_id = await _signup(async_client, "crash_journal_clear")
    entry = JournalEntry(
        sender="user",
        user_id=user_id,
        message=_BODY,
        classification=JournalClassification.INTIMATE,
        vault_ref="vault-ref-legacy",
    )
    db_session.add(entry)
    await db_session.commit()
    assert entry.id is not None
    vault = _DraftVault()
    real_withdraw = withdraw_module.withdraw_journal_from_vault

    async def _withdraw_then_crash(client: CreekVaultPipelineClient, *, entry_id: int) -> bool:
        await real_withdraw(client, entry_id=entry_id)
        raise _CrashError

    monkeypatch.setattr(withdraw_module, "withdraw_journal_from_vault", _withdraw_then_crash)
    with pytest.raises(_CrashError):
        await _sweep(db_session, vault, _T0)
    monkeypatch.setattr(withdraw_module, "withdraw_journal_from_vault", real_withdraw)
    await db_session.refresh(entry)
    assert entry.vault_ref == "vault-ref-legacy"

    await _sweep(db_session, vault, _T0 + _INSIDE_BACKOFF)

    assert vault.withdrawals == [entry.id, entry.id]
    await db_session.refresh(entry)
    assert entry.vault_ref is None


class _UpsertCountingVault(_DraftVault):
    """Record any PUT that reaches the vault."""

    def __init__(self) -> None:
        super().__init__()
        self.upserts: list[VaultVoiceDraftRequest] = []

    async def upsert_voice_draft(self, request: VaultVoiceDraftRequest, /) -> VaultVoiceDraftResult:
        self.upserts.append(request)
        return VaultVoiceDraftResult(stored=True, vault_ref="r", action=VaultIngestAction.CREATED)


@pytest.mark.asyncio
async def test_stale_mirror_cannot_republish_over_an_owed_withdrawal(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A late mirror finding a pending row is withheld, and the obligation is untouched."""
    _headers, user_id = await _signup(async_client, "stale_mirror")
    entry_id, note_id = await _seed_pending(
        db_session, user_id, classification=JournalClassification.PERSONAL
    )
    vault = _UpsertCountingVault()

    async def _record_intent() -> bool:
        return await record_mirror_intent(
            db_session,
            user_id=user_id,
            entry_id=entry_id,
            marginalia_id=note_id,
            destination=None,
        )

    await mirror_voice_draft(
        vault,
        VoiceDraftCopy(
            owner_user_id=user_id,
            marginalia_id=note_id,
            essay=_ESSAY,
            classification=JournalClassification.PERSONAL,
        ),
        record_intent=_record_intent,
    )

    assert vault.upserts == []
    row = await _row(db_session, note_id)
    assert row.state == VoiceDraftRetractionState.PENDING
    assert row.attempt_count == 0


_DESTINATION_A = "a" * 32
_DESTINATION_B = "b" * 32


@pytest.mark.asyncio
async def test_sweep_never_confirms_against_a_fallback_for_a_bound_vault(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A connected vault that briefly resolves to the local fallback is unavailable, not empty."""
    _headers, user_id = await _signup(async_client, "recovery_fallback_bound")
    _entry_id, note_id = await _seed_pending(db_session, user_id, destination=_DESTINATION_A)

    await _sweep(db_session, LocalFallbackCreekVaultClient(), _T0, destination=_DESTINATION_A)

    row = await _row(db_session, note_id)
    assert row.state == VoiceDraftRetractionState.PENDING
    assert row.safe_failure_code == "vault_unavailable"


@pytest.mark.asyncio
async def test_sweep_never_dials_a_replaced_vault(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A row owed to vault A is never sent to vault B; it backs off as destination_changed."""
    _headers, user_id = await _signup(async_client, "recovery_replaced_vault")
    _entry_id, note_id = await _seed_pending(db_session, user_id, destination=_DESTINATION_A)
    vault = _DraftVault()

    await _sweep(db_session, vault, _T0, destination=_DESTINATION_B)

    assert vault.deletes == []
    row = await _row(db_session, note_id)
    assert row.state == VoiceDraftRetractionState.PENDING
    assert row.safe_failure_code == "destination_changed"
    assert row.next_attempt_at is not None


async def _seed_marked_intimate(session: AsyncSession, user_id: int) -> int:
    entry = JournalEntry(
        sender="user",
        user_id=user_id,
        message=_BODY,
        classification=JournalClassification.INTIMATE,
        vault_ref="vault-ref-legacy",
    )
    session.add(entry)
    await session.commit()
    assert entry.id is not None
    return entry.id


@pytest.mark.asyncio
async def test_sweep_backs_off_a_failing_journal_copy(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A vault refusing the journal withdrawal is retried once per backoff window."""
    _headers, user_id = await _signup(async_client, "recovery_journal_backoff")
    entry_id = await _seed_marked_intimate(db_session, user_id)
    vault = _DraftVault(fail=True)
    schedule = JournalRetrySchedule()

    await _sweep(db_session, vault, _T0, schedule=schedule)
    await _sweep(db_session, vault, _T0 + _INSIDE_BACKOFF, schedule=schedule)

    assert vault.withdrawals == [entry_id]

    await _sweep(db_session, vault, _T0 + _PAST_BACKOFF, schedule=schedule)

    assert vault.withdrawals == [entry_id, entry_id]


class _SelectiveWithdrawVault(_DraftVault):
    """Refuse the journal withdrawal for a fixed set of stuck entries only."""

    def __init__(self, stuck: set[int]) -> None:
        super().__init__()
        self.stuck = stuck

    async def withdraw_journal_entry(self, entry_id: int, /) -> VaultJournalWithdrawResult:
        self.withdrawals.append(entry_id)
        if entry_id in self.stuck:
            raise CreekVaultUnavailableError("synthetic refusal")
        return VaultJournalWithdrawResult(withdrawn=True)


@pytest.mark.asyncio
async def test_backed_off_journal_copies_never_starve_a_healthy_one(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """More stuck entries than one batch cannot hide a later, healthy entry from the sweep."""
    _headers, user_id = await _signup(async_client, "recovery_journal_starve")
    stuck = {await _seed_marked_intimate(db_session, user_id) for _ in range(_STUCK_ENTRIES)}
    healthy = await _seed_marked_intimate(db_session, user_id)
    vault = _SelectiveWithdrawVault(stuck)
    schedule = JournalRetrySchedule()

    await _sweep(db_session, vault, _T0, schedule=schedule)
    await _sweep(db_session, vault, _T0 + _INSIDE_BACKOFF, schedule=schedule)

    assert healthy in vault.withdrawals


@pytest.mark.asyncio
async def test_one_unreadable_account_never_aborts_the_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A resolver fault for one account is logged and skipped; the next account completes."""
    _headers_x, broken_id = await _signup(async_client, "recovery_poison")
    _headers_y, live_id = await _signup(async_client, "recovery_after_poison")
    _broken_entry, broken_note = await _seed_pending(db_session, broken_id)
    _live_entry, live_note = await _seed_pending(db_session, live_id)
    vault = _DraftVault()

    async def _client(_session: AsyncSession, user_id: int) -> CreekVaultPipelineClient:
        if user_id == broken_id:
            raise _UnreadableConfigError
        return vault

    async def _destination(_session: AsyncSession, _user_id: int) -> str | None:
        return None

    await resume_voice_draft_retractions(
        _factory(db_session),
        _client,
        _destination,
        now=_T0,
        journal_retries=JournalRetrySchedule(),
    )

    assert vault.deletes == [voice_draft_external_id(live_id, live_note)]
    broken = await _row(db_session, broken_note)
    assert broken.state == VoiceDraftRetractionState.PENDING
    assert broken.next_attempt_at is not None, "a failing account is backed off, not retried first"


class _UnreadableConfigError(RuntimeError):
    """Stands in for a vault credential that can no longer be decrypted."""


@pytest.mark.asyncio
async def test_a_faulting_account_backs_off_its_journal_copy_too(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A fault defers the journal copy as well, so its entries cannot refill the batch."""
    _headers, broken_id = await _signup(async_client, "recovery_poison_journal")
    broken_entry = await _seed_marked_intimate(db_session, broken_id)
    schedule = JournalRetrySchedule()

    async def _client(_session: AsyncSession, _user_id: int) -> CreekVaultPipelineClient:
        raise _UnreadableConfigError

    async def _destination(_session: AsyncSession, _user_id: int) -> str | None:
        return None

    await resume_voice_draft_retractions(
        _factory(db_session), _client, _destination, now=_T0, journal_retries=schedule
    )

    assert broken_entry in schedule.backed_off(_T0 + _INSIDE_BACKOFF)


@pytest.mark.asyncio
async def test_a_legacy_unbound_row_is_never_confirmed_through_the_fallback(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A pre-migration essay row with no vault connected now is unknown, not withdrawn.

    The row cannot say which vault received the essay, and the local fallback
    dials nothing, so "absent" would be a guess (#3060 escalation 2).
    """
    _headers, user_id = await _signup(async_client, "recovery_legacy_fallback")
    _entry_id, note_id = await _seed_pending(db_session, user_id)

    await _sweep(db_session, LocalFallbackCreekVaultClient(), _T0)

    row = await _row(db_session, note_id)
    assert row.state == VoiceDraftRetractionState.PENDING
    assert row.safe_failure_code == "vault_unavailable"
