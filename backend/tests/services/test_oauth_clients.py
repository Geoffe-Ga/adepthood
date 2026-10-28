"""Registering a vault agent, and finding one by the URL of its own metadata (#3532).

Three layers, tested in the order a request meets them: the pure rules every
self-description is judged by, the fetch of a client metadata document under its
budget, ceiling and redirect limits, and the registry that caches what was
fetched and refuses what could not be.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.oauth_client import OAuthClient, OAuthClientSource
from schemas.oauth import ClientRegistrationRequest
from services import creek_vault_url_resolution, oauth_metadata_fetch
from services.oauth_client_metadata import (
    MAX_REDIRECT_URIS,
    ClientMetadata,
    MetadataRefusal,
    RegistrationRefusal,
    is_metadata_document_client_id,
    parse_client_metadata_document,
    validate_client_metadata,
)
from services.oauth_clients import (
    METADATA_DOCUMENT_TTL,
    REGISTERED_CLIENT_PREFIX,
    register_client,
    resolve_client,
)

_DOCUMENT_URL = "https://agent.example/oauth/client.json"
_CALLBACK = "https://agent.example/callback"
_NOW = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)
# Spelled by code point so the source file itself carries no invisible character.
_RIGHT_TO_LEFT_OVERRIDE = chr(0x202E)


def _document(**overrides: object) -> bytes:
    document: dict[str, object] = {
        "client_id": _DOCUMENT_URL,
        "client_name": "Example Agent",
        "redirect_uris": [_CALLBACK],
        "token_endpoint_auth_method": "none",
    }
    document.update(overrides)
    return json.dumps(document).encode()


# --- the rules ---------------------------------------------------------------


def test_a_public_client_with_good_redirects_is_accepted() -> None:
    """Name trimmed, redirects kept in order, logo kept."""
    result = validate_client_metadata(
        ClientRegistrationRequest(
            redirect_uris=["http://127.0.0.1/callback", _CALLBACK],
            client_name="  Claude Code  ",
            logo_uri="https://agent.example/logo.png",
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
            token_endpoint_auth_method="none",
        )
    )
    assert result == ClientMetadata(
        client_name="Claude Code",
        redirect_uris=("http://127.0.0.1/callback", _CALLBACK),
        logo_uri="https://agent.example/logo.png",
    )


def test_a_nameless_client_is_accepted_with_an_empty_name() -> None:
    """The consent page says the agent did not give its name; registration still works."""
    result = validate_client_metadata(ClientRegistrationRequest(redirect_uris=[_CALLBACK]))
    assert isinstance(result, ClientMetadata)
    assert result.client_name == ""


@pytest.mark.parametrize(
    "redirect_uris",
    [
        [],
        ["http://evil.example/callback"],
        [_CALLBACK, "javascript:alert(1)"],
        [f"https://agent.example/{index}" for index in range(MAX_REDIRECT_URIS + 1)],
    ],
)
def test_bad_redirects_are_refused_with_their_own_code(redirect_uris: list[str]) -> None:
    """RFC 7591 names redirect faults separately from every other metadata fault."""
    result = validate_client_metadata(ClientRegistrationRequest(redirect_uris=redirect_uris))
    assert isinstance(result, MetadataRefusal)
    assert result.error == RegistrationRefusal.INVALID_REDIRECT_URI


@pytest.mark.parametrize(
    "fields",
    [
        {"token_endpoint_auth_method": "client_secret_basic"},
        {"grant_types": ["client_credentials"]},
        {"grant_types": ["implicit"]},
        {"response_types": ["token"]},
        {"client_name": "Claude" + _RIGHT_TO_LEFT_OVERRIDE + "edoC"},
        {"client_name": "tab\tname"},
        {"client_name": "x" * 101},
        {"logo_uri": "http://agent.example/logo.png"},
    ],
)
def test_anything_but_a_readable_public_code_client_is_refused(fields: dict[str, object]) -> None:
    """No secrets, no client credentials, no implicit flow, no invisible characters."""
    request = ClientRegistrationRequest.model_validate({"redirect_uris": [_CALLBACK], **fields})
    result = validate_client_metadata(request)
    assert isinstance(result, MetadataRefusal)
    assert result.error == RegistrationRefusal.INVALID_CLIENT_METADATA


@pytest.mark.parametrize(
    "client_id",
    [
        "https://agent.example/oauth/client.json",
        "https://claude.ai/oauth/claude-code-client-metadata",
    ],
)
def test_an_https_url_with_a_path_is_a_metadata_document_id(client_id: str) -> None:
    """The CIMD shape: https and a path."""
    assert is_metadata_document_client_id(client_id)


@pytest.mark.parametrize(
    "client_id",
    [
        "cl_abc",
        "http://agent.example/client.json",
        "https://agent.example",
        "https://agent.example/",
        "https://agent.example/a/../client.json",
        "https://agent.example/client.json?x=1",
        "https://agent.example/client.json#x",
        "https://user@agent.example/client.json",
        "https://10.0.0.7/client.json",
        "https://127.0.0.1/client.json",
        "https://vault.internal/client.json",
        "https://[::1/client.json",
    ],
)
def test_every_other_identifier_is_not_fetched(client_id: str) -> None:
    """Nothing private, local, plaintext, rootless or decorated is ever dialled."""
    assert not is_metadata_document_client_id(client_id)


def test_a_document_must_name_itself() -> None:
    """A page cannot claim to describe a client whose URL it is not."""
    assert parse_client_metadata_document(_document(), _DOCUMENT_URL) is not None
    other = _document(client_id="https://other.example/client.json")
    assert parse_client_metadata_document(other, _DOCUMENT_URL) is None


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        _document(redirect_uris="https://agent.example/callback"),
        _document(redirect_uris=["http://evil.example/cb"]),
        _document(token_endpoint_auth_method="private_key_jwt"),
    ],
)
def test_a_document_that_is_not_a_valid_public_client_is_refused(body: bytes) -> None:
    """Malformed JSON, the wrong shape, or a client this server cannot serve."""
    assert parse_client_metadata_document(body, _DOCUMENT_URL) is None


# --- the fetch -------------------------------------------------------------------


Handler = Callable[[httpx.Request], httpx.Response]


def _serve(monkeypatch: pytest.MonkeyPatch, handler: Handler) -> list[str]:
    """Answer every document fetch with ``handler``; return the URLs fetched."""
    fetched: list[str] = []

    def _recording(request: httpx.Request) -> httpx.Response:
        fetched.append(str(request.url))
        return handler(request)

    monkeypatch.setattr(
        oauth_metadata_fetch,
        "build_metadata_transport",
        lambda: httpx.MockTransport(_recording),
    )
    return fetched


@pytest.mark.asyncio
async def test_a_document_is_fetched_anonymously_and_parsed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One GET, asking for JSON, carrying no credential."""
    seen: list[httpx.Request] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=_document())

    _serve(monkeypatch, _handler)
    metadata = await oauth_metadata_fetch.fetch_client_metadata(_DOCUMENT_URL)
    assert metadata == ClientMetadata("Example Agent", (_CALLBACK,), None)
    assert [request.method for request in seen] == ["GET"]
    assert seen[0].headers["accept"] == "application/json"
    assert "authorization" not in seen[0].headers
    assert "cookie" not in seen[0].headers


