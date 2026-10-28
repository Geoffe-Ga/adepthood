"""The rules an authorization request is judged by (#3532), one at a time.

Each rule here is a security property of the authorization endpoint, so each is
pinned on both sides: the value it must accept and the nearest value it must
refuse. The router tests drive the same rules through HTTP; these exist so a
regression names the rule rather than a status code.
"""

from __future__ import annotations

import base64
import hashlib
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.agent_grant import AgentGrant
from models.oauth_authorization_code import OAuthAuthorizationCode
from models.oauth_client import OAuthClient, OAuthClientSource
from models.user import User
from models.vault_activation import VaultActivation, VaultActivationState
from services import oauth_authorization as rules
from services.user_vault_config import store_vault_config

_SECRET = "a-test-deployment-secret-of-some-length"  # pragma: allowlist secret
# RFC 7636 appendix B's published example verifier.
_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"  # pragma: allowlist secret
_CHALLENGE = (
    base64.urlsafe_b64encode(hashlib.sha256(_VERIFIER.encode()).digest()).rstrip(b"=").decode()
)
_VAULT_URL = "https://v-7q2k.creek.fly.dev/v1"
_VAULT_RESOURCE = "https://v-7q2k.creek.fly.dev/mcp"
_NOW = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)


def _params(**overrides: str) -> dict[str, str]:
    """A complete, valid authorization request's query, with any field replaced."""
    params = {
        "response_type": "code",
        "client_id": "cl_agent",
        "redirect_uri": "http://127.0.0.1:3118/callback",
        "code_challenge": _CHALLENGE,
        "code_challenge_method": "S256",
        "state": "xyz",
        "scope": "vault:read vault:desk",
        "resource": _VAULT_RESOURCE,
    }
    params.update(overrides)
    return params


# --- metadata --------------------------------------------------------------


def test_the_metadata_advertises_exactly_what_the_endpoint_enforces() -> None:
    """Claude picks CIMD only when both CIMD values are present; PKCE is S256 only."""
    document = rules.authorization_server_metadata("https://api.example")
    assert document == {
        "issuer": "https://api.example",
        "authorization_endpoint": "https://api.example/oauth/authorize",
        "token_endpoint": "https://api.example/oauth/token",
        "registration_endpoint": "https://api.example/oauth/register",
        "jwks_uri": "https://api.example/.well-known/jwks.json",
        "revocation_endpoint": "https://api.example/oauth/revoke",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "client_id_metadata_document_supported": True,
        "scopes_supported": [
            "vault:read",
            "vault:desk",
            "vault:journal",
            "vault:pipeline",
            "offline_access",
        ],
        "authorization_response_iss_parameter_supported": True,
    }


def test_the_issuer_is_configured_and_never_keeps_a_trailing_slash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A trailing slash would make ``iss`` differ from what the vault expects by one byte."""
    monkeypatch.setenv(rules.OAUTH_ISSUER_ENV_VAR, " https://api.example/ ")
    assert rules.configured_issuer() == "https://api.example"


def test_the_issuer_falls_back_to_the_dev_server_outside_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A laptop gets a working issuer with no configuration at all."""
    monkeypatch.delenv(rules.OAUTH_ISSUER_ENV_VAR, raising=False)
    monkeypatch.setenv("ENV", "development")
    assert rules.configured_issuer() == rules.DEV_ISSUER


def test_production_has_no_issuer_until_one_is_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A production issuer guessed from anything on the wire would be the caller's to choose."""
    monkeypatch.delenv(rules.OAUTH_ISSUER_ENV_VAR, raising=False)
    monkeypatch.setenv("ENV", "production")
    assert rules.configured_issuer() is None


# --- redirect URIs ---------------------------------------------------------


@pytest.mark.parametrize(
    "uri",
    [
        "https://claude.ai/api/mcp/auth_callback",
        "https://chatgpt.com/connector_platform_oauth_redirect",
        "http://localhost/callback",
        "http://127.0.0.1:3118/callback",
        "http://[::1]:9000/cb",
    ],
)
def test_https_and_loopback_redirects_may_be_registered(uri: str) -> None:
    """The three acceptance clients' callbacks, plus every loopback spelling."""
    assert rules.redirect_uri_is_registrable(uri)


