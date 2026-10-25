"""Consent grants belong to the person, even when an agent asks for everything (#3544)."""

from __future__ import annotations

from html.parser import HTMLParser
from http import HTTPStatus
from urllib.parse import urlencode

import jwt
import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.agent_grant import AgentGrant
from models.oauth_authorization_code import OAuthAuthorizationCode
from models.oauth_refresh_token import OAuthRefreshToken
from services import oauth_signing_keys
from services.oauth_authorization import OAUTH_ISSUER_ENV_VAR
from tests.helpers.oauth import (
    ISSUER,
    authorize_params,
    code_exchange_form,
    connect_vault,
    exchange,
    install_signing_keys,
    redirect_query,
    register_agent,
    signup,
    ticket_from,
)

_ALL_GRANTS = "vault:read vault:desk vault:journal vault:pipeline offline_access"


class _Checkboxes(HTMLParser):
    """Read the controls a browser would display and submit, without matching HTML spacing."""

    def __init__(self, html: str) -> None:
        super().__init__()
        self.choices: dict[str, bool] = {}
        self.feed(html)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        fields = dict(attrs)
        if tag == "input" and fields.get("type") == "checkbox":
            self.choices[str(fields.get("name"))] = "checked" in fields


@pytest.fixture(autouse=True)
def _issuer_and_keys(monkeypatch: pytest.MonkeyPatch) -> object:
    monkeypatch.setenv(OAUTH_ISSUER_ENV_VAR, ISSUER)
    install_signing_keys(monkeypatch)
    yield
    oauth_signing_keys.reset_cache()


async def _page(
    client: AsyncClient, session: AsyncSession, *, scope: str = _ALL_GRANTS
) -> tuple[Response, str]:
    headers, user_id = await signup(client, "grant-choice")
    resource = await connect_vault(session, user_id, "grant-choice")
    client_id = await register_agent(client)
    page = await client.get(
        "/oauth/authorize",
        params=authorize_params(client_id, resource, scope=scope),
        headers=headers,
    )
    assert page.status_code == HTTPStatus.OK, page.text
    return page, client_id


@pytest.mark.parametrize(
    "requested",
    [_ALL_GRANTS, "vault:journal vault:pipeline", "vault:desk", "offline_access vault:read"],
)
@pytest.mark.asyncio
async def test_only_requested_read_and_desk_are_preselected(
    async_client: AsyncClient, db_session: AsyncSession, requested: str
) -> None:
    """The agent cannot set the default by requesting journal, pipeline or offline access."""
    page, _client_id = await _page(async_client, db_session, scope=requested)
    choices = _Checkboxes(page.text).choices
    assert set(choices) == {f"grant.{scope}" for scope in requested.split()}
    assert {name for name, checked in choices.items() if checked} == {
        f"grant.{scope}" for scope in requested.split() if scope in {"vault:read", "vault:desk"}
    }
    csp = page.headers["content-security-policy"]
    assert "'unsafe-inline'" not in csp
    assert "style=" not in page.text
    assert "<script" not in page.text


@pytest.mark.parametrize(
    ("requested", "selected"),
    [
        (_ALL_GRANTS, "vault:read"),
        (_ALL_GRANTS, "vault:desk vault:journal offline_access"),
        ("vault:read vault:desk", "vault:read vault:desk"),
    ],
)
@pytest.mark.asyncio
async def test_selected_subset_alone_reaches_code_grant_and_tokens(
    async_client: AsyncClient, db_session: AsyncSession, requested: str, selected: str
) -> None:
    """An unchecked requested permission never reaches the agent, including on refresh."""
    page, client_id = await _page(async_client, db_session, scope=requested)
    response = await async_client.post(
        "/oauth/authorize/decision",
        data={
            "ticket": ticket_from(page),
            "decision": "approve",
            **{f"grant.{scope}": "on" for scope in selected.split()},
        },
    )
    assert response.status_code == HTTPStatus.SEE_OTHER, response.text
    _target, query = redirect_query(response)
    code = (await db_session.execute(select(OAuthAuthorizationCode))).scalars().one()
    grant = (await db_session.execute(select(AgentGrant))).scalars().one()
    assert code.scope == selected
    assert grant.grants == selected.split()
    token = await exchange(async_client, code_exchange_form(query["code"], client_id))
    assert token.status_code == HTTPStatus.OK, token.text
    body = token.json()
    assert body["scope"] == selected
    assert body["expires_in"] == 600
    claims = jwt.decode(body["access_token"], options={"verify_signature": False})
    assert claims["scope"] == selected
    assert "vault:pipeline" not in claims["scope"]
    if "offline_access" in selected.split():
        refreshed = await exchange(
            async_client,
            {
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": body["refresh_token"],
            },
        )
        assert refreshed.status_code == HTTPStatus.OK, refreshed.text
        assert refreshed.json()["scope"] == selected
    else:
        assert "refresh_token" not in body
        assert (await db_session.execute(select(OAuthRefreshToken))).scalars().first() is None


@pytest.mark.parametrize(
    "fields",
    [
        [("grant.vault:pipeline", "on")],
        [("grant.vault:unknown", "on")],
        [("grant.vault:read", "false")],
        [("grant.vault:read", "on"), ("grant.vault:read", "on")],
        [],
    ],
)
@pytest.mark.asyncio
async def test_unrequested_malformed_or_empty_selection_approves_nothing(
    async_client: AsyncClient, db_session: AsyncSession, fields: list[tuple[str, str]]
) -> None:
    """No choices means no access; modifying the form cannot expand the signed request."""
    page, _client_id = await _page(async_client, db_session, scope="vault:read")
    response = await async_client.post(
        "/oauth/authorize/decision",
        content=urlencode([("ticket", ticket_from(page)), ("decision", "approve"), *fields]),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert "code=" not in response.headers.get("location", "")
    assert (await db_session.execute(select(OAuthAuthorizationCode))).scalars().first() is None
    assert (await db_session.execute(select(AgentGrant))).scalars().first() is None
    if not fields:
        assert response.status_code == HTTPStatus.SEE_OTHER
        assert redirect_query(response)[1]["error"] == "access_denied"
