"""Without the writer's own key, nothing they wrote reaches a cloud model (ADR 0009 phase (a)).

The owner's words (B12, #3066): people may use Anthropic or OpenAI "by adding a
key in the settings", and otherwise "NONE of their data" is given to a cloud
model. Before phase (a) a request carrying no key of the writer's own was paid
for by the server's ``LLM_API_KEY`` and dialled the vendor anyway. This file is
phase (a)'s exit test for #3067: on a server that is as cloud-ready as a
deployment can be -- a real provider configured, ``LLM_API_KEY`` set, the stub
seam disarmed -- a request with no key of the writer's own builds no SDK client,
sends no request, opens no socket and resolves no host, on every path that
carries a person's content: chat (the leaf), marginalia, essays, completion
detection, frequency classification on create, edit and backfill, and
transcription.

Three independent spies, so no single blind spot can make the claim vacuous:

* the **provider factories** (``openai.AsyncOpenAI`` / ``anthropic.AsyncAnthropic``)
  record every client built;
* each SDK's **transport** counts every request that reaches it;
* the **socket layer** records every non-loopback ``connect`` and every lookup of
  a host that is not this machine.

Each family carries a counterweight that sends the same request *with* the
writer's own key and watches the spies fire, and the socket layer has its own
(a real lookup and a real connect to unroutable addresses), so a spy that
cannot see a dial fails here rather than passing everything.

The second claim is B07 provenance, and it is narrower than "non-cloud": a
BotMason credit debit stands only beside a receipt that names a
**vault-answered** source, never the app's own provider. Credits pay only when
the caller's vault answers; whether the vault itself uses a cloud model is the
vault's boundary (``CREEK_DOWNSTREAM_MODEL``, under the Creek deployment's
``CREEK_CLOUD_CONSENT``), and is not yet verified per receipt -- a known gap
escalated to the owner. A keyless request the app's provider would have
answered is refused before the wallet is touched, and a caller-paid one never
touches it.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import TYPE_CHECKING, Final, cast

import httpx
import pytest
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.creek_vault import (
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
)
from main import app
from models.corpus_fragment import CorpusSource
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaSource
from models.wallet_audit import WalletAudit
from services import botmason
from services.frequency_classification import UNCLASSIFIED, classify_frequencies
from services.reflection_boundary import ReflectionBoundary
from tests.incident.test_privacy_suspension import (
    _call_route,
    seed_entry,
    signup,
    suspend_ai,
)
from tests.provider_transport import (
    ANTHROPIC_KEY,
    OPENAI_KEY,
    TransportStub,
    use_anthropic,
    use_openai,
)
from tests.support.reflecting_vault import ReflectingVaultClient
from tests.transcription_helpers import PNG_BYTES, payload

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession

_BODY: Final = "I meditated by the river and the willow bent without breaking."
_QUOTE: Final = "the willow bent without breaking"
_VAULT_NOTE: Final = "The vault reads this passage back."
_ROUTES: Final = ("resonance", "essay", "detect", "transcribe")
#: The routes that still relay the writer's key to the vendor from the server.
#: Page reading left this set in phase (a)'s second half: the device calls the
#: vendor itself, so the server has no key to forward (#3067).
_RELAYED_ROUTES: Final = ("resonance", "essay", "detect")
_KEY_HEADER: Final = "X-LLM-API-Key"
_TRANSCRIBE: Final = "/journal/transcribe-page"
_DIRECT_ADMISSION: Final = "/journal/transcribe-page/direct-admission"
_LOCAL_HOSTS: Final = frozenset({"localhost", "localhost.localdomain", "testserver", ""})

#: A notes reply both SDKs can carry, so a BYOK counterweight pass succeeds.
_NOTES_JSON: Final = (
    '{"notes": [{"kind": "theme", "quote": "' + _QUOTE + '", "note": "It holds."}]}'
)
_OPENAI_OK: Final[dict[str, object]] = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "created": 0,
    "model": "gpt-4o-mini",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": _NOTES_JSON},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}
_ANTHROPIC_OK: Final[dict[str, object]] = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": "claude-sonnet-5",
    "content": [{"type": "text", "text": _NOTES_JSON}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 1, "output_tokens": 1},
}

#: The receipt sources that name the app's own provider. A credit may never stand
#: beside one of these. This does NOT prove a vault-answered receipt is
#: non-cloud: the vault's own model routing is outside what a receipt records.
_APP_PROVIDER_SOURCES: Final = frozenset({MarginaliaSource.APP_PROVIDER.value})


@dataclass
class EgressSpy:
    """Everything a dial would leave behind, at three layers."""

    stubs: list[TransportStub]
    clients: list[str] = field(default_factory=list)
    connects: list[tuple[object, ...]] = field(default_factory=list)
    lookups: list[str] = field(default_factory=list)

    def requests(self) -> int:
        """Requests that reached either provider's transport."""
        return sum(stub.request_count for stub in self.stubs)

    def assert_silent(self) -> None:
        """No client built, no request sent, no socket opened, no host resolved."""
        assert self.clients == [], f"SDK clients built without the writer's key: {self.clients}"
        assert self.requests() == 0, "a provider transport was reached without the writer's key"
        assert self.connects == [], f"non-loopback sockets opened: {self.connects}"
        assert self.lookups == [], f"external hosts resolved: {self.lookups}"


