"""``GET /vault/connection`` tells the deployment-wide vault's owner the truth (#3608).

An account reaches a vault one of three ways: a connection it stored itself
(``connected``), a managed binding the lifecycle provisioned (``managed``), or
the legacy deployment-wide ``CREEK_VAULT_OWNER_USER_ID`` binding
(``deployment``). The pipeline has always routed the third kind's writing to
the deployment vault; the read used to answer them ``connected: false``, so
every surface gating on it hid vault-only features from somebody whose writing
was really being sorted there.

The read now answers from the same precedence the pipeline routes by -- a
stored row first, then the deployment binding -- through one helper both
share, so they cannot drift. The deployment source is reported without its
address, its agent address or anything else of the operator's configuration:
it is the operator's vault, and ``source`` is the only new thing said about it.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Final

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.creek_vault import (
    OWNER_ENV_VAR,
    account_has_configured_vault,
    vault_connection_source,
)
from schemas.vault_config import VaultConnectionSource
from services.user_vault_config import load_vault_config, store_vault_config

_CONNECTION_PATH: Final = "/vault/connection"
_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
_VAULT_URL_ENV: Final = "CREEK_VAULT_URL"
_VAULT_KEY_ENV: Final = "CREEK_VAULT_API_KEY"
_DEPLOYMENT_VAULT_HOST: Final = "deployment-vault-3608.example.com"
_DEPLOYMENT_VAULT_URL: Final = f"https://{_DEPLOYMENT_VAULT_HOST}"
_DEPLOYMENT_VAULT_KEY: Final = "deployment-key-3608"  # pragma: allowlist secret
_OWN_VAULT_URL: Final = "https://own-vault-3608.example.com"
_OWN_VAULT_KEY: Final = "own-key-3608"  # pragma: allowlist secret


@pytest.fixture(autouse=True)
def _no_deployment_vault(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start every test with no deployment vault, so only what a test sets binds one."""
    monkeypatch.delenv(_VAULT_URL_ENV, raising=False)
    monkeypatch.delenv(_VAULT_KEY_ENV, raising=False)
    monkeypatch.delenv(OWNER_ENV_VAR, raising=False)


def _bind_deployment_vault(monkeypatch: pytest.MonkeyPatch, owner: int | str) -> None:
    """Configure the deployment-wide vault and name ``owner`` as its one account."""
    monkeypatch.setenv(_VAULT_URL_ENV, _DEPLOYMENT_VAULT_URL)
    monkeypatch.setenv(_VAULT_KEY_ENV, _DEPLOYMENT_VAULT_KEY)
    monkeypatch.setenv(OWNER_ENV_VAR, str(owner))


async def _signup(client: AsyncClient, name: str) -> tuple[dict[str, str], int]:
    """A fresh account's auth header and id."""
    response = await client.post(
        "/auth/signup", json={"email": f"{name}@example.com", "password": _PASSWORD}
    )
    assert response.status_code == HTTPStatus.OK
    body = response.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _read(client: AsyncClient, headers: dict[str, str]) -> tuple[dict[str, object], str]:
    """The connection answer as the caller reads it, parsed and as raw text."""
    response = await client.get(_CONNECTION_PATH, headers=headers)
    assert response.status_code == HTTPStatus.OK
    body: dict[str, object] = response.json()
    return body, response.text


def _assert_nothing_of_the_deployment_leaks(raw: str) -> None:
    """No part of the operator's vault configuration is in a response body."""
    assert _DEPLOYMENT_VAULT_HOST not in raw
    assert _DEPLOYMENT_VAULT_KEY not in raw


async def _pipeline_agrees(session: AsyncSession, user_id: int, body: dict[str, object]) -> None:
    """The read says what the pipeline routes by: has-a-vault and which kind."""
    assert body["connected"] is await account_has_configured_vault(session, user_id)
    expected = vault_connection_source(await load_vault_config(session, user_id), user_id)
    assert body["source"] == (None if expected is None else expected.value)


