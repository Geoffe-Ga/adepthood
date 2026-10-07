"""The operator's privacy suspension switches, end to end (#3075).

Two switches an operator flips during a privacy incident, both default-off and
both strictly narrowing:

* ``PRIVACY_SUSPEND_EXTERNAL_AI`` refuses every cloud language-model call --
  server-paid *and* bring-your-own-key -- before any provider client is built.
  Before it existed nothing did: ``BOTMASON_PROVIDER=stub`` does not stop a BYOK
  key from selecting its own provider, and the daily ceiling only counts
  charged generations.
* ``PRIVACY_SUSPEND_VAULT_SEND`` refuses every content-bearing Creek request
  while the content-free withdrawals and deletions keep running, because an
  incident is exactly when a stuck withdrawal must still be able to land.

Under either, the writing itself is never at risk: journal create, read and
edit, export and account deletion all keep working.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime
from http import HTTPStatus
from typing import TYPE_CHECKING, Any, Final, cast
from unittest.mock import AsyncMock, patch

import anthropic
import httpx
import openai
import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, func, select

from conftest import test_engine
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekVaultUnavailableError,
    VaultIngestRequest,
    VaultSendSuspendedError,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultVoiceDraftRequest,
)
from main import app, lifespan
from models.corpus_fragment import CorpusSource
from models.generation_slot import GenerationSlot
from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalClassification, JournalEntry
from models.llm_usage_log import LLMUsageLog
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from models.wallet_audit import WalletAudit
from routers import journal as journal_router
from services import botmason
from services.botmason import LLMProviderError
from services.creek_vault_client import HttpCreekVaultClient, carries_content
from services.creek_vault_upload import upload_external_id
from services.privacy_suspension import (
    AI_SUSPENDED_DETAIL,
    EXTERNAL_AI_SUSPEND_ENV_VAR,
    VAULT_SEND_SUSPEND_ENV_VAR,
    external_ai_suspended,
    log_suspension_state,
    vault_send_suspended,
)
from tests.provider_transport import (
    ANTHROPIC_KEY,
    OPENAI_KEY,
    TransportStub,
    use_anthropic,
    use_openai,
)
from tests.transcription_helpers import PNG_BYTES, payload

if TYPE_CHECKING:
    from collections.abc import Callable

ON: Final = "true"
_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
_BODY: Final = "I meditated by the river and the willow bent without breaking."
_DISTRESS_BODY: Final = "I keep thinking I want to kill myself and end my life tonight."
_CACHED_ESSAY: Final = "A letter already written and already paid for."
_PRICED: Final = {"price_acknowledged": True}
_VAULT_URL: Final = "https://vault.example.test"
_VAULT_CREDENTIAL: Final = "test-vault-credential"  # pragma: allowlist secret
_ALL_CAPABILITIES: Final = (
    "capabilities",
    "journal-upsert",
    "journal-withdraw",
    "reflections",
    "upload",
    "voice-drafts",
)
_VOICE_DRAFT_ID: Final = "adepthood-voicedraft-0123456789abcdef0123456789abcdef"
_WITHDRAWN_ENTRY: Final = 7
_CREATED_AT: Final = datetime(2026, 8, 8, 9, 30, tzinfo=UTC)
_ANTHROPIC_OK: Final[dict[str, object]] = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": "claude-sonnet-5",
    "content": [{"type": "text", "text": "ok"}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 1, "output_tokens": 1},
}


# --- helpers -----------------------------------------------------------------


def suspend_ai(monkeypatch: pytest.MonkeyPatch) -> None:
    """Flip the external-AI switch on, exactly as an operator's env var would."""
    monkeypatch.setenv(EXTERNAL_AI_SUSPEND_ENV_VAR, ON)


def suspend_vault(monkeypatch: pytest.MonkeyPatch) -> None:
    """Flip the vault-send switch on."""
    monkeypatch.setenv(VAULT_SEND_SUSPEND_ENV_VAR, ON)


