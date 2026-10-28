"""A vault-bound writer's essays, corpus and page reads never reach the app provider (#3156).

Wave 34b (#3085) bound reflection and completion detection to the writer's
vault. Three operations still dialled the app provider whatever the boundary:
essay expansion built the adapter directly, and corpus classification and page
transcription call the provider's ``generate_response`` without the adapter at
all. Each now answers a vault-bound writer from the vault or not at all. No
vault advertises a classification adepthood may call or a transcription today,
so those fail closed; a letter is written by a vault that advertises
``letters`` (#3203, ``tests/test_vault_written_letters.py``) and fails closed
here, where the writer's vault cannot be reached.

Every forbidden-effect assertion here is made at the route, with a recording
spy on the module binding the operation actually dials through, and each spy
has a counterweight that sends the same request app-provider-bound and watches
it fire -- so a spy that could not see a dial fails here instead of passing.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from main import app
from models.corpus_fragment import CorpusFragment, CorpusSource
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from models.wallet_audit import WalletAudit
from routers import transcription as transcription_router
from services import frequency_classification
from services import marginalia as marginalia_service
from services.botmason import LLMResponse
from services.corpus_consent import set_consent
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_telemetry import VaultTelemetryOutcome
from services.reflection_boundary import REFLECTION_SOURCE_UNAVAILABLE, ReflectionBoundary
from services.user_vault_config import store_vault_config
from tests.provider_transport import OPENAI_KEY
from tests.support.fake_llm import real_provider_response
from tests.transcription_helpers import PNG_BYTES, payload

_PASSWORD = "secret12345"  # pragma: allowlist secret
_BODY = "SENTINEL_BODY_3156 the willow bent by the river and did not break."
_EDITED = "SENTINEL_EDIT_3156 the river rose and the willow held."
_LETTER = "SENTINEL_LETTER_3156 a warm letter about bending."
_PRICED = {"price_acknowledged": True}
_BYOK = {"X-LLM-API-Key": OPENAI_KEY}
_CLASSIFIER_REPLY = '{"weights": {"F4": 0.8}, "overall_confidence": 0.9}'
_VAULT_URL = "https://vault.example.test"
_VAULT_KEY = "creek-vault-3156-unit-key"  # pragma: allowlist secret
_SENTINELS = ("SENTINEL_BODY_3156", "SENTINEL_EDIT_3156", "SENTINEL_LETTER_3156", OPENAI_KEY)


class _Dials:
    """Records every provider dial made through one module's ``generate_response`` binding."""

    def __init__(self, text: str) -> None:
        """Answer every dial with ``text``, as a real provider would."""
        self.text = text
        self.calls = 0

    async def __call__(self, *_args: object, **_kwargs: object) -> LLMResponse:
        """Count the dial and answer it."""
        self.calls += 1
        return real_provider_response(self.text)


@pytest.fixture
def essay_dials(monkeypatch: pytest.MonkeyPatch) -> _Dials:
    """Spy on the dial the essay adapter makes."""
    dials = _Dials(_LETTER)
    monkeypatch.setattr(marginalia_service, "generate_response", dials)
    return dials


@pytest.fixture
def classifier_dials(monkeypatch: pytest.MonkeyPatch) -> _Dials:
    """Spy on the dial the frequency classifier makes."""
    dials = _Dials(_CLASSIFIER_REPLY)
    monkeypatch.setattr(frequency_classification, "generate_response", dials)
    return dials


@pytest.fixture
def transcription_dials(monkeypatch: pytest.MonkeyPatch) -> _Dials:
    """Spy on the dial page transcription makes."""
    dials = _Dials("The transcribed page.")
    monkeypatch.setattr(transcription_router, "generate_response", dials)
    return dials