@pytest.mark.parametrize(
    "uri",
    [
        "http://evil.example/callback",
        "http://192.168.1.4:3000/callback",
        "javascript:alert(1)",
        "cursor://callback",
        "https://claude.ai/cb#fragment",
        "https://user:pass@claude.ai/cb",  # pragma: allowlist secret
        "https:///no-host",
        "/relative/callback",
        "",
        "https://claude.ai/" + "x" * 2048,
    ],
)
def test_everything_else_is_refused_at_registration(uri: str) -> None:
    """Plain http off-box, script schemes, fragments, userinfo and relative paths."""
    assert not rules.redirect_uri_is_registrable(uri)


def test_a_https_redirect_matches_only_itself() -> None:
    """Exact match: no prefix, no extra path, no swapped host."""
    registered = ["https://claude.ai/api/mcp/auth_callback"]
    assert rules.redirect_uri_matches(registered, "https://claude.ai/api/mcp/auth_callback")
    for attempt in (
        "https://claude.ai/api/mcp/auth_callback/../evil",
        "https://claude.ai/api/mcp/auth_callback?next=https://evil.example",
        "https://claude.ai.evil.example/api/mcp/auth_callback",
        "https://claude.ai:8443/api/mcp/auth_callback",
        "http://claude.ai/api/mcp/auth_callback",
    ):
        assert not rules.redirect_uri_matches(registered, attempt), attempt


def test_a_loopback_redirect_matches_on_any_port() -> None:
    """Claude Code and OpenClaw listen on an ephemeral port chosen per sign-in."""
    registered = ["http://127.0.0.1/callback"]
    assert rules.redirect_uri_matches(registered, "http://127.0.0.1:3118/callback")
    assert rules.redirect_uri_matches(registered, "http://127.0.0.1:50211/callback")


def test_a_loopback_redirect_still_matches_host_and_path_exactly() -> None:
    """Port-agnostic is the only relaxation; the loopback spelling and path still bind."""
    registered = ["http://127.0.0.1:3000/callback"]
    assert not rules.redirect_uri_matches(registered, "http://localhost:3000/callback")
    assert not rules.redirect_uri_matches(registered, "http://127.0.0.1:3000/other")
    assert not rules.redirect_uri_matches(registered, "https://127.0.0.1:3000/callback")
    assert not rules.redirect_uri_matches(registered, "http://127.0.0.1:3000/callback?x=1")


def test_an_unparseable_presented_redirect_matches_nothing() -> None:
    """A redirect that will not parse is refused rather than raised on."""
    assert not rules.redirect_uri_matches(["http://127.0.0.1/cb"], "http://[::1/cb")


def test_loopback_detection_reads_the_host_not_the_string() -> None:
    """``localhost.evil.example`` is not on this computer."""
    assert rules.is_loopback_redirect("http://localhost:1/cb")
    assert not rules.is_loopback_redirect("https://localhost.evil.example/cb")
    assert not rules.is_loopback_redirect("https://claude.ai/cb")


def test_redirect_parameters_are_appended_after_an_existing_query() -> None:
    """A registered query survives; the new parameters are encoded, never spliced."""
    assert (
        rules.redirect_with("https://a.example/cb?tenant=1", {"code": "ac_x", "state": "a b"})
        == "https://a.example/cb?tenant=1&code=ac_x&state=a+b"
    )
    assert rules.redirect_with("https://a.example/cb", {"error": "access_denied"}) == (
        "https://a.example/cb?error=access_denied"
    )


def test_the_redirect_host_is_what_the_person_is_shown() -> None:
    """The consent page names where approval sends them, host only."""
    assert rules.redirect_host("http://127.0.0.1:3118/callback") == "127.0.0.1"
    assert rules.redirect_host("https://claude.ai/api/mcp/auth_callback") == "claude.ai"


# --- scope, PKCE, resource --------------------------------------------------


def test_scopes_are_deduplicated_into_the_servers_order() -> None:
    """The stored scope string is canonical, whatever order the agent asked in."""
    assert rules.parse_scope("vault:desk vault:read vault:desk") == ("vault:read", "vault:desk")


@pytest.mark.parametrize("raw", ["", "   ", "vault:read vault:everything", "openid", None])
def test_an_empty_or_unknown_scope_is_refused(raw: str | None) -> None:
    """A subset of the supported set, and never nothing."""
    assert rules.parse_scope(raw) is None


def test_an_s256_challenge_has_the_shape_of_a_digest() -> None:
    """43 to 128 unreserved characters, per RFC 7636."""
    assert rules.code_challenge_is_valid(_CHALLENGE)
    assert rules.code_challenge_is_valid("a" * 128)
    assert not rules.code_challenge_is_valid("a" * 42)
    assert not rules.code_challenge_is_valid("a" * 129)
    assert not rules.code_challenge_is_valid("a" * 42 + "!")