@pytest.mark.asyncio
async def test_the_deployment_vaults_owner_reads_connected_with_the_deployment_source(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The bound owner is told they have a vault, and which kind, and nothing more."""
    headers, user_id = await _signup(async_client, "deploy-src-owner")
    _bind_deployment_vault(monkeypatch, user_id)

    body, raw = await _read(async_client, headers)

    assert body["connected"] is True
    assert body["source"] == "deployment"
    assert body["vault_url"] is None
    assert body["mcp_address"] is None
    _assert_nothing_of_the_deployment_leaks(raw)
    await _pipeline_agrees(db_session, user_id, body)


@pytest.mark.asyncio
async def test_a_stranger_on_the_same_deployment_never_reads_its_vault_as_theirs(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every other account reads nothing connected, and learns nothing about the vault."""
    _, owner_id = await _signup(async_client, "deploy-src-bound")
    stranger_headers, stranger_id = await _signup(async_client, "deploy-src-stranger")
    _bind_deployment_vault(monkeypatch, owner_id)

    body, raw = await _read(async_client, stranger_headers)

    assert body["connected"] is False
    assert body["source"] is None
    assert body["vault_url"] is None
    assert body["mcp_address"] is None
    _assert_nothing_of_the_deployment_leaks(raw)
    await _pipeline_agrees(db_session, stranger_id, body)


@pytest.mark.asyncio
async def test_a_user_who_connected_their_own_vault_reads_the_connected_source(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A per-user connection is unchanged by the binding, apart from naming its kind."""
    _, owner_id = await _signup(async_client, "deploy-src-other-owner")
    headers, user_id = await _signup(async_client, "deploy-src-byo")
    _bind_deployment_vault(monkeypatch, owner_id)
    await store_vault_config(db_session, user_id, vault_url=_OWN_VAULT_URL, api_key=_OWN_VAULT_KEY)

    body, raw = await _read(async_client, headers)

    assert body["connected"] is True
    assert body["source"] == "connected"
    assert body["vault_url"] == _OWN_VAULT_URL
    _assert_nothing_of_the_deployment_leaks(raw)
    await _pipeline_agrees(db_session, user_id, body)


@pytest.mark.asyncio
async def test_the_owners_own_connection_wins_over_the_deployment_binding(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The precedence the pipeline routes by: a stored connection first, then the binding.

    :func:`~dependencies.creek_vault.resolve_creek_vault_client` hands an owner
    who connected a vault of their own that vault and never the shared one, so
    the read names their own vault too.
    """
    headers, user_id = await _signup(async_client, "deploy-src-both")
    _bind_deployment_vault(monkeypatch, user_id)
    await store_vault_config(db_session, user_id, vault_url=_OWN_VAULT_URL, api_key=_OWN_VAULT_KEY)

    body, raw = await _read(async_client, headers)

    assert body["connected"] is True
    assert body["source"] == "connected"
    assert body["vault_url"] == _OWN_VAULT_URL
    _assert_nothing_of_the_deployment_leaks(raw)
    await _pipeline_agrees(db_session, user_id, body)


@pytest.mark.asyncio
async def test_disconnecting_the_owners_own_vault_falls_back_to_the_deployment_one(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Removing the stored row hands the owner back to the binding, as the pipeline does."""
    headers, user_id = await _signup(async_client, "deploy-src-fallback")
    _bind_deployment_vault(monkeypatch, user_id)
    await store_vault_config(db_session, user_id, vault_url=_OWN_VAULT_URL, api_key=_OWN_VAULT_KEY)

    deleted = await async_client.delete(_CONNECTION_PATH, headers=headers)
    body, raw = await _read(async_client, headers)

    assert deleted.status_code == HTTPStatus.NO_CONTENT
    assert body["connected"] is True
    assert body["source"] == "deployment"
    assert body["vault_url"] is None
    _assert_nothing_of_the_deployment_leaks(raw)
    await _pipeline_agrees(db_session, user_id, body)


@pytest.mark.asyncio
async def test_a_managed_binding_reads_the_managed_source(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provisioned row says ``managed``, still with its private address withheld."""
    headers, user_id = await _signup(async_client, "deploy-src-managed")
    _bind_deployment_vault(monkeypatch, user_id)
    await store_vault_config(
        db_session, user_id, vault_url=_OWN_VAULT_URL, api_key=_OWN_VAULT_KEY, provisioned=True
    )

    async def no_discovery(*_args: object) -> None:
        """Stand in for agent discovery, which this module is not about."""

    monkeypatch.setattr("routers.vault_config.managed_agent_address", no_discovery)

    body, raw = await _read(async_client, headers)

    assert body["connected"] is True
    assert body["source"] == "managed"
    assert body["vault_url"] is None
    assert "own-vault-3608" not in raw
    _assert_nothing_of_the_deployment_leaks(raw)
    await _pipeline_agrees(db_session, user_id, body)


@pytest.mark.asyncio
@pytest.mark.parametrize("owner", ["", "not-a-number", "-1"])
async def test_an_unreadable_binding_belongs_to_nobody(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    owner: str,
) -> None:
    """A vault bound to no readable account is nobody's, so nobody reads it as theirs."""
    headers, user_id = await _signup(async_client, f"deploy-src-unbound{len(owner)}")
    _bind_deployment_vault(monkeypatch, owner)

    body, _ = await _read(async_client, headers)

    assert body["connected"] is False
    assert body["source"] is None
    await _pipeline_agrees(db_session, user_id, body)


@pytest.mark.asyncio
async def test_an_owner_named_for_a_vault_that_is_not_configured_has_none(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The binding alone is not a vault: with no ``CREEK_VAULT_URL`` there is nothing to read."""
    headers, user_id = await _signup(async_client, "deploy-src-no-url")
    monkeypatch.setenv(OWNER_ENV_VAR, str(user_id))

    body, _ = await _read(async_client, headers)

    assert body["connected"] is False
    assert body["source"] is None
    await _pipeline_agrees(db_session, user_id, body)


@pytest.mark.asyncio
async def test_connecting_their_own_vault_moves_the_owner_off_the_deployment_source(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``PUT`` answers the same field, naming the connection it just stored."""
    headers, user_id = await _signup(async_client, "deploy-src-put")
    _bind_deployment_vault(monkeypatch, user_id)

    async def accept_any_url(_session: AsyncSession, _url: str) -> None:
        """Stand in for the URL judgement, which this module is not about."""

    monkeypatch.setattr(
        "routers.vault_config._refuse_a_url_this_endpoint_must_not_store", accept_any_url
    )

    response = await async_client.put(
        _CONNECTION_PATH,
        headers=headers,
        json={"vault_url": _OWN_VAULT_URL, "api_key": _OWN_VAULT_KEY},
    )

    assert response.status_code == HTTPStatus.OK
    assert response.json()["source"] == "connected"
    _assert_nothing_of_the_deployment_leaks(response.text)


def test_the_source_vocabulary_is_the_three_ways_an_account_reaches_a_vault() -> None:
    """A closed vocabulary the client mirrors; growing it is a contract change."""
    assert {source.value for source in VaultConnectionSource} == {
        "connected",
        "managed",
        "deployment",
    }