@pytest.mark.asyncio
async def test_a_same_host_redirect_is_followed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hosting platforms add trailing slashes; one hop on the same host is fine."""

    def _handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/old.json"):
            return httpx.Response(301, headers={"location": "/oauth/client.json"})
        return httpx.Response(200, content=_document())

    fetched = _serve(monkeypatch, _handler)
    metadata = await oauth_metadata_fetch.fetch_client_metadata(
        "https://agent.example/oauth/old.json"
    )
    # The document names the URL it was first asked for, not the one it moved to.
    assert metadata is None
    assert fetched == ["https://agent.example/oauth/old.json", _DOCUMENT_URL]


@pytest.mark.asyncio
async def test_a_same_host_redirect_to_a_document_naming_the_original_is_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ``client_id`` is the URL the agent presented, wherever the bytes came from."""
    original = "https://agent.example/oauth/old.json"

    def _handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/old.json"):
            return httpx.Response(302, headers={"location": _DOCUMENT_URL})
        return httpx.Response(200, content=_document(client_id=original))

    _serve(monkeypatch, _handler)
    assert await oauth_metadata_fetch.fetch_client_metadata(original) is not None


@pytest.mark.parametrize(
    "location",
    [
        "https://evil.example/client.json",
        "http://agent.example/oauth/client.json",
        "https://10.0.0.7/client.json",
        "",
    ],
)
@pytest.mark.asyncio
async def test_a_redirect_off_the_host_is_not_followed(
    monkeypatch: pytest.MonkeyPatch, location: str
) -> None:
    """Another host, plaintext, a private address, or nowhere at all: stop."""
    fetched = _serve(
        monkeypatch, lambda _request: httpx.Response(302, headers={"location": location})
    )
    assert await oauth_metadata_fetch.fetch_client_metadata(_DOCUMENT_URL) is None
    assert fetched == [_DOCUMENT_URL]