def record_constructions(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Wrap both SDK constructors so every client built is named in the result.

    Wraps whatever is installed (the transport stub's factory, when armed), so a
    construction that slips through still reaches a mock transport rather than
    the network.
    """
    built: list[str] = []
    real_openai = botmason.openai.AsyncOpenAI
    real_anthropic = botmason.anthropic.AsyncAnthropic

    def _openai(**kwargs: object) -> openai.AsyncOpenAI:
        built.append("openai")
        return real_openai(**cast("dict[str, Any]", kwargs))

    def _anthropic(**kwargs: object) -> anthropic.AsyncAnthropic:
        built.append("anthropic")
        return real_anthropic(**cast("dict[str, Any]", kwargs))

    monkeypatch.setattr(botmason.openai, "AsyncOpenAI", _openai)
    monkeypatch.setattr(botmason.anthropic, "AsyncAnthropic", _anthropic)
    return built


def arm_anthropic(monkeypatch: pytest.MonkeyPatch) -> TransportStub:
    """A server-paid Anthropic provider over a counting mock transport."""
    return use_anthropic(monkeypatch, HTTPStatus.OK, _ANTHROPIC_OK)


async def signup(client: AsyncClient, name: str) -> tuple[dict[str, str], int, str]:
    """A fresh account: its bearer headers, its id and its email."""
    email = f"{name}@example.com"
    resp = await client.post("/auth/signup", json={"email": email, "password": _PASSWORD})
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"]), email


async def seed_entry(
    session: AsyncSession,
    user_id: int,
    *,
    body: str = _BODY,
    classification: JournalClassification = JournalClassification.PERSONAL,
) -> int:
    """One persisted journal entry, classified as given."""
    entry = JournalEntry(
        sender="user", user_id=user_id, message=body, classification=classification
    )
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    assert entry.id is not None
    return entry.id


async def seed_note(
    session: AsyncSession,
    user_id: int,
    *,
    essay: str | None = None,
    classification: JournalClassification = JournalClassification.PERSONAL,
) -> int:
    """One marginalia note on a fresh entry, with its letter cached when ``essay`` is set."""
    entry_id = await seed_entry(session, user_id, classification=classification)
    note = Marginalia(
        journal_entry_id=entry_id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=6,
        anchor_text="I medi",
        note="A beginning.",
        essay=essay,
        essay_generated_at=None if essay is None else _CREATED_AT,
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    assert note.id is not None
    return note.id


async def seed_habit(session: AsyncSession, user_id: int) -> None:
    """A habit with a goal, so completion detection has a candidate to offer."""
    habit = Habit(
        name="Meditation",
        icon="🧘",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
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


async def wallet(session: AsyncSession, user_id: int) -> tuple[int, int]:
    """The account's two wallet buckets, read fresh."""
    await session.rollback()
    session.expire_all()
    user = await session.get(User, user_id)
    assert user is not None
    return user.monthly_messages_used, user.offering_balance


async def count_rows(session: AsyncSession, model: type[Any]) -> int:
    """How many rows ``model``'s table holds right now."""
    await session.rollback()
    result = await session.execute(select(func.count()).select_from(model))
    return int(result.scalar_one())


def record_minute_bucket(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record every touch of the per-user generation minute bucket on the journal routes."""
    touched: list[str] = []

    def _peek(_user: int) -> None:
        touched.append("peek")

    def _hit(_user: int) -> None:
        touched.append("hit")

    monkeypatch.setattr(journal_router, "require_generation_minute_available", _peek)
    monkeypatch.setattr(journal_router, "consume_generation_minute", _hit)
    return touched


# --- T1/T2: the leaf refuses before any client exists --------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("api_key", [ANTHROPIC_KEY, OPENAI_KEY, None])
async def test_suspend_external_ai_blocks_byok_before_client_construction(
    monkeypatch: pytest.MonkeyPatch, api_key: str | None
) -> None:
    """BYOK of either provider, and the server key, are all refused unbuilt.

    ``BOTMASON_PROVIDER=stub`` is set for the BYOK cases on purpose: that is the
    configuration an operator would reach for, and a BYOK key escapes it.
    """
    openai_stub = use_openai(monkeypatch, HTTPStatus.OK, {})
    anthropic_stub = arm_anthropic(monkeypatch)
    if api_key is None:
        monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
        monkeypatch.setenv("LLM_API_KEY", OPENAI_KEY)
    else:
        monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    built = record_constructions(monkeypatch)
    suspend_ai(monkeypatch)

    with pytest.raises(botmason.ExternalAISuspendedError) as raised:
        await botmason.generate_response("x", [], api_key=api_key)

    assert isinstance(raised.value, LLMProviderError)
    assert str(raised.value) == AI_SUSPENDED_DETAIL
    assert built == []
    assert openai_stub.request_count == 0
    assert anthropic_stub.request_count == 0


@pytest.mark.asyncio
async def test_suspension_refuses_the_stub_too(monkeypatch: pytest.MonkeyPatch) -> None:
    """A suspended deployment says so; it never answers with canned demo text."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    suspend_ai(monkeypatch)

    with pytest.raises(botmason.ExternalAISuspendedError):
        await botmason.generate_response("hello", [])


# --- T3/T4: the AI routes refuse after their free exits, and charge nothing ---


async def _call_route(
    route: str, client: AsyncClient, session: AsyncSession, headers: dict[str, str], user_id: int
) -> Response:
    """Drive one AI-reaching route against a fresh, non-intimate, uncached target."""
    if route == "resonance":
        entry_id = await seed_entry(session, user_id)
        return await client.post(f"/journal/{entry_id}/resonance", headers=headers)
    if route == "essay":
        note_id = await seed_note(session, user_id)
        return await client.post(
            f"/journal/marginalia/{note_id}/essay", headers=headers, json=_PRICED
        )
    if route == "detect":
        await seed_habit(session, user_id)
        entry_id = await seed_entry(session, user_id)
        return await client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)
    return await client.post(
        "/journal/transcribe-page", headers=headers, json=payload(PNG_BYTES, "image/png")
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["resonance", "essay", "detect", "transcribe"])
async def test_suspended_ai_routes_return_503_and_charge_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
) -> None:
    """503 ``ai_suspended``: no charge, no audit row, no slot, no usage row, no dial."""
    stub = arm_anthropic(monkeypatch)
    minute = record_minute_bucket(monkeypatch)
    headers, user_id, _ = await signup(async_client, f"suspended_{route}")
    before_wallet = await wallet(db_session, user_id)
    before_audit = await count_rows(db_session, WalletAudit)
    suspend_ai(monkeypatch)

    resp = await _call_route(route, async_client, db_session, headers, user_id)

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE, resp.text
    assert resp.json() == {"detail": AI_SUSPENDED_DETAIL}
    assert await wallet(db_session, user_id) == before_wallet
    assert await count_rows(db_session, WalletAudit) == before_audit
    assert await count_rows(db_session, GenerationSlot) == 0
    assert await count_rows(db_session, LLMUsageLog) == 0
    assert stub.request_count == 0
    assert minute == []


@pytest.mark.asyncio
async def test_free_exits_survive_suspension(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Care, a paid-for letter and the intimate floor never depend on the switch."""
    stub = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "free_exits")
    distress = await seed_entry(
        db_session,
        user_id,
        body=_DISTRESS_BODY,
        classification=JournalClassification.INTIMATE,
    )
    cached = await seed_note(db_session, user_id, essay=_CACHED_ESSAY)
    intimate = await seed_entry(db_session, user_id, classification=JournalClassification.INTIMATE)
    await seed_habit(db_session, user_id)
    suspend_ai(monkeypatch)

    care = await async_client.post(f"/journal/{distress}/resonance", headers=headers)
    letter = await async_client.post(
        f"/journal/marginalia/{cached}/essay", headers=headers, json=_PRICED
    )
    detect = await async_client.post(f"/journal/{intimate}/suggestions/detect", headers=headers)

    assert care.status_code == HTTPStatus.OK, care.text
    assert care.json()["care"] is not None
    assert letter.status_code == HTTPStatus.OK, letter.text
    assert letter.json()["essay"] == _CACHED_ESSAY
    assert detect.status_code == HTTPStatus.OK, detect.text
    assert detect.json()["checked"] is False
    assert stub.request_count == 0


# --- T5/T9: the writing itself is never at risk --------------------------------


@pytest.mark.asyncio
async def test_suspension_preserves_journal_export_and_deletion(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Create, read, edit, export and delete all succeed under both switches."""
    arm_anthropic(monkeypatch)
    suspend_ai(monkeypatch)
    suspend_vault(monkeypatch)
    headers, _, email = await signup(async_client, "keeps_writing")

    created = await async_client.post("/journal/", json={"message": _BODY}, headers=headers)
    assert created.status_code == HTTPStatus.CREATED, created.text
    entry_id = created.json()["id"]
    read = await async_client.get(f"/journal/{entry_id}", headers=headers)
    assert read.status_code == HTTPStatus.OK, read.text
    assert read.json()["message"] == _BODY
    edited_body = f"{_BODY} And again."
    edited = await async_client.patch(
        f"/journal/{entry_id}", json={"message": edited_body}, headers=headers
    )
    assert edited.status_code == HTTPStatus.OK, edited.text
    exported = await async_client.get("/users/me/export", headers=headers)
    assert exported.status_code == HTTPStatus.OK, exported.text
    assert edited_body in exported.text
    deleted = await async_client.request(
        "DELETE", "/users/me", json={"confirm_email": email}, headers=headers
    )
    assert deleted.status_code == HTTPStatus.OK, deleted.text


@pytest.mark.asyncio
async def test_classification_degrades_under_suspension(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A consented write that would classify is saved; the classifier simply never dials.

    The control at the end proves the suspended write *would* have dialled: the
    same request with the switch off reaches the provider.
    """
    stub = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "classified")
    consent = await async_client.put(
        f"/corpus/consent/{CorpusSource.JOURNAL.value}", json={"granted": True}, headers=headers
    )
    assert consent.status_code == HTTPStatus.OK, consent.text
    suspend_ai(monkeypatch)

    created = await async_client.post("/journal/", json={"message": _BODY}, headers=headers)

    assert created.status_code == HTTPStatus.CREATED, created.text
    assert stub.request_count == 0
    stored = await db_session.execute(
        select(func.count()).select_from(JournalEntry).where(col(JournalEntry.user_id) == user_id)
    )
    assert stored.scalar_one() == 1

    monkeypatch.delenv(EXTERNAL_AI_SUSPEND_ENV_VAR)
    control = await async_client.post("/journal/", json={"message": _BODY}, headers=headers)
    assert control.status_code == HTTPStatus.CREATED, control.text
    assert stub.request_count >= 1


@pytest.mark.asyncio
async def test_consent_grant_under_suspension_records_and_leaves_backlog_unmarked(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The grant is recorded; its backfill sweep stops without demoting any entry."""
    stub = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "suspended_grant")
    entry_id = await seed_entry(db_session, user_id)
    suspend_ai(monkeypatch)

    granted = await async_client.put(
        f"/corpus/consent/{CorpusSource.JOURNAL.value}", json={"granted": True}, headers=headers
    )

    assert granted.status_code == HTTPStatus.OK, granted.text
    assert stub.request_count == 0
    await db_session.rollback()
    entry = await db_session.get(JournalEntry, entry_id)
    assert entry is not None
    await db_session.refresh(entry)
    assert entry.corpus_attempted_at is None


# --- T6: parsing fails closed ----------------------------------------------------


@pytest.mark.parametrize("value", ["1", "yes", "TRUE ", "garbage", "off", "0", "on", "true"])
def test_malformed_switch_value_fails_closed(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    """Anything that is not unset, empty or ``false`` suspends; failure never broadens."""
    monkeypatch.setenv(EXTERNAL_AI_SUSPEND_ENV_VAR, value)
    monkeypatch.setenv(VAULT_SEND_SUSPEND_ENV_VAR, value)

    assert external_ai_suspended() is True
    assert vault_send_suspended() is True


@pytest.mark.parametrize("value", [None, "", "false", " FALSE "])
def test_unset_empty_false_are_off(monkeypatch: pytest.MonkeyPatch, value: str | None) -> None:
    """Only the absence of a decision, or an explicit ``false``, leaves a switch off."""
    for var in (EXTERNAL_AI_SUSPEND_ENV_VAR, VAULT_SEND_SUSPEND_ENV_VAR):
        if value is None:
            monkeypatch.delenv(var, raising=False)
        else:
            monkeypatch.setenv(var, value)

    assert external_ai_suspended() is False
    assert vault_send_suspended() is False


def test_malformed_value_logged_by_name_only(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The operator learns which switch they mistyped, never what they typed."""
    monkeypatch.delenv(EXTERNAL_AI_SUSPEND_ENV_VAR, raising=False)
    monkeypatch.setenv(VAULT_SEND_SUSPEND_ENV_VAR, "garbage")

    with caplog.at_level(logging.INFO):
        log_suspension_state()

    messages = [record.getMessage() for record in caplog.records]
    assert any(
        VAULT_SEND_SUSPEND_ENV_VAR in message and "treated_as=suspended" in message
        for message in messages
    ), messages
    assert not any("garbage" in message for message in messages)
    assert sum(message.startswith("privacy_suspension_state") for message in messages) == 1


# --- T7: the vault refuses content and keeps withdrawing -------------------------


class _VaultRecorder:
    """A Creek fake that answers the capability probe and records everything else."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "GET":
            minor = ".".join(CONTRACT_VERSION.split(".")[:2])
            return httpx.Response(
                HTTPStatus.OK,
                json={
                    "vault": {"available": True},
                    "capabilities": list(_ALL_CAPABILITIES),
                    "contract_version": CONTRACT_VERSION,
                    "contract_minor": minor,
                    "supported_contract_minors": [minor],
                    "ontology_version": "aptitude-wavelength/2026-05-23",
                    "attestation": None,
                },
            )
        return httpx.Response(HTTPStatus.OK, json={"status": "ok"})

    def methods(self) -> list[str]:
        """The HTTP method of every request that reached the fake, in order."""
        return [request.method for request in self.requests]


async def handshaken_vault(recorder: _VaultRecorder) -> HttpCreekVaultClient:
    """A vault client that has negotiated every capability against ``recorder``."""
    http = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    client = HttpCreekVaultClient(_VAULT_URL, _VAULT_CREDENTIAL, http_client=http)
    assert (await client.handshake()).available is True
    return client


def _content_verbs(client: HttpCreekVaultClient) -> list[Callable[[], Any]]:
    """Every content-bearing verb, each bound to a minimal valid request."""
    personal = VaultTierCeiling.PERSONAL
    return [
        lambda: client.ingest(
            VaultIngestRequest(
                entry_id=1, body=_BODY, tier=personal, tier_ceiling=personal, created_at=_CREATED_AT
            )
        ),
        lambda: client.reflect(_BODY, personal),
        lambda: client.upsert_voice_draft(
            VaultVoiceDraftRequest(
                external_id=_VOICE_DRAFT_ID, content=_BODY, tier=personal, tier_ceiling=personal
            )
        ),
        lambda: client.upload(
            VaultUploadRequest(
                external_id=upload_external_id(1, "page.txt"),
                filename="page.txt",
                content_base64="aGVsbG8=",
                tier=personal,
                tier_ceiling=personal,
                created_at=_CREATED_AT,
            )
        ),
    ]


@pytest.mark.asyncio
async def test_vault_send_suspended_refuses_content_and_allows_withdraw(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ingest, reflect, voice-draft upsert and upload refuse; both deletions still go out."""
    recorder = _VaultRecorder()
    client = await handshaken_vault(recorder)
    suspend_vault(monkeypatch)

    for verb in _content_verbs(client):
        with pytest.raises(VaultSendSuspendedError) as raised:
            await verb()
        assert isinstance(raised.value, CreekVaultUnavailableError)
    assert recorder.methods() == ["GET"]

    await client.withdraw_journal_entry(_WITHDRAWN_ENTRY)
    await client.delete_voice_draft(_VOICE_DRAFT_ID, VaultTierCeiling.PERSONAL)

    assert recorder.methods() == ["GET", "DELETE", "DELETE"]
    assert all(request.content == b"" for request in recorder.requests[1:])
    assert recorder.requests[1].url.path.endswith(f"/{_WITHDRAWN_ENTRY}")


@pytest.mark.parametrize(
    ("method", "body", "expected"),
    [
        ("GET", None, False),
        ("DELETE", None, False),
        ("DELETE", {"body": _BODY}, True),
        ("GET", {"body": _BODY}, True),
        ("PUT", None, True),
        ("post", None, True),
        ("PATCH", None, True),
    ],
)
def test_content_bearing_rule_is_structural(
    method: str, body: dict[str, str] | None, expected: bool
) -> None:
    """A body on any method is content; so is any write method, body or not.

    The rule the request site applies, pinned on its own because no verb sends a
    body on a DELETE today -- and nothing else would notice the day one did.
    """
    assert carries_content(method, body) is expected


@pytest.mark.asyncio
async def test_content_flows_when_vault_send_is_not_suspended(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The control for the test above: the same ingest is sent when the switch is off."""
    monkeypatch.delenv(VAULT_SEND_SUSPEND_ENV_VAR, raising=False)
    recorder = _VaultRecorder()
    client = await handshaken_vault(recorder)

    # The fake's bare ``{"status": "ok"}`` is no stored acknowledgement, so the
    # result reads as not stored; what matters is that the PUT was sent at all.
    await _content_verbs(client)[0]()

    assert "PUT" in recorder.methods()


# --- T8: admin probe and boot log ------------------------------------------------


@pytest.mark.asyncio
async def test_admin_privacy_suspensions_endpoint(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Admins read the switch state, content-free; everyone else is refused."""
    member, _, _ = await signup(async_client, "probe_member")
    admin, admin_id, _ = await signup(async_client, "probe_admin")
    user = await db_session.get(User, admin_id)
    assert user is not None
    user.is_admin = True
    db_session.add(user)
    await db_session.commit()
    suspend_ai(monkeypatch)
    monkeypatch.delenv(VAULT_SEND_SUSPEND_ENV_VAR, raising=False)

    refused = await async_client.get("/admin/privacy-suspensions", headers=member)
    visible = await async_client.get("/admin/privacy-suspensions", headers=admin)

    assert refused.status_code == HTTPStatus.FORBIDDEN
    assert visible.status_code == HTTPStatus.OK, visible.text
    assert visible.json() == {"external_ai_suspended": True, "vault_send_suspended": False}


@pytest.mark.asyncio
async def test_boot_logs_suspension_state(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The real lifespan names the active switches once, by name only."""
    suspend_ai(monkeypatch)
    monkeypatch.delenv(VAULT_SEND_SUSPEND_ENV_VAR, raising=False)
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)

    with (
        caplog.at_level(logging.INFO),
        patch("main.async_session_factory", new=factory),
        patch("main.require_database_schema_current", new=AsyncMock()),
    ):
        async with lifespan(app):
            pass

    states = [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("privacy_suspension_state")
    ]
    assert len(states) == 1, states
    assert EXTERNAL_AI_SUSPEND_ENV_VAR in states[0]
    assert VAULT_SEND_SUSPEND_ENV_VAR not in states[0]
