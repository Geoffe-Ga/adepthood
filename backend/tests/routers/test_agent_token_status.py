"""The vault asks, on every call, whether an agent's token still stands (R3-2, #3585).

Creek's control plane (Creek-Vault#2005) sends the three claims of an access
token it has already verified offline -- ``sub``, ``client_id``, ``iat`` -- with
its mounted handoff bearer, and is told ``{"active": true}`` or
``{"active": false}`` and nothing else. Each test mints a real token through the
consent page and the token endpoint, so the claims asked about are the ones this
server actually signs, then changes the world the way a person does: Revoke in
Settings, approve again, switch the account off.

Every negative answer is the same answer -- same status, same body -- so the
endpoint tells a caller nothing about whether a subject, an agent or a grant
exists.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import TYPE_CHECKING, Final

import pytest
from sqlmodel import col, select, update

from models.agent_grant import AgentGrant
from models.user import User
from models.vault_activation import VaultActivation, VaultActivationState
from routers.vault_provisioning_internal import STATUS_LOOKUP_RATE_LIMIT
from services import oauth_signing_keys
from services.oauth_authorization import OAUTH_ISSUER_ENV_VAR
from services.oauth_tokens import ACCESS_TOKEN_TTL, AGENT_SUBJECT_PREFIX
from services.user_vault_config import store_vault_config
from tests.helpers.oauth import (
    AGENT_TOKEN_STATUS_PATH,
    HANDOFF_BEARER,
    ISSUER,
    PASSWORD,
    VAULT_KEY,
    approve,
    approved_code,
    code_exchange_form,
    exchange,
    install_handoff_bearer,
    install_signing_keys,
    register_agent,
    signup,
    token_status_claims,
    vault_url_for,
)
from tests.helpers.openapi_errors import declared_response_schema, live_document, response_validator

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from httpx import AsyncClient, Response
    from sqlalchemy.ext.asyncio import AsyncSession

_INACTIVE: Final = {"active": False}
_ACTIVE: Final = {"active": True}
_STATUS_BUDGET: Final = int(STATUS_LOOKUP_RATE_LIMIT.split("/", 1)[0])
_STATUS_EVENT: Final = "oauth_agent_token_status"


@pytest.fixture(autouse=True)
def _issuer_keys_and_bearer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> Iterator[dict[str, str]]:
    """One issuer, one signing key, and Creek's handoff bearer mounted."""
    monkeypatch.setenv(OAUTH_ISSUER_ENV_VAR, ISSUER)
    install_signing_keys(monkeypatch)
    yield install_handoff_bearer(monkeypatch, tmp_path)
    oauth_signing_keys.reset_cache()


def _bearer() -> dict[str, str]:
    return {"Authorization": f"Bearer {HANDOFF_BEARER}"}


async def _ask(
    async_client: AsyncClient,
    body: object,
    headers: dict[str, str] | None = None,
) -> Response:
    return await async_client.post(
        AGENT_TOKEN_STATUS_PATH, json=body, headers=_bearer() if headers is None else headers
    )


def _validate(response: Response) -> None:
    """The body matches the schema this operation publishes for its status."""
    document = live_document()
    schema = declared_response_schema(
        document, "post", AGENT_TOKEN_STATUS_PATH, response.status_code
    )
    response_validator(document, schema).validate(response.json())


def _assert_answer(response: Response, expected: dict[str, bool]) -> None:
    """A 200, uncached, whose body is exactly ``expected`` -- no other key, ever."""
    assert response.status_code == HTTPStatus.OK, response.text
    assert response.json() == expected
    assert set(response.json()) == {"active"}
    assert response.headers["cache-control"] == "no-store"
    _validate(response)


async def _agent_token(
    async_client: AsyncClient, db_session: AsyncSession, name: str
) -> tuple[dict[str, object], str, int]:
    """Approve an agent and exchange the code; return the status claims, client and account."""
    code, client_id, _resource, user_id = await approved_code(async_client, db_session, name)
    response = await exchange(async_client, code_exchange_form(code, client_id))
    assert response.status_code == HTTPStatus.OK, response.text
    return token_status_claims(response.json()["access_token"]), client_id, user_id