def _is_loopback(host: object) -> bool:
    """Whether ``host`` names this machine (an address or a local name)."""
    text = str(host).strip("[]").lower()
    if text in _LOCAL_HOSTS:
        return True
    try:
        return ipaddress.ip_address(text).is_loopback
    except ValueError:
        return False


def _spy_on_sockets(monkeypatch: pytest.MonkeyPatch, spy: EgressSpy) -> None:
    """Record every outbound connect and every lookup that is not this machine."""
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_getaddrinfo = socket.getaddrinfo

    def _note(address: object) -> None:
        if isinstance(address, tuple) and address and not _is_loopback(address[0]):
            spy.connects.append(address)

    def _connect(self: socket.socket, address: tuple[object, ...] | str) -> None:
        _note(address)
        real_connect(self, address)

    def _connect_ex(self: socket.socket, address: tuple[object, ...] | str) -> int:
        _note(address)
        return real_connect_ex(self, address)

    def _getaddrinfo(
        host: bytes | str | None, port: bytes | str | int | None, *args: int, **kwargs: int
    ) -> object:
        if host is not None and not _is_loopback(host):
            spy.lookups.append(str(host))
        return real_getaddrinfo(host, port, *args, **kwargs)

    monkeypatch.setattr(socket.socket, "connect", _connect)
    monkeypatch.setattr(socket.socket, "connect_ex", _connect_ex)
    monkeypatch.setattr(socket, "getaddrinfo", _getaddrinfo)


def _spy_on_factories(monkeypatch: pytest.MonkeyPatch, spy: EgressSpy) -> None:
    """Wrap both installed SDK factories so every client built is named."""
    built_openai = botmason.openai.AsyncOpenAI
    built_anthropic = botmason.anthropic.AsyncAnthropic

    def _openai(**kwargs: object) -> object:
        spy.clients.append("openai")
        return cast("Callable[..., object]", built_openai)(**kwargs)

    def _anthropic(**kwargs: object) -> object:
        spy.clients.append("anthropic")
        return cast("Callable[..., object]", built_anthropic)(**kwargs)

    monkeypatch.setattr(botmason.openai, "AsyncOpenAI", _openai)
    monkeypatch.setattr(botmason.anthropic, "AsyncAnthropic", _anthropic)


@pytest.fixture
def cloud_ready(monkeypatch: pytest.MonkeyPatch) -> Iterator[EgressSpy]:
    """A server as able to dial as a deployment can be, with every egress layer watched.

    Both SDKs point at counting mock transports, the server's provider is
    OpenAI with its own ``LLM_API_KEY`` set, and the stub seam is disarmed, so
    the only thing between a keyless request and a vendor is the rule under
    test.
    """
    anthropic_stub = use_anthropic(monkeypatch, HTTPStatus.OK, _ANTHROPIC_OK)
    openai_stub = use_openai(monkeypatch, HTTPStatus.OK, _OPENAI_OK)
    monkeypatch.setenv("LLM_API_KEY", OPENAI_KEY)
    monkeypatch.delenv(botmason.STUB_SEAM_ENV_VAR, raising=False)
    # Each provider's own default model, so a key of either kind is servable.
    monkeypatch.delenv("LLM_MODEL", raising=False)
    spy = EgressSpy(stubs=[openai_stub, anthropic_stub])
    _spy_on_factories(monkeypatch, spy)
    _spy_on_sockets(monkeypatch, spy)
    yield spy
    app.dependency_overrides.pop(get_creek_vault_client, None)
    app.dependency_overrides.pop(get_reflection_boundary, None)


