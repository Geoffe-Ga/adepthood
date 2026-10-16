"""Generation admission is bound to the payer route the writer was shown (#3385).

``GET /user/usage`` discloses ``resonance_route``: whether the writer's own key
pays the app provider or their vault answers on a wallet credit. The resonance
and letter POSTs used to resolve that boundary again on their own, so a vault
connected or disconnected from another client between the disclosure and
Continue could make a wallet pay after a key-funded disclosure, or send the
writing to the app provider after a vault disclosure.

A client now sends the route it disclosed (``disclosed_route``). A request
whose route no longer matches the server's is refused with the 409 its route
already uses for "the writer was not shown this price" -- before any charge,
slot, vault handshake or provider dial -- so the client rereads the route and
discloses again. The free answers still come first: an intimate entry's
privacy message, care for a distressed entry, and a cached letter.

Each test holds a GET, changes the route the way another client would, then
sends the POST carrying the held route.
"""

from __future__ import annotations

from collections.abc import Iterator
from http import HTTPStatus
from typing import Final

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.creek_vault import (
    OWNER_ENV_VAR,
    get_creek_vault_client,
    get_reflection_boundary,
)
from domain.creek_vault import (
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
)
from main import app
from models.journal_entry import JournalClassification
from models.llm_usage_log import LLMUsageLog
from models.wallet_audit import WalletAudit
from routers.journal import ESSAY_PRICE_UNACKNOWLEDGED
from services import creek_vault_url_resolution
from services import marginalia as marginalia_service
from services.botmason import LLMResponse
from services.generation_access import RESONANCE_PAYMENT_UNCONFIRMED
from services.reflection_boundary import ReflectionBoundary
from services.resonance_care import INTIMATE_PRIVATE_MESSAGE
from services.user_vault_config import store_vault_config
from tests.incident.test_privacy_suspension import (
    arm_anthropic,
    count_rows,
    seed_entry,
    seed_note,
    signup,
    wallet,
)
from tests.provider_transport import ANTHROPIC_KEY, TransportStub
from tests.support.fake_llm import real_provider_response
from tests.support.reflecting_vault import ReflectingVaultClient

_BYOK: Final = {"X-LLM-API-Key": ANTHROPIC_KEY}
_BODY: Final = "The heron waited at the edge of the reeds until the water stilled."
_DISTRESS_BODY: Final = "I keep thinking I want to kill myself and end my life tonight."
_QUOTE: Final = "The heron waited"
_VAULT_NOTE: Final = "The vault reads: patience, again, in your own words."
_APP_LETTER: Final = "A letter about waiting, written by the app provider."
_VAULT_URL: Final = "https://route-binding-vault.example.test"
_VAULT_KEY: Final = "route-binding-test-credential"  # pragma: allowlist secret
_APP: Final = ReflectionBoundary.APP_PROVIDER
_VAULT: Final = ReflectionBoundary.VAULT_BOUND


class _Route:
    """The server's boundary for every request, changed between requests by a test.

    ``vault`` is the client every request is served while the route is held.
    """

    def __init__(self, boundary: ReflectionBoundary, vault: ReflectingVaultClient) -> None:
        self.boundary = boundary
        self.vault = vault

    def __call__(self) -> ReflectionBoundary:
        return self.boundary


class _AppLetters:
    """Counts every essay dial to the app provider and answers as a real provider."""

    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, *_args: object, **_kwargs: object) -> LLMResponse:
        self.calls += 1
        return real_provider_response(_APP_LETTER)


def _answering_vault() -> ReflectingVaultClient:
    return ReflectingVaultClient(
        reflect_result=VaultReflection(
            status=VaultReflectionStatus.OK,
            notes=(VaultReflectionNote(kind="theme", quote=_QUOTE, note=_VAULT_NOTE),),
            essay=None,
            essay_grounded=False,
            routed_tier=VaultTierCeiling.PERSONAL,
        )
    )


@pytest.fixture
def vault() -> Iterator[ReflectingVaultClient]:
    """The vault client every request is served, recording each handshake and reflect."""
    client = _answering_vault()
    app.dependency_overrides[get_creek_vault_client] = lambda: client
    yield client
    app.dependency_overrides.pop(get_creek_vault_client, None)


