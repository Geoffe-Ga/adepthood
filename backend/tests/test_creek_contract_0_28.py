"""Creek contract 0.28's ``request_key_rejected``, read without moving the 0.22 pin.

0.28 answers a writer key its vendor refused, on ``POST /v1/reflections`` and
``POST /v1/letters/{external_id}``, as ``424 request_key_rejected`` with a
terminal retry disposition. A caller declaring an older minor keeps getting
``503 temporarily_unavailable``, which told the writer to wait for something
that never clears. Creek refuses any minor its ``supported_contract_minors``
does not list, so the two keyed generation calls declare 0.28 only to a vault
that lists it; everything else keeps hearing 0.22.

Pinned here: the negotiation on both calls and on neither of the others; the
adapter's classification of the refusal; and, at the routes, that a refusal is
``424 reflection_key_rejected`` with nothing charged and no app-provider dial,
while an older vault's 503 is still ``reflection_source_unavailable``.

Expectations are literals, never values read off the pin, for the reason
``tests/test_creek_contract_0_21.py`` gives. Creek's 0.28 bundle is not
published yet, so the refusal envelope here is built in the published 0.22
envelope's shape rather than read from a vendored example.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Awaitable, Iterator
from http import HTTPStatus
from pathlib import Path
from typing import Any, Final

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultError,
    CreekVaultUnavailableError,
    VaultLetterRequest,
    VaultTierCeiling,
)
from domain.vault_key_rejection import (
    REQUEST_KEY_REJECTED_SINCE_MINOR,
    CreekVaultRequestKeyRejectedError,
)
from main import app
from models.journal_entry import JournalClassification, JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from services import frequency_classification as frequency_classification_service
from services import marginalia as marginalia_service
from services.botmason import LLMResponse
from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_telemetry import VaultTelemetryOutcome, outcome_for_error
from services.creek_vault_voice_drafts import voice_draft_external_id
from services.reflection_boundary import (
    REFLECTION_KEY_REJECTED,
    REFLECTION_SOURCE_UNAVAILABLE,
    ReflectionBoundary,
)
from tests.support.fake_llm import real_provider_response
from tests.vault_client_doubles import bind_every_account_to_a_recorded_vault

_CAPABILITIES: Final = (
    Path(__file__).parent / "fixtures" / "creek_jobs_v026" / "examples" / "capabilities"
)
_VAULT_URL: Final = "https://vault.example.test"
_API_KEY: Final = "contract-028-test-key"  # pragma: allowlist secret
_CONTRACT_HEADER: Final = "X-Creek-Contract-Version"
_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
_BODY: Final = "I walked by the river and the willow bent without breaking."
_PRICED: Final = {"price_acknowledged": True}

#: The minor the two keyed generation calls declare to a vault that lists it.
_KEY_REJECTED_MINOR: Final = "0.28"
#: The minor every other call -- and both calls against an older vault -- declares.
_PINNED_MINOR: Final = "0.22"

_REFLECTIONS: Final = "/v1/reflections"
_LETTERS_PREFIX: Final = "/v1/letters/"
_CLASSIFICATIONS: Final = "/v1/classifications"


def _capabilities(*, lists_0_28: bool) -> dict[str, Any]:
    """A 0.26-image capability document, widened to list 0.28 when asked."""
    loaded: dict[str, Any] = json.loads((_CAPABILITIES / "success.json").read_bytes())
    document = copy.deepcopy(loaded)
    if lists_0_28:
        document["supported_contract_minors"] = [
            _KEY_REJECTED_MINOR,
            "0.27",
            *document["supported_contract_minors"],
        ]
    return document


def _envelope(code: str) -> dict[str, str]:
    """An error body in the published envelope's three-field shape."""
    return {"code": code, "message": "a constant message", "request_id": "req-0-28"}


def _refusal(*, lists_0_28: bool) -> httpx.Response:
    """What each vault answers a refused writer key with, by the minor it serves."""
    if lists_0_28:
        return httpx.Response(HTTPStatus.FAILED_DEPENDENCY, json=_envelope("request_key_rejected"))
    return httpx.Response(HTTPStatus.SERVICE_UNAVAILABLE, json=_envelope("temporarily_unavailable"))


