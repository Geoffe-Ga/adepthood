"""Every margin note says which source answered it, and a demo costs nothing (#3062).

A note's provenance is a server-observed fact: the receipt is built from the
response the pass actually received (the app provider's ``LLMResponse``, or the
vault adapter that answered), stamped on the row in the same commit as the
note, and read back unchanged. Nothing here is derived from the request, and
nothing is inferred from whether a vault happens to be connected now.

The stub provider is a demo state end to end: its notes and letters are stamped
``demo``, and the wallet unit the pass took is handed back under its own audit
reason, so a canned note is never billed as a reflection.
"""

from __future__ import annotations

import json
import logging
from datetime import date
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.creek_vault import (
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
)
from main import app
from models.goal import Goal
from models.habit import Habit
from models.marginalia import (
    RECEIPT_VERSION,
    InferenceProvider,
    Marginalia,
    MarginaliaKind,
    MarginaliaSource,
)
from models.user import User
from models.wallet_audit import (
    GENERATION_REFUND_REASONS,
    REASON_REFUND_DEMO,
    REASON_SPEND_MONTHLY,
    WalletAudit,
)
from services import marginalia as marginalia_service
from services.botmason import LLMResponse
from services.llm_usage import OUTCOME_FOR_REFUND_REASON, GenerationOutcome
from services.marginalia import receipt_for
from services.reflection_boundary import ReflectionBoundary
from services.usage import get_monthly_cap
from tests.support.fake_llm import real_provider_response
from tests.support.reflecting_vault import ReflectingVaultClient