@pytest.mark.asyncio
async def test_a_redirect_loop_gives_up(monkeypatch: pytest.MonkeyPatch) -> None:
    """A page that redirects to itself is fetched a bounded number of times."""
    fetched = _serve(
        monkeypatch, lambda _request: httpx.Response(302, headers={"location": _DOCUMENT_URL})
    )
    assert await oauth_metadata_fetch.fetch_client_metadata(_DOCUMENT_URL) is None
    assert len(fetched) == oauth_metadata_fetch.MAX_SAME_HOST_REDIRECTS + 1


@pytest.mark.asyncio
async def test_a_document_past_the_ceiling_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """64 KiB and not a byte more is read."""
    padding = "x" * oauth_metadata_fetch.MAX_METADATA_DOCUMENT_BYTES
    _serve(monkeypatch, lambda _request: httpx.Response(200, content=_document(pad=padding)))
    assert await oauth_metadata_fetch.fetch_client_metadata(_DOCUMENT_URL) is None


@pytest.mark.parametrize("status", [404, 500, 204])
@pytest.mark.asyncio
async def test_a_non_200_answer_is_refused(monkeypatch: pytest.MonkeyPatch, status: int) -> None:
    """Only a 200 carries a document."""
    _serve(monkeypatch, lambda _request: httpx.Response(status, content=_document()))
    assert await oauth_metadata_fetch.fetch_client_metadata(_DOCUMENT_URL) is None


@pytest.mark.asyncio
async def test_an_unreachable_page_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """A transport failure is a client that cannot be identified, not a 500."""

    def _handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    _serve(monkeypatch, _handler)
    assert await oauth_metadata_fetch.fetch_client_metadata(_DOCUMENT_URL) is None