class _KeyRefusingVault:
    """A vault whose model vendor refuses the writer's key, recording each declared minor."""

    def __init__(self, *, lists_0_28: bool) -> None:
        """Serve a handshake listing 0.28 or not, and refuse each keyed generation call."""
        self.lists_0_28 = lists_0_28
        self.declared: dict[str, str | None] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer the handshake and the admission; refuse reflections and letters."""
        path = request.url.path
        route = _LETTERS_PREFIX if path.startswith(_LETTERS_PREFIX) else path
        self.declared[route] = request.headers.get(_CONTRACT_HEADER)
        if path == "/v1/capabilities":
            return httpx.Response(HTTPStatus.OK, json=_capabilities(lists_0_28=self.lists_0_28))
        if path == _CLASSIFICATIONS:
            return httpx.Response(
                HTTPStatus.ACCEPTED,
                json={
                    "status": "accepted",
                    "job_id": "33333333-3333-4333-8333-333333333333",
                    "state": "queued",
                },
            )
        return _refusal(lists_0_28=self.lists_0_28)


def _letter_request() -> VaultLetterRequest:
    """One letter ask at the personal tier."""
    return VaultLetterRequest(
        external_id=voice_draft_external_id(1, 1),
        content=_BODY,
        note="A beginning.",
        anchor_text="I walked",
        kind="symbol",
        tier=VaultTierCeiling.PERSONAL,
    )


async def _refusal_of(call: Awaitable[object]) -> CreekVaultError:
    """The vault error ``call`` raised; a call that was answered fails the test."""
    try:
        await call
    except CreekVaultError as error:
        return error
    message = "the vault answered a call it was scripted to refuse"
    raise AssertionError(message)


async def _drive(vault: _KeyRefusingVault) -> tuple[CreekVaultError, CreekVaultError]:
    """Handshake, admit a pass, then ask for a reflection and a letter; return both refusals."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
        assert (await client.handshake()).available
        await client.classify_corpus()
        reflected = await _refusal_of(client.reflect(_BODY, VaultTierCeiling.PERSONAL))
        lettered = await _refusal_of(client.write_letter(_letter_request()))
        return reflected, lettered


def test_the_pin_stays_0_22_and_the_gate_is_0_28() -> None:
    """The base pin does not move; the refusal's minor is its own constant."""
    assert CONTRACT_VERSION == "0.22.0"
    assert REQUEST_KEY_REJECTED_SINCE_MINOR == _KEY_REJECTED_MINOR


@pytest.mark.asyncio
async def test_a_vault_listing_0_28_hears_it_on_reflections_and_letters_only() -> None:
    """Both keyed generation calls declare 0.28; the admission and the handshake do not."""
    vault = _KeyRefusingVault(lists_0_28=True)
    await _drive(vault)
    assert vault.declared[_REFLECTIONS] == _KEY_REJECTED_MINOR
    assert vault.declared[_LETTERS_PREFIX] == _KEY_REJECTED_MINOR
    assert vault.declared[_CLASSIFICATIONS] == _PINNED_MINOR
    assert vault.declared["/v1/capabilities"] is None


@pytest.mark.asyncio
async def test_a_vault_whose_window_stops_below_0_28_keeps_hearing_0_22() -> None:
    """An older image is never sent a minor it would refuse with 409."""
    vault = _KeyRefusingVault(lists_0_28=False)
    assert _KEY_REJECTED_MINOR not in _capabilities(lists_0_28=False)["supported_contract_minors"]
    await _drive(vault)
    assert vault.declared[_REFLECTIONS] == _PINNED_MINOR
    assert vault.declared[_LETTERS_PREFIX] == _PINNED_MINOR


@pytest.mark.asyncio
async def test_a_refused_key_is_its_own_terminal_error_on_both_calls() -> None:
    """424 ``request_key_rejected`` is neither an outage nor a contract fault, on either route."""
    reflected, lettered = await _drive(_KeyRefusingVault(lists_0_28=True))
    for error in (reflected, lettered):
        assert isinstance(error, CreekVaultRequestKeyRejectedError)
        assert not isinstance(error, CreekVaultUnavailableError)
        assert outcome_for_error(error) is VaultTelemetryOutcome.KEY_REJECTED
        assert "request_key_rejected" not in str(error)


@pytest.mark.asyncio
async def test_an_older_vaults_503_is_still_an_outage() -> None:
    """Below 0.28 the same refusal arrives as ``temporarily_unavailable``, and reads as one."""
    reflected, lettered = await _drive(_KeyRefusingVault(lists_0_28=False))
    for error in (reflected, lettered):
        assert isinstance(error, CreekVaultUnavailableError)
        assert not isinstance(error, CreekVaultRequestKeyRejectedError)


# --- the routes -----------------------------------------------------------------


