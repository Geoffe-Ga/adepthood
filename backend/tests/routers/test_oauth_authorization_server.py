"""The vault-agent authorization server, end to end through HTTP (#3532).

Each section is one endpoint, driven as an agent and a person's browser would
drive it: discover the metadata, register, ask to authorize, sign in, decide.
The security properties the issue names -- PKCE S256 only, exact redirects,
no open redirect, the person's own vault as the only resource -- each have a
test here; the cross-tenant case lives with the other IDOR regressions in
``tests/security/test_idor.py``.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import func, select

from models.agent_grant import AgentGrant
from models.login_attempt import LoginAttempt
from models.oauth_authorization_code import OAuthAuthorizationCode
from models.oauth_client import OAuthClient
from models.user import User
from routers.auth import session_signing_secret
from services import oauth_metadata_fetch
from services.email_templates import PALETTE
from services.oauth_authorization import (
    OAUTH_ISSUER_ENV_VAR,
    AuthorizationRequest,
    hash_code,
    sign_consent_ticket,
)
from services.user_vault_config import clear_vault_config
from tests.helpers.oauth import (
    CHALLENGE,
    ISSUER,
    PASSWORD,
    PRESENTED_REDIRECT,
    authorize_params,
    connect_vault,
    decide,
    redirect_query,
    register_agent,
    signup,
    ticket_from,
)


@pytest.fixture(autouse=True)
def _issuer(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every test runs against one configured issuer."""
    monkeypatch.setenv(OAUTH_ISSUER_ENV_VAR, ISSUER)


async def _count(db_session: AsyncSession, model: type[object]) -> int:
    return int((await db_session.execute(select(func.count()).select_from(model))).scalar_one())


async def _consent_page(
    async_client: AsyncClient, db_session: AsyncSession, name: str
) -> tuple[httpx.Response, str, int]:
    """Sign up, connect a vault, register an agent and land on its consent page."""
    headers, user_id = await signup(async_client, name)
    resource = await connect_vault(db_session, user_id, name)
    client_id = await register_agent(async_client)
    page = await async_client.get(
        "/oauth/authorize", params=authorize_params(client_id, resource), headers=headers
    )
    return page, client_id, user_id


# --- metadata ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_metadata_names_every_endpoint_under_the_configured_issuer(
    async_client: AsyncClient,
) -> None:
    """RFC 8414, with both CIMD values Claude looks for."""
    response = await async_client.get("/.well-known/oauth-authorization-server")
    assert response.status_code == HTTPStatus.OK
    document = response.json()
    assert document["issuer"] == ISSUER
    assert document["authorization_endpoint"] == f"{ISSUER}/oauth/authorize"
    assert document["registration_endpoint"] == f"{ISSUER}/oauth/register"
    assert document["code_challenge_methods_supported"] == ["S256"]
    assert document["client_id_metadata_document_supported"] is True
    assert document["token_endpoint_auth_methods_supported"] == ["none"]