def test_a_resource_is_normalized_for_comparison() -> None:
    """Case-folded scheme and host, no trailing slash: one vault, one spelling."""
    assert rules.normalize_resource("HTTPS://V-7Q2K.creek.fly.dev/mcp/") == _VAULT_RESOURCE


@pytest.mark.parametrize(
    "resource",
    [
        "https://vault.example/mcp#frag",
        "https://vault.example/mcp?tenant=2",
        "https://user@vault.example/mcp",
        "http://vault.example/mcp",
        "ftp://vault.example/mcp",
        "vault.example/mcp",
        "",
        "https://[::1/mcp",
    ],
)
def test_a_resource_that_is_not_an_absolute_secure_address_is_refused(resource: str) -> None:
    """RFC 8707 forbids a fragment; a query, userinfo or plaintext transport is refused too."""
    assert rules.normalize_resource(resource) is None


def test_a_loopback_vault_may_be_named_over_plain_http() -> None:
    """The self-hosted tracer runs its vault on the same machine."""
    assert rules.normalize_resource("http://localhost:8823/mcp") == "http://localhost:8823/mcp"


def test_the_vault_mcp_url_is_the_vault_root_plus_mcp() -> None:
    """The MCP mount sits beside ``/v1`` in the same process, so ``/v1`` is dropped."""
    assert rules.vault_mcp_url(_VAULT_URL) == _VAULT_RESOURCE
    assert rules.vault_mcp_url("https://vault.example/") == "https://vault.example/mcp"


# --- the whole request ------------------------------------------------------


def test_a_complete_request_is_read_into_one_value() -> None:
    """Every field the code will be bound to, already normalized."""
    request = rules.read_authorization_request(_params(scope="vault:desk vault:read"))
    assert request == rules.AuthorizationRequest(
        client_id="cl_agent",
        redirect_uri="http://127.0.0.1:3118/callback",
        code_challenge=_CHALLENGE,
        scopes=("vault:read", "vault:desk"),
        state="xyz",
        resource=_VAULT_RESOURCE,
    )


@pytest.mark.parametrize(
    ("overrides", "error"),
    [
        ({"response_type": "token"}, rules.AuthorizationError.UNSUPPORTED_RESPONSE_TYPE),
        ({"response_type": ""}, rules.AuthorizationError.UNSUPPORTED_RESPONSE_TYPE),
        ({"code_challenge_method": "plain"}, rules.AuthorizationError.INVALID_REQUEST),
        ({"code_challenge_method": ""}, rules.AuthorizationError.INVALID_REQUEST),
        ({"code_challenge": ""}, rules.AuthorizationError.INVALID_REQUEST),
        ({"code_challenge": "short"}, rules.AuthorizationError.INVALID_REQUEST),
        ({"state": ""}, rules.AuthorizationError.INVALID_REQUEST),
        ({"scope": "vault:everything"}, rules.AuthorizationError.INVALID_SCOPE),
        ({"resource": ""}, rules.AuthorizationError.INVALID_TARGET),
        ({"resource": "https://vault.example/mcp#x"}, rules.AuthorizationError.INVALID_TARGET),
    ],
)
def test_each_missing_or_wrong_field_is_named_by_its_rfc_code(
    overrides: dict[str, str], error: rules.AuthorizationError
) -> None:
    """No ``plain`` PKCE, no implicit flow, no unknown scope, no missing resource."""
    assert rules.read_authorization_request(_params(**overrides)) == error


def test_an_absent_field_is_refused_like_an_empty_one() -> None:
    """A dropped parameter must not read as a default."""
    params = _params()
    del params["code_challenge_method"]
    assert rules.read_authorization_request(params) == rules.AuthorizationError.INVALID_REQUEST


def test_the_resource_rule_runs_last() -> None:
    """A request that is wrong in two ways names the protocol fault, not the vault."""
    params = _params(scope="nope", resource="")
    assert rules.read_authorization_request(params) == rules.AuthorizationError.INVALID_SCOPE


# --- the account's own vault ------------------------------------------------


async def _user(db_session: AsyncSession, email: str) -> int:
    user = User(email=email, password_hash="x")
    db_session.add(user)
    await db_session.commit()
    assert user.id is not None
    return user.id


