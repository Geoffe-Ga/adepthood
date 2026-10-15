"""A vault-bound writer's first letter is written by their vault, or not at all (#3203).

#3183 made every vault-bound first letter fail closed, because the app provider
was the only thing that could write one. Creek's contract 0.17 publishes
``letters``, and a vault that advertises it (with the ``voice-drafts`` resource
that retracts what it writes) now answers the letter itself. These tests drive
the real route with a scripted vault and pin the four things that must hold:

* the letter comes from the vault, is cached, and is charged once whatever key
  header rides along -- with zero app-provider dials (a recording spy whose
  counterweight, in ``test_vault_bound_essay_and_corpus``, watches it fire);
* every other ending -- no capability, an outage, an unreadable answer, a
  suspended send -- is #3183's 503 ``reflection_source_unavailable``, refunded,
  with ``essay`` still ``NULL`` and the app provider never asked;
* the content-free Voice Draft intent row is committed before the call, so an
  Intimate reclassification or a delete withdraws the vault's letter exactly as
  it withdraws a mirrored draft;
* the INTIMATE floor still returns before the vault is touched.
"""

from __future__ import annotations

from collections.abc import Iterator
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultCareEscalationError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultIngestAction,
    VaultLetter,
    VaultLetterRequest,
    VaultSendSuspendedError,
    VaultTierCeiling,
    VaultVoiceDraftDeleteResult,
)
from main import app
from models.journal_entry import JournalClassification, JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from models.voice_draft_retraction import VoiceDraftRetraction, VoiceDraftRetractionState
from services import marginalia as marginalia_service
from services.botmason import LLMResponse
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_voice_drafts import voice_draft_external_id
from services.reflection_boundary import REFLECTION_SOURCE_UNAVAILABLE, ReflectionBoundary
from services.usage import get_monthly_cap
from tests.provider_transport import OPENAI_KEY
from tests.support.fake_llm import real_provider_response
from tests.vault_client_doubles import RECORDED_VAULT, bind_every_account_to_a_recorded_vault

_PASSWORD = "secret12345"  # pragma: allowlist secret
_BODY = "SENTINEL_BODY_3203 the willow bent by the river and did not break."
_VAULT_LETTER = "A letter your vault wrote: the willow bends, and so do you."
_APP_LETTER = "SENTINEL_APP_LETTER_3203 the app provider must never write this."
_PRICED = {"price_acknowledged": True}
_BYOK = {"X-LLM-API-Key": OPENAI_KEY}
_LETTERS_AND_DRAFTS = frozenset({CreekCapability.LETTERS, CreekCapability.VOICE_DRAFTS})


class _LetterVault(LocalFallbackCreekVaultClient):
    """A connected vault that writes letters, records every call, and keeps what it wrote."""

    def __init__(self, capabilities: frozenset[CreekCapability] = _LETTERS_AND_DRAFTS) -> None:
        super().__init__()
        self.capabilities = capabilities
        self.letters: list[VaultLetterRequest] = []
        self.deletes: list[tuple[str, VaultTierCeiling]] = []
        self.remote: dict[str, str] = {}
        self.fail: BaseException | None = None
        self.answer = _VAULT_LETTER

    async def handshake(self) -> HandshakeResult:
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="aptitude-wavelength/2026-05-23",
            capabilities=self.capabilities,
            attestation=None,
        )

    def supports(self, capability: CreekCapability, /) -> bool:
        return capability in self.capabilities

    async def write_letter(self, request: VaultLetterRequest, /) -> VaultLetter:
        self.letters.append(request)
        if self.fail is not None:
            raise self.fail
        self.remote[request.external_id] = self.answer
        return VaultLetter(
            letter=self.answer, vault_ref="voice-draft-fragment-1", action=VaultIngestAction.CREATED
        )

    async def delete_voice_draft(
        self, external_id: str, tier_ceiling: VaultTierCeiling, /
    ) -> VaultVoiceDraftDeleteResult:
        self.deletes.append((external_id, tier_ceiling))
        self.remote.pop(external_id, None)
        return VaultVoiceDraftDeleteResult(deleted=True)


class _AppDials:
    """Counts every dial the essay adapter makes to the app provider."""

    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, *_args: object, **_kwargs: object) -> LLMResponse:
        self.calls += 1
        return real_provider_response(_APP_LETTER)


