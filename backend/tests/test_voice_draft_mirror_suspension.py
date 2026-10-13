"""A Voice Draft mirror the vault-send switch refuses records nothing (#3122).

The essay mirror commits a content-free retraction intent before its PUT, so a
crash or a lost acknowledgement still leaves the withdrawal it would owe on
record. When ``PRIVACY_SUSPEND_VAULT_SEND`` refuses that PUT before the wire,
though, nothing was offered: keeping the intent would set the background sweep
retracting a draft the vault never received, and a ``VOICE_DRAFT_MIRROR`` shadow
would tell the operator lineage log about a mirror that never happened. This is
the essay-side twin of what #3107 did for journal writes:

* a mirror refused by :class:`VaultSendSuspendedError` is its own outcome, and it
  leaves neither record behind -- the staged intent is dropped, or restored to
  what it was before this attempt staged it;
* a mirror that was dialled and failed (a 5xx, or an acknowledgement lost in
  transit) keeps both, because the draft may now be in the vault;
* once the switch is lifted, the next mirror records exactly one of each.

Driven through the real HTTP adapter, whose single request site is where the
switch refuses (#3075).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from http import HTTPStatus
from typing import Final

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    HandshakeResult,
    VaultSendSuspendedError,
    VaultVoiceDraftRequest,
    VaultVoiceDraftResult,
)
from main import app
from models.journal_entry import JournalClassification
from models.marginalia import Marginalia, MarginaliaKind
from models.voice_draft_retraction import VoiceDraftRetraction, VoiceDraftRetractionState
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_voice_drafts import (
    MirrorOutcome,
    VoiceDraftCopy,
    mirror_recorded_voice_draft,
)
from services.privacy_lineage import LINEAGE_SHADOW_EVENT, LineageOperation
from services.privacy_suspension import VAULT_SEND_SUSPEND_ENV_VAR
from tests.incident.test_privacy_suspension import (
    _VaultRecorder,
    handshaken_vault,
    suspend_vault,
)
from tests.support.lineage_canaries import seed_folded_lineage

_ESSAY: Final = "A warm letter about beginnings."
_ESSAY_ASK: Final = {"price_acknowledged": True}
_MIRROR: Final = LineageOperation.VOICE_DRAFT_MIRROR.value
_DESTINATION: Final = "d" * 32
_EARLIER: Final = datetime(2026, 8, 8, 9, 30, tzinfo=UTC)
_EARLIER_ATTEMPTS: Final = 3


class _EssayLLM:
    """Answer every essay ask with one fixed letter."""

    async def __call__(
        self, prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        return LLMResponse(
            text=_ESSAY,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )


class _FailingPutRecorder(_VaultRecorder):
    """A Creek fake whose draft PUT is received and then fails: a 5xx, or a lost ack."""

    def __init__(self, *, lost_ack: bool) -> None:
        super().__init__()
        self._lost_ack = lost_ack

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.method != "PUT":
            return super().__call__(request)
        self.requests.append(request)
        if self._lost_ack:
            message = "synthetic acknowledgement lost after receipt"
            raise httpx.ReadTimeout(message, request=request)
        return httpx.Response(HTTPStatus.SERVICE_UNAVAILABLE, json={"detail": "unavailable"})


async def _signup(client: AsyncClient, name: str) -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{name}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _seed_note(session: AsyncSession, *, user_id: int, entry_id: int) -> int:
    """One marginalia note with no letter yet, on ``entry_id``."""
    note = Marginalia(
        journal_entry_id=entry_id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=4,
        anchor_text="Some",
        note="A beginning.",
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    assert note.id is not None
    return note.id


async def _tainted_note(session: AsyncSession, user_id: int) -> tuple[int, int]:
    """A note on a review with restricted lineage, so a mirror of it is shadowed."""
    chain = await seed_folded_lineage(session, user_id=user_id)
    return chain.review_id, await _seed_note(session, user_id=user_id, entry_id=chain.review_id)


async def _intents(session: AsyncSession, user_id: int) -> list[VoiceDraftRetraction]:
    """Every retraction row the account holds, read fresh."""
    await session.rollback()
    result = await session.execute(
        select(VoiceDraftRetraction)
        .where(col(VoiceDraftRetraction.user_id) == user_id)
        .execution_options(populate_existing=True)
    )
    rows = list(result.scalars().all())
    await session.commit()
    return rows


def _mirror_shadows(caplog: pytest.LogCaptureFixture, entry_id: int) -> int:
    """How many ``VOICE_DRAFT_MIRROR`` shadow records name ``entry_id``."""
    return sum(
        1
        for record in caplog.records
        if record.getMessage() == LINEAGE_SHADOW_EVENT
        and getattr(record, "operation", None) == _MIRROR
        and getattr(record, "entry_id", None) == entry_id
    )


async def _ask_for_letter(client: AsyncClient, headers: dict[str, str], note_id: int) -> None:
    resp = await client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json=_ESSAY_ASK
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["essay"] == _ESSAY


@pytest.fixture(autouse=True)
def _letters(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(marginalia_service, "generate_response", _EssayLLM())


@pytest.mark.asyncio
async def test_a_suspended_mirror_leaves_no_intent_no_shadow_and_no_put(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Under the switch the letter is kept locally and nothing about a mirror is recorded."""
    recorder = _VaultRecorder()
    vault = await handshaken_vault(recorder)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    headers, user_id = await _signup(async_client, "mirror_suspended")
    review_id, note_id = await _tainted_note(db_session, user_id)
    suspend_vault(monkeypatch)

    caplog.clear()
    with caplog.at_level(logging.INFO):
        await _ask_for_letter(async_client, headers, note_id)

    assert "PUT" not in recorder.methods()
    assert await _intents(db_session, user_id) == []
    assert _mirror_shadows(caplog, review_id) == 0
    persisted = await db_session.get(Marginalia, note_id)
    assert persisted is not None
    assert persisted.essay == _ESSAY


