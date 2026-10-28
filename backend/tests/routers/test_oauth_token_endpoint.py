"""The token endpoint, the key set and revocation, end to end through HTTP (#3533).

Each test drives the flow an agent drives: a person approves on the consent
page (#3532), the agent exchanges the code with its PKCE verifier, refreshes,
and is cut off. The access token is then read the way the vault reads it
(Creek-Vault#1963): signature through the published key set, ``alg``, ``kid``,
``iss``, ``aud`` and the claim set, so a token this server mints is one the
vault's verifier accepts.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import Final

import jwt
import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, func, select, update

from models.agent_grant import AgentGrant
from models.oauth_authorization_code import OAuthAuthorizationCode
from models.oauth_refresh_token import OAuthRefreshToken
from models.user import User
from models.vault_activation import VaultActivation, VaultActivationState
from routers.oauth_tokens import EXCHANGE_RATE_LIMIT, REVOKE_RATE_LIMIT
from services import oauth_signing_keys
from services.journal_encryption import PRODUCTION_SIGNAL_ENV_VARS
from services.oauth_authorization import (
    EXCHANGE_PATH,
    JWKS_PATH,
    OAUTH_ISSUER_ENV_VAR,
    REVOKE_PATH,
)
from services.oauth_signing_keys import SIGNING_KEYS_ENV_VAR, jwk_thumbprint
from services.oauth_tokens import (
    ACCESS_TOKEN_TTL,
    AGENT_SUBJECT_HEX_DIGITS,
    AGENT_SUBJECT_PREFIX,
    REFRESH_PREFIX,
    REFRESH_TOKEN_TTL,
)
from services.user_vault_config import store_vault_config
from tests.helpers.oauth import (
    ISSUER,
    PASSWORD,
    VAULT_KEY,
    VERIFIER,
    approve,
    approved_code,
    code_exchange_form,
    connect_vault,
    exchange,
    generate_signing_key,
    install_signing_keys,
    register_agent,
    signup,
    vault_url_for,
)
from tests.helpers.openapi_errors import declared_response_schema, live_document, response_validator

_TOKEN: Final = "/oauth/token"
_REVOKE: Final = "/oauth/revoke"
_JWKS: Final = "/.well-known/jwks.json"
_SCOPE: Final = "vault:read vault:desk offline_access"
# A verifier of the right shape that is not the one the challenge was made from.
_WRONG_VERIFIER: Final = "x" * 43
# The claims the vault requires (Creek-Vault#1963 ``REQUIRED_CLAIMS``).
_VAULT_REQUIRED_CLAIMS: Final = ("iss", "sub", "aud", "exp", "iat")
# Every claim an access token carries, and nothing else: no email, no name.
_ACCESS_TOKEN_CLAIMS: Final = frozenset(
    {"iss", "sub", "aud", "scope", "client_id", "iat", "exp", "jti"}
)
_TOKEN_BUDGET: Final = int(EXCHANGE_RATE_LIMIT.split("/", 1)[0])
_REVOKE_BUDGET: Final = int(REVOKE_RATE_LIMIT.split("/", 1)[0])


@pytest.fixture(autouse=True)
def _issuer_and_keys(monkeypatch: pytest.MonkeyPatch) -> object:
    """Every test runs against one configured issuer and one signing key."""
    monkeypatch.setenv(OAUTH_ISSUER_ENV_VAR, ISSUER)
    install_signing_keys(monkeypatch)
    yield
    oauth_signing_keys.reset_cache()


def _validate(method: str, path: str, response: Response) -> None:
    """The body matches the schema this operation publishes for its status."""
    document = live_document()
    schema = declared_response_schema(document, method, path, response.status_code)
    response_validator(document, schema).validate(response.json())


def _assert_no_store(response: Response) -> None:
    """RFC 6749 section 5.1: a token response is never cached."""
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"


def _assert_refused(response: Response, error: str) -> None:
    """An RFC 6749 section 5.2 error, uncached, in the published shape."""
    assert response.status_code == HTTPStatus.BAD_REQUEST, response.text
    assert response.json()["error"] == error
    _assert_no_store(response)
    _validate("post", _TOKEN, response)


async def _tokens(
    async_client: AsyncClient, db_session: AsyncSession, name: str
) -> tuple[dict[str, object], str, str, int]:
    """Approve and exchange for a fresh account; return the body, client, resource, account."""
    code, client_id, resource, user_id = await approved_code(
        async_client, db_session, name, scope=_SCOPE
    )
    response = await exchange(async_client, code_exchange_form(code, client_id))
    assert response.status_code == HTTPStatus.OK, response.text
    return response.json(), client_id, resource, user_id


async def _refresh(async_client: AsyncClient, refresh_token: str, **extra: str) -> Response:
    return await exchange(
        async_client, {"grant_type": "refresh_token", "refresh_token": refresh_token, **extra}
    )


async def _jwks(async_client: AsyncClient) -> jwt.PyJWKSet:
    response = await async_client.get(_JWKS)
    assert response.status_code == HTTPStatus.OK
    return jwt.PyJWKSet.from_dict(response.json())


async def _verify_as_the_vault(
    async_client: AsyncClient, token: str, audience: str
) -> dict[str, object]:
    """Read ``token`` exactly as Creek-Vault#1963's verifier does, and return its claims."""
    header = jwt.get_unverified_header(token)
    assert header["alg"] == "ES256"
    assert "crit" not in header
    kid = header["kid"]
    assert isinstance(kid, str)
    assert kid
    key = (await _jwks(async_client))[kid]
    assert key.algorithm_name == header["alg"]
    claims: dict[str, object] = jwt.decode(
        token,
        key.key,
        algorithms=["ES256"],
        audience=audience,
        issuer=ISSUER,
        options={"require": list(_VAULT_REQUIRED_CLAIMS)},
    )
    return claims