@pytest.fixture
def app_dials(monkeypatch: pytest.MonkeyPatch) -> _AppDials:
    """Spy on the app provider's essay dial; every test here requires it silent."""
    dials = _AppDials()
    monkeypatch.setattr(marginalia_service, "generate_response", dials)
    return dials


@pytest.fixture
def vault(monkeypatch: pytest.MonkeyPatch) -> Iterator[_LetterVault]:
    """A vault-bound writer whose letter-writing vault is recorded, as production binds it."""
    bind_every_account_to_a_recorded_vault(monkeypatch)
    letters = _LetterVault()
    app.dependency_overrides[get_creek_vault_client] = lambda: letters
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.VAULT_BOUND
    yield letters
    app.dependency_overrides.pop(get_creek_vault_client, None)
    app.dependency_overrides.pop(get_reflection_boundary, None)


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, int(data["user_id"])


async def _seed_note(
    session: AsyncSession,
    user_id: int,
    classification: JournalClassification = JournalClassification.PERSONAL,
) -> tuple[int, int]:
    """One entry with one margin note; returns (entry id, note id)."""
    entry = JournalEntry(
        sender="user", user_id=user_id, message=_BODY, classification=classification
    )
    session.add(entry)
    await session.flush()
    note = Marginalia(
        journal_entry_id=entry.id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=8,
        anchor_text=_BODY[:8],
        note="A beginning.",
    )
    session.add(note)
    await session.commit()
    assert entry.id is not None
    assert note.id is not None
    return entry.id, note.id


async def _spent(session: AsyncSession, user_id: int, before: tuple[int, int]) -> int:
    """Units taken from either wallet bucket since ``before``."""
    used, balance = await _wallet(session, user_id)
    return (used - before[0]) + (before[1] - balance)


async def _wallet(session: AsyncSession, user_id: int) -> tuple[int, int]:
    session.expire_all()
    user = (await session.execute(select(User).where(col(User.id) == user_id))).scalar_one()
    return user.monthly_messages_used, user.offering_balance


async def _note(session: AsyncSession, note_id: int) -> Marginalia:
    session.expire_all()
    result = await session.execute(select(Marginalia).where(col(Marginalia.id) == note_id))
    return result.scalar_one()


async def _intent(session: AsyncSession, note_id: int) -> VoiceDraftRetraction | None:
    session.expire_all()
    result = await session.execute(
        select(VoiceDraftRetraction).where(col(VoiceDraftRetraction.marginalia_id) == note_id)
    )
    return result.scalars().first()


async def _ask(
    client: AsyncClient, headers: dict[str, str], note_id: int, body: dict[str, bool] | None = None
) -> Response:
    payload = _PRICED if body is None else body
    return await client.post(f"/journal/marginalia/{note_id}/essay", headers=headers, json=payload)


@pytest.mark.asyncio
@pytest.mark.parametrize("headers_extra", [{}, _BYOK], ids=["server_paid", "byok"])
async def test_the_vault_writes_the_letter_and_it_is_charged_once(
    async_client: AsyncClient,
    db_session: AsyncSession,
    vault: _LetterVault,
    app_dials: _AppDials,
    headers_extra: dict[str, str],
) -> None:
    """200 with the vault's letter, one unit whatever the key header, zero app-provider dials."""
    headers, user_id = await _signup(async_client, f"vault_letter_{len(headers_extra)}")
    entry_id, note_id = await _seed_note(db_session, user_id)
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers={**headers, **headers_extra}, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["essay"] == _VAULT_LETTER
    assert resp.json()["essay_source"] == "creek_vault"
    assert app_dials.calls == 0
    assert await _spent(db_session, user_id, before) == 1
    [request] = vault.letters
    assert request.external_id == voice_draft_external_id(user_id, note_id)
    assert request.tier is VaultTierCeiling.PERSONAL
    assert request.content == _BODY
    assert request.note == "A beginning."
    assert request.kind == "symbol"
    note = await _note(db_session, note_id)
    assert note.essay == _VAULT_LETTER
    intent = await _intent(db_session, note_id)
    assert intent is not None
    assert intent.journal_entry_id == entry_id
    assert intent.state == VoiceDraftRetractionState.MIRROR_INTENT.value
    assert intent.destination == RECORDED_VAULT