@pytest.mark.asyncio
async def test_an_account_without_a_vault_has_no_resource(db_session: AsyncSession) -> None:
    """No vault, nothing to authorize."""
    user_id = await _user(db_session, "novault@example.com")
    assert await rules.account_vault_resource(db_session, user_id) is None


@pytest.mark.asyncio
async def test_a_connected_vault_is_the_accounts_resource(db_session: AsyncSession) -> None:
    """The self-connected vault's root plus ``/mcp``."""
    user_id = await _user(db_session, "connected@example.com")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_URL, api_key="k" * 20)
    assert await rules.account_vault_resource(db_session, user_id) == _VAULT_RESOURCE


@pytest.mark.asyncio
async def test_a_managed_vault_is_the_resource_only_once_ready(db_session: AsyncSession) -> None:
    """A handed-off credential is inert until the allocation is ready; so is its resource."""
    user_id = await _user(db_session, "managed@example.com")
    await store_vault_config(
        db_session, user_id, vault_url=_VAULT_URL, api_key="k" * 20, provisioned=True
    )
    assert await rules.account_vault_resource(db_session, user_id) is None
    activation = VaultActivation(
        user_id=user_id,
        activation_id="act-1",
        consumer_identity="acct_1",
        state=VaultActivationState.PROVISIONING.value,
    )
    db_session.add(activation)
    await db_session.commit()
    assert await rules.account_vault_resource(db_session, user_id) is None
    activation.state = VaultActivationState.READY.value
    db_session.add(activation)
    await db_session.commit()
    assert await rules.account_vault_resource(db_session, user_id) == _VAULT_RESOURCE


# --- consent tickets ---------------------------------------------------------


def _request() -> rules.AuthorizationRequest:
    request = rules.read_authorization_request(_params())
    assert isinstance(request, rules.AuthorizationRequest)
    return request


def test_a_consent_ticket_round_trips_the_request_and_the_account() -> None:
    """What the person saw is exactly what Approve binds the code to."""
    ticket = rules.sign_consent_ticket(_request(), 7, secret=_SECRET, now=_NOW)
    assert rules.read_consent_ticket(ticket, secret=_SECRET, now=_NOW) == (_request(), 7)


def test_a_consent_ticket_expires() -> None:
    """A page left open is not a standing approval."""
    ticket = rules.sign_consent_ticket(_request(), 7, secret=_SECRET, now=_NOW)
    later = _NOW + rules.CONSENT_TICKET_TTL + timedelta(seconds=1)
    assert rules.read_consent_ticket(ticket, secret=_SECRET, now=later) is None


def test_a_tampered_or_foreign_ticket_is_refused() -> None:
    """Another secret, a flipped byte, or plain garbage: all nothing."""
    ticket = rules.sign_consent_ticket(_request(), 7, secret=_SECRET, now=_NOW)
    other = "another-secret-entirely!!"  # pragma: allowlist secret
    assert rules.read_consent_ticket(ticket, secret=other, now=_NOW) is None
    assert rules.read_consent_ticket(ticket[:-2] + "xx", secret=_SECRET, now=_NOW) is None
    assert rules.read_consent_ticket("not-a-ticket", secret=_SECRET, now=_NOW) is None


def test_a_session_token_signed_with_the_deployment_secret_is_not_a_ticket() -> None:
    """The ticket key is derived: a session JWT and a ticket never stand in for each other."""
    session_token = jwt.encode(
        {"sub": "7", "exp": _NOW + timedelta(minutes=5)}, _SECRET, algorithm="HS256"
    )
    assert rules.read_consent_ticket(session_token, secret=_SECRET, now=_NOW) is None
    ticket = rules.sign_consent_ticket(_request(), 7, secret=_SECRET, now=_NOW)
    with pytest.raises(jwt.InvalidSignatureError):
        jwt.decode(ticket, _SECRET, algorithms=["HS256"])


def test_a_well_signed_ticket_missing_a_field_is_refused() -> None:
    """A ticket is read whole or not at all."""
    key = rules.consent_ticket_key(_SECRET)
    partial = jwt.encode(
        {"typ": rules.CONSENT_TICKET_TYPE, "uid": 7, "exp": _NOW + timedelta(minutes=1)},
        key,
        algorithm="HS256",
    )
    assert rules.read_consent_ticket(partial, secret=_SECRET, now=_NOW) is None
    wrong_type = jwt.encode(
        {"typ": "something_else", "exp": _NOW + timedelta(minutes=1)}, key, algorithm="HS256"
    )
    assert rules.read_consent_ticket(wrong_type, secret=_SECRET, now=_NOW) is None