async def _audit_rows(session: AsyncSession, user_id: int) -> list[WalletAudit]:
    await session.rollback()
    result = await session.execute(
        select(WalletAudit).where(col(WalletAudit.user_id) == user_id).order_by(col(WalletAudit.id))
    )
    return list(result.scalars().all())


# --- the socket spy's own counterweight ----------------------------------------


_UNRESOLVABLE_HOST: Final = "vendor.invalid"
#: TEST-NET-1 (RFC 5737): routable syntax, never answered.
_UNROUTABLE_ADDRESS: Final = "192.0.2.1"
_DIAL_TIMEOUT_SECONDS: Final = 0.2


@pytest.mark.asyncio
async def test_the_socket_spy_records_a_real_lookup_and_a_real_connect(
    cloud_ready: EgressSpy,
) -> None:
    """A dial that bypasses both SDK factories is still seen at the socket layer."""
    with pytest.raises(socket.gaierror):
        socket.getaddrinfo(_UNRESOLVABLE_HOST, 443)
    with pytest.raises(httpx.HTTPError):
        async with httpx.AsyncClient(timeout=_DIAL_TIMEOUT_SECONDS, trust_env=False) as client:
            await client.get(f"http://{_UNROUTABLE_ADDRESS}/")

    assert _UNRESOLVABLE_HOST in cloud_ready.lookups
    assert any(address[0] == _UNROUTABLE_ADDRESS for address in cloud_ready.connects)


# --- chat: the leaf every feature funnels through ------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("with_image", [False, True])
async def test_the_leaf_builds_no_client_without_the_writers_key(
    cloud_ready: EgressSpy, *, with_image: bool
) -> None:
    """``generate_response`` with no key refuses ``llm_key_required`` before any client exists."""
    images = (
        [botmason.ImagePayload(media_type="image/png", data="aGVsbG8=")] if with_image else None
    )

    with pytest.raises(botmason.NoGenerationSourceError) as raised:
        await botmason.generate_response(_BODY, [], images=images)

    assert str(raised.value) == botmason.KEY_REQUIRED_DETAIL
    cloud_ready.assert_silent()