@pytest.mark.asyncio
async def test_a_vault_letter_reopens_free_without_asking_the_vault_again(
    async_client: AsyncClient, db_session: AsyncSession, vault: _LetterVault, app_dials: _AppDials
) -> None:
    """The cached letter is a read: no second vault call, no second charge."""
    headers, user_id = await _signup(async_client, "vault_letter_reopen")
    _, note_id = await _seed_note(db_session, user_id)
    assert (await _ask(async_client, headers, note_id)).status_code == HTTPStatus.OK
    before = await _wallet(db_session, user_id)

    reopened = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json=_PRICED
    )

    assert reopened.status_code == HTTPStatus.OK
    assert reopened.json()["essay"] == _VAULT_LETTER
    assert len(vault.letters) == 1
    assert await _spent(db_session, user_id, before) == 0
    assert app_dials.calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [
        CreekVaultUnavailableError("synthetic letter outage"),
        VaultSendSuspendedError(),
    ],
    ids=["outage", "suspended"],
)
async def test_a_vault_that_cannot_answer_fails_closed_refunded(
    async_client: AsyncClient,
    db_session: AsyncSession,
    vault: _LetterVault,
    app_dials: _AppDials,
    failure: Exception,
) -> None:
    """503 ``reflection_source_unavailable``, the unit refunded, nothing cached, no app dial."""
    headers, user_id = await _signup(async_client, f"vault_letter_fail_{type(failure).__name__}")
    _, note_id = await _seed_note(db_session, user_id)
    vault.fail = failure
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers={**headers, **_BYOK}, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert resp.json() == {"detail": REFLECTION_SOURCE_UNAVAILABLE}
    assert app_dials.calls == 0
    assert await _spent(db_session, user_id, before) == 0
    assert (await _note(db_session, note_id)).essay is None
    intent = await _intent(db_session, note_id)
    if isinstance(failure, VaultSendSuspendedError):
        # Refused before the wire: nothing was offered, so nothing is owed.
        assert intent is None
    else:
        # The answer may have been lost after the vault stored it: still owed.
        assert intent is not None


@pytest.mark.asyncio
async def test_an_answer_that_is_not_a_letter_is_refunded_and_refused(
    async_client: AsyncClient, db_session: AsyncSession, vault: _LetterVault, app_dials: _AppDials
) -> None:
    """A letter that sanitizes away to nothing is not cached and costs nothing."""
    headers, user_id = await _signup(async_client, "vault_letter_blank")
    _, note_id = await _seed_note(db_session, user_id)
    vault.answer = "\u200b"
    before = await _wallet(db_session, user_id)

    resp = await _ask(async_client, headers, note_id)

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert await _spent(db_session, user_id, before) == 0
    assert (await _note(db_session, note_id)).essay is None
    assert app_dials.calls == 0


@pytest.mark.asyncio
async def test_a_care_escalation_answers_no_letter_and_refunds(
    async_client: AsyncClient, db_session: AsyncSession, vault: _LetterVault, app_dials: _AppDials
) -> None:
    """The vault's care guard spoke: no letter, no charge, and never the app provider's prose."""
    headers, user_id = await _signup(async_client, "vault_letter_care")
    _, note_id = await _seed_note(db_session, user_id)
    vault.fail = CreekVaultCareEscalationError()
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["essay"] is None
    assert await _spent(db_session, user_id, before) == 0
    assert app_dials.calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "capabilities",
    [frozenset({CreekCapability.VOICE_DRAFTS}), frozenset({CreekCapability.LETTERS})],
    ids=["no_letters", "no_voice_drafts"],
)
async def test_a_vault_without_letters_keeps_the_fail_closed_refusal(
    async_client: AsyncClient,
    db_session: AsyncSession,
    vault: _LetterVault,
    app_dials: _AppDials,
    capabilities: frozenset[CreekCapability],
) -> None:
    """No ``letters`` -- or no ``voice-drafts`` to retract one with -- is #3183's 503, uncharged."""
    headers, user_id = await _signup(async_client, f"vault_letter_cap_{len(capabilities)}")
    _, note_id = await _seed_note(db_session, user_id)
    vault.capabilities = capabilities
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers={**headers, **_BYOK}, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert resp.json() == {"detail": REFLECTION_SOURCE_UNAVAILABLE}
    assert vault.letters == []
    assert app_dials.calls == 0
    assert await _wallet(db_session, user_id) == before
    assert await _intent(db_session, note_id) is None


