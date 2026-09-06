"""Journal integration tests for the optional Creek Voice Draft mirror."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultIngestAction,
    VaultTierCeiling,
    VaultVoiceDraftDeleteResult,
    VaultVoiceDraftRequest,
    VaultVoiceDraftResult,
)
from main import app
from models.journal_entry import JournalClassification, JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_voice_drafts import voice_draft_external_id

_BODY = "I walked by the river and the willow bent without breaking."
_ESSAY = "A warm letter about beginnings."


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
) -> tuple[int, int]:
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
    await session.commit()
    await session.refresh(entry)
    await session.refresh(note)
    assert entry.id is not None
    assert note.id is not None
    return entry.id, note.id


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
    ) -> None:
        super().__init__()
        self.session = session
        self.supported = supported
        self.fail_upsert = fail_upsert
        self.fail_delete = fail_delete
        self.upserts: list[VaultVoiceDraftRequest] = []
        self.deletes: list[tuple[str, VaultTierCeiling]] = []

    async def handshake(self) -> HandshakeResult:
        capabilities = frozenset({CreekCapability.VOICE_DRAFTS}) if self.supported else frozenset()
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="aptitude-wavelength/2026-05-23",
            capabilities=capabilities,
            attestation=None,
        )

    def supports(self, capability: CreekCapability, /) -> bool:
        return self.supported and capability is CreekCapability.VOICE_DRAFTS

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
        if self.fail_delete:
            raise CreekVaultUnavailableError("synthetic draft outage")
        return VaultVoiceDraftDeleteResult(deleted=True)


def _wire_vault(vault: _RecordingDraftVault) -> None:
    app.dependency_overrides[get_creek_vault_client] = lambda: vault


@pytest.mark.asyncio
async def test_new_essay_is_cached_then_mirrored_once(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The local commit lands before one capability-gated mirror attempt."""
    headers, user_id = await _signup(async_client, "draft_mirror")
    _entry_id, note_id = await _seed_note(db_session, user_id)
    llm = _EssayLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", llm)
    vault = _RecordingDraftVault(db_session)
    _wire_vault(vault)

    first = await async_client.post(f"/journal/marginalia/{note_id}/essay", headers=headers)
    second = await async_client.post(f"/journal/marginalia/{note_id}/essay", headers=headers)

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
    )

    assert response.status_code == HTTPStatus.OK
    assert response.json()["essay"] is None
    assert llm.calls == 0
    assert vault.upserts == []


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
    await db_session.commit()
    await db_session.refresh(second_note)
    assert second_note.id is not None
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


@pytest.mark.asyncio
async def test_failed_retraction_never_costs_the_intimate_reclassification(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The privacy PATCH remains committed when the one DELETE attempt fails."""
    headers, user_id = await _signup(async_client, "draft_retract_degrade")
    entry_id, note_id = await _seed_note(db_session, user_id, essay="Existing draft")
    vault = _RecordingDraftVault(db_session, fail_delete=True)
    _wire_vault(vault)

    response = await async_client.patch(
        f"/journal/{entry_id}",
        json={"classification": "intimate"},
        headers=headers,
    )

    assert response.status_code == HTTPStatus.OK
    assert response.json()["classification"] == "intimate"
    assert vault.deletes == [(voice_draft_external_id(user_id, note_id), VaultTierCeiling.PERSONAL)]

    repeated = await async_client.patch(
        f"/journal/{entry_id}",
        json={"classification": "intimate"},
        headers=headers,
    )

    assert repeated.status_code == HTTPStatus.OK
    assert len(vault.deletes) == 1, "a same-value PATCH must not retry a failed retraction"


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

    expansion = asyncio.create_task(
        concurrent_async_client.post(
            f"/journal/marginalia/{note_id}/essay",
            headers=headers,
        )
    )
    await asyncio.wait_for(generation_started.wait(), timeout=2)
    patched = await concurrent_async_client.patch(
        f"/journal/{entry_id}",
        json={"classification": "intimate"},
        headers=headers,
    )
    finish_generation.set()
    expanded = await expansion

    assert patched.status_code == HTTPStatus.OK
    assert expanded.status_code == HTTPStatus.OK
    assert expanded.json()["essay"] == _ESSAY
    assert vault.upserts == []