@pytest.mark.asyncio
async def test_no_text_in_a_keyless_prompt_can_select_a_provider(
    cloud_ready: EgressSpy, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The retired provider probe's marker, armed as it once was, dials nothing.

    The probe sent a keyless prompt carrying ``<token>:<provider>`` past the stub
    on the server's own key. Phase (a) retired it with the fallback it rode on.
    """
    token = "probe-token-armed-long-enough-0123456789"  # pragma: allowlist secret
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.setenv("BOTMASON_PROVIDER_PROBE_TOKEN", token)

    with pytest.raises(botmason.NoGenerationSourceError):
        await botmason.generate_response(f"{token}:anthropic {_BODY}", [])

    cloud_ready.assert_silent()


@pytest.mark.asyncio
@pytest.mark.parametrize(("key", "client"), [(OPENAI_KEY, "openai"), (ANTHROPIC_KEY, "anthropic")])
async def test_the_leaf_counterweight_dials_with_the_writers_key(
    cloud_ready: EgressSpy, key: str, client: str
) -> None:
    """The spies are live: the same call with the writer's key builds a client and sends."""
    response = await botmason.generate_response(_BODY, [], api_key=key)

    assert response.provider == client
    assert cloud_ready.clients == [client]
    assert cloud_ready.requests() == 1


def test_the_server_offers_no_keyless_generation_once_the_seam_is_disarmed(
    cloud_ready: EgressSpy,
) -> None:
    """A configured provider and ``LLM_API_KEY`` buy a keyless request nothing."""
    assert botmason.server_generation_available() is False
    assert botmason.resolve_chat_api_key(None) is None
    cloud_ready.assert_silent()


# --- the AI routes: marginalia, essays, completion detection, transcription -----


@pytest.mark.asyncio
@pytest.mark.parametrize("route", _ROUTES)
async def test_every_ai_route_refuses_a_keyless_request_with_no_dial(
    async_client: AsyncClient,
    db_session: AsyncSession,
    cloud_ready: EgressSpy,
    route: str,
) -> None:
    """402 ``llm_key_required``, nothing dialled, nothing charged."""
    headers, user_id, _ = await signup(async_client, f"keyless_{route}")

    resp = await _call_route(route, async_client, db_session, headers, user_id)

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert resp.json() == {"detail": botmason.KEY_REQUIRED_DETAIL}
    cloud_ready.assert_silent()
    assert await _audit_rows(db_session, user_id) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("route", _RELAYED_ROUTES)
async def test_every_ai_route_counterweight_dials_with_the_writers_key(
    async_client: AsyncClient,
    db_session: AsyncSession,
    cloud_ready: EgressSpy,
    route: str,
) -> None:
    """The same request carrying the writer's key reaches the vendor, so the spies can see."""
    headers, user_id, _ = await signup(async_client, f"byok_{route}")

    await _call_route(
        route, async_client, db_session, {**headers, "X-LLM-API-Key": OPENAI_KEY}, user_id
    )

    assert "openai" in cloud_ready.clients
    assert cloud_ready.requests() >= 1


# --- frequency classification: on create, on edit, and the consent backfill -----


@pytest.mark.asyncio
async def test_classification_on_create_edit_and_backfill_makes_no_cloud_call(
    async_client: AsyncClient,
    db_session: AsyncSession,
    cloud_ready: EgressSpy,
) -> None:
    """Consented writing is saved and simply left unclassified; nothing is dialled."""
    headers, user_id, _ = await signup(async_client, "keyless_classified")
    backlog_id = await seed_entry(db_session, user_id)

    granted = await async_client.put(
        f"/corpus/consent/{CorpusSource.JOURNAL.value}", json={"granted": True}, headers=headers
    )
    created = await async_client.post("/journal/", json={"message": _BODY}, headers=headers)
    assert created.status_code == HTTPStatus.CREATED, created.text
    edited = await async_client.patch(
        f"/journal/{created.json()['id']}", json={"message": f"{_BODY} Again."}, headers=headers
    )

    assert granted.status_code == HTTPStatus.OK, granted.text
    assert edited.status_code == HTTPStatus.OK, edited.text
    cloud_ready.assert_silent()
    await db_session.rollback()
    stored = await db_session.execute(
        select(col(JournalEntry.id)).where(col(JournalEntry.user_id) == user_id)
    )
    assert backlog_id in set(stored.scalars().all())


@pytest.mark.asyncio
async def test_the_classifier_degrades_without_a_key_and_dials_with_one(
    cloud_ready: EgressSpy,
) -> None:
    """Keyless: unclassified and silent. With the writer's key: the vendor is asked."""
    keyless = await classify_frequencies(_BODY, classification="personal")

    assert keyless == UNCLASSIFIED
    cloud_ready.assert_silent()

    await classify_frequencies(_BODY, classification="personal", api_key=OPENAI_KEY)
    assert cloud_ready.clients == ["openai"]
    assert cloud_ready.requests() == 1


# --- B07 provenance: a credit debit stands only beside a vault-answered receipt -


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


async def _settled_debits(session: AsyncSession, user_id: int) -> int:
    """Units the wallet kept: spends minus the refunds that settled them."""
    rows = await _audit_rows(session, user_id)
    return sum(1 if row.reason.startswith("spend_") else -1 for row in rows)


async def _note_sources(session: AsyncSession, user_id: int) -> set[str | None]:
    await session.rollback()
    result = await session.execute(
        select(col(Marginalia.source)).where(col(Marginalia.user_id) == user_id)
    )
    return set(result.scalars().all())


@pytest.mark.asyncio
async def test_a_credit_debit_stands_only_beside_a_vault_answered_receipt(
    async_client: AsyncClient,
    db_session: AsyncSession,
    cloud_ready: EgressSpy,
) -> None:
    """Keyless app provider: refused, uncharged. BYOK: cloud, uncharged. Vault: charged, local."""
    keyless_headers, keyless_id, _ = await signup(async_client, "debit_keyless")
    keyless_entry = await seed_entry(db_session, keyless_id)
    refused = await async_client.post(
        f"/journal/{keyless_entry}/resonance", headers=keyless_headers
    )
    assert refused.status_code == HTTPStatus.PAYMENT_REQUIRED, refused.text
    cloud_ready.assert_silent()

    byok_headers, byok_id, _ = await signup(async_client, "debit_byok")
    byok_entry = await seed_entry(db_session, byok_id)
    paid_by_key = await async_client.post(
        f"/journal/{byok_entry}/resonance",
        headers={**byok_headers, "X-LLM-API-Key": OPENAI_KEY},
    )
    assert paid_by_key.status_code == HTTPStatus.OK, paid_by_key.text
    assert paid_by_key.json()["provenance"]["paid_by"] == "own_key"
    assert cloud_ready.requests() >= 1

    vault_headers, vault_id, _ = await signup(async_client, "debit_vault")
    vault_entry = await seed_entry(db_session, vault_id)
    app.dependency_overrides[get_creek_vault_client] = _vault_with_note
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.VAULT_BOUND
    paid_by_credit = await async_client.post(
        f"/journal/{vault_entry}/resonance", headers=vault_headers
    )
    assert paid_by_credit.status_code == HTTPStatus.OK, paid_by_credit.text
    assert paid_by_credit.json()["provenance"]["paid_by"] == "wallet"

    assert await _settled_debits(db_session, keyless_id) == 0
    assert await _settled_debits(db_session, byok_id) == 0
    assert await _settled_debits(db_session, vault_id) == 1
    assert await _note_sources(db_session, vault_id) == {MarginaliaSource.CREEK_VAULT.value}
    for user_id in (keyless_id, byok_id, vault_id):
        if await _settled_debits(db_session, user_id):
            assert not (await _note_sources(db_session, user_id)) & _APP_PROVIDER_SOURCES


# --- page reading is client-direct: the server never takes the key ------------


def _declared_headers(path: str) -> set[str]:
    """The header parameters the route at ``path`` declares in the live schema."""
    operation = app.openapi()["paths"][path]["post"]
    return {
        str(parameter["name"]).lower()
        for parameter in operation.get("parameters", [])
        if parameter.get("in") == "header"
    }


def test_the_page_read_route_declares_no_key_header() -> None:
    """The server no longer accepts a key for a page read; a relayed route still does.

    The relayed route is the counterweight: it shows the schema check can see a
    declared key header at all, so the page-read half is not vacuously empty.
    """
    assert _KEY_HEADER.lower() not in _declared_headers(_TRANSCRIBE)
    assert _KEY_HEADER.lower() in _declared_headers("/journal/{entry_id}/resonance")


@pytest.mark.asyncio
@pytest.mark.parametrize("key", [OPENAI_KEY, ANTHROPIC_KEY], ids=["openai", "anthropic"])
async def test_a_key_sent_anyway_with_a_page_is_never_forwarded_or_logged(
    async_client: AsyncClient,
    db_session: AsyncSession,
    cloud_ready: EgressSpy,
    caplog: pytest.LogCaptureFixture,
    key: str,
) -> None:
    """A stale client's header is not a payer: refused keyless, nothing dialled or logged."""
    headers, user_id, _ = await signup(async_client, f"stale_header_{key[:6]}")

    with caplog.at_level(logging.DEBUG):
        resp = await async_client.post(
            _TRANSCRIBE,
            headers={**headers, _KEY_HEADER: key},
            json=payload(PNG_BYTES, "image/png"),
        )

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert resp.json() == {"detail": botmason.KEY_REQUIRED_DETAIL}
    assert key not in resp.text
    cloud_ready.assert_silent()
    assert await _audit_rows(db_session, user_id) == []
    for record in caplog.records:
        assert key not in record.getMessage()
        assert key not in str(record.__dict__)


@pytest.mark.asyncio
async def test_the_direct_admission_carries_nothing_and_admits(
    async_client: AsyncClient, cloud_ready: EgressSpy
) -> None:
    """204 with an empty body: the device may call its vendor; the server dials nothing."""
    headers, _, _ = await signup(async_client, "direct_admitted")

    resp = await async_client.post(_DIRECT_ADMISSION, headers=headers)

    assert resp.status_code == HTTPStatus.NO_CONTENT, resp.text
    assert resp.content == b""
    assert _KEY_HEADER.lower() not in _declared_headers(_DIRECT_ADMISSION)
    cloud_ready.assert_silent()


@pytest.mark.asyncio
async def test_the_direct_admission_refuses_while_external_ai_is_suspended(
    async_client: AsyncClient, cloud_ready: EgressSpy, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The operator's incident switch still stops a page read the device would send itself."""
    headers, _, _ = await signup(async_client, "direct_suspended")
    suspend_ai(monkeypatch)

    resp = await async_client.post(_DIRECT_ADMISSION, headers=headers)

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE, resp.text
    assert resp.json() == {"detail": "ai_suspended"}
    cloud_ready.assert_silent()


@pytest.mark.asyncio
async def test_the_direct_admission_requires_a_session(async_client: AsyncClient) -> None:
    """An anonymous caller is refused before anything else."""
    resp = await async_client.post(_DIRECT_ADMISSION)

    assert resp.status_code == HTTPStatus.UNAUTHORIZED