@pytest.fixture
def no_real_vault() -> Iterator[None]:
    """Serve a vault client that dials nothing, so the boundary is the only vault fact in play."""
    app.dependency_overrides[get_creek_vault_client] = lambda: LocalFallbackCreekVaultClient(
        VaultTelemetryOutcome.FALLBACK_UNCONFIGURED
    )
    yield
    app.dependency_overrides.pop(get_creek_vault_client, None)


def _bind(boundary: ReflectionBoundary) -> None:
    """Pin the request boundary; the resolver is unit-tested in ``test_reflection_boundary``."""
    app.dependency_overrides[get_reflection_boundary] = lambda: boundary


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create an account and return its auth headers and id."""
    resp = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, int(data["user_id"])


async def _connect_vault(session: AsyncSession, user_id: int) -> None:
    """Give the account a stored vault connection: server state that makes it vault-bound."""
    await store_vault_config(
        session, user_id, vault_url=_VAULT_URL, api_key=_VAULT_KEY, provisioned=True
    )


async def _consent(session: AsyncSession, user_id: int) -> None:
    """Grant journal corpus consent directly, so no sweep runs as a side effect."""
    await set_consent(session, user_id=user_id, source=CorpusSource.JOURNAL, granted=True)
    await session.commit()


async def _seed_note(session: AsyncSession, user_id: int) -> int:
    """Seed one personal entry with one margin note; return the note id."""
    entry = JournalEntry(sender="user", user_id=user_id, message=_BODY)
    session.add(entry)
    await session.flush()
    note = Marginalia(
        journal_entry_id=entry.id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=6,
        anchor_text="SENTIN",
        note="A beginning.",
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    assert note.id is not None
    return note.id


async def _wallet(session: AsyncSession, user_id: int) -> tuple[int, int]:
    """(monthly messages used, offering balance), read fresh."""
    session.expire_all()
    user = (await session.execute(select(User).where(col(User.id) == user_id))).scalar_one()
    return user.monthly_messages_used, user.offering_balance


async def _audit_rows(session: AsyncSession, user_id: int) -> int:
    """How many wallet audit rows the account has: a staged-then-refunded charge leaves two."""
    result = await session.execute(
        select(func.count()).select_from(WalletAudit).where(col(WalletAudit.user_id) == user_id)
    )
    return int(result.scalar_one())


async def _fragments(session: AsyncSession, user_id: int) -> int:
    """How many corpus fragments the account holds."""
    result = await session.execute(
        select(func.count())
        .select_from(CorpusFragment)
        .where(col(CorpusFragment.user_id) == user_id)
    )
    return int(result.scalar_one())


def _assert_logs_carry_no_content(caplog: pytest.LogCaptureFixture) -> None:
    """No record -- message, args or extras -- carries writing, a letter or a key."""
    for record in caplog.records:
        rendered = f"{record.getMessage()} {record.__dict__}"
        for sentinel in _SENTINELS:
            assert sentinel not in rendered, f"{record.name} logged content: {record.msg}"


# --- essay expansion ---------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("headers_extra", [{}, _BYOK], ids=["server_paid", "byok"])
async def test_vault_bound_essay_never_dials_and_fails_closed_uncharged(
    async_client: AsyncClient,
    db_session: AsyncSession,
    essay_dials: _Dials,
    caplog: pytest.LogCaptureFixture,
    headers_extra: dict[str, str],
) -> None:
    """503 ``reflection_source_unavailable``, zero dials, ``essay IS NULL``, wallet untouched.

    The writer is bound to a vault this server cannot reach (no stored client
    resolves), so the refusal names ``unavailable``; a reachable vault that does
    not advertise ``letters`` names ``capability_missing`` instead (#3203).
    """
    headers, user_id = await _signup(async_client, f"vault_essay_{len(headers_extra)}")
    note_id = await _seed_note(db_session, user_id)
    _bind(ReflectionBoundary.VAULT_BOUND)
    before = await _wallet(db_session, user_id)
    caplog.set_level(logging.INFO)

    resp = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers={**headers, **headers_extra}, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert resp.json() == {"detail": REFLECTION_SOURCE_UNAVAILABLE}
    assert essay_dials.calls == 0
    db_session.expire_all()
    note = (
        await db_session.execute(select(Marginalia).where(col(Marginalia.id) == note_id))
    ).scalar_one()
    assert note.essay is None
    assert await _wallet(db_session, user_id) == before
    assert await _audit_rows(db_session, user_id) == 0
    refusals = [r for r in caplog.records if r.getMessage() == REFLECTION_SOURCE_UNAVAILABLE]
    assert len(refusals) == 1
    assert refusals[0].__dict__["user_id"] == user_id
    assert refusals[0].__dict__["id"] == note_id
    assert refusals[0].__dict__["operation"] == "essay"
    assert refusals[0].__dict__["reason"] == "unavailable"
    _assert_logs_carry_no_content(caplog)


@pytest.mark.asyncio
async def test_vault_bound_writer_still_reopens_a_letter_already_bought(
    async_client: AsyncClient, db_session: AsyncSession, essay_dials: _Dials
) -> None:
    """A cached letter is a read, not an AI operation: it reopens free and without a dial."""
    headers, user_id = await _signup(async_client, "vault_essay_cached")
    note_id = await _seed_note(db_session, user_id)
    _bind(ReflectionBoundary.APP_PROVIDER)
    bought = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json=_PRICED
    )
    assert bought.status_code == HTTPStatus.OK
    assert essay_dials.calls == 1, "the counterweight: an app-provider letter is dialled"
    _bind(ReflectionBoundary.VAULT_BOUND)

    reopened = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json=_PRICED
    )

    assert reopened.status_code == HTTPStatus.OK
    assert reopened.json()["essay"] == _LETTER
    assert essay_dials.calls == 1


# --- corpus classification ---------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_real_vault")
async def test_vault_bound_create_and_edit_never_classify_and_store_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    classifier_dials: _Dials,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A consented, vault-connected writer's create and edit make zero classifier dials."""
    headers, user_id = await _signup(async_client, "vault_corpus_write")
    await _connect_vault(db_session, user_id)
    await _consent(db_session, user_id)
    caplog.set_level(logging.INFO)

    created = await async_client.post("/journal/", json={"message": _BODY}, headers=headers)
    assert created.status_code == HTTPStatus.CREATED, created.text
    edited = await async_client.patch(
        f"/journal/{created.json()['id']}", json={"message": _EDITED}, headers=headers
    )
    assert edited.status_code == HTTPStatus.OK, edited.text

    assert classifier_dials.calls == 0
    assert await _fragments(db_session, user_id) == 0
    outcomes = [r.__dict__["outcome"] for r in caplog.records if r.getMessage() == "corpus_ingest"]
    assert outcomes == ["boundary_refused", "boundary_refused"]
    _assert_logs_carry_no_content(caplog)


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_real_vault")
async def test_app_provider_create_still_classifies_and_stores(
    async_client: AsyncClient, db_session: AsyncSession, classifier_dials: _Dials
) -> None:
    """The counterweight: the same consented create with no vault is classified, once."""
    headers, user_id = await _signup(async_client, "app_corpus_write")
    await _consent(db_session, user_id)

    created = await async_client.post("/journal/", json={"message": _BODY}, headers=headers)

    assert created.status_code == HTTPStatus.CREATED, created.text
    assert classifier_dials.calls == 1
    assert await _fragments(db_session, user_id) == 1


async def _seed_entry(session: AsyncSession, user_id: int) -> int:
    """Seed one personal entry written before consent; return its id."""
    entry = JournalEntry(sender="user", user_id=user_id, message=_BODY)
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    assert entry.id is not None
    return entry.id


async def _attempted_at(session: AsyncSession, entry_id: int) -> object:
    """The sweep's mark on one entry, read fresh."""
    session.expire_all()
    entry = (
        await session.execute(select(JournalEntry).where(col(JournalEntry.id) == entry_id))
    ).scalar_one()
    return entry.corpus_attempted_at


async def _grant(client: AsyncClient, headers: dict[str, str]) -> None:
    """Grant journal corpus consent through the route, which runs the backfill sweep."""
    resp = await client.put("/corpus/consent/journal", json={"granted": True}, headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text


@pytest.mark.asyncio
async def test_vault_bound_backfill_never_classifies_and_never_marks(
    async_client: AsyncClient,
    db_session: AsyncSession,
    classifier_dials: _Dials,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A vault-connected grant is recorded; its sweep makes no dial and leaves entries unmarked."""
    headers, user_id = await _signup(async_client, "backfill_vault_bound")
    entry_id = await _seed_entry(db_session, user_id)
    await _connect_vault(db_session, user_id)
    caplog.set_level(logging.INFO)

    await _grant(async_client, headers)

    assert classifier_dials.calls == 0
    assert await _fragments(db_session, user_id) == 0
    assert await _attempted_at(db_session, entry_id) is None
    stops = [r for r in caplog.records if r.getMessage() == "corpus_backfill_boundary_refused"]
    assert [(r.__dict__["user_id"], r.__dict__["reason"]) for r in stops] == [
        (user_id, "vault_bound")
    ]
    _assert_logs_carry_no_content(caplog)


@pytest.mark.asyncio
async def test_app_provider_backfill_still_classifies_and_marks(
    async_client: AsyncClient, db_session: AsyncSession, classifier_dials: _Dials
) -> None:
    """The counterweight: the same grant with no vault classifies the entry and marks it."""
    headers, user_id = await _signup(async_client, "backfill_app_provider")
    entry_id = await _seed_entry(db_session, user_id)

    await _grant(async_client, headers)

    assert classifier_dials.calls == 1
    assert await _fragments(db_session, user_id) == 1
    assert await _attempted_at(db_session, entry_id) is not None


# --- page transcription ------------------------------------------------------


async def _transcribe(client: AsyncClient, headers: dict[str, str]) -> tuple[int, object]:
    """Post one page with a BYOK key; return the status and the decoded body."""
    resp = await client.post(
        "/journal/transcribe-page",
        json=payload(PNG_BYTES, "image/png"),
        headers={**headers, **_BYOK},
    )
    return resp.status_code, resp.json()


@pytest.mark.asyncio
async def test_vault_bound_transcription_never_dials_and_charges_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    transcription_dials: _Dials,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A vault-connected writer's page is refused before the charge or the dial, key or not."""
    headers, user_id = await _signup(async_client, "transcribe_vault_bound")
    await _connect_vault(db_session, user_id)
    before = await _wallet(db_session, user_id)
    caplog.set_level(logging.INFO)

    status, body = await _transcribe(async_client, headers)

    assert status == HTTPStatus.SERVICE_UNAVAILABLE
    assert body == {"detail": REFLECTION_SOURCE_UNAVAILABLE}
    assert transcription_dials.calls == 0
    assert await _wallet(db_session, user_id) == before
    refusals = [r for r in caplog.records if r.getMessage() == REFLECTION_SOURCE_UNAVAILABLE]
    assert [
        (r.__dict__["user_id"], r.__dict__["operation"], r.__dict__["reason"]) for r in refusals
    ] == [(user_id, "transcription", "capability_missing")]
    _assert_logs_carry_no_content(caplog)


@pytest.mark.asyncio
async def test_app_provider_transcription_still_dials(
    async_client: AsyncClient, transcription_dials: _Dials
) -> None:
    """The counterweight: the same page with no vault is read, once."""
    headers, _ = await _signup(async_client, "transcribe_app_provider")

    status, _ = await _transcribe(async_client, headers)

    assert status == HTTPStatus.OK
    assert transcription_dials.calls == 1