class _AppDials:
    """Counts every dial the app provider's adapters make."""

    def __init__(self) -> None:
        """Start at zero."""
        self.calls = 0

    async def __call__(self, *_args: object, **_kwargs: object) -> LLMResponse:
        """Record the dial and answer something a test would notice."""
        self.calls += 1
        return real_provider_response(json.dumps({"notes": [], "hits": []}))


@pytest.fixture
def app_dials(monkeypatch: pytest.MonkeyPatch) -> _AppDials:
    """Spy on every app-provider seam the two routes could reach."""
    dials = _AppDials()
    monkeypatch.setattr(marginalia_service, "generate_response", dials)
    monkeypatch.setattr(frequency_classification_service, "generate_response", dials)
    return dials


@pytest.fixture(params=[True, False], ids=["lists_0_28", "below_0_28"])
def wire_vault(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[_KeyRefusingVault, HttpCreekVaultClient]]:
    """A vault-bound writer whose real HTTP adapter talks to a key-refusing vault."""
    bind_every_account_to_a_recorded_vault(monkeypatch)
    vault = _KeyRefusingVault(lists_0_28=bool(request.param))
    http = httpx.AsyncClient(transport=httpx.MockTransport(vault))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    app.dependency_overrides[get_creek_vault_client] = lambda: client
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.VAULT_BOUND
    yield vault, client
    app.dependency_overrides.pop(get_creek_vault_client, None)
    app.dependency_overrides.pop(get_reflection_boundary, None)


def _expected(vault: _KeyRefusingVault) -> tuple[HTTPStatus, str]:
    """The status and token a writer is answered with, by the minor their vault serves."""
    if vault.lists_0_28:
        return HTTPStatus.FAILED_DEPENDENCY, REFLECTION_KEY_REJECTED
    return HTTPStatus.SERVICE_UNAVAILABLE, REFLECTION_SOURCE_UNAVAILABLE


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up and return the auth header and the user id."""
    resp = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, int(data["user_id"])


async def _wallet(session: AsyncSession, user_id: int) -> tuple[int, int]:
    """The writer's monthly units used and credit balance, read fresh."""
    session.expire_all()
    user = (await session.execute(select(User).where(col(User.id) == user_id))).scalar_one()
    return user.monthly_messages_used, user.offering_balance


async def _seed_note(session: AsyncSession, user_id: int) -> tuple[int, int]:
    """One personal entry with one margin note; returns (entry id, note id)."""
    entry = JournalEntry(
        sender="user",
        user_id=user_id,
        message=_BODY,
        classification=JournalClassification.PERSONAL,
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


@pytest.mark.asyncio
async def test_a_refused_key_on_resonance_is_named_refunded_and_never_substituted(
    async_client: AsyncClient,
    db_session: AsyncSession,
    app_dials: _AppDials,
    wire_vault: tuple[_KeyRefusingVault, HttpCreekVaultClient],
) -> None:
    """0.28: 424 ``reflection_key_rejected``; older: 503. Either way free, the entry intact."""
    vault, _ = wire_vault
    headers, user_id = await _signup(async_client, f"key_rejected_pass_{vault.lists_0_28}")
    entry_id, _ = await _seed_note(db_session, user_id)
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    status, token = _expected(vault)
    assert resp.status_code == status, resp.text
    assert resp.json() == {"detail": token}
    assert vault.declared[_REFLECTIONS] is not None
    assert app_dials.calls == 0
    assert await _wallet(db_session, user_id) == before
    entry = await async_client.get(f"/journal/{entry_id}", headers=headers)
    assert entry.json()["message"] == _BODY


@pytest.mark.asyncio
async def test_a_refused_key_on_a_letter_is_named_refunded_and_never_substituted(
    async_client: AsyncClient,
    db_session: AsyncSession,
    app_dials: _AppDials,
    wire_vault: tuple[_KeyRefusingVault, HttpCreekVaultClient],
) -> None:
    """The letter route answers the same token, refunds the unit and caches no letter."""
    vault, client = wire_vault
    headers, user_id = await _signup(async_client, f"key_rejected_letter_{vault.lists_0_28}")
    _, note_id = await _seed_note(db_session, user_id)
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json=_PRICED
    )

    status, token = _expected(vault)
    assert resp.status_code == status, resp.text
    assert resp.json() == {"detail": token}
    assert client.supports(CreekCapability.LETTERS)
    assert vault.declared[_LETTERS_PREFIX] is not None
    assert app_dials.calls == 0
    assert await _wallet(db_session, user_id) == before
    db_session.expire_all()
    note = (
        await db_session.execute(select(Marginalia).where(col(Marginalia.id) == note_id))
    ).scalar_one()
    assert note.essay is None