_PASSWORD = "secret12345"  # pragma: allowlist secret
_BODY = "I meditated by the river and the willow bent without breaking."
_QUOTE = "the willow bent without breaking"
_NOTE_TEXT = "Sentinel-note: it holds."
_VAULT_NOTE = "The vault reads this passage back."
_LETTER = "Sentinel-letter: a warm letter about bending."
_PRICED = {"price_acknowledged": True}
_REAL_MODEL = "claude-test"
_INFERENCE_SOURCES = {"creek_vault", "app_provider", "demo", "none", None}


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    resp = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _create_entry(client: AsyncClient, headers: dict[str, str]) -> int:
    resp = await client.post("/journal/", json={"message": _BODY}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


async def _user(session: AsyncSession, username: str) -> User:
    await session.rollback()
    return (
        await session.execute(select(User).where(col(User.email) == f"{username}@example.com"))
    ).scalar_one()


async def _audit_reasons(session: AsyncSession, username: str) -> list[str]:
    user = await _user(session, username)
    rows = await session.execute(
        select(col(WalletAudit.reason))
        .where(col(WalletAudit.user_id) == user.id)
        .order_by(col(WalletAudit.id))
    )
    return list(rows.scalars().all())


def _answer_as(monkeypatch: pytest.MonkeyPatch, *, provider: str, model: str) -> None:
    """Answer every resonance-family call as ``provider``: notes, letters, or no hits."""

    async def _complete(
        prompt: str, history: object, *, system_prompt: str | None, api_key: object
    ) -> LLMResponse:
        del history, api_key
        task = f"{system_prompt or ''}\n{prompt}"
        if '"hits"' in task or "COMPLETED" in task:
            text = json.dumps({"hits": []})
        elif '"notes"' in task:
            text = json.dumps({"notes": [{"kind": "theme", "quote": _QUOTE, "note": _NOTE_TEXT}]})
        else:
            text = _LETTER
        return LLMResponse(
            text=text, provider=provider, model=model, prompt_tokens=0, completion_tokens=0
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)


def _bind_to_vault(fake_vault: ReflectingVaultClient) -> None:
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.VAULT_BOUND


def _vault_with_note() -> ReflectingVaultClient:
    return ReflectingVaultClient(
        reflect_result=VaultReflection(
            status=VaultReflectionStatus.OK,
            notes=(VaultReflectionNote(kind="theme", quote=_QUOTE, note=_VAULT_NOTE),),
            essay=None,
            essay_grounded=False,
            routed_tier=VaultTierCeiling.PERSONAL,
        )
    )


async def _seed_habit(session: AsyncSession, username: str) -> None:
    user = await _user(session, username)
    habit = Habit(
        name="Meditation",
        icon="m",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=2,
        user_id=user.id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    session.add(
        Goal(
            habit_id=habit.id,
            title="clear",
            tier="clear",
            target=1.0,
            target_unit="x",
            frequency=1.0,
            frequency_unit="per_day",
            is_additive=True,
        )
    )
    await session.commit()


async def _stored_rows(session: AsyncSession, entry_id: int) -> list[Marginalia]:
    await session.rollback()
    result = await session.execute(
        select(Marginalia).where(col(Marginalia.journal_entry_id) == entry_id)
    )
    return list(result.scalars().all())


# --------------------------------------------------------------------------- notes


@pytest.mark.asyncio
async def test_stub_pass_persists_demo_source_and_is_not_charged(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The default stub answers: the note is a labelled demo and the unit comes back."""
    headers = await _signup(async_client, "prov_demo")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["marginalia"], "the stub should anchor a note against this body"
    note = body["marginalia"][0]
    assert note["source"] == "demo"
    assert note["source_provider"] == "stub"
    assert note["receipt_version"] == RECEIPT_VERSION
    assert body["provenance"]["notes"]["source"] == "demo"
    assert body["provenance"]["paid_by"] == "free"
    assert body["remaining_messages"] == get_monthly_cap()
    user = await _user(db_session, "prov_demo")
    assert user.monthly_messages_used == 0
    assert await _audit_reasons(db_session, "prov_demo") == [
        REASON_SPEND_MONTHLY,
        REASON_REFUND_DEMO,
    ]

    listed = await async_client.get(f"/journal/{entry_id}/marginalia", headers=headers)
    assert listed.status_code == HTTPStatus.OK
    assert [item["source"] for item in listed.json()["items"]] == ["demo"]
    assert listed.json()["items"][0]["receipt_version"] == RECEIPT_VERSION


@pytest.mark.asyncio
async def test_app_provider_pass_persists_provider_source_and_keeps_charge(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real provider's note records who answered and what model it reported; the charge stands."""
    _answer_as(monkeypatch, provider="anthropic", model=_REAL_MODEL)
    headers = await _signup(async_client, "prov_app")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    note = body["marginalia"][0]
    assert note["source"] == "app_provider"
    assert note["source_provider"] == "anthropic"
    assert note["source_model"] == _REAL_MODEL
    assert body["provenance"]["notes"] == {
        "source": "app_provider",
        "provider": "anthropic",
        "model": _REAL_MODEL,
        "receipt_version": RECEIPT_VERSION,
    }
    assert body["provenance"]["paid_by"] == "wallet"
    assert body["remaining_messages"] == get_monthly_cap() - 1
    (row,) = await _stored_rows(db_session, entry_id)
    assert row.source == MarginaliaSource.APP_PROVIDER
    assert row.source_provider == InferenceProvider.ANTHROPIC
    assert row.source_model == _REAL_MODEL
    assert row.receipt_version == RECEIPT_VERSION


@pytest.mark.asyncio
async def test_byok_pass_is_paid_by_own_key(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A caller's own key pays for a real provider's pass: ``own_key``, never the wallet."""
    _answer_as(monkeypatch, provider="anthropic", model=_REAL_MODEL)
    headers = await _signup(async_client, "prov_byok")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(
        f"/journal/{entry_id}/resonance",
        headers={**headers, "X-LLM-API-Key": "sk-ant-test-key-for-provenance"},
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["provenance"]["paid_by"] == "own_key"


@pytest.mark.asyncio
async def test_vault_answered_pass_persists_creek_vault_source_without_model(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The vault's note is stamped creek_vault/creek, with no model claimed it did not report."""
    fake_vault = _vault_with_note()
    _bind_to_vault(fake_vault)
    headers = await _signup(async_client, "prov_vault")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    note = body["marginalia"][0]
    assert note["note"] == _VAULT_NOTE
    assert note["source"] == "creek_vault"
    assert note["source_provider"] == "creek"
    assert note["source_model"] is None
    assert body["provenance"]["notes"]["source"] == "creek_vault"
    assert body["provenance"]["paid_by"] == "wallet"
    (row,) = await _stored_rows(db_session, entry_id)
    assert row.source == MarginaliaSource.CREEK_VAULT
    assert row.source_provider == InferenceProvider.CREEK
    assert row.source_model is None


@pytest.mark.asyncio
async def test_vault_empty_pass_names_the_vault_as_the_empty_source(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A vault with nothing to say is an empty pass the vault answered -- never a cloud note."""
    _bind_to_vault(ReflectingVaultClient())
    headers = await _signup(async_client, "prov_vault_empty")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["marginalia"] == []
    assert body["no_notes_message"]
    assert body["provenance"]["notes"]["source"] == "creek_vault"
    assert body["provenance"]["paid_by"] == "free"
    assert await _stored_rows(db_session, entry_id) == []


@pytest.mark.asyncio
async def test_vault_bound_pass_reports_detection_as_not_run(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Vault notes beside candidates: detection did not run, and says ``none``, unchecked."""
    _bind_to_vault(_vault_with_note())
    headers = await _signup(async_client, "prov_mixed")
    await _seed_habit(db_session, "prov_mixed")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    provenance = resp.json()["provenance"]
    assert provenance["notes"]["source"] == "creek_vault"
    assert provenance["detection"]["source"] == "none"
    assert provenance["detection_checked"] is False


@pytest.mark.asyncio
async def test_detection_with_candidates_reports_its_own_source(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Detection is its own sub-operation with its own receipt."""
    _answer_as(monkeypatch, provider="openai", model="gpt-4o-mini")
    headers = await _signup(async_client, "prov_detect")
    await _seed_habit(db_session, "prov_detect")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    provenance = resp.json()["provenance"]
    assert provenance["detection"]["source"] == "app_provider"
    assert provenance["detection"]["provider"] == "openai"
    assert provenance["detection_checked"] is True


@pytest.mark.asyncio
async def test_detection_without_candidates_reports_none(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No candidates means no call: ``none`` and checked, never "not recorded"."""
    _answer_as(monkeypatch, provider="anthropic", model=_REAL_MODEL)
    headers = await _signup(async_client, "prov_nodetect")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    provenance = resp.json()["provenance"]
    assert provenance["detection"] == {
        "source": "none",
        "provider": None,
        "model": None,
        "receipt_version": RECEIPT_VERSION,
    }
    assert provenance["detection_checked"] is True


@pytest.mark.asyncio
async def test_historical_row_without_source_serializes_as_not_recorded(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A row written before receipts existed reads back with every provenance field null."""
    headers = await _signup(async_client, "prov_legacy")
    entry_id = await _create_entry(async_client, headers)
    user = await _user(db_session, "prov_legacy")
    db_session.add(
        Marginalia(
            journal_entry_id=entry_id,
            user_id=user.id,
            kind=MarginaliaKind.THEME,
            anchor_start=0,
            anchor_end=11,
            anchor_text="I meditated",
            note="An older note.",
        )
    )
    await db_session.commit()

    resp = await async_client.get(f"/journal/{entry_id}/marginalia", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    (item,) = resp.json()["items"]
    for field in ("source", "source_provider", "source_model", "essay_source", "receipt_version"):
        assert item[field] is None, field


@pytest.mark.asyncio
async def test_client_cannot_supply_provenance(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Provenance in a body or query is ignored: the stub's notes and letter stay ``demo``."""
    headers = await _signup(async_client, "prov_spoof")
    entry_id = await _create_entry(async_client, headers)
    spoof = {"source": "creek_vault", "source_provider": "creek", "essay_source": "app_provider"}

    resp = await async_client.post(
        f"/journal/{entry_id}/resonance", headers=headers, params=spoof, json=spoof
    )
    assert resp.status_code == HTTPStatus.OK
    note_id = resp.json()["marginalia"][0]["id"]
    essay = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json={**_PRICED, **spoof}
    )

    assert essay.status_code == HTTPStatus.OK
    assert essay.json()["essay_source"] == "demo"
    (row,) = await _stored_rows(db_session, entry_id)
    assert row.source == MarginaliaSource.DEMO
    assert row.essay_source == MarginaliaSource.DEMO
    essay_request = app.openapi()["components"]["schemas"]["EssayRequest"]
    assert set(essay_request["properties"]) == {"price_acknowledged"}


# --------------------------------------------------------------------------- essays


@pytest.mark.asyncio
async def test_demo_essay_is_not_charged_and_labelled(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A stub letter is cached with ``essay_source=demo`` and hands its unit back."""
    headers = await _signup(async_client, "prov_demo_essay")
    entry_id = await _create_entry(async_client, headers)
    resonance = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    note_id = resonance.json()["marginalia"][0]["id"]

    resp = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["essay"]
    assert body["essay_source"] == "demo"
    assert body["remaining_messages"] == get_monthly_cap()
    assert (await _audit_reasons(db_session, "prov_demo_essay"))[-2:] == [
        REASON_SPEND_MONTHLY,
        REASON_REFUND_DEMO,
    ]
    drafts = await async_client.get("/journal/voice-drafts", headers=headers)
    assert drafts.status_code == HTTPStatus.OK
    assert drafts.json()["items"][0]["essay_source"] == "demo"


@pytest.mark.asyncio
async def test_vault_note_with_provider_essay_shows_both_sources(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The letter's source is its own: a vault note can carry an app-provider letter."""
    _bind_to_vault(_vault_with_note())
    _answer_as(monkeypatch, provider="anthropic", model=_REAL_MODEL)
    headers = await _signup(async_client, "prov_both")
    entry_id = await _create_entry(async_client, headers)
    resonance = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    note_id = resonance.json()["marginalia"][0]["id"]
    before = await _user(db_session, "prov_both")
    used_before = before.monthly_messages_used

    resp = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["source"] == "creek_vault"
    assert body["essay_source"] == "app_provider"
    after = await _user(db_session, "prov_both")
    assert after.monthly_messages_used == used_before + 1


# --------------------------------------------------------------------------- logs + vocab


@pytest.mark.asyncio
async def test_demo_pass_settlement_and_logs_are_closed_vocabulary(
    async_client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    """The demo pass settles ``refunded_demo``; the outcome line names sources by enum only."""
    headers = await _signup(async_client, "prov_logs")
    entry_id = await _create_entry(async_client, headers)
    caplog.set_level(logging.INFO)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    note_text = resp.json()["marginalia"][0]["note"]
    settled = [r for r in caplog.records if r.getMessage().startswith("llm_generation_settled")]
    assert [r.__dict__["outcome"] for r in settled] == ["refunded_demo"]
    (outcome,) = [r for r in caplog.records if r.getMessage() == "journal_resonance_generated"]
    assert outcome.__dict__["notes_source"] == "demo"
    assert outcome.__dict__["detection_source"] in _INFERENCE_SOURCES
    for record in caplog.records:
        rendered = f"{record.getMessage()} {record.__dict__}"
        assert _BODY not in rendered
        assert note_text not in rendered


def test_demo_refund_is_a_generation_refund_with_its_own_outcome() -> None:
    """The ceiling nets a demo refund, and its settlement line can say why."""
    assert REASON_REFUND_DEMO in GENERATION_REFUND_REASONS
    assert OUTCOME_FOR_REFUND_REASON[REASON_REFUND_DEMO] is GenerationOutcome.REFUNDED_DEMO


@pytest.mark.parametrize(
    ("provider", "model", "expected"),
    [
        ("stub", "stub", (MarginaliaSource.DEMO, InferenceProvider.STUB, "stub")),
        ("anthropic", "m", (MarginaliaSource.APP_PROVIDER, InferenceProvider.ANTHROPIC, "m")),
        ("openai", "", (MarginaliaSource.APP_PROVIDER, InferenceProvider.OPENAI, None)),
        ("mystery", "x" * 200, (MarginaliaSource.APP_PROVIDER, None, "x" * 64)),
    ],
)
def test_receipt_for_maps_a_response_into_the_closed_vocabulary(
    provider: str, model: str, expected: tuple[MarginaliaSource, InferenceProvider | None, str]
) -> None:
    """Only the stub is demo; an unknown provider is never widened to a vault or demo."""
    receipt = receipt_for(real_provider_response("x", provider=provider, model=model))

    assert (receipt.source, receipt.provider, receipt.model) == expected