@pytest.mark.asyncio
async def test_production_without_an_issuer_publishes_nothing(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No metadata, and no authorization page, rather than an issuer guessed from the wire."""
    monkeypatch.delenv(OAUTH_ISSUER_ENV_VAR)
    monkeypatch.setenv("ENV", "production")
    metadata = await async_client.get("/.well-known/oauth-authorization-server")
    assert metadata.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert metadata.json() == {"detail": "oauth_issuer_unconfigured"}
    page = await async_client.get("/oauth/authorize", params={"client_id": "cl_x"})
    assert page.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert "not available here yet" in page.text
    for path in ("/oauth/authorize/sign-in", "/oauth/authorize/decision"):
        posted = await async_client.post(path, data={"ticket": "x"})
        assert posted.status_code == HTTPStatus.SERVICE_UNAVAILABLE


# --- registration ------------------------------------------------------------


@pytest.mark.asyncio
async def test_registration_returns_a_public_client_and_no_secret(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """RFC 7591 section 3.2.1, minus the secret a public client never has."""
    response = await async_client.post(
        "/oauth/register",
        json={
            "client_name": "OpenClaw",
            "redirect_uris": ["http://localhost/callback"],
            "scope": "vault:read",
            "software_id": "ignored-by-this-server",
        },
    )
    assert response.status_code == HTTPStatus.CREATED, response.text
    body = response.json()
    assert body["client_id"].startswith("cl_")
    assert body["client_name"] == "OpenClaw"
    assert body["redirect_uris"] == ["http://localhost/callback"]
    assert body["token_endpoint_auth_method"] == "none"
    assert body["grant_types"] == ["authorization_code", "refresh_token"]
    assert body["response_types"] == ["code"]
    assert not {key for key in body if "secret" in key}
    assert await _count(db_session, OAuthClient) == 1


@pytest.mark.parametrize(
    ("payload", "error"),
    [
        ({"redirect_uris": ["http://evil.example/cb"]}, "invalid_redirect_uri"),
        ({"redirect_uris": []}, "invalid_redirect_uri"),
        (
            {"redirect_uris": ["https://a.example/cb"], "token_endpoint_auth_method": "x"},
            "invalid_client_metadata",
        ),
        (
            {"redirect_uris": ["https://a.example/cb"], "grant_types": ["client_credentials"]},
            "invalid_client_metadata",
        ),
    ],
)
@pytest.mark.asyncio
async def test_a_refused_registration_answers_with_the_rfc_error(
    async_client: AsyncClient,
    db_session: AsyncSession,
    payload: dict[str, object],
    error: str,
) -> None:
    """A 400 carrying RFC 7591's own code, and nothing stored."""
    response = await async_client.post("/oauth/register", json=payload)
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["error"] == error
    assert response.json()["error_description"]
    assert await _count(db_session, OAuthClient) == 0


@pytest.mark.asyncio
async def test_a_body_of_the_wrong_shape_is_a_validation_refusal(
    async_client: AsyncClient,
) -> None:
    """Not RFC client metadata at all: the app's ordinary 422."""
    response = await async_client.post("/oauth/register", json={"redirect_uris": "not-a-list"})
    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_registration_is_rate_limited_per_address(async_client: AsyncClient) -> None:
    """Twenty an hour from one address, then 429."""
    body = {"client_name": "Burst", "redirect_uris": ["https://a.example/cb"]}
    for _ in range(20):
        assert (await async_client.post("/oauth/register", json=body)).status_code == 201
    assert (
        await async_client.post("/oauth/register", json=body)
    ).status_code == HTTPStatus.TOO_MANY_REQUESTS


# --- authorize: before the redirect is trusted -----------------------------------


@pytest.mark.asyncio
async def test_an_unknown_client_is_refused_on_a_page_without_redirecting(
    async_client: AsyncClient,
) -> None:
    """Nothing on the request is trusted yet, so the browser goes nowhere."""
    response = await async_client.get(
        "/oauth/authorize", params=authorize_params("cl_never_issued", "https://v.example/mcp")
    )
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert "location" not in response.headers
    assert "could not tell which agent" in response.text


@pytest.mark.parametrize(
    "redirect_uri",
    [
        "https://evil.example/callback",
        "http://127.0.0.1:3118/callback/../../evil",
        "http://127.0.0.1:3118/other",
        "http://localhost:3118/callback",
        "",
    ],
)
@pytest.mark.asyncio
async def test_a_redirect_the_client_did_not_register_is_refused_without_redirecting(
    async_client: AsyncClient, redirect_uri: str
) -> None:
    """The open-redirect defence: an unregistered address is never followed, even with errors."""
    client_id = await register_agent(async_client)
    params = authorize_params(client_id, "https://v.example/mcp", redirect_uri=redirect_uri)
    params["code_challenge_method"] = "plain"
    response = await async_client.get("/oauth/authorize", params=params)
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert "location" not in response.headers
    assert "somewhere it had not said it would" in response.text


@pytest.mark.asyncio
async def test_a_repeated_parameter_is_refused_without_redirecting(
    async_client: AsyncClient,
) -> None:
    """RFC 6749 section 3.1: no parameter twice, and no guessing which one was meant."""
    client_id = await register_agent(async_client)
    query = httpx.QueryParams(authorize_params(client_id, "https://v.example/mcp")).add(
        "redirect_uri", "https://evil.example/cb"
    )
    response = await async_client.get(f"/oauth/authorize?{query}")
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert "location" not in response.headers


# --- authorize: protocol faults go back to the agent ----------------------------


@pytest.mark.parametrize(
    ("overrides", "error"),
    [
        ({"code_challenge_method": "plain"}, "invalid_request"),
        ({"code_challenge_method": ""}, "invalid_request"),
        ({"code_challenge": ""}, "invalid_request"),
        ({"response_type": "token"}, "unsupported_response_type"),
        ({"scope": "vault:read vault:everything"}, "invalid_scope"),
    ],
)
@pytest.mark.asyncio
async def test_a_protocol_fault_is_reported_to_the_verified_redirect(
    async_client: AsyncClient,
    db_session: AsyncSession,
    overrides: dict[str, str],
    error: str,
) -> None:
    """No PKCE, ``plain`` PKCE, the implicit flow, an unknown scope: an RFC error, no code."""
    client_id = await register_agent(async_client)
    params = authorize_params(client_id, "https://v.example/mcp", **overrides)
    response = await async_client.get("/oauth/authorize", params=params)
    assert response.status_code == HTTPStatus.SEE_OTHER
    target, query = redirect_query(response)
    assert target == PRESENTED_REDIRECT
    assert query == {"error": error, "state": "xyz", "iss": ISSUER}
    assert await _count(db_session, OAuthAuthorizationCode) == 0


@pytest.mark.asyncio
async def test_a_request_without_a_resource_is_refused_on_a_page(
    async_client: AsyncClient,
) -> None:
    """RFC 8707 resource is required, and its absence names no vault anywhere."""
    client_id = await register_agent(async_client)
    response = await async_client.get("/oauth/authorize", params=authorize_params(client_id, ""))
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert "location" not in response.headers
    assert "invalid_target" in response.text


# --- authorize: the person ---------------------------------------------------------


@pytest.mark.asyncio
async def test_a_person_who_is_not_signed_in_is_asked_to_sign_in(
    async_client: AsyncClient,
) -> None:
    """The request rides through the sign-in form in hidden fields, and nothing else does."""
    client_id = await register_agent(async_client)
    params = authorize_params(client_id, "https://v.example/mcp")
    response = await async_client.get("/oauth/authorize", params={**params, "extra": "dropped"})
    assert response.status_code == HTTPStatus.OK
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-store"
    assert 'action="/oauth/authorize/sign-in"' in response.text
    assert f'name="code_challenge" value="{CHALLENGE}"' in response.text
    assert 'name="extra"' not in response.text


@pytest.mark.asyncio
async def test_a_signed_in_person_sees_what_the_agent_asks_for(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The agent's name, each grant in plain words, the floor, and where approval goes."""
    page, _client_id, _user_id = await _consent_page(async_client, db_session, "reader")
    assert page.status_code == HTTPStatus.OK, page.text
    text = page.text
    assert "Claude Code" in text
    assert "That is the name the agent gave itself." in text
    assert "Read and search your Open and Personal writing" in text
    assert "Draft and reflect from your Open and Personal writing" in text
    assert "Add journal entries" not in text
    assert "Intimate entries are never included." in text
    assert "127.0.0.1" in text
    assert "a program running on this computer" in text
    assert 'value="approve"' in text
    assert 'value="decline"' in text
    assert "v-reader.vaults.example" not in text
    assert "style=" not in text
    assert 'href="/oauth/consent.css"' in text


@pytest.mark.asyncio
async def test_the_agents_name_is_escaped(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The name is whatever the agent registered; it is shown as text, never as markup."""
    headers, user_id = await signup(async_client, "escaped")
    resource = await connect_vault(db_session, user_id, "escaped")
    client_id = await register_agent(async_client, name='<script>alert("x")</script>')
    page = await async_client.get(
        "/oauth/authorize", params=authorize_params(client_id, resource), headers=headers
    )
    assert page.status_code == HTTPStatus.OK
    assert "<script>" not in page.text
    assert "&lt;script&gt;" in page.text


@pytest.mark.asyncio
async def test_an_account_without_a_vault_has_nothing_to_authorize(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``invalid_target``, said plainly, with the way to connect one."""
    headers, _user_id = await signup(async_client, "vaultless")
    client_id = await register_agent(async_client)
    response = await async_client.get(
        "/oauth/authorize",
        params=authorize_params(client_id, "https://v.example/mcp"),
        headers=headers,
    )
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert "invalid_target" in response.text
    assert "no vault connected yet" in response.text
    assert await _count(db_session, OAuthAuthorizationCode) == 0


@pytest.mark.asyncio
async def test_an_expired_session_token_is_treated_as_signed_out(
    async_client: AsyncClient,
) -> None:
    """A stale bearer is not an error; the person is simply asked to sign in."""
    client_id = await register_agent(async_client)
    response = await async_client.get(
        "/oauth/authorize",
        params=authorize_params(client_id, "https://v.example/mcp"),
        headers={"Authorization": "Bearer not-a-token"},
    )
    assert response.status_code == HTTPStatus.OK
    assert 'action="/oauth/authorize/sign-in"' in response.text


# --- signing in on the page ----------------------------------------------------------


async def _sign_in(
    async_client: AsyncClient, params: dict[str, str], email: str, password: str
) -> httpx.Response:
    return await async_client.post(
        "/oauth/authorize/sign-in", data={**params, "email": email, "password": password}
    )


@pytest.mark.asyncio
async def test_signing_in_on_the_page_leads_to_the_decision(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The same credentials the app takes, then the consent page."""
    _headers, user_id = await signup(async_client, "formuser")
    resource = await connect_vault(db_session, user_id, "formuser")
    client_id = await register_agent(async_client)
    response = await _sign_in(
        async_client, authorize_params(client_id, resource), "formuser@example.com", PASSWORD
    )
    assert response.status_code == HTTPStatus.OK, response.text
    assert "Intimate entries are never included." in response.text
    assert ticket_from(response)


@pytest.mark.asyncio
async def test_a_wrong_password_is_refused_like_the_app_refuses_it(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A 401, the generic sentence, the request still carried, and the attempt logged."""
    _headers, user_id = await signup(async_client, "wrongpass")
    resource = await connect_vault(db_session, user_id, "wrongpass")
    client_id = await register_agent(async_client)
    params = authorize_params(client_id, resource)
    for email, password in (
        ("wrongpass@example.com", "not-the-password"),
        ("nobody@example.com", PASSWORD),
        ("not-an-email", PASSWORD),
    ):
        response = await _sign_in(async_client, params, email, password)
        assert response.status_code == HTTPStatus.UNAUTHORIZED
        assert "did not match" in response.text
        assert f'name="code_challenge" value="{CHALLENGE}"' in response.text
        assert password not in response.text
    attempts = (
        await db_session.execute(
            select(func.count())
            .select_from(LoginAttempt)
            .where(LoginAttempt.email == "wrongpass@example.com")
        )
    ).scalar_one()
    assert attempts >= 1


@pytest.mark.asyncio
async def test_the_sign_in_form_reads_only_form_encoding(async_client: AsyncClient) -> None:
    """A JSON body is not a form; refused on a page, not parsed as one."""
    response = await async_client.post(
        "/oauth/authorize/sign-in", content=json.dumps({"email": "a@example.com"})
    )
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert "location" not in response.headers


@pytest.mark.asyncio
async def test_the_sign_in_form_is_rate_limited_like_login(async_client: AsyncClient) -> None:
    """Five a minute from one address, then 429: no cheaper place to guess a password."""
    client_id = await register_agent(async_client)
    params = authorize_params(client_id, "https://v.example/mcp")
    for _ in range(5):
        await _sign_in(async_client, params, "who@example.com", "guessing-123")
    response = await _sign_in(async_client, params, "who@example.com", "guessing-123")
    assert response.status_code == HTTPStatus.TOO_MANY_REQUESTS


# --- deciding -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approve_sends_the_agent_a_one_time_code_bound_to_the_request(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """303 to the presented redirect with the code, the state and the issuer; one code row."""
    page, client_id, user_id = await _consent_page(async_client, db_session, "approver")
    response = await decide(async_client, ticket_from(page), "approve")
    assert response.status_code == HTTPStatus.SEE_OTHER, response.text
    target, query = redirect_query(response)
    assert target == PRESENTED_REDIRECT
    assert set(query) == {"code", "state", "iss"}
    assert query["state"] == "xyz"
    assert query["iss"] == ISSUER
    row = (await db_session.execute(select(OAuthAuthorizationCode))).scalars().one()
    assert row.code_hash == hash_code(query["code"])
    assert row.client_id == client_id
    assert row.user_id == user_id
    assert row.redirect_uri == PRESENTED_REDIRECT
    assert row.code_challenge == CHALLENGE
    assert row.resource == "https://v-approver.vaults.example/mcp"
    assert row.scope == "vault:read vault:desk"
    grant = (await db_session.execute(select(AgentGrant))).scalars().one()
    assert (grant.user_id, grant.client_id) == (user_id, client_id)
    assert grant.grants == ["vault:read", "vault:desk"]


@pytest.mark.asyncio
async def test_decline_sends_access_denied_and_writes_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The agent learns the person said no; no code, no grant."""
    page, _client_id, _user_id = await _consent_page(async_client, db_session, "decliner")
    response = await decide(async_client, ticket_from(page), "decline")
    assert response.status_code == HTTPStatus.SEE_OTHER
    target, query = redirect_query(response)
    assert target == PRESENTED_REDIRECT
    assert query == {"error": "access_denied", "state": "xyz", "iss": ISSUER}
    assert await _count(db_session, OAuthAuthorizationCode) == 0
    assert await _count(db_session, AgentGrant) == 0


@pytest.mark.parametrize("ticket", ["", "garbage", "a.b.c"])
@pytest.mark.asyncio
async def test_a_missing_or_forged_ticket_approves_nothing(
    async_client: AsyncClient, db_session: AsyncSession, ticket: str
) -> None:
    """Only a ticket this server signed for this request can be approved."""
    response = await decide(async_client, ticket, "approve")
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert "location" not in response.headers
    assert await _count(db_session, OAuthAuthorizationCode) == 0


@pytest.mark.asyncio
async def test_an_expired_ticket_approves_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A page left open past its life asks the person to start again."""
    _headers, user_id = await signup(async_client, "stale")
    resource = await connect_vault(db_session, user_id, "stale")
    client_id = await register_agent(async_client)
    request = AuthorizationRequest(
        client_id=client_id,
        redirect_uri=PRESENTED_REDIRECT,
        code_challenge=CHALLENGE,
        scopes=("vault:read",),
        state="xyz",
        resource=resource,
    )
    old = sign_consent_ticket(
        request,
        user_id,
        secret=session_signing_secret(),
        now=datetime.now(UTC) - timedelta(hours=1),
    )
    response = await decide(async_client, old, "approve")
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert "open for a while" in response.text
    assert await _count(db_session, OAuthAuthorizationCode) == 0


@pytest.mark.asyncio
async def test_a_vault_changed_after_the_page_rendered_approves_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The resource is checked again at Approve, not only when the page was drawn."""
    page, _client_id, user_id = await _consent_page(async_client, db_session, "mover")
    await clear_vault_config(db_session, user_id)
    response = await decide(async_client, ticket_from(page), "approve")
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert "invalid_target" in response.text
    assert await _count(db_session, OAuthAuthorizationCode) == 0


@pytest.mark.asyncio
async def test_an_account_disabled_after_the_page_rendered_approves_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A ticket outlives its page by minutes; a disabled account cannot finish with it."""
    page, _client_id, user_id = await _consent_page(async_client, db_session, "disabled")
    user = await db_session.get(User, user_id)
    assert user is not None
    user.is_active = False
    db_session.add(user)
    await db_session.commit()
    response = await decide(async_client, ticket_from(page), "approve")
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert "location" not in response.headers
    assert await _count(db_session, OAuthAuthorizationCode) == 0


@pytest.mark.asyncio
async def test_an_unknown_decision_approves_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Approve and Decline are the only two answers."""
    page, _client_id, _user_id = await _consent_page(async_client, db_session, "undecided")
    response = await decide(async_client, ticket_from(page), "maybe")
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert await _count(db_session, OAuthAuthorizationCode) == 0


@pytest.mark.asyncio
async def test_a_client_removed_after_the_page_rendered_approves_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A ticket for a client the registry no longer holds redirects nowhere."""
    page, client_id, _user_id = await _consent_page(async_client, db_session, "orphan")
    client = (
        await db_session.execute(select(OAuthClient).where(OAuthClient.client_id == client_id))
    ).scalar_one()
    await db_session.delete(client)
    await db_session.commit()
    response = await decide(async_client, ticket_from(page), "approve")
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert "location" not in response.headers


# --- a client described by its own metadata document -------------------------------


@pytest.mark.asyncio
async def test_a_metadata_document_client_needs_no_registration(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The document's redirects govern, and the flow completes as for a registered client."""
    document_url = "https://agent.example/oauth/client.json"
    callback = "https://agent.example/callback"

    def _serve(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "client_id": document_url,
                "client_name": "Document Agent",
                "redirect_uris": [callback],
            },
        )

    monkeypatch.setattr(
        oauth_metadata_fetch, "build_metadata_transport", lambda: httpx.MockTransport(_serve)
    )
    headers, user_id = await signup(async_client, "cimd")
    resource = await connect_vault(db_session, user_id, "cimd")
    params = authorize_params(document_url, resource, redirect_uri=callback)
    page = await async_client.get("/oauth/authorize", params=params, headers=headers)
    assert page.status_code == HTTPStatus.OK, page.text
    assert "Document Agent" in page.text
    assert "agent.example" in page.text
    assert "a program running on this computer" not in page.text
    response = await decide(async_client, ticket_from(page), "approve")
    target, query = redirect_query(response)
    assert target == callback
    assert "code" in query

    elsewhere = authorize_params(document_url, resource, redirect_uri="https://evil.example/cb")
    refused = await async_client.get("/oauth/authorize", params=elsewhere, headers=headers)
    assert refused.status_code == HTTPStatus.BAD_REQUEST
    assert "location" not in refused.headers


# --- the stylesheet -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_stylesheet_is_candle_and_ink(async_client: AsyncClient) -> None:
    """Same-origin CSS, drawn from the backend's one copy of the tokens."""
    response = await async_client.get("/oauth/consent.css")
    assert response.status_code == HTTPStatus.OK
    assert response.headers["content-type"].startswith("text/css")
    assert PALETTE["canvas"] in response.text
    assert PALETTE["accent_primary"] in response.text
    assert "&#39;" not in response.text