@pytest.mark.asyncio
async def test_a_slow_page_runs_out_of_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    """The budget covers the whole fetch, so a page that never answers is abandoned."""
    monkeypatch.setattr(oauth_metadata_fetch, "METADATA_FETCH_BUDGET_SECONDS", 0.01)

    async def _never(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(1)
        return httpx.Response(200, content=_document(), request=request)

    monkeypatch.setattr(
        oauth_metadata_fetch, "build_metadata_transport", lambda: httpx.MockTransport(_never)
    )
    assert await oauth_metadata_fetch.fetch_client_metadata(_DOCUMENT_URL) is None


@pytest.mark.asyncio
async def test_a_name_resolving_somewhere_private_is_never_dialled(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The real pinning transport refuses a public-looking name that points inside."""
    looked_up: list[str] = []

    async def _private(host: str) -> tuple[str, ...]:
        looked_up.append(host)
        return ("10.0.0.7",)

    monkeypatch.setattr(creek_vault_url_resolution, "resolve_host_addresses", _private)
    with caplog.at_level(logging.WARNING):
        assert await oauth_metadata_fetch.fetch_client_metadata(_DOCUMENT_URL) is None
    assert looked_up == ["agent.example"]
    assert any("destination is not dialable" in record.getMessage() for record in caplog.records)


@pytest.mark.asyncio
async def test_an_identifier_of_the_wrong_shape_is_never_fetched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``cl_`` identifiers and private URLs do not reach the transport at all."""
    fetched = _serve(monkeypatch, lambda _request: httpx.Response(200, content=_document()))
    assert await oauth_metadata_fetch.fetch_client_metadata("cl_abc") is None
    assert await oauth_metadata_fetch.fetch_client_metadata("https://10.0.0.7/c.json") is None
    assert fetched == []


# --- the registry --------------------------------------------------------------


@pytest.mark.asyncio
async def test_registration_mints_an_unguessable_identifier(db_session: AsyncSession) -> None:
    """Two registrations of the same agent are two clients."""
    metadata = ClientMetadata("Claude Code", ("http://127.0.0.1/callback",), None)
    first = await register_client(db_session, metadata)
    second = await register_client(db_session, metadata)
    assert first.client_id.startswith(REGISTERED_CLIENT_PREFIX)
    assert first.client_id != second.client_id
    assert first.source == OAuthClientSource.DYNAMIC_REGISTRATION.value
    assert first.redirect_uris == ["http://127.0.0.1/callback"]


@pytest.mark.asyncio
async def test_a_registered_client_resolves_without_a_fetch(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A ``cl_`` identifier is looked up, never fetched."""
    fetched = _serve(monkeypatch, lambda _request: httpx.Response(500))
    client = await register_client(db_session, ClientMetadata("A", (_CALLBACK,), None))
    assert await resolve_client(db_session, client.client_id) == client
    assert await resolve_client(db_session, "cl_nobody_was_issued_this") is None
    assert fetched == []


@pytest.mark.asyncio
async def test_a_document_client_is_fetched_once_and_cached(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The first sign-in fetches; the next one within the hour reads the cache."""
    fetched = _serve(monkeypatch, lambda _request: httpx.Response(200, content=_document()))
    first = await resolve_client(db_session, _DOCUMENT_URL, now=_NOW)
    second = await resolve_client(db_session, _DOCUMENT_URL, now=_NOW + timedelta(minutes=5))
    assert first is not None
    assert second is not None
    assert first.id == second.id
    assert first.source == OAuthClientSource.METADATA_DOCUMENT.value
    assert first.redirect_uris == [_CALLBACK]
    assert fetched == [_DOCUMENT_URL]


@pytest.mark.asyncio
async def test_a_stale_document_is_fetched_again_and_its_redirects_govern(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """After the TTL the document is the authority again, and a changed list replaces the old."""
    documents = iter([_document(), _document(redirect_uris=["https://agent.example/new"])])
    _serve(monkeypatch, lambda _request: httpx.Response(200, content=next(documents)))
    await resolve_client(db_session, _DOCUMENT_URL, now=_NOW)
    later = _NOW + METADATA_DOCUMENT_TTL + timedelta(seconds=1)
    refreshed = await resolve_client(db_session, _DOCUMENT_URL, now=later)
    assert refreshed is not None
    assert refreshed.redirect_uris == ["https://agent.example/new"]
    rows = (await db_session.execute(select(OAuthClient))).scalars().all()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_a_document_that_cannot_be_fetched_is_no_client_even_if_cached(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A stale cache is not served in place of the authority it caches."""
    answers = iter([httpx.Response(200, content=_document()), httpx.Response(503)])
    _serve(monkeypatch, lambda _request: next(answers))
    assert await resolve_client(db_session, _DOCUMENT_URL, now=_NOW) is not None
    later = _NOW + METADATA_DOCUMENT_TTL + timedelta(seconds=1)
    assert await resolve_client(db_session, _DOCUMENT_URL, now=later) is None


@pytest.mark.asyncio
async def test_a_registered_row_cannot_be_reached_through_a_document_shape(
    db_session: AsyncSession,
) -> None:
    """Only a dynamically registered row is served for a non-URL identifier."""
    db_session.add(
        OAuthClient(
            client_id="not-a-url-and-not-registered",
            client_name="Odd",
            redirect_uris=[_CALLBACK],
            source=OAuthClientSource.METADATA_DOCUMENT.value,
        )
    )
    await db_session.commit()
    assert await resolve_client(db_session, "not-a-url-and-not-registered") is None