async def _login(async_client: AsyncClient, name: str) -> dict[str, str]:
    response = await async_client.post(
        "/auth/login", json={"email": f"{name}@example.com", "password": PASSWORD}
    )
    assert response.status_code == HTTPStatus.OK, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def _grant(db_session: AsyncSession, user_id: int) -> AgentGrant:
    result = await db_session.execute(
        select(AgentGrant)
        .where(AgentGrant.user_id == user_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().one()


async def _revoke_in_settings(
    async_client: AsyncClient, db_session: AsyncSession, name: str, user_id: int
) -> None:
    """Press Stop under Agents that may read your vault, through the real route."""
    grant = await _grant(db_session, user_id)
    response = await async_client.delete(
        f"/vault/agents/{grant.id}", headers=await _login(async_client, name)
    )
    assert response.status_code == HTTPStatus.NO_CONTENT, response.text


# --- the answer -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_token_under_a_standing_grant_is_active(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Approved and not revoked: the vault may serve the call."""
    claims, _client_id, _user_id = await _agent_token(async_client, db_session, "standing")
    assert str(claims["sub"]).startswith(AGENT_SUBJECT_PREFIX)
    _assert_answer(await _ask(async_client, claims), _ACTIVE)


@pytest.mark.asyncio
async def test_revoking_in_settings_makes_the_next_answer_inactive(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Revoke lands on the vault's next lookup, not ten minutes later (R3-2)."""
    claims, _client_id, user_id = await _agent_token(async_client, db_session, "revoker")
    _assert_answer(await _ask(async_client, claims), _ACTIVE)
    await _revoke_in_settings(async_client, db_session, "revoker", user_id)
    _assert_answer(await _ask(async_client, claims), _INACTIVE)


@pytest.mark.asyncio
async def test_a_token_from_before_a_re_approval_stays_inactive(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Revoke, then approve again: the old consent's token does not come back, the new one works."""
    claims, client_id, user_id = await _agent_token(async_client, db_session, "again")
    await _revoke_in_settings(async_client, db_session, "again", user_id)
    grant = await _grant(db_session, user_id)
    # The re-approval lands in a later second than the first token's ``iat``.
    grant.created_at = datetime.now(UTC) + timedelta(seconds=2)
    grant.revoked_at = None
    db_session.add(grant)
    await db_session.commit()
    _assert_answer(await _ask(async_client, claims), _INACTIVE)

    reapproved = {**claims, "iat": int(grant.created_at.timestamp())}
    _assert_answer(await _ask(async_client, reapproved), _ACTIVE)
    assert reapproved["client_id"] == client_id


@pytest.mark.asyncio
async def test_a_token_minted_in_the_same_second_as_its_approval_is_active(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``iat`` is whole seconds and the grant's ``created_at`` is not; the token still stands."""
    claims, _client_id, user_id = await _agent_token(async_client, db_session, "subsecond")
    grant = await _grant(db_session, user_id)
    issued = int(str(claims["iat"]))
    grant.created_at = datetime.fromtimestamp(issued, UTC) + timedelta(microseconds=999_999)
    db_session.add(grant)
    await db_session.commit()
    _assert_answer(await _ask(async_client, claims), _ACTIVE)


@pytest.mark.asyncio
async def test_a_disabled_account_has_no_active_agent_tokens(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An account switched off stops its agents at once, grant or no grant."""
    claims, _client_id, user_id = await _agent_token(async_client, db_session, "disabled")
    await db_session.execute(update(User).where(col(User.id) == user_id).values(is_active=False))
    await db_session.commit()
    _assert_answer(await _ask(async_client, claims), _INACTIVE)


@pytest.mark.asyncio
async def test_a_token_past_its_lifetime_is_inactive(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """RFC 7662 section 2.2: an expired token is not active, whatever its grant says."""
    claims, _client_id, _user_id = await _agent_token(async_client, db_session, "expired")
    expired = {**claims, "iat": int(str(claims["iat"])) - int(ACCESS_TOKEN_TTL.total_seconds())}
    _assert_answer(await _ask(async_client, expired), _INACTIVE)


@pytest.mark.asyncio
async def test_a_managed_vaults_subject_is_answered_for(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A managed vault's ``sub`` is its provisioned consumer identity, and that is looked up too."""
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
    client_id = await register_agent(async_client)
    code = await approve(async_client, headers, client_id, "https://v-managed.vaults.example/mcp")
    response = await exchange(async_client, code_exchange_form(code, client_id))
    claims = token_status_claims(response.json()["access_token"])
    assert claims["sub"] == "adepthood-user-managed-identity"
    _assert_answer(await _ask(async_client, claims), _ACTIVE)

    await _revoke_in_settings(async_client, db_session, "managed", user_id)
    _assert_answer(await _ask(async_client, claims), _INACTIVE)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [
        pytest.param({"sub": "adepthood-user-nobody"}, id="unknown-managed-subject"),
        pytest.param({"sub": f"{AGENT_SUBJECT_PREFIX}{'0' * 32}"}, id="unknown-derived-subject"),
        pytest.param({"client_id": "cl_never_registered"}, id="unknown-client"),
    ],
)
async def test_an_unknown_subject_or_agent_is_inactive_like_any_other_no(
    async_client: AsyncClient, db_session: AsyncSession, change: dict[str, object]
) -> None:
    """Not found reads exactly like revoked: the answer is not an oracle."""
    claims, _client_id, _user_id = await _agent_token(async_client, db_session, "known")
    _assert_answer(await _ask(async_client, {**claims, **change}), _INACTIVE)


@pytest.mark.asyncio
async def test_one_accounts_subject_never_borrows_anothers_agent(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Alice's ``sub`` paired with an agent only Bob approved is inactive, and writes nothing."""
    alice, _alice_client, _alice_id = await _agent_token(async_client, db_session, "alice_st")
    bob, bob_client, bob_id = await _agent_token(async_client, db_session, "bob_st")
    before = (await _grant(db_session, bob_id)).last_used_at
    crossed = {**alice, "client_id": bob_client}
    assert alice["client_id"] != bob_client
    _assert_answer(await _ask(async_client, crossed), _INACTIVE)
    _assert_answer(await _ask(async_client, bob), _ACTIVE)
    assert (await _grant(db_session, bob_id)).last_used_at == before


# --- who may ask --------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "headers",
    [
        pytest.param({}, id="no-bearer"),
        pytest.param({"Authorization": "Bearer not-the-handoff-bearer"}, id="wrong-bearer"),
        pytest.param({"Authorization": f"Basic {HANDOFF_BEARER}"}, id="wrong-scheme"),
    ],
)
async def test_only_the_mounted_handoff_bearer_may_ask(
    async_client: AsyncClient, db_session: AsyncSession, headers: dict[str, str]
) -> None:
    """Without Creek's bearer the answer is a 401 that says nothing about the token."""
    claims, _client_id, _user_id = await _agent_token(async_client, db_session, "unauth")
    response = await _ask(async_client, claims, headers=headers)
    assert response.status_code == HTTPStatus.UNAUTHORIZED
    assert response.json() == {"detail": "invalid_provisioning_handoff"}
    _validate(response)


@pytest.mark.asyncio
async def test_without_a_mounted_bearer_nobody_may_ask(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A deployment that never mounted the bearer refuses every caller rather than answering."""
    monkeypatch.delenv("CREEK_PROVISIONING_HANDOFF_AUTH_FILE")
    response = await _ask(async_client, {"sub": "s", "client_id": "c", "iat": 1})
    assert response.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"sub": "s", "client_id": "c"}, id="missing-iat"),
        pytest.param({"sub": "s", "client_id": "c", "iat": "1700000000"}, id="iat-as-string"),
        pytest.param({"sub": "s", "client_id": "c", "iat": True}, id="iat-as-bool"),
        pytest.param({"sub": "s", "client_id": "c", "iat": -1}, id="negative-iat"),
        pytest.param({"sub": "s", "client_id": "c", "iat": 10**12}, id="iat-past-year-3000"),
        pytest.param({"sub": "", "client_id": "c", "iat": 1}, id="empty-sub"),
        pytest.param({"sub": "s", "client_id": "c", "iat": 1, "token": "t"}, id="extra-field"),
        pytest.param(["s", "c", 1], id="not-an-object"),
    ],
)
async def test_a_malformed_question_is_a_400_after_the_bearer(
    async_client: AsyncClient, body: object
) -> None:
    """Shape errors are refused with one code, and only once the caller is authenticated."""
    response = await _ask(async_client, body)
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json() == {"detail": "invalid_agent_token_status"}
    _validate(response)
    unauthenticated = await _ask(async_client, body, headers={})
    assert unauthenticated.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_a_body_that_is_not_json_is_a_400(async_client: AsyncClient) -> None:
    """Bytes that do not parse are the same refusal as a wrong shape."""
    response = await async_client.post(
        AGENT_TOKEN_STATUS_PATH,
        content=b"{not json",
        headers={**_bearer(), "Content-Type": "application/json"},
    )
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json() == {"detail": "invalid_agent_token_status"}


@pytest.mark.asyncio
async def test_the_status_lookup_is_rate_limited_per_caller(async_client: AsyncClient) -> None:
    """A caller past its budget is throttled with the limiter's JSON."""
    body = {"sub": "s", "client_id": "c", "iat": 1}
    for _ in range(_STATUS_BUDGET):
        await _ask(async_client, body)
    response = await _ask(async_client, body)
    assert response.status_code == HTTPStatus.TOO_MANY_REQUESTS
    _validate(response)


# --- what is said about it ----------------------------------------------------------


@pytest.mark.asyncio
async def test_the_log_names_a_fixed_outcome_and_never_the_subject(
    async_client: AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """One event per lookup, with an outcome from a closed vocabulary and no identifier."""
    claims, client_id, user_id = await _agent_token(async_client, db_session, "logged")
    with caplog.at_level(logging.INFO, logger="services.oauth_tokens"):
        await _ask(async_client, claims)
        await _revoke_in_settings(async_client, db_session, "logged", user_id)
        await _ask(async_client, claims)
        await _ask(async_client, {**claims, "sub": "adepthood-user-nobody"})
    events = [record for record in caplog.records if record.getMessage() == _STATUS_EVENT]
    assert [record.__dict__["outcome"] for record in events] == [
        "active",
        "grant_withdrawn",
        "unknown_subject",
    ]
    for record in events:
        rendered = f"{record.getMessage()} {record.__dict__}"
        assert str(claims["sub"]) not in rendered
        assert client_id not in rendered
        assert "user_id" not in record.__dict__