@pytest.fixture
def route(vault: ReflectingVaultClient) -> Iterator[_Route]:
    """A server boundary the test moves, as another client's connect or disconnect would."""
    held = _Route(_APP, vault)
    app.dependency_overrides[get_reflection_boundary] = held
    yield held
    app.dependency_overrides.pop(get_reflection_boundary, None)


@pytest.fixture
def app_letters(monkeypatch: pytest.MonkeyPatch) -> _AppLetters:
    """Spy on the essay route's app-provider dial."""
    letters = _AppLetters()
    monkeypatch.setattr(marginalia_service, "generate_response", letters)
    return letters


class _Ledger:
    """What a refused request must leave alone: both buckets, the audit trail, the usage log."""

    def __init__(self, session: AsyncSession, user_id: int) -> None:
        self._session = session
        self._user_id = user_id
        self._before: tuple[tuple[int, int], int, int] | None = None

    async def _read(self) -> tuple[tuple[int, int], int, int]:
        return (
            await wallet(self._session, self._user_id),
            await count_rows(self._session, WalletAudit),
            await count_rows(self._session, LLMUsageLog),
        )

    async def snapshot(self) -> None:
        self._before = await self._read()

    async def assert_unchanged(self) -> None:
        assert self._before is not None
        assert await self._read() == self._before


async def _disclosed_route(client: AsyncClient, headers: dict[str, str]) -> str:
    """The route the payer disclosure shows the writer, read as the client reads it."""
    resp = await client.get("/user/usage", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    return str(resp.json()["resonance_route"])


async def _read(
    client: AsyncClient, headers: dict[str, str], entry_id: int, disclosed: str
) -> tuple[int, dict[str, object]]:
    resp = await client.post(
        f"/journal/{entry_id}/resonance", headers=headers, params={"disclosed_route": disclosed}
    )
    return resp.status_code, resp.json()


async def _letter(
    client: AsyncClient, headers: dict[str, str], note_id: int, disclosed: str
) -> tuple[int, dict[str, object]]:
    resp = await client.post(
        f"/journal/marginalia/{note_id}/essay",
        headers=headers,
        json={"price_acknowledged": True, "disclosed_route": disclosed},
    )
    return resp.status_code, resp.json()


def _assert_nothing_dialled(vault: ReflectingVaultClient, provider: TransportStub) -> None:
    assert vault.handshake_calls == 0
    assert vault.reflect_calls == []
    assert provider.request_count == 0


# --- The reading ----------------------------------------------------------


@pytest.mark.asyncio
async def test_a_reading_disclosed_as_key_funded_is_refused_once_a_vault_connects(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    vault: ReflectingVaultClient,
) -> None:
    """Connecting a vault elsewhere turns the key-funded reading into a credit: confirm it first."""
    monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    monkeypatch.delenv(OWNER_ENV_VAR, raising=False)

    async def no_lookup(_host: str) -> tuple[str, ...]:
        raise AssertionError("a refused reading must never resolve the vault host")

    monkeypatch.setattr(creek_vault_url_resolution, "resolve_host_addresses", no_lookup)
    provider = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "route_reading_connect")
    entry_id = await seed_entry(db_session, user_id, body=_BODY)
    disclosed = await _disclosed_route(async_client, headers)
    assert disclosed == _APP
    await store_vault_config(db_session, user_id, vault_url=_VAULT_URL, api_key=_VAULT_KEY)
    ledger = _Ledger(db_session, user_id)
    await ledger.snapshot()

    status, body = await _read(async_client, {**headers, **_BYOK}, entry_id, disclosed)

    assert status == HTTPStatus.CONFLICT, body
    assert body == {"detail": RESONANCE_PAYMENT_UNCONFIRMED}
    _assert_nothing_dialled(vault, provider)
    await ledger.assert_unchanged()
    # The refreshed disclosure names the route a confirmed request would use.
    assert await _disclosed_route(async_client, headers) == _VAULT