# --- issuing a code ---------------------------------------------------------


async def _client(db_session: AsyncSession) -> None:
    db_session.add(
        OAuthClient(
            client_id="cl_agent",
            client_name="Claude Code",
            redirect_uris=["http://127.0.0.1/callback"],
            source=OAuthClientSource.DYNAMIC_REGISTRATION.value,
        )
    )
    await db_session.commit()


@pytest.mark.asyncio
async def test_approval_issues_a_hashed_one_minute_code_bound_to_everything(
    db_session: AsyncSession,
) -> None:
    """Only the digest is stored, and the row carries every binding A2 checks."""
    user_id = await _user(db_session, "approve@example.com")
    await _client(db_session)

    code = await rules.issue_authorization_code(db_session, _request(), user_id, now=_NOW)

    assert code.startswith(rules.CODE_PREFIX)
    row = (await db_session.execute(select(OAuthAuthorizationCode))).scalars().one()
    assert row.code_hash == rules.hash_code(code)
    assert row.code_hash == hashlib.sha256(code.encode()).hexdigest()
    assert code not in row.code_hash
    assert row.client_id == "cl_agent"
    assert row.user_id == user_id
    assert row.redirect_uri == "http://127.0.0.1:3118/callback"
    assert row.code_challenge == _CHALLENGE
    assert row.code_challenge_method == "S256"
    assert row.resource == _VAULT_RESOURCE
    assert row.scope == "vault:read vault:desk"
    assert timedelta(seconds=60) == rules.AUTHORIZATION_CODE_TTL
    assert row.expires_at.replace(tzinfo=UTC) == _NOW + rules.AUTHORIZATION_CODE_TTL
    assert row.consumed_at is None


@pytest.mark.asyncio
async def test_approval_records_one_grant_per_account_and_agent(db_session: AsyncSession) -> None:
    """A second approval restates the grant rather than adding a second one."""
    user_id = await _user(db_session, "grant@example.com")
    await _client(db_session)
    first = await rules.issue_authorization_code(db_session, _request(), user_id, now=_NOW)
    narrower = rules.read_authorization_request(_params(scope="vault:read"))
    assert isinstance(narrower, rules.AuthorizationRequest)
    second = await rules.issue_authorization_code(
        db_session, narrower, user_id, now=_NOW + timedelta(minutes=1)
    )

    assert first != second
    grants = (await db_session.execute(select(AgentGrant))).scalars().all()
    assert len(grants) == 1
    assert grants[0].grants == ["vault:read"]
    assert grants[0].resource == _VAULT_RESOURCE
    assert grants[0].created_at.replace(tzinfo=UTC) == _NOW
    assert grants[0].revoked_at is None


@pytest.mark.asyncio
async def test_re_approving_a_revoked_agent_is_a_new_consent(db_session: AsyncSession) -> None:
    """Revocation is cleared, and ``created_at`` restarts so older credentials predate it."""
    user_id = await _user(db_session, "revoked@example.com")
    await _client(db_session)
    await rules.issue_authorization_code(db_session, _request(), user_id, now=_NOW)
    grant = (await db_session.execute(select(AgentGrant))).scalars().one()
    grant.revoked_at = _NOW + timedelta(hours=1)
    db_session.add(grant)
    await db_session.commit()

    later = _NOW + timedelta(days=1)
    await rules.issue_authorization_code(db_session, _request(), user_id, now=later)

    grant = (
        (await db_session.execute(select(AgentGrant).execution_options(populate_existing=True)))
        .scalars()
        .one()
    )
    assert grant.revoked_at is None
    assert grant.created_at.replace(tzinfo=UTC) == later


@pytest.mark.asyncio
async def test_only_an_active_undeleted_account_may_authorize(db_session: AsyncSession) -> None:
    """Disabled, deleted or missing: none may finish an approval."""
    user_id = await _user(db_session, "active@example.com")
    assert await rules.account_may_authorize(db_session, user_id)
    assert not await rules.account_may_authorize(db_session, user_id + 1000)
    user = await db_session.get(User, user_id)
    assert user is not None
    user.deleted_at = _NOW
    db_session.add(user)
    await db_session.commit()
    assert not await rules.account_may_authorize(db_session, user_id)
    user.deleted_at = None
    user.is_active = False
    db_session.add(user)
    await db_session.commit()
    assert not await rules.account_may_authorize(db_session, user_id)