@pytest.mark.asyncio
@pytest.mark.parametrize("lost_ack", [False, True], ids=["vault_5xx", "lost_ack"])
async def test_a_dialled_mirror_that_fails_keeps_both_records(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    *,
    lost_ack: bool,
) -> None:
    """The draft may be in the vault, so its withdrawal stays owed and the shadow counts it."""
    recorder = _FailingPutRecorder(lost_ack=lost_ack)
    vault = await handshaken_vault(recorder)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    headers, user_id = await _signup(async_client, f"mirror_failed_{lost_ack}")
    review_id, note_id = await _tainted_note(db_session, user_id)

    caplog.clear()
    with caplog.at_level(logging.INFO):
        await _ask_for_letter(async_client, headers, note_id)

    assert recorder.methods().count("PUT") == 1
    intents = await _intents(db_session, user_id)
    assert [(row.marginalia_id, row.state) for row in intents] == [
        (note_id, VoiceDraftRetractionState.MIRROR_INTENT)
    ]
    assert _mirror_shadows(caplog, review_id) == 1


@pytest.mark.asyncio
async def test_suspend_then_resume_records_exactly_one_intent_and_one_shadow(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A letter under the switch records nothing; the next one after it lifts records once."""
    recorder = _VaultRecorder()
    vault = await handshaken_vault(recorder)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    headers, user_id = await _signup(async_client, "mirror_resumed")
    review_id, suspended_note = await _tainted_note(db_session, user_id)
    resumed_note = await _seed_note(db_session, user_id=user_id, entry_id=review_id)

    caplog.clear()
    with caplog.at_level(logging.INFO):
        suspend_vault(monkeypatch)
        await _ask_for_letter(async_client, headers, suspended_note)
        monkeypatch.delenv(VAULT_SEND_SUSPEND_ENV_VAR)
        await _ask_for_letter(async_client, headers, resumed_note)

    assert recorder.methods().count("PUT") == 1
    intents = await _intents(db_session, user_id)
    assert [(row.marginalia_id, row.state) for row in intents] == [
        (resumed_note, VoiceDraftRetractionState.MIRROR_INTENT)
    ]
    assert _mirror_shadows(caplog, review_id) == 1


class _SuspendedDraftVault(LocalFallbackCreekVaultClient):
    """A connected Voice Draft vault whose PUT the operator switch refuses."""

    def __init__(self) -> None:
        super().__init__()
        self.upserts: list[VaultVoiceDraftRequest] = []

    async def handshake(self) -> HandshakeResult:
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="aptitude-wavelength/2026-05-23",
            capabilities=frozenset({CreekCapability.VOICE_DRAFTS}),
            attestation=None,
        )

    def supports(self, capability: CreekCapability, /) -> bool:
        return capability is CreekCapability.VOICE_DRAFTS

    async def upsert_voice_draft(self, request: VaultVoiceDraftRequest, /) -> VaultVoiceDraftResult:
        self.upserts.append(request)
        raise VaultSendSuspendedError


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "earlier_state",
    [VoiceDraftRetractionState.CONFIRMED, VoiceDraftRetractionState.MIRROR_INTENT],
)
async def test_a_suspended_remirror_restores_the_row_it_rearmed(
    async_client: AsyncClient,
    db_session: AsyncSession,
    earlier_state: VoiceDraftRetractionState,
) -> None:
    """Dropping the staged intent never erases what an earlier attempt recorded.

    A confirmed withdrawal goes back to confirmed (nothing is owed for a send
    that never happened), and an earlier offer to the same vault -- which may
    hold a copy -- keeps its row exactly as it was.
    """
    _headers, user_id = await _signup(async_client, f"mirror_rearm_{earlier_state.value}")
    review_id, note_id = await _tainted_note(db_session, user_id)
    db_session.add(
        VoiceDraftRetraction(
            user_id=user_id,
            journal_entry_id=review_id,
            marginalia_id=note_id,
            destination=_DESTINATION,
            state=earlier_state.value,
            attempt_count=_EARLIER_ATTEMPTS,
            confirmed_at=_EARLIER,
            updated_at=_EARLIER,
        )
    )
    await db_session.commit()
    before = [
        (row.state, row.destination, row.attempt_count, row.confirmed_at, row.updated_at)
        for row in await _intents(db_session, user_id)
    ]
    vault = _SuspendedDraftVault()

    outcome = await mirror_recorded_voice_draft(
        db_session,
        vault,
        VoiceDraftCopy(
            owner_user_id=user_id,
            marginalia_id=note_id,
            essay=_ESSAY,
            classification=JournalClassification.PERSONAL,
        ),
        entry_id=review_id,
        destination=_DESTINATION,
    )

    assert outcome is MirrorOutcome.SUSPENDED
    assert len(vault.upserts) == 1
    after = [
        (row.state, row.destination, row.attempt_count, row.confirmed_at, row.updated_at)
        for row in await _intents(db_session, user_id)
    ]
    assert after == before
