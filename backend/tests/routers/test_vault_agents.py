"""The agents a person has let read their vault: listing them, and stopping one (#3534).

Each test drives the flow a person drives: an agent is approved on the consent
page (#3532), it exchanges its code at the token endpoint (#3533), and the
person then reads ``GET /vault/agents`` under Settings, "Where your writing
lives", and presses Revoke, which is ``DELETE /vault/agents/{agent_id}``.

The cross-tenant half -- revoking another person's agent -- lives in
``tests/security/test_idor.py`` beside every other ownership regression.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import Final

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.agent_grant import AgentGrant
from models.oauth_client import OAuthClient, OAuthClientSource
from models.oauth_refresh_token import OAuthRefreshToken
from models.user_vault_config import UserVaultConfig
from services import oauth_signing_keys
from services.oauth_authorization import OAUTH_ISSUER_ENV_VAR
from tests.helpers.oauth import (
    ISSUER,
    approve,
    code_exchange_form,
    connect_vault,
    exchange,
    install_signing_keys,
    mcp_url_for,
    register_agent,
    signup,
)
from tests.helpers.openapi_errors import declared_response_schema, live_document, response_validator

_AGENTS: Final = "/vault/agents"
_CONNECTION: Final = "/vault/connection"
_CHATGPT_REDIRECT: Final = "https://chatgpt.com/connector_platform_oauth_redirect"
# Every key one agent row carries, and nothing else: no account id, no
# resource, no client id, no redirect list.
_AGENT_KEYS: Final = frozenset(
    {"id", "name", "grants", "created_at", "last_used_at", "redirect_host"}
)
# An id no row will ever hold in a test database.
_ABSENT_ID: Final = 987_654


@pytest.fixture(autouse=True)
def _issuer_and_keys(monkeypatch: pytest.MonkeyPatch) -> object:
    """Every test runs against one configured issuer and one signing key."""
    monkeypatch.setenv(OAUTH_ISSUER_ENV_VAR, ISSUER)
    install_signing_keys(monkeypatch)
    yield
    oauth_signing_keys.reset_cache()


def _validate(method: str, path: str, response: Response) -> None:
    """Hold a live body to the schema the published document declares for it."""
    document = live_document()
    schema = declared_response_schema(document, method, path, response.status_code)
    response_validator(document, schema).validate(response.json())


async def _grant(db_session: AsyncSession, grant_id: int) -> AgentGrant:
    """One grant, read fresh from storage."""
    result = await db_session.execute(
        select(AgentGrant)
        .where(AgentGrant.id == grant_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().one()


async def _refresh_tokens(db_session: AsyncSession) -> list[OAuthRefreshToken]:
    """Every refresh token stored, read fresh from storage."""
    result = await db_session.execute(
        select(OAuthRefreshToken).execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


async def _connected_agent(
    async_client: AsyncClient, db_session: AsyncSession, name: str
) -> tuple[dict[str, str], str, str]:
    """Approve one agent for a fresh account and let it exchange its code.

    Returns the account's bearer header, the agent's client id and the refresh
    token it holds.
    """
    headers, user_id = await signup(async_client, name)
    resource = await connect_vault(db_session, user_id, name)
    client_id = await register_agent(async_client)
    code = await approve(
        async_client, headers, client_id, resource, scope="vault:read vault:desk offline_access"
    )
    issued = await exchange(async_client, code_exchange_form(code, client_id))
    assert issued.status_code == HTTPStatus.OK, issued.text
    return headers, client_id, str(issued.json()["refresh_token"])


# --- listing --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_account_with_no_agents_is_answered_with_an_empty_list(
    async_client: AsyncClient,
) -> None:
    """Nobody approved yet is an answer, not a 404: the screen renders its empty state."""
    headers, _user_id = await signup(async_client, "agents_none")

    response = await async_client.get(_AGENTS, headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json() == []
    _validate("get", _AGENTS, response)


@pytest.mark.asyncio
async def test_an_approved_agent_is_listed_with_its_name_grants_and_return_host(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The row says who the agent is, what it may do and where approval sent the person back."""
    headers, user_id = await signup(async_client, "agents_one")
    resource = await connect_vault(db_session, user_id, "agents-one")
    client_id = await register_agent(async_client, name="OpenClaw on my Mac mini")
    await approve(async_client, headers, client_id, resource)

    response = await async_client.get(_AGENTS, headers=headers)

    assert response.status_code == HTTPStatus.OK
    (row,) = response.json()
    assert set(row) == _AGENT_KEYS
    assert row["name"] == "OpenClaw on my Mac mini"
    assert row["grants"] == ["vault:read", "vault:desk"]
    assert row["redirect_host"] == "127.0.0.1"
    assert row["last_used_at"] is None
    stored = (
        await db_session.execute(select(AgentGrant).where(AgentGrant.user_id == user_id))
    ).scalar_one()
    assert row["id"] == stored.id
    assert datetime.fromisoformat(row["created_at"]) == stored.created_at.replace(tzinfo=UTC)
    _validate("get", _AGENTS, response)