@pytest.mark.asyncio
async def test_the_refusal_names_the_missing_capability(
    async_client: AsyncClient,
    db_session: AsyncSession,
    vault: _LetterVault,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A reachable vault without ``letters`` is logged as ``capability_missing``, ids only."""
    headers, user_id = await _signup(async_client, "vault_letter_cap_log")
    _, note_id = await _seed_note(db_session, user_id)
    vault.capabilities = frozenset({CreekCapability.VOICE_DRAFTS})

    resp = await _ask(async_client, headers, note_id)

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    [refusal] = [r for r in caplog.records if r.getMessage() == REFLECTION_SOURCE_UNAVAILABLE]
    assert refusal.__dict__["reason"] == "capability_missing"
    assert refusal.__dict__["id"] == note_id
    assert "SENTINEL" not in f"{refusal.getMessage()} {refusal.__dict__}"


@pytest.mark.asyncio
async def test_a_byok_key_does_not_waive_the_price_of_a_vault_letter(
    async_client: AsyncClient, db_session: AsyncSession, vault: _LetterVault, app_dials: _AppDials
) -> None:
    """The vault never uses the key, so the letter is priced: 409 before any charge or call."""
    headers, user_id = await _signup(async_client, "vault_letter_unpriced")
    _, note_id = await _seed_note(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{note_id}/essay",
        headers={**headers, **_BYOK},
        json={"price_acknowledged": False},
    )

    assert resp.status_code == HTTPStatus.CONFLICT
    assert vault.letters == []
    assert app_dials.calls == 0


@pytest.mark.asyncio
async def test_a_byok_key_does_not_pay_for_a_vault_letter(
    async_client: AsyncClient, db_session: AsyncSession, vault: _LetterVault, app_dials: _AppDials
) -> None:
    """An empty wallet is 402 for a vault letter whatever key rides along (#3258)."""
    headers, user_id = await _signup(async_client, "vault_letter_broke")
    _, note_id = await _seed_note(db_session, user_id)
    user = await db_session.get(User, user_id)
    assert user is not None
    user.monthly_messages_used = get_monthly_cap()
    user.offering_balance = 0
    await db_session.commit()

    resp = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers={**headers, **_BYOK}, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert vault.letters == []
    assert app_dials.calls == 0


@pytest.mark.asyncio
async def test_an_intimate_entry_never_reaches_the_vault(
    async_client: AsyncClient, db_session: AsyncSession, vault: _LetterVault, app_dials: _AppDials
) -> None:
    """The INTIMATE floor returns the note before any handshake, charge or call."""
    headers, user_id = await _signup(async_client, "vault_letter_intimate")
    _, note_id = await _seed_note(db_session, user_id, JournalClassification.INTIMATE)
    before = await _wallet(db_session, user_id)

    resp = await _ask(async_client, headers, note_id)

    assert resp.status_code == HTTPStatus.OK
    assert vault.letters == []
    assert app_dials.calls == 0
    assert await _wallet(db_session, user_id) == before


@pytest.mark.asyncio
async def test_choosing_intimate_withdraws_the_vault_written_letter(
    async_client: AsyncClient, db_session: AsyncSession, vault: _LetterVault, app_dials: _AppDials
) -> None:
    """The letter the vault wrote is a Voice Draft the ledger owes, and retracts, by its id."""
    headers, user_id = await _signup(async_client, "vault_letter_withdraw")
    entry_id, note_id = await _seed_note(db_session, user_id)
    assert (await _ask(async_client, headers, note_id)).status_code == HTTPStatus.OK
    external_id = voice_draft_external_id(user_id, note_id)
    assert external_id in vault.remote

    resp = await async_client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert (external_id, VaultTierCeiling.PERSONAL) in vault.deletes
    assert external_id not in vault.remote
    intent = await _intent(db_session, note_id)
    assert intent is not None
    assert intent.state == VoiceDraftRetractionState.CONFIRMED.value
    assert app_dials.calls == 0


@pytest.mark.asyncio
async def test_deleting_the_page_withdraws_the_vault_written_letter(
    async_client: AsyncClient, db_session: AsyncSession, vault: _LetterVault, app_dials: _AppDials
) -> None:
    """Deletion owes the vault's letter its withdrawal exactly as it owes a mirrored one."""
    headers, user_id = await _signup(async_client, "vault_letter_delete")
    entry_id, note_id = await _seed_note(db_session, user_id)
    assert (await _ask(async_client, headers, note_id)).status_code == HTTPStatus.OK
    external_id = voice_draft_external_id(user_id, note_id)

    resp = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert resp.status_code == HTTPStatus.NO_CONTENT, resp.text
    assert (external_id, VaultTierCeiling.PERSONAL) in vault.deletes
    assert external_id not in vault.remote
    assert app_dials.calls == 0
