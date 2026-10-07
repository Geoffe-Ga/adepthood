"""Journal integration tests for the optional Creek Voice Draft mirror."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
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
from models.voice_draft_retraction import VoiceDraftRetraction, VoiceDraftRetractionState
from services import marginalia as marginalia_service
from services.account_egress_barrier import account_egress_barrier
from services.botmason import STUB_MODEL_NAME, STUB_PROSE_PREFIX, LLMResponse
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_voice_drafts import voice_draft_external_id
from tests.support.barrier_arrivals import BARRIER_ARRIVAL_TIMEOUT_SECONDS, BarrierArrivals

# A server-paid first letter must say the writer saw its price (#623); without
# it the route answers 409 before it charges or dials anything.
_ESSAY_ASK = {"price_acknowledged": True}

_BODY = "I walked by the river and the willow bent without breaking."
_ESSAY = "A warm letter about beginnings."

#: DELETE count after one failed attempt and one successful retry.
_FAILED_THEN_RETRIED = 2
_JOURNAL_REF = "vault-fragment-1"

#: How long a competing mutation is given to overtake a dial that is being held
#: open, *once it is provably at the barrier*. Long enough that a request which
#: *can* proceed will have, short enough that four of these do not lengthen the
#: suite noticeably.
_SERIALIZATION_PROBE_SECONDS = 0.05


async def _waited_behind_the_held_dial(
    arrivals: BarrierArrivals, actor: str, competitor: asyncio.Task[object]
) -> bool:
    """Whether ``competitor`` queued on the account barrier and stayed behind the dial.

    Waits for the competitor to *reach* the barrier before probing, rather than
    inferring it from a short timeout: on a slow runner a request still in
    authentication also fails to finish within the probe, and releasing the
    dial then lets the holder's next critical section go first for a reason
    the product is right about (#2986). A competitor that never reaches the
    barrier within the bound is, by definition, not serialized behind it.
    """
    if not await arrivals.arrived(actor, within_seconds=BARRIER_ARRIVAL_TIMEOUT_SECONDS):
        return False
    try:
        await asyncio.wait_for(asyncio.shield(competitor), timeout=_SERIALIZATION_PROBE_SECONDS)
    except TimeoutError:
        return True
    return False


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    response = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert response.status_code == HTTPStatus.OK
    payload = response.json()
    return {"Authorization": f"Bearer {payload['token']}"}, int(payload["user_id"])


async def _seed_note(
    session: AsyncSession,
    user_id: int,
    *,
    classification: JournalClassification = JournalClassification.PERSONAL,
    essay: str | None = None,
    mirrored: bool = True,
) -> tuple[int, int]:
    """Seed one entry and note; a seeded essay is recorded as offered to a vault.

    ``mirrored`` writes the ``mirror_intent`` row the essay route writes before
    its PUT, so a seeded essay behaves like one the vault may hold.
    """
    entry = JournalEntry(
        sender="user",
        user_id=user_id,
        message=_BODY,
        classification=classification,
    )
    session.add(entry)
    await session.flush()
    note = Marginalia(
        journal_entry_id=entry.id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=6,
        anchor_text="I walk",
        note="A beginning.",
    )
    if essay is not None:
        note.essay = essay
        note.essay_generated_at = datetime.now(UTC)
    session.add(note)
    await session.flush()
    assert entry.id is not None
    assert note.id is not None
    if essay is not None and mirrored:
        _record_mirror_intent(session, user_id, entry.id, note.id)
    await session.commit()
    await session.refresh(entry)
    await session.refresh(note)
    return entry.id, note.id


def _record_mirror_intent(session: AsyncSession, user_id: int, entry_id: int, note_id: int) -> None:
    """Stage the content-free row a real mirror commits before its PUT."""
    session.add(
        VoiceDraftRetraction(
            user_id=user_id,
            journal_entry_id=entry_id,
            marginalia_id=note_id,
        )
    )


async def _mark_ingested(session: AsyncSession, entry_id: int) -> None:
    """Give an entry the durable marker a successful journal ingest leaves."""
    entry = await session.get(JournalEntry, entry_id)
    assert entry is not None
    entry.vault_ref = _JOURNAL_REF
    session.add(entry)
    await session.commit()


async def _obligation(session: AsyncSession, note_id: int) -> VoiceDraftRetraction | None:
    """Read one note's obligation row fresh from the database."""
    result = await session.execute(
        select(VoiceDraftRetraction)
        .where(col(VoiceDraftRetraction.marginalia_id) == note_id)
        .execution_options(populate_existing=True)
    )
    row = result.scalars().first()
    await session.commit()
    return row


class _EssayLLM:
    """Return one fixed essay and count generation calls."""

    def __init__(self) -> None:
        self.calls = 0

    async def __call__(
        self, prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        self.calls += 1
        return LLMResponse(
            text=_ESSAY,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )


class _RecordingDraftVault(LocalFallbackCreekVaultClient):
    """A connected Voice Draft-only vault that records PUTs and DELETEs."""

    def __init__(
        self,
        session: AsyncSession | None,
        *,
        supported: bool = True,
        fail_upsert: bool = False,
        fail_delete: bool = False,
        journal_withdraw: bool = False,
    ) -> None:
        super().__init__()
        self.session = session
        self.supported = supported
        self.fail_upsert = fail_upsert
        self.fail_delete = fail_delete
        self.journal_withdraw = journal_withdraw
        self.fail_withdraw = False
        #: External ids whose DELETE fails while the rest succeed.
        self.fail_delete_for: set[str] = set()
        #: Answer a DELETE for a slot this vault never stored the way Creek does
        #: today: ``privacy_refused``, which the adapter raises as a vault error.
        self.refuse_missing = False
        self.upserts: list[VaultVoiceDraftRequest] = []
        self.deletes: list[tuple[str, VaultTierCeiling]] = []
        self.withdrawals: list[int] = []

    def _capabilities(self) -> frozenset[CreekCapability]:
        capabilities = {CreekCapability.VOICE_DRAFTS} if self.supported else set()
        if self.journal_withdraw:
            capabilities.add(CreekCapability.JOURNAL_WITHDRAW)
        return frozenset(capabilities)

    async def handshake(self) -> HandshakeResult:
        capabilities = self._capabilities()
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="aptitude-wavelength/2026-05-23",
            capabilities=capabilities,
            attestation=None,
        )

    def supports(self, capability: CreekCapability, /) -> bool:
        return capability in self._capabilities()

    async def withdraw_journal_entry(self, entry_id: int, /) -> VaultJournalWithdrawResult:
        if self.session is not None:
            assert not self.session.in_transaction(), "withdraw held a pooled DB connection"
        self.withdrawals.append(entry_id)
        if self.fail_withdraw:
            raise CreekVaultUnavailableError("synthetic withdraw outage")
        return VaultJournalWithdrawResult(withdrawn=True)

    async def upsert_voice_draft(self, request: VaultVoiceDraftRequest, /) -> VaultVoiceDraftResult:
        if self.session is not None:
            assert not self.session.in_transaction(), "draft PUT held a pooled DB connection"
        self.upserts.append(request)
        if self.fail_upsert:
            raise CreekVaultUnavailableError("synthetic draft outage")
        return VaultVoiceDraftResult(
            stored=True,
            vault_ref="voice-draft-fragment-1",
            action=VaultIngestAction.CREATED,
        )

    async def delete_voice_draft(
        self, external_id: str, tier_ceiling: VaultTierCeiling, /
    ) -> VaultVoiceDraftDeleteResult:
        if self.session is not None:
            assert not self.session.in_transaction(), "draft DELETE held a pooled DB connection"
        self.deletes.append((external_id, tier_ceiling))
        if self.fail_delete or external_id in self.fail_delete_for:
            raise CreekVaultUnavailableError("synthetic draft outage")
        stored = {request.external_id for request in self.upserts}
        if self.refuse_missing and external_id not in stored:
            raise CreekVaultUnavailableError("synthetic privacy_refused for a missing slot")
        return VaultVoiceDraftDeleteResult(deleted=True)


class _BlockingDraftVault(_RecordingDraftVault):
    """Pause a draft PUT so a competing privacy PATCH can reach the race window."""

    def __init__(self) -> None:
        super().__init__(None)
        self.upsert_started = asyncio.Event()
        self.finish_upsert = asyncio.Event()
        self.operations: list[str] = []

    async def upsert_voice_draft(self, request: VaultVoiceDraftRequest, /) -> VaultVoiceDraftResult:
        self.upsert_started.set()
        await self.finish_upsert.wait()
        result = await super().upsert_voice_draft(request)
        self.operations.append("put")
        return result

    async def delete_voice_draft(
        self, external_id: str, tier_ceiling: VaultTierCeiling, /
    ) -> VaultVoiceDraftDeleteResult:
        result = await super().delete_voice_draft(external_id, tier_ceiling)
        self.operations.append("delete")
        return result


def _wire_vault(vault: _RecordingDraftVault) -> None:
    app.dependency_overrides[get_creek_vault_client] = lambda: vault


@pytest.mark.asyncio
async def test_new_essay_is_cached_then_mirrored_once(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The essay commits before one serialized, capability-gated mirror attempt."""
    headers, user_id = await _signup(async_client, "draft_mirror")
    _entry_id, note_id = await _seed_note(db_session, user_id)
    llm = _EssayLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", llm)
    vault = _RecordingDraftVault(db_session)
    _wire_vault(vault)

    first = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json=_ESSAY_ASK
    )
    second = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json=_ESSAY_ASK
    )

    assert first.status_code == HTTPStatus.OK
    assert second.status_code == HTTPStatus.OK
    assert first.json()["essay"] == second.json()["essay"] == _ESSAY
    assert llm.calls == 1
    assert len(vault.upserts) == 1
    mirrored = vault.upserts[0]
    assert mirrored.external_id == voice_draft_external_id(user_id, note_id)
    assert mirrored.content == _ESSAY
    assert mirrored.tier is VaultTierCeiling.PERSONAL


@pytest.mark.parametrize(
    ("supported", "fail_upsert"),
    [(False, False), (True, True)],
    ids=["unsupported", "unavailable_during_put"],
)
@pytest.mark.asyncio
async def test_mirror_degradation_never_costs_the_cached_essay(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    *,
    supported: bool,
    fail_upsert: bool,
) -> None:
    """Unsupported and failed mirrors both return the committed local draft."""
    headers, user_id = await _signup(async_client, f"draft_degrade_{supported}_{fail_upsert}")
    _entry_id, note_id = await _seed_note(db_session, user_id)
    monkeypatch.setattr(marginalia_service, "generate_response", _EssayLLM())
    vault = _RecordingDraftVault(
        db_session,
        supported=supported,
        fail_upsert=fail_upsert,
    )
    _wire_vault(vault)

    response = await async_client.post(
        f"/journal/marginalia/{note_id}/essay",
        headers=headers,
        json=_ESSAY_ASK,
    )

    assert response.status_code == HTTPStatus.OK
    assert response.json()["essay"] == _ESSAY
    persisted = await db_session.get(Marginalia, note_id)
    assert persisted is not None
    assert persisted.essay == _ESSAY
    assert len(vault.upserts) == int(supported)


@pytest.mark.asyncio
async def test_intimate_essay_never_attempts_a_mirror(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The existing intimate generation guard also leaves the vault untouched."""
    headers, user_id = await _signup(async_client, "draft_intimate")
    _entry_id, note_id = await _seed_note(
        db_session,
        user_id,
        classification=JournalClassification.INTIMATE,
    )
    llm = _EssayLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", llm)
    vault = _RecordingDraftVault(db_session)
    _wire_vault(vault)

    response = await async_client.post(
        f"/journal/marginalia/{note_id}/essay",
        headers=headers,
        json=_ESSAY_ASK,
    )

    assert response.status_code == HTTPStatus.OK
    assert response.json()["essay"] is None
    assert llm.calls == 0
    assert vault.upserts == []


class _EchoingLLM:
    """Answer every prompt with that prompt, the way the stub provider used to."""

    async def __call__(
        self, prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del history, system_prompt, api_key
        return LLMResponse(
            text=f'{STUB_PROSE_PREFIX} "{prompt}"',
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )


@pytest.mark.asyncio
async def test_a_refused_essay_never_reaches_the_vault(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A completion refused as a prompt echo is not a draft, so it is not mirrored.

    The local row keeps ``essay IS NULL``, and the mirror is the second place
    that text would have come to rest -- in the writer's own vault, attributed
    to the app, feeding the corpus that later speaks in their voice (#2762).
    """
    headers, user_id = await _signup(async_client, "draft_refused")
    _entry_id, note_id = await _seed_note(db_session, user_id)
    monkeypatch.setattr(marginalia_service, "generate_response", _EchoingLLM())
    vault = _RecordingDraftVault(db_session)
    _wire_vault(vault)

    response = await async_client.post(
        f"/journal/marginalia/{note_id}/essay",
        headers=headers,
        json=_ESSAY_ASK,
    )

    assert response.status_code == HTTPStatus.OK, response.text
    assert response.json()["essay"] is None
    assert vault.upserts == []
    persisted = await db_session.get(Marginalia, note_id)
    assert persisted is not None
    await db_session.refresh(persisted)
    assert persisted.essay is None


@pytest.mark.asyncio
async def test_reclassifying_an_entry_intimate_retracts_each_existing_draft(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Every already-mirrored essay gets a content-free DELETE after the PATCH commits."""
    headers, user_id = await _signup(async_client, "draft_retract")
    entry_id, first_note_id = await _seed_note(db_session, user_id, essay="First draft")
    second_note = Marginalia(
        journal_entry_id=entry_id,
        user_id=user_id,
        kind=MarginaliaKind.THEME,
        anchor_start=7,
        anchor_end=12,
        anchor_text="river",
        note="A current.",
        essay="Second draft",
    )
    second_note.essay_generated_at = datetime.now(UTC)
    db_session.add(second_note)
    await db_session.flush()
    assert second_note.id is not None
    _record_mirror_intent(db_session, user_id, entry_id, second_note.id)
    await db_session.commit()
    await db_session.refresh(second_note)
    vault = _RecordingDraftVault(db_session)
    _wire_vault(vault)

    response = await async_client.patch(
        f"/journal/{entry_id}",
        json={"classification": "intimate"},
        headers=headers,
    )

    assert response.status_code == HTTPStatus.OK
    assert response.json()["classification"] == "intimate"
    assert set(vault.deletes) == {
        (voice_draft_external_id(user_id, first_note_id), VaultTierCeiling.PERSONAL),
        (voice_draft_external_id(user_id, second_note.id), VaultTierCeiling.PERSONAL),
    }
    assert vault.upserts == []


async def _patch_intimate(client: AsyncClient, entry_id: int, headers: dict[str, str]) -> Response:
    """Ask for the Intimate tier on one entry."""
    return await client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )


@pytest.mark.asyncio
async def test_failed_retraction_keeps_intimate_and_reports_pending(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A failed DELETE keeps the stricter tier, answers 503, and leaves a durable obligation."""
    headers, user_id = await _signup(async_client, "draft_retract_degrade")
    entry_id, note_id = await _seed_note(db_session, user_id, essay="Existing draft")
    vault = _RecordingDraftVault(db_session, fail_delete=True)
    _wire_vault(vault)

    response = await _patch_intimate(async_client, entry_id, headers)

    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json() == {"detail": "vault_withdrawal_pending"}
    persisted = await db_session.get(JournalEntry, entry_id)
    assert persisted is not None
    await db_session.refresh(persisted)
    assert persisted.classification == JournalClassification.INTIMATE
    assert vault.deletes == [(voice_draft_external_id(user_id, note_id), VaultTierCeiling.PERSONAL)]
    obligation = await _obligation(db_session, note_id)
    assert obligation is not None
    assert obligation.state == VoiceDraftRetractionState.PENDING
    assert obligation.attempt_count == 1
    assert obligation.safe_failure_code == "vault_error"


@pytest.mark.asyncio
async def test_repeated_intimate_patch_retries_then_stops(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A same-value Intimate PATCH retries the owed DELETE, then is idempotent once confirmed."""
    headers, user_id = await _signup(async_client, "draft_retract_retry")
    entry_id, note_id = await _seed_note(db_session, user_id, essay="Existing draft")
    vault = _RecordingDraftVault(db_session, fail_delete=True)
    _wire_vault(vault)
    failed = await _patch_intimate(async_client, entry_id, headers)
    assert failed.status_code == HTTPStatus.SERVICE_UNAVAILABLE

    vault.fail_delete = False
    retried = await _patch_intimate(async_client, entry_id, headers)

    assert retried.status_code == HTTPStatus.OK
    assert retried.json()["classification"] == "intimate"
    assert len(vault.deletes) == _FAILED_THEN_RETRIED
    obligation = await _obligation(db_session, note_id)
    assert obligation is not None
    assert obligation.state == VoiceDraftRetractionState.CONFIRMED
    assert obligation.confirmed_at is not None

    again = await _patch_intimate(async_client, entry_id, headers)

    assert again.status_code == HTTPStatus.OK
    assert len(vault.deletes) == _FAILED_THEN_RETRIED, "a confirmed withdrawal is never re-sent"


@pytest.mark.asyncio
async def test_one_failed_note_keeps_the_entry_pending_and_retries_only_it(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Among several notes, one failure keeps the whole PATCH pending; the retry covers only it."""
    headers, user_id = await _signup(async_client, "draft_retract_partial")
    entry_id, first_id = await _seed_note(db_session, user_id, essay="First draft")
    second = Marginalia(
        journal_entry_id=entry_id,
        user_id=user_id,
        kind=MarginaliaKind.THEME,
        anchor_start=7,
        anchor_end=12,
        anchor_text="river",
        note="A current.",
        essay="Second draft",
        essay_generated_at=datetime.now(UTC),
    )
    db_session.add(second)
    await db_session.flush()
    assert second.id is not None
    second_id = second.id
    _record_mirror_intent(db_session, user_id, entry_id, second_id)
    await db_session.commit()
    vault = _RecordingDraftVault(db_session)
    failing = voice_draft_external_id(user_id, first_id)
    vault.fail_delete_for = {failing}
    _wire_vault(vault)

    failed = await _patch_intimate(async_client, entry_id, headers)

    assert failed.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    first_attempts = len(vault.deletes)
    vault.fail_delete_for = set()
    retried = await _patch_intimate(async_client, entry_id, headers)

    assert retried.status_code == HTTPStatus.OK
    assert vault.deletes[first_attempts:] == [(failing, VaultTierCeiling.PERSONAL)]
    for note_id in (first_id, second_id):
        obligation = await _obligation(db_session, note_id)
        assert obligation is not None
        assert obligation.state == VoiceDraftRetractionState.CONFIRMED


@pytest.mark.asyncio
async def test_journal_withdraw_failure_still_attempts_essay_retraction(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A failing journal withdrawal never short-circuits the essay retraction."""
    headers, user_id = await _signup(async_client, "draft_journal_fails")
    entry_id, note_id = await _seed_note(db_session, user_id, essay="Existing draft")
    await _mark_ingested(db_session, entry_id)
    vault = _RecordingDraftVault(db_session, journal_withdraw=True)
    vault.fail_withdraw = True
    _wire_vault(vault)

    response = await _patch_intimate(async_client, entry_id, headers)

    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json() == {"detail": "vault_withdrawal_pending"}
    assert vault.withdrawals == [entry_id]
    assert vault.deletes == [(voice_draft_external_id(user_id, note_id), VaultTierCeiling.PERSONAL)]
    persisted = await db_session.get(JournalEntry, entry_id)
    assert persisted is not None
    await db_session.refresh(persisted)
    assert persisted.classification == JournalClassification.INTIMATE
    assert persisted.vault_ref == _JOURNAL_REF


@pytest.mark.asyncio
async def test_essay_failure_still_attempts_journal_withdrawal(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A failing essay retraction never short-circuits the journal withdrawal."""
    headers, user_id = await _signup(async_client, "draft_essay_fails")
    entry_id, _note_id = await _seed_note(db_session, user_id, essay="Existing draft")
    await _mark_ingested(db_session, entry_id)
    vault = _RecordingDraftVault(db_session, fail_delete=True, journal_withdraw=True)
    _wire_vault(vault)

    response = await _patch_intimate(async_client, entry_id, headers)

    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert vault.withdrawals == [entry_id]
    persisted = await db_session.get(JournalEntry, entry_id)
    assert persisted is not None
    await db_session.refresh(persisted)
    assert persisted.classification == JournalClassification.INTIMATE
    assert persisted.vault_ref is None


@pytest.mark.asyncio
async def test_never_mirrored_essay_needs_no_retraction(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An essay cached while no vault took drafts never makes journal DELETE 503 forever."""
    headers, user_id = await _signup(async_client, "draft_never_mirrored")
    entry_id, note_id = await _seed_note(db_session, user_id)
    monkeypatch.setattr(marginalia_service, "generate_response", _EssayLLM())
    vault = _RecordingDraftVault(db_session, supported=False)
    _wire_vault(vault)
    expanded = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json=_ESSAY_ASK
    )
    assert expanded.status_code == HTTPStatus.OK
    assert expanded.json()["essay"] == _ESSAY
    assert await _obligation(db_session, note_id) is None

    vault.supported = True
    vault.refuse_missing = True
    deleted = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert deleted.status_code == HTTPStatus.NO_CONTENT
    assert vault.deletes == []


@pytest.mark.asyncio
async def test_mirror_intent_is_committed_before_the_put(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The PUT sees a committed intent row, so a failed or lost PUT is still retracted later."""
    headers, user_id = await _signup(async_client, "draft_intent_first")
    entry_id, note_id = await _seed_note(db_session, user_id)
    monkeypatch.setattr(marginalia_service, "generate_response", _EssayLLM())
    seen_at_put: list[str | None] = []

    class _IntentProbeVault(_RecordingDraftVault):
        async def upsert_voice_draft(
            self, request: VaultVoiceDraftRequest, /
        ) -> VaultVoiceDraftResult:
            row = await _obligation(db_session, note_id)
            seen_at_put.append(None if row is None else row.state)
            return await super().upsert_voice_draft(request)

    vault = _IntentProbeVault(db_session, fail_upsert=True)
    _wire_vault(vault)
    expanded = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json=_ESSAY_ASK
    )
    assert expanded.status_code == HTTPStatus.OK

    assert seen_at_put == [VoiceDraftRetractionState.MIRROR_INTENT]
    patched = await _patch_intimate(async_client, entry_id, headers)

    assert patched.status_code == HTTPStatus.OK
    assert vault.deletes == [(voice_draft_external_id(user_id, note_id), VaultTierCeiling.PERSONAL)]


@pytest.mark.asyncio
async def test_failed_voice_draft_retraction_keeps_journal_delete_retryable(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """DELETE stays pending and visible until Creek confirms the draft is absent."""
    headers, user_id = await _signup(async_client, "draft_delete_retry")
    entry_id, note_id = await _seed_note(db_session, user_id, essay="Existing draft")
    vault = _RecordingDraftVault(db_session, fail_delete=True)
    _wire_vault(vault)

    failed = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert failed.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert failed.json() == {"detail": "vault_withdrawal_pending"}
    visible = await async_client.get(f"/journal/{entry_id}", headers=headers)
    assert visible.status_code == HTTPStatus.OK
    persisted = await db_session.get(JournalEntry, entry_id)
    assert persisted is not None
    await db_session.refresh(persisted)
    assert persisted.deleted_at is None

    vault.fail_delete = False
    retried = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert retried.status_code == HTTPStatus.NO_CONTENT
    assert vault.deletes == [
        (voice_draft_external_id(user_id, note_id), VaultTierCeiling.PERSONAL),
        (voice_draft_external_id(user_id, note_id), VaultTierCeiling.PERSONAL),
    ]
    gone = await async_client.get(f"/journal/{entry_id}", headers=headers)
    assert gone.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_missing_connected_voice_draft_capability_keeps_journal_delete_retryable(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Capability withdrawal is not proof that an earlier mirrored draft is absent."""
    headers, user_id = await _signup(async_client, "draft_delete_capability_downgrade")
    entry_id, note_id = await _seed_note(db_session, user_id, essay="Previously mirrored draft")
    vault = _RecordingDraftVault(db_session, supported=False)
    _wire_vault(vault)

    failed = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert failed.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert failed.json() == {"detail": "vault_withdrawal_pending"}
    assert vault.deletes == []
    visible = await async_client.get(f"/journal/{entry_id}", headers=headers)
    assert visible.status_code == HTTPStatus.OK
    persisted = await db_session.get(JournalEntry, entry_id)
    assert persisted is not None
    await db_session.refresh(persisted)
    assert persisted.deleted_at is None

    vault.supported = True
    retried = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert retried.status_code == HTTPStatus.NO_CONTENT
    assert vault.deletes == [
        (voice_draft_external_id(user_id, note_id), VaultTierCeiling.PERSONAL),
    ]
    gone = await async_client.get(f"/journal/{entry_id}", headers=headers)
    assert gone.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
@pytest.mark.integration
async def test_intimate_patch_during_generation_prevents_the_later_mirror(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The tier is re-read after a slow LLM, closing the stale-entry privacy race."""
    headers, user_id = await _signup(concurrent_async_client, "draft_race")
    async with concurrent_session_factory() as session:
        entry_id, note_id = await _seed_note(session, user_id)

    generation_started = asyncio.Event()
    finish_generation = asyncio.Event()

    async def _slow_essay(
        prompt: str,
        history: object,
        *,
        system_prompt: object,
        api_key: object,
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        generation_started.set()
        await finish_generation.wait()
        return LLMResponse(
            text=_ESSAY,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _slow_essay)
    vault = _RecordingDraftVault(None)
    _wire_vault(vault)

    arrivals = BarrierArrivals.install(monkeypatch, account_egress_barrier)
    expansion = asyncio.create_task(
        concurrent_async_client.post(
            f"/journal/marginalia/{note_id}/essay",
            headers=headers,
            json=_ESSAY_ASK,
        )
    )
    await asyncio.wait_for(generation_started.wait(), timeout=2)
    patch = arrivals.start(
        "patch",
        concurrent_async_client.patch(
            f"/journal/{entry_id}",
            json={"classification": "intimate"},
            headers=headers,
        ),
    )

    # The account egress barrier (#2642) orders the *generation* dial, which
    # carries this entry's body and every prior letter to a cloud model, against
    # this account's own erasure. A privacy PATCH takes the same barrier, so it
    # can no longer land in the middle of the dial -- it lands immediately after
    # it, ahead of the mirror, because the barrier is released between the two
    # dials and its waiters are served in order. The property this test exists
    # for is unchanged and now holds by ordering rather than by luck: the entry
    # is INTIMATE before the mirror reads it, so nothing is ever sent.
    try:
        patch_was_serialized = await _waited_behind_the_held_dial(arrivals, "patch", patch)
    finally:
        finish_generation.set()

    expanded = await expansion
    patched = await patch

    assert patch_was_serialized, "the privacy PATCH did not queue behind the in-flight generation"
    assert patched.status_code == HTTPStatus.OK
    assert expanded.status_code == HTTPStatus.OK
    assert expanded.json()["essay"] == _ESSAY
    assert vault.upserts == []
    async with concurrent_session_factory() as session:
        assert await _obligation(session, note_id) is None, "a withheld mirror owes nothing"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_intimate_patch_waits_for_an_in_flight_mirror_then_retracts_it(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A privacy PATCH cannot delete-before-PUT and leave a late draft resident."""
    headers, user_id = await _signup(concurrent_async_client, "draft_reverse_race")
    async with concurrent_session_factory() as session:
        entry_id, note_id = await _seed_note(session, user_id)

    monkeypatch.setattr(marginalia_service, "generate_response", _EssayLLM())
    vault = _BlockingDraftVault()
    _wire_vault(vault)

    arrivals = BarrierArrivals.install(monkeypatch, account_egress_barrier)
    expansion = asyncio.create_task(
        concurrent_async_client.post(
            f"/journal/marginalia/{note_id}/essay",
            headers=headers,
            json=_ESSAY_ASK,
        )
    )
    await asyncio.wait_for(vault.upsert_started.wait(), timeout=2)
    patch = arrivals.start(
        "patch",
        concurrent_async_client.patch(
            f"/journal/{entry_id}",
            json={"classification": "intimate"},
            headers=headers,
        ),
    )

    try:
        patch_was_serialized = await _waited_behind_the_held_dial(arrivals, "patch", patch)
    finally:
        vault.finish_upsert.set()

    expanded = await expansion
    patched = await patch

    assert patch_was_serialized, "the privacy PATCH did not queue behind the in-flight PUT"
    assert expanded.status_code == HTTPStatus.OK
    assert patched.status_code == HTTPStatus.OK
    assert patched.json()["classification"] == "intimate"
    assert vault.operations == ["put", "delete"]
    assert vault.deletes == [(voice_draft_external_id(user_id, note_id), VaultTierCeiling.PERSONAL)]
    async with concurrent_session_factory() as session:
        obligation = await _obligation(session, note_id)
    assert obligation is not None
    assert obligation.state == VoiceDraftRetractionState.CONFIRMED


@pytest.mark.asyncio
@pytest.mark.integration
async def test_delete_during_generation_prevents_the_later_mirror(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A completed DELETE makes a delayed Voice Draft generation ineligible to mirror."""
    headers, user_id = await _signup(concurrent_async_client, "draft_delete_generation_race")
    async with concurrent_session_factory() as session:
        entry_id, note_id = await _seed_note(session, user_id)

    generation_started = asyncio.Event()
    finish_generation = asyncio.Event()

    async def _slow_essay(
        prompt: str,
        history: object,
        *,
        system_prompt: object,
        api_key: object,
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        generation_started.set()
        await finish_generation.wait()
        return LLMResponse(
            text=_ESSAY,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _slow_essay)
    vault = _RecordingDraftVault(None)
    _wire_vault(vault)

    arrivals = BarrierArrivals.install(monkeypatch, account_egress_barrier)
    expansion = asyncio.create_task(
        concurrent_async_client.post(
            f"/journal/marginalia/{note_id}/essay",
            headers=headers,
            json=_ESSAY_ASK,
        )
    )
    await asyncio.wait_for(generation_started.wait(), timeout=2)
    deletion = arrivals.start(
        "deletion",
        concurrent_async_client.delete(
            f"/journal/{entry_id}",
            headers=headers,
        ),
    )

    # Serialized behind the generation dial for the same reason the privacy
    # PATCH above is, and with the same consequence: the withdrawal completes
    # between the two dials, so the mirror reads a deleted row and sends nothing.
    try:
        delete_was_serialized = await _waited_behind_the_held_dial(arrivals, "deletion", deletion)
    finally:
        finish_generation.set()

    expanded = await expansion
    deleted = await deletion

    assert delete_was_serialized, "the DELETE did not queue behind the in-flight generation"
    assert deleted.status_code == HTTPStatus.NO_CONTENT
    assert expanded.status_code == HTTPStatus.OK
    assert vault.upserts == []
    async with concurrent_session_factory() as session:
        assert await _obligation(session, note_id) is None, "a withheld mirror owes nothing"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_delete_waits_for_an_in_flight_mirror_then_retracts_it(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """DELETE cannot return while a Voice Draft PUT can still remain in Creek."""
    headers, user_id = await _signup(concurrent_async_client, "draft_delete_mirror_race")
    async with concurrent_session_factory() as session:
        entry_id, note_id = await _seed_note(session, user_id)

    monkeypatch.setattr(marginalia_service, "generate_response", _EssayLLM())
    vault = _BlockingDraftVault()
    _wire_vault(vault)

    arrivals = BarrierArrivals.install(monkeypatch, account_egress_barrier)
    expansion = asyncio.create_task(
        concurrent_async_client.post(
            f"/journal/marginalia/{note_id}/essay",
            headers=headers,
            json=_ESSAY_ASK,
        )
    )
    await asyncio.wait_for(vault.upsert_started.wait(), timeout=2)
    deletion = arrivals.start(
        "deletion",
        concurrent_async_client.delete(
            f"/journal/{entry_id}",
            headers=headers,
        ),
    )

    try:
        delete_was_serialized = await _waited_behind_the_held_dial(arrivals, "deletion", deletion)
    finally:
        vault.finish_upsert.set()

    expanded = await expansion
    deleted = await deletion

    assert delete_was_serialized, "DELETE did not queue behind the in-flight Voice Draft PUT"
    assert expanded.status_code == HTTPStatus.OK
    assert deleted.status_code == HTTPStatus.NO_CONTENT
    assert vault.operations == ["put", "delete"]
    assert vault.deletes == [(voice_draft_external_id(user_id, note_id), VaultTierCeiling.PERSONAL)]
    async with concurrent_session_factory() as session:
        obligation = await _obligation(session, note_id)
    assert obligation is not None
    assert obligation.state == VoiceDraftRetractionState.CONFIRMED


@pytest.mark.asyncio
async def test_message_edit_on_an_intimate_entry_never_waits_on_owed_withdrawals(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Only choosing Intimate (or deleting) retries owed withdrawals; an edit saves and returns.

    A legacy Intimate essay whose withdrawal can never confirm (#3060 escalation
    1) must not turn every autosave and Finish into a 503; the sweep keeps
    retrying it in the background.
    """
    headers, user_id = await _signup(async_client, "draft_intimate_edit")
    entry_id, note_id = await _seed_note(
        db_session,
        user_id,
        classification=JournalClassification.INTIMATE,
        essay="Legacy draft",
    )
    obligation = await _obligation(db_session, note_id)
    assert obligation is not None
    obligation.state = VoiceDraftRetractionState.PENDING
    db_session.add(obligation)
    await db_session.commit()
    vault = _RecordingDraftVault(db_session, fail_delete=True)
    _wire_vault(vault)

    edited = await async_client.patch(
        f"/journal/{entry_id}", json={"message": "An edited page."}, headers=headers
    )

    assert edited.status_code == HTTPStatus.OK
    assert vault.deletes == []
    still_owed = await _obligation(db_session, note_id)
    assert still_owed is not None
    assert still_owed.state == VoiceDraftRetractionState.PENDING