@pytest.mark.asyncio
async def test_last_used_moves_once_the_agent_has_traded_its_code(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """``last_used_at`` is the token endpoint's stamp: set on exchange, carried here."""
    headers, _client_id, _refresh = await _connected_agent(async_client, db_session, "agents_used")

    (row,) = (await async_client.get(_AGENTS, headers=headers)).json()

    assert row["last_used_at"] is not None
    assert datetime.fromisoformat(row["last_used_at"]).tzinfo is not None


@pytest.mark.asyncio
async def test_offline_access_is_carried_as_the_scope_name_the_consent_page_described(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Grants are scope names in the server's order; the screen maps each to words."""
    headers, user_id = await signup(async_client, "agents_offline")
    resource = await connect_vault(db_session, user_id, "agents-offline")
    client_id = await register_agent(async_client)
    await approve(async_client, headers, client_id, resource, scope="offline_access vault:desk")

    (row,) = (await async_client.get(_AGENTS, headers=headers)).json()

    assert row["grants"] == ["vault:desk", "offline_access"]


@pytest.mark.asyncio
async def test_an_https_connector_names_its_own_host(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A hosted connector returns the person to its own site, and the row says which."""
    headers, user_id = await signup(async_client, "agents_connector")
    db_session.add(
        OAuthClient(
            client_id="cl_connector",
            client_name="ChatGPT",
            redirect_uris=[_CHATGPT_REDIRECT],
            source=OAuthClientSource.DYNAMIC_REGISTRATION.value,
        )
    )
    db_session.add(
        AgentGrant(
            user_id=user_id,
            client_id="cl_connector",
            grants=["vault:read"],
            resource=mcp_url_for("agents-connector"),
        )
    )
    await db_session.commit()

    (row,) = (await async_client.get(_AGENTS, headers=headers)).json()

    assert row["redirect_host"] == "chatgpt.com"


@pytest.mark.asyncio
async def test_an_agent_that_gave_no_name_is_listed_without_one(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An empty name is ``null``, so the screen says so in its own words."""
    headers, user_id = await signup(async_client, "agents_unnamed")
    db_session.add(
        OAuthClient(
            client_id="cl_unnamed",
            client_name="",
            redirect_uris=[],
            source=OAuthClientSource.DYNAMIC_REGISTRATION.value,
        )
    )
    db_session.add(
        AgentGrant(
            user_id=user_id,
            client_id="cl_unnamed",
            grants=["vault:read"],
            resource=mcp_url_for("agents-unnamed"),
        )
    )
    await db_session.commit()

    (row,) = (await async_client.get(_AGENTS, headers=headers)).json()

    assert row["name"] is None
    assert row["redirect_host"] is None


@pytest.mark.asyncio
async def test_agents_are_listed_newest_approval_first(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The agent approved most recently is the one a person is most likely looking for."""
    headers, user_id = await signup(async_client, "agents_order")
    earlier = datetime(2026, 10, 1, tzinfo=UTC)
    for index, name in enumerate(("Older", "Newer")):
        client_id = f"cl_order_{index}"
        db_session.add(
            OAuthClient(
                client_id=client_id,
                client_name=name,
                redirect_uris=[],
                source=OAuthClientSource.DYNAMIC_REGISTRATION.value,
            )
        )
        db_session.add(
            AgentGrant(
                user_id=user_id,
                client_id=client_id,
                grants=["vault:read"],
                resource=mcp_url_for("agents-order"),
                created_at=earlier + timedelta(days=index),
            )
        )
    await db_session.commit()

    names = [row["name"] for row in (await async_client.get(_AGENTS, headers=headers)).json()]

    assert names == ["Newer", "Older"]


@pytest.mark.asyncio
async def test_the_list_holds_only_the_callers_own_agents(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The account comes from the token; nothing on the request can name another."""
    alice_headers, _alice_client, _refresh = await _connected_agent(
        async_client, db_session, "agents_alice"
    )
    bob_headers, bob_id = await signup(async_client, "agents_bob")
    await connect_vault(db_session, bob_id, "agents-bob")

    assert (await async_client.get(_AGENTS, headers=bob_headers)).json() == []
    assert len((await async_client.get(_AGENTS, headers=alice_headers)).json()) == 1


@pytest.mark.asyncio
async def test_the_agent_routes_require_a_session(async_client: AsyncClient) -> None:
    """No bearer, no list and no revoke."""
    assert (await async_client.get(_AGENTS)).status_code == HTTPStatus.UNAUTHORIZED
    assert (await async_client.delete(f"{_AGENTS}/1")).status_code == HTTPStatus.UNAUTHORIZED


# --- revoking -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_revoking_an_agent_stops_its_next_refresh_and_drops_it_from_the_list(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Revoke sets ``revoked_at``, revokes every refresh token, and the agent is gone."""
    headers, client_id, refresh_token = await _connected_agent(
        async_client, db_session, "agents_revoke"
    )
    (row,) = (await async_client.get(_AGENTS, headers=headers)).json()

    response = await async_client.delete(f"{_AGENTS}/{row['id']}", headers=headers)

    assert response.status_code == HTTPStatus.NO_CONTENT
    assert response.content == b""
    grant = await _grant(db_session, row["id"])
    assert grant.revoked_at is not None
    assert all(token.revoked_at is not None for token in await _refresh_tokens(db_session))
    refresh = await exchange(
        async_client,
        {"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": client_id},
    )
    assert refresh.status_code == HTTPStatus.BAD_REQUEST
    assert refresh.json() == {"error": "invalid_grant"}
    assert (await async_client.get(_AGENTS, headers=headers)).json() == []


@pytest.mark.asyncio
async def test_revoking_twice_is_answered_the_same_and_keeps_the_first_moment(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A second press -- a double tap, a retried request -- changes nothing."""
    headers, _client_id, _refresh = await _connected_agent(async_client, db_session, "agents_twice")
    (row,) = (await async_client.get(_AGENTS, headers=headers)).json()
    first = await async_client.delete(f"{_AGENTS}/{row['id']}", headers=headers)
    revoked_at = (await _grant(db_session, row["id"])).revoked_at

    second = await async_client.delete(f"{_AGENTS}/{row['id']}", headers=headers)

    assert (first.status_code, second.status_code) == (HTTPStatus.NO_CONTENT,) * 2
    assert (await _grant(db_session, row["id"])).revoked_at == revoked_at


@pytest.mark.asyncio
async def test_revoking_an_id_nobody_holds_is_a_404(async_client: AsyncClient) -> None:
    """A missing agent is the ordinary not-found answer."""
    headers, _user_id = await signup(async_client, "agents_missing")

    response = await async_client.delete(f"{_AGENTS}/{_ABSENT_ID}", headers=headers)

    assert response.status_code == HTTPStatus.NOT_FOUND
    assert response.json() == {"detail": "agent_not_found"}


@pytest.mark.asyncio
async def test_a_re_approval_after_revoking_lists_the_agent_again_with_a_fresh_start(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Approving again is a new consent: listed again, and its old tokens stay dead."""
    headers, client_id, refresh_token = await _connected_agent(
        async_client, db_session, "agents_again"
    )
    (row,) = (await async_client.get(_AGENTS, headers=headers)).json()
    await async_client.delete(f"{_AGENTS}/{row['id']}", headers=headers)

    await approve(async_client, headers, client_id, mcp_url_for("agents_again"))

    (again,) = (await async_client.get(_AGENTS, headers=headers)).json()
    assert again["id"] == row["id"]
    assert again["created_at"] > row["created_at"]
    stale = await exchange(
        async_client,
        {"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": client_id},
    )
    assert stale.status_code == HTTPStatus.BAD_REQUEST


# --- the address an agent is pointed at -----------------------------------------


@pytest.mark.asyncio
async def test_a_vault_you_run_tells_you_the_address_to_give_an_agent(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """``mcp_address`` is the audience every token for this vault names."""
    headers, user_id = await signup(async_client, "agents_address")
    resource = await connect_vault(db_session, user_id, "agents-address")

    response = await async_client.get(_CONNECTION, headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json()["mcp_address"] == resource
    _validate("get", _CONNECTION, response)


@pytest.mark.asyncio
async def test_no_vault_has_no_address(async_client: AsyncClient) -> None:
    """Nothing connected, nothing to paste."""
    headers, _user_id = await signup(async_client, "agents_no_address")

    response = await async_client.get(_CONNECTION, headers=headers)

    assert response.json() == {
        "connected": False,
        "vault_url": None,
        "mcp_address": None,
        "classification_key_rejected": False,
    }


@pytest.mark.asyncio
async def test_a_managed_vault_without_oauth_readiness_has_no_agent_address(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A binding alone does not establish its allocation's OAuth readiness."""
    headers, user_id = await signup(async_client, "agents_managed")
    db_session.add(
        UserVaultConfig(
            user_id=user_id,
            vault_url="https://pilot.vaults.example/v1",
            api_key="managed-key-0123456789",  # pragma: allowlist secret
            provisioned=True,
        )
    )
    await db_session.commit()

    response = await async_client.get(_CONNECTION, headers=headers)

    assert response.json() == {
        "connected": True,
        "vault_url": None,
        "mcp_address": None,
        "classification_key_rejected": False,
    }