@pytest.mark.asyncio
async def test_a_reading_disclosed_as_vault_answered_never_reaches_the_app_provider(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    vault: ReflectingVaultClient,
    route: _Route,
) -> None:
    """Disconnecting the vault elsewhere must not hand the page to the app provider unasked."""
    provider = arm_anthropic(monkeypatch)
    route.boundary = _VAULT
    headers, user_id, _ = await signup(async_client, "route_reading_disconnect")
    entry_id = await seed_entry(db_session, user_id, body=_BODY)
    disclosed = await _disclosed_route(async_client, headers)
    route.boundary = _APP
    ledger = _Ledger(db_session, user_id)
    await ledger.snapshot()

    status, body = await _read(async_client, {**headers, **_BYOK}, entry_id, disclosed)

    assert status == HTTPStatus.CONFLICT, body
    assert body == {"detail": RESONANCE_PAYMENT_UNCONFIRMED}
    _assert_nothing_dialled(vault, provider)
    await ledger.assert_unchanged()


@pytest.mark.asyncio
async def test_a_reading_on_the_disclosed_route_is_admitted_and_charged_once(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    vault: ReflectingVaultClient,
    route: _Route,
) -> None:
    """Control: an unchanged route is the ordinary reading, one credit to the vault."""
    arm_anthropic(monkeypatch)
    route.boundary = _VAULT
    headers, user_id, _ = await signup(async_client, "route_reading_same")
    entry_id = await seed_entry(db_session, user_id, body=_BODY)
    used_before, balance_before = await wallet(db_session, user_id)

    status, body = await _read(
        async_client, headers, entry_id, await _disclosed_route(async_client, headers)
    )

    assert status == HTTPStatus.OK, body
    assert len(vault.reflect_calls) == 1
    assert await wallet(db_session, user_id) == (used_before + 1, balance_before)


@pytest.mark.asyncio
async def test_a_retried_stale_reading_stays_refused_until_the_writer_sees_the_new_route(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    vault: ReflectingVaultClient,
    route: _Route,
) -> None:
    """Retrying the held route changes nothing; the reread route then reads once."""
    provider = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "route_reading_retry")
    entry_id = await seed_entry(db_session, user_id, body=_BODY)
    held = await _disclosed_route(async_client, headers)
    route.boundary = _VAULT
    ledger = _Ledger(db_session, user_id)
    await ledger.snapshot()

    for _ in range(2):
        status, body = await _read(async_client, {**headers, **_BYOK}, entry_id, held)
        assert status == HTTPStatus.CONFLICT, body
    _assert_nothing_dialled(vault, provider)
    await ledger.assert_unchanged()

    used_before, balance_before = await wallet(db_session, user_id)
    refreshed = await _disclosed_route(async_client, headers)
    status, body = await _read(async_client, {**headers, **_BYOK}, entry_id, refreshed)
    assert status == HTTPStatus.OK, body
    assert len(vault.reflect_calls) == 1
    assert provider.request_count == 0
    assert await wallet(db_session, user_id) == (used_before + 1, balance_before)


@pytest.mark.asyncio
async def test_a_distressed_entry_on_a_stale_route_still_gets_care_free(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    vault: ReflectingVaultClient,
    route: _Route,
) -> None:
    """Care never waits on a price, so a stale route answers it rather than the 409."""
    provider = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "route_reading_care")
    entry_id = await seed_entry(db_session, user_id, body=_DISTRESS_BODY)
    route.boundary = _VAULT
    ledger = _Ledger(db_session, user_id)
    await ledger.snapshot()

    status, body = await _read(async_client, {**headers, **_BYOK}, entry_id, _APP)

    assert status == HTTPStatus.OK, body
    assert body["care"] is not None
    assert body["marginalia"] == []
    _assert_nothing_dialled(vault, provider)
    await ledger.assert_unchanged()