async def _family_rows(db_session: AsyncSession) -> list[OAuthRefreshToken]:
    result = await db_session.execute(
        select(OAuthRefreshToken)
        .order_by(col(OAuthRefreshToken.id))
        .execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


async def _grant(db_session: AsyncSession, user_id: int) -> AgentGrant:
    result = await db_session.execute(
        select(AgentGrant)
        .where(AgentGrant.user_id == user_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().one()


async def _count(db_session: AsyncSession, model: type[object]) -> int:
    return int((await db_session.execute(select(func.count()).select_from(model))).scalar_one())


# --- authorization_code ------------------------------------------------------


@pytest.mark.asyncio
async def test_a_code_and_its_verifier_buy_an_access_and_a_refresh_token(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The happy path: a short-lived bearer for the vault, and a refresh token."""
    code, client_id, _resource, user_id = await approved_code(
        async_client, db_session, "happy", scope=_SCOPE
    )
    response = await exchange(async_client, code_exchange_form(code, client_id))

    assert response.status_code == HTTPStatus.OK, response.text
    _assert_no_store(response)
    _validate("post", _TOKEN, response)
    body = response.json()
    assert set(body) == {"access_token", "token_type", "expires_in", "refresh_token", "scope"}
    assert body["token_type"] == "Bearer"
    assert body["expires_in"] == ACCESS_TOKEN_TTL.total_seconds()
    assert body["scope"] == _SCOPE
    assert body["refresh_token"].startswith(REFRESH_PREFIX)

    stored = (await db_session.execute(select(OAuthAuthorizationCode))).scalars().one()
    assert stored.consumed_at is not None
    grant = await _grant(db_session, user_id)
    assert grant.last_used_at is not None
    (row,) = await _family_rows(db_session)
    assert row.token_hash != body["refresh_token"]
    assert body["refresh_token"] not in row.token_hash


@pytest.mark.asyncio
async def test_the_access_token_is_one_the_vault_verifier_accepts(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """ES256 with a published ``kid``; ``iss``, one-string ``aud``, scopes and the agent."""
    body, client_id, resource, _user_id = await _tokens(async_client, db_session, "verifier")
    token = body["access_token"]
    assert isinstance(token, str)
    claims = await _verify_as_the_vault(async_client, token, resource)

    assert set(claims) == _ACCESS_TOKEN_CLAIMS
    assert claims["iss"] == ISSUER
    assert claims["aud"] == resource
    assert isinstance(claims["aud"], str)
    assert claims["scope"] == _SCOPE
    assert claims["client_id"] == client_id
    assert isinstance(claims["sub"], str)
    assert claims["sub"]
    assert claims["sub"] != client_id
    assert isinstance(claims["exp"], int)
    assert isinstance(claims["iat"], int)
    assert claims["exp"] - claims["iat"] == ACCESS_TOKEN_TTL.total_seconds()
    assert jwt.get_unverified_header(token)["typ"] == "at+jwt"
    assert "@" not in json.dumps(claims)


@pytest.mark.asyncio
async def test_the_subject_is_stable_and_opaque_for_a_self_hosted_vault(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The same account mints the same ``sub`` every time, and it names no row id."""
    body, _client_id, resource, user_id = await _tokens(async_client, db_session, "stable")
    first = await _verify_as_the_vault(async_client, str(body["access_token"]), resource)
    refreshed = await _refresh(async_client, str(body["refresh_token"]))
    assert refreshed.status_code == HTTPStatus.OK
    second = await _verify_as_the_vault(
        async_client, str(refreshed.json()["access_token"]), resource
    )
    assert first["sub"] == second["sub"]
    subject = str(first["sub"])
    assert subject != str(user_id)
    digest = subject.removeprefix(AGENT_SUBJECT_PREFIX)
    assert subject == f"{AGENT_SUBJECT_PREFIX}{digest}"
    assert len(digest) == AGENT_SUBJECT_HEX_DIGITS
    int(digest, 16)


@pytest.mark.asyncio
async def test_a_managed_vaults_subject_is_its_provisioned_consumer_identity(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A managed vault pins ``sub`` to the consumer identity provisioning handed it."""
    headers, user_id = await signup(async_client, "managed")
    await store_vault_config(
        db_session,
        user_id,
        vault_url=vault_url_for("managed"),
        api_key=VAULT_KEY,
        provisioned=True,
    )
    db_session.add(
        VaultActivation(
            user_id=user_id,
            activation_id="activation-managed",
            consumer_identity="adepthood-user-managed-identity",
            state=VaultActivationState.READY.value,
        )
    )
    await db_session.commit()
    resource = "https://v-managed.vaults.example/mcp"
    client_id = await register_agent(async_client)
    code = await approve(async_client, headers, client_id, resource)

    response = await exchange(async_client, code_exchange_form(code, client_id))
    assert response.status_code == HTTPStatus.OK, response.text
    claims = await _verify_as_the_vault(async_client, response.json()["access_token"], resource)
    assert claims["sub"] == "adepthood-user-managed-identity"
    assert claims["client_id"] == client_id


@pytest.mark.asyncio
async def test_a_wrong_verifier_is_refused_and_the_code_stays_unspent(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """PKCE: only the agent that made the challenge holds the verifier."""
    code, client_id, _resource, _user_id = await approved_code(async_client, db_session, "pkce")
    for verifier in (_WRONG_VERIFIER, "short", ""):
        response = await exchange(
            async_client, code_exchange_form(code, client_id, code_verifier=verifier)
        )
        _assert_refused(response, "invalid_grant" if verifier else "invalid_request")
    stored = (await db_session.execute(select(OAuthAuthorizationCode))).scalars().one()
    assert stored.consumed_at is None
    assert await _count(db_session, OAuthRefreshToken) == 0
    good = await exchange(async_client, code_exchange_form(code, client_id))
    assert good.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_a_code_spent_twice_is_refused_and_revokes_what_it_bought(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """OAuth 2.1 section 4.1.3: a replayed code revokes the tokens issued from it."""
    code, client_id, _resource, _user_id = await approved_code(
        async_client, db_session, "replay", scope=_SCOPE
    )
    first = await exchange(async_client, code_exchange_form(code, client_id))
    assert first.status_code == HTTPStatus.OK
    replay = await exchange(async_client, code_exchange_form(code, client_id))
    _assert_refused(replay, "invalid_grant")

    (row,) = await _family_rows(db_session)
    assert row.revoked_at is not None
    refreshed = await _refresh(async_client, first.json()["refresh_token"])
    _assert_refused(refreshed, "invalid_grant")


@pytest.mark.asyncio
async def test_an_expired_code_is_refused(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Sixty seconds, then never."""
    code, client_id, _resource, _user_id = await approved_code(async_client, db_session, "stale")
    await db_session.execute(
        update(OAuthAuthorizationCode).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
    )
    await db_session.commit()
    _assert_refused(
        await exchange(async_client, code_exchange_form(code, client_id)), "invalid_grant"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "override",
    [
        pytest.param({"redirect_uri": "http://127.0.0.1:3118/other"}, id="other-redirect"),
        pytest.param({"redirect_uri": "http://127.0.0.1:9999/callback"}, id="other-port"),
        pytest.param({"code": "ac_never-issued"}, id="unknown-code"),
    ],
)
async def test_a_code_presented_with_anything_but_its_own_binding_is_refused(
    async_client: AsyncClient, db_session: AsyncSession, override: dict[str, str]
) -> None:
    """The exact redirect the code was sent to, and the code itself."""
    code, client_id, _resource, _user_id = await approved_code(async_client, db_session, "bound")
    response = await exchange(async_client, code_exchange_form(code, client_id, **override))
    _assert_refused(response, "invalid_grant")
    assert await _count(db_session, OAuthRefreshToken) == 0


@pytest.mark.asyncio
async def test_a_resent_resource_must_be_the_one_approved(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """RFC 8707: a resent ``resource`` is compared, and a different one is ``invalid_target``."""
    code, client_id, resource, _user_id = await approved_code(async_client, db_session, "target")
    other = await exchange(
        async_client,
        code_exchange_form(code, client_id, resource="https://v-other.vaults.example/mcp"),
    )
    _assert_refused(other, "invalid_target")
    same = await exchange(
        async_client,
        code_exchange_form(
            code, client_id, resource=f"{resource.replace('https://v-', 'HTTPS://V-')}/"
        ),
    )
    assert same.status_code == HTTPStatus.OK, same.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "missing", ["code", "code_verifier", "client_id", "redirect_uri", "grant_type"]
)
async def test_a_request_missing_a_parameter_is_invalid_request(
    async_client: AsyncClient, db_session: AsyncSession, missing: str
) -> None:
    """RFC 6749 section 5.2: a missing parameter is the client's fault, named as such."""
    code, client_id, _resource, _user_id = await approved_code(async_client, db_session, "missing")
    form = code_exchange_form(code, client_id)
    del form[missing]
    _assert_refused(await exchange(async_client, form), "invalid_request")


@pytest.mark.asyncio
async def test_an_unknown_grant_type_is_unsupported(async_client: AsyncClient) -> None:
    """No implicit, no password, no client credentials."""
    for grant_type in ("password", "client_credentials", "implicit"):
        response = await exchange(async_client, {"grant_type": grant_type})
        _assert_refused(response, "unsupported_grant_type")


@pytest.mark.asyncio
async def test_a_json_body_is_refused_with_the_rfc_error_not_a_415(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Form encoding is what OAuth sends; anything else is ``invalid_request``."""
    code, client_id, _resource, _user_id = await approved_code(async_client, db_session, "json")
    response = await async_client.post(_TOKEN, json=code_exchange_form(code, client_id))
    _assert_refused(response, "invalid_request")
    repeated = await async_client.post(
        _TOKEN,
        content=f"grant_type=authorization_code&code={code}&code={code}",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    _assert_refused(repeated, "invalid_request")
    form = await exchange(async_client, code_exchange_form(code, client_id))
    assert form.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_a_revoked_grant_cannot_spend_a_code(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Revoking in Settings between approval and exchange stops the exchange too."""
    code, client_id, _resource, user_id = await approved_code(async_client, db_session, "revoked")
    grant = await _grant(db_session, user_id)
    grant.revoked_at = datetime.now(UTC)
    db_session.add(grant)
    await db_session.commit()
    _assert_refused(
        await exchange(async_client, code_exchange_form(code, client_id)), "invalid_grant"
    )
    assert await _count(db_session, OAuthRefreshToken) == 0


@pytest.mark.asyncio
async def test_a_vault_changed_after_approval_mints_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The audience is re-checked at exchange: it must still be the account's own vault."""
    code, client_id, _resource, user_id = await approved_code(async_client, db_session, "moved")
    await connect_vault(db_session, user_id, "moved-elsewhere")
    _assert_refused(
        await exchange(async_client, code_exchange_form(code, client_id)), "invalid_grant"
    )


@pytest.mark.asyncio
async def test_a_disabled_account_mints_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An account switched off after approving has no agent tokens to give."""
    code, client_id, _resource, user_id = await approved_code(async_client, db_session, "off")
    await db_session.execute(update(User).where(col(User.id) == user_id).values(is_active=False))
    await db_session.commit()
    _assert_refused(
        await exchange(async_client, code_exchange_form(code, client_id)), "invalid_grant"
    )


# --- refresh_token -----------------------------------------------------------


@pytest.mark.asyncio
async def test_a_refresh_rotates_the_pair_and_retires_the_old_token(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Every use mints a new refresh token in the same family; the presented one is spent."""
    body, client_id, resource, user_id = await _tokens(async_client, db_session, "rotate")
    grant = await _grant(db_session, user_id)
    first_use = grant.last_used_at
    refreshed = await _refresh(async_client, str(body["refresh_token"]), client_id=client_id)

    assert refreshed.status_code == HTTPStatus.OK, refreshed.text
    _assert_no_store(refreshed)
    _validate("post", _TOKEN, refreshed)
    pair = refreshed.json()
    assert pair["refresh_token"] != body["refresh_token"]
    assert pair["scope"] == _SCOPE
    claims = await _verify_as_the_vault(async_client, pair["access_token"], resource)
    assert claims["client_id"] == client_id

    old, new = await _family_rows(db_session)
    assert old.family_id == new.family_id
    assert old.rotated_at is not None
    assert new.rotated_at is None
    assert new.revoked_at is None
    assert new.expires_at.replace(tzinfo=UTC) - new.created_at.replace(tzinfo=UTC) == (
        REFRESH_TOKEN_TTL
    )
    refreshed_grant = await _grant(db_session, user_id)
    assert refreshed_grant.last_used_at is not None
    assert first_use is not None
    assert refreshed_grant.last_used_at >= first_use


@pytest.mark.asyncio
async def test_presenting_a_rotated_away_token_revokes_the_whole_family(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Reuse detection: the thief and the agent both lose, and the person re-approves."""
    body, _client_id, _resource, _user_id = await _tokens(async_client, db_session, "reuse")
    original = str(body["refresh_token"])
    rotated = await _refresh(async_client, original)
    assert rotated.status_code == HTTPStatus.OK
    newest = rotated.json()["refresh_token"]

    _assert_refused(await _refresh(async_client, original), "invalid_grant")
    assert all(row.revoked_at is not None for row in await _family_rows(db_session))
    _assert_refused(await _refresh(async_client, newest), "invalid_grant")


@pytest.mark.asyncio
async def test_a_revoked_grant_refuses_refresh(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """What Settings' Revoke does (#3534): the next refresh is ``invalid_grant``."""
    body, _client_id, _resource, user_id = await _tokens(async_client, db_session, "cutoff")
    grant = await _grant(db_session, user_id)
    grant.revoked_at = datetime.now(UTC)
    db_session.add(grant)
    await db_session.commit()
    _assert_refused(await _refresh(async_client, str(body["refresh_token"])), "invalid_grant")


@pytest.mark.asyncio
async def test_a_refresh_token_from_before_a_re_approval_stays_dead(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Revoke, then approve again: tokens from the first consent do not come back."""
    body, client_id, resource, user_id = await _tokens(async_client, db_session, "again")
    grant = await _grant(db_session, user_id)
    grant.revoked_at = datetime.now(UTC)
    db_session.add(grant)
    await db_session.commit()
    login = await async_client.post(
        "/auth/login", json={"email": "again@example.com", "password": PASSWORD}
    )
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    code = await approve(async_client, headers, client_id, resource, scope=_SCOPE)

    _assert_refused(await _refresh(async_client, str(body["refresh_token"])), "invalid_grant")
    fresh = await exchange(async_client, code_exchange_form(code, client_id))
    assert fresh.status_code == HTTPStatus.OK
    assert (await _refresh(async_client, fresh.json()["refresh_token"])).status_code == (
        HTTPStatus.OK
    )


@pytest.mark.asyncio
async def test_an_expired_refresh_token_is_refused(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Thirty days without a refresh ends the agent's session."""
    body, _client_id, _resource, _user_id = await _tokens(async_client, db_session, "lapsed")
    await db_session.execute(
        update(OAuthRefreshToken).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
    )
    await db_session.commit()
    _assert_refused(await _refresh(async_client, str(body["refresh_token"])), "invalid_grant")


@pytest.mark.asyncio
async def test_a_refresh_from_another_client_is_refused(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A refresh token is bound to the agent it was issued to."""
    body, _client_id, _resource, _user_id = await _tokens(async_client, db_session, "otheragent")
    other = await register_agent(async_client, name="Somebody else")
    _assert_refused(
        await _refresh(async_client, str(body["refresh_token"]), client_id=other), "invalid_grant"
    )
    (row,) = await _family_rows(db_session)
    assert row.rotated_at is None


@pytest.mark.asyncio
async def test_a_refresh_after_the_vault_moved_is_refused(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Never a token whose audience is not the account's vault, at refresh as at exchange."""
    body, _client_id, _resource, user_id = await _tokens(async_client, db_session, "relocated")
    await connect_vault(db_session, user_id, "relocated-elsewhere")
    _assert_refused(await _refresh(async_client, str(body["refresh_token"])), "invalid_grant")


@pytest.mark.asyncio
async def test_a_refresh_may_narrow_its_scope_but_never_widen_it(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """RFC 6749 section 6: no scope the person did not approve."""
    body, _client_id, resource, _user_id = await _tokens(async_client, db_session, "narrow")
    wider = await _refresh(async_client, str(body["refresh_token"]), scope="vault:pipeline")
    _assert_refused(wider, "invalid_scope")
    narrower = await _refresh(async_client, str(body["refresh_token"]), scope="vault:read")
    assert narrower.status_code == HTTPStatus.OK, narrower.text
    assert narrower.json()["scope"] == "vault:read"
    assert "refresh_token" not in narrower.json()
    claims = await _verify_as_the_vault(async_client, narrower.json()["access_token"], resource)
    assert claims["scope"] == "vault:read"


@pytest.mark.asyncio
async def test_a_refresh_naming_another_resource_is_invalid_target(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """RFC 8707 at refresh: the audience stays the vault the person approved."""
    body, _client_id, _resource, _user_id = await _tokens(async_client, db_session, "retarget")
    other = await _refresh(
        async_client, str(body["refresh_token"]), resource="https://v-other.vaults.example/mcp"
    )
    _assert_refused(other, "invalid_target")
    (row,) = await _family_rows(db_session)
    assert row.rotated_at is None


@pytest.mark.asyncio
async def test_an_unknown_refresh_token_is_refused(async_client: AsyncClient) -> None:
    """Nothing about a token nobody issued, and no hint which part was wrong."""
    _assert_refused(await _refresh(async_client, "rt_never-issued"), "invalid_grant")
    _assert_refused(
        await exchange(async_client, {"grant_type": "refresh_token"}), "invalid_request"
    )


# --- the key set --------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_key_set_serves_both_keys_during_rotation(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Add-new, redeploy, drop-old: a token signed before the rotation still verifies."""
    previous = generate_signing_key()
    install_signing_keys(monkeypatch, previous)
    body, _client_id, resource, _user_id = await _tokens(async_client, db_session, "rotation")
    before = str(body["access_token"])

    newest = generate_signing_key()
    install_signing_keys(monkeypatch, newest, previous)
    response = await async_client.get(_JWKS)
    assert response.status_code == HTTPStatus.OK
    assert response.headers["cache-control"] == "public, max-age=300"
    kids = [entry["kid"] for entry in response.json()["keys"]]
    assert kids == [jwk_thumbprint(newest.public_key()), jwk_thumbprint(previous.public_key())]
    assert all("d" not in entry for entry in response.json()["keys"])
    _validate("get", _JWKS, response)

    await _verify_as_the_vault(async_client, before, resource)
    refreshed = await _refresh(async_client, str(body["refresh_token"]))
    after = refreshed.json()["access_token"]
    assert jwt.get_unverified_header(after)["kid"] == jwk_thumbprint(newest.public_key())
    await _verify_as_the_vault(async_client, after, resource)


@pytest.mark.asyncio
async def test_without_signing_keys_nothing_is_issued_or_published(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Where a key is required, none is a 503; a broken key is the same, naming nothing."""
    code, client_id, _resource, _user_id = await approved_code(async_client, db_session, "nokeys")
    monkeypatch.delenv(SIGNING_KEYS_ENV_VAR)
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "staging")
    oauth_signing_keys.reset_cache()
    token = await exchange(async_client, code_exchange_form(code, client_id))
    assert token.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert token.json() == {"detail": "oauth_signing_unconfigured"}
    jwks = await async_client.get(_JWKS)
    assert jwks.status_code == HTTPStatus.SERVICE_UNAVAILABLE

    monkeypatch.setenv(SIGNING_KEYS_ENV_VAR, "not a key")
    oauth_signing_keys.reset_cache()
    broken = await exchange(async_client, code_exchange_form(code, client_id))
    assert broken.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert broken.json() == {"detail": "oauth_signing_unavailable"}
    assert (await async_client.get(_JWKS)).json() == {"detail": "oauth_signing_unavailable"}
    stored = (await db_session.execute(select(OAuthAuthorizationCode))).scalars().one()
    assert stored.consumed_at is None


@pytest.mark.asyncio
async def test_an_unconfigured_laptop_still_issues_tokens_the_key_set_verifies(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Off-platform with no key configured, the flow works end to end on a process-local key."""
    for name in PRODUCTION_SIGNAL_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv(SIGNING_KEYS_ENV_VAR)
    oauth_signing_keys.reset_cache()
    body, _client_id, resource, _user_id = await _tokens(async_client, db_session, "laptop")
    claims = await _verify_as_the_vault(async_client, str(body["access_token"]), resource)
    assert claims["aud"] == resource


@pytest.mark.asyncio
async def test_production_without_an_issuer_issues_nothing(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The ``iss`` every token carries is configuration, so no configuration, no token."""
    monkeypatch.delenv(OAUTH_ISSUER_ENV_VAR)
    monkeypatch.setenv("ENV", "production")
    response = await exchange(async_client, {"grant_type": "refresh_token"})
    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json() == {"detail": "oauth_issuer_unconfigured"}
    revoke = await async_client.post(_REVOKE, data={"token": "rt_x"})
    assert revoke.status_code == HTTPStatus.SERVICE_UNAVAILABLE


@pytest.mark.asyncio
async def test_the_token_endpoint_is_rate_limited_per_address(async_client: AsyncClient) -> None:
    """A burst well past any agent's need is throttled, with the limiter's JSON."""
    for _ in range(_TOKEN_BUDGET):
        await exchange(async_client, {"grant_type": "refresh_token", "refresh_token": "rt_x"})
    response = await exchange(async_client, {"grant_type": "refresh_token"})
    assert response.status_code == HTTPStatus.TOO_MANY_REQUESTS
    _validate("post", _TOKEN, response)


@pytest.mark.asyncio
async def test_the_metadata_advertises_exactly_these_endpoints(async_client: AsyncClient) -> None:
    """The paths A1's metadata names are the paths this router serves."""
    document = (await async_client.get("/.well-known/oauth-authorization-server")).json()
    assert document["token_endpoint"] == f"{ISSUER}{_TOKEN}"
    assert document["jwks_uri"] == f"{ISSUER}{_JWKS}"
    assert document["revocation_endpoint"] == f"{ISSUER}{_REVOKE}"
    assert (_TOKEN, _JWKS, _REVOKE) == (EXCHANGE_PATH, JWKS_PATH, REVOKE_PATH)


# --- revocation (RFC 7009) ----------------------------------------------------


@pytest.mark.asyncio
async def test_revoking_a_refresh_token_ends_its_family(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The agent signs out: its refresh token and every rotation of it stop working."""
    body, client_id, _resource, _user_id = await _tokens(async_client, db_session, "signout")
    rotated = await _refresh(async_client, str(body["refresh_token"]))
    newest = rotated.json()["refresh_token"]

    response = await async_client.post(
        _REVOKE, data={"token": newest, "token_type_hint": "refresh_token", "client_id": client_id}
    )
    assert response.status_code == HTTPStatus.OK
    assert response.content == b""
    _assert_no_store(response)
    assert all(row.revoked_at is not None for row in await _family_rows(db_session))
    _assert_refused(await _refresh(async_client, newest), "invalid_grant")


@pytest.mark.asyncio
async def test_revoking_without_naming_the_client_still_revokes(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Possession of the token is the proof a public client has; ``client_id`` is optional."""
    body, _client_id, _resource, _user_id = await _tokens(async_client, db_session, "anonrevoke")
    response = await async_client.post(_REVOKE, data={"token": str(body["refresh_token"])})
    assert response.status_code == HTTPStatus.OK
    (row,) = await _family_rows(db_session)
    assert row.revoked_at is not None


@pytest.mark.asyncio
async def test_revoking_something_unknown_is_still_a_200(async_client: AsyncClient) -> None:
    """RFC 7009 section 2.2: an invalid token is not an error, and says nothing."""
    stranger = jwt.encode({"aud": "elsewhere"}, generate_signing_key(), algorithm="ES256")
    for token in ("rt_never-issued", stranger):
        response = await async_client.post(_REVOKE, data={"token": token})
        assert response.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_revocation_reads_only_a_form_with_a_token(async_client: AsyncClient) -> None:
    """A JSON body, or no ``token``, is the RFC's ``invalid_request``."""
    for response in (
        await async_client.post(_REVOKE, json={"token": "rt_x"}),
        await async_client.post(_REVOKE, data={"token_type_hint": "refresh_token"}),
    ):
        assert response.status_code == HTTPStatus.BAD_REQUEST
        assert response.json() == {"error": "invalid_request"}
        _validate("post", _REVOKE, response)


@pytest.mark.asyncio
async def test_revocation_is_rate_limited_per_address(async_client: AsyncClient) -> None:
    """The same throttle shape as the token endpoint."""
    for _ in range(_REVOKE_BUDGET):
        await async_client.post(_REVOKE, data={"token": "rt_x"})
    response = await async_client.post(_REVOKE, data={"token": "rt_x"})
    assert response.status_code == HTTPStatus.TOO_MANY_REQUESTS


@pytest.mark.asyncio
async def test_the_access_token_carries_the_verifier_in_no_form(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Nothing the agent proved with -- code, verifier -- is echoed into what it holds."""
    code, client_id, _resource, _user_id = await approved_code(async_client, db_session, "echo")
    body = (await exchange(async_client, code_exchange_form(code, client_id))).json()
    for value in body.values():
        assert VERIFIER not in str(value)
        assert code not in str(value)