@pytest.mark.asyncio
async def test_an_intimate_entry_on_a_stale_route_gets_its_privacy_message(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    vault: ReflectingVaultClient,
    route: _Route,
) -> None:
    """The privacy floor answers before any payer question, stale or not."""
    provider = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "route_reading_intimate")
    entry_id = await seed_entry(
        db_session, user_id, body=_BODY, classification=JournalClassification.INTIMATE
    )
    route.boundary = _VAULT
    ledger = _Ledger(db_session, user_id)
    await ledger.snapshot()

    status, body = await _read(async_client, headers, entry_id, _APP)

    assert status == HTTPStatus.OK, body
    assert body["private_message"] == INTIMATE_PRIVATE_MESSAGE
    _assert_nothing_dialled(vault, provider)
    await ledger.assert_unchanged()


@pytest.mark.asyncio
async def test_a_route_outside_the_disclosure_vocabulary_is_rejected(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    vault: ReflectingVaultClient,
) -> None:
    """Only the two routes the usage GET can disclose are accepted."""
    provider = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "route_reading_unknown")
    entry_id = await seed_entry(db_session, user_id, body=_BODY)
    ledger = _Ledger(db_session, user_id)
    await ledger.snapshot()

    status, _ = await _read(async_client, {**headers, **_BYOK}, entry_id, "wallet")

    assert status == HTTPStatus.UNPROCESSABLE_ENTITY
    _assert_nothing_dialled(vault, provider)
    await ledger.assert_unchanged()


# --- The letter -----------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "transition", [(_APP, _VAULT), (_VAULT, _APP)], ids=["connect", "disconnect"]
)
async def test_a_first_letter_on_a_changed_route_is_refused_before_any_dial(
    async_client: AsyncClient,
    db_session: AsyncSession,
    route: _Route,
    app_letters: _AppLetters,
    transition: tuple[ReflectionBoundary, ReflectionBoundary],
) -> None:
    """Either transition refuses the held price: no handshake, no dial, no credit, twice over."""
    disclosed, current = transition
    vault = route.vault
    route.boundary = disclosed
    headers, user_id, _ = await signup(async_client, f"route_letter_{disclosed}")
    note_id = await seed_note(db_session, user_id)
    held = await _disclosed_route(async_client, headers)
    route.boundary = current
    ledger = _Ledger(db_session, user_id)
    await ledger.snapshot()

    for _ in range(2):
        status, body = await _letter(async_client, {**headers, **_BYOK}, note_id, held)
        assert status == HTTPStatus.CONFLICT, body
        assert body == {"detail": ESSAY_PRICE_UNACKNOWLEDGED}

    assert vault.handshake_calls == 0
    assert app_letters.calls == 0
    await ledger.assert_unchanged()


@pytest.mark.asyncio
async def test_a_key_funded_letter_on_the_disclosed_route_is_written_without_a_credit(
    async_client: AsyncClient,
    db_session: AsyncSession,
    route: _Route,
    app_letters: _AppLetters,
) -> None:
    """Control: an unchanged app-provider route lets the writer's key pay, as before."""
    headers, user_id, _ = await signup(async_client, "route_letter_same")
    note_id = await seed_note(db_session, user_id)
    assert route.boundary is _APP
    before = await wallet(db_session, user_id)

    status, body = await _letter(
        async_client, {**headers, **_BYOK}, note_id, await _disclosed_route(async_client, headers)
    )

    assert status == HTTPStatus.OK, body
    assert body["essay"] == _APP_LETTER
    assert app_letters.calls == 1
    assert await wallet(db_session, user_id) == before


@pytest.mark.asyncio
async def test_a_cached_letter_reopens_free_whatever_route_the_client_held(
    async_client: AsyncClient,
    db_session: AsyncSession,
    vault: ReflectingVaultClient,
    route: _Route,
    app_letters: _AppLetters,
) -> None:
    """Reopening a letter already bought costs nothing, so no route is in question."""
    headers, user_id, _ = await signup(async_client, "route_letter_cached")
    note_id = await seed_note(db_session, user_id, essay="A letter already written.")
    route.boundary = _VAULT
    ledger = _Ledger(db_session, user_id)
    await ledger.snapshot()

    status, body = await _letter(async_client, headers, note_id, _APP)

    assert status == HTTPStatus.OK, body
    assert body["essay"] == "A letter already written."
    assert vault.handshake_calls == 0
    assert app_letters.calls == 0
    await ledger.assert_unchanged()
