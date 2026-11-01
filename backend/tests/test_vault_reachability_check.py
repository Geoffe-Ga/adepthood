"""``POST /vault/connection/check``: is the caller's own vault reachable right now (#3406)?

The Creek pilot was down for two days in October 2026 while the Settings card
kept saying "connected", and the only symptom a writer saw was a Resonance
failure carrying a reference id. This endpoint lets a writer ask, on demand,
whether their vault answers -- and nothing more.

Four families, each pinned through the real resolver and the production HTTP
adapter over an ``httpx.MockTransport``, so no test dials a real vault:

* **The three states.** A handshake that succeeds is ``reachable``; one that
  could not land (refused connection, timeout, a 5xx, a vault that says it is
  unavailable) is ``unreachable``; anything that does not settle the question
  (a refused credential, a malformed document, a contract skew, no dialable
  vault at all) is ``unknown``.
* **Content-free.** The body is exactly ``state`` and ``checked_at``: no
  address, no error text, no provider identifier.
* **Ownership.** The client is resolved from the caller's JWT alone, so a check
  only ever dials the caller's own vault, whatever the request carries.
* **Rate limit.** Per user, because every check can wake a scale-to-zero vault
  Machine; a refused check dials nothing and spends nobody else's budget.

That nothing runs a check on its own -- the screen opening included -- is a
property of the client, pinned in ``ManagedVaultReachability.test.tsx``.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from functools import partial
from http import HTTPStatus

import httpx
import pytest
from httpx import AsyncClient, MockTransport, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.user_vault_config import UserVaultConfig
from models.vault_activation import VaultActivation, VaultActivationState
from routers.vault_config import VAULT_REACHABILITY_CHECKS_PER_MINUTE
from schemas.vault_config import VaultReachability
from services import creek_vault_client as vault_client_module
from services import creek_vault_url_resolution
from services.creek_vault_client import (
    HandshakeDegradeReason,
    HttpCreekVaultClient,
    LocalFallbackCreekVaultClient,
)
from services.vault_reachability import check_vault_reachability, reachability_for_degrade
from tests.test_creek_vault_http_client import _handshake_payload

_CHECK_PATH = "/vault/connection/check"
_CONNECTION_PATH = "/vault/connection"

_VAULT_A_HOST = "vault-alpha-reach.example.test"
_VAULT_B_HOST = "vault-beta-reach.example.test"
_VAULT_A_URL = f"https://{_VAULT_A_HOST}"
_VAULT_B_URL = f"https://{_VAULT_B_HOST}"
_KEY_A = "alpha-reachability-credential-0123"  # pragma: allowlist secret
_KEY_B = "beta-reachability-credential-4567"  # pragma: allowlist secret
_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

# Text a failing vault or transport might carry. Unmistakable, so finding it in
# a response body can only mean the body repeated it.
_ERROR_SENTINEL = "SENTINEL-VAULT-ERROR-TEXT-MUST-NOT-LEAK"

_PUBLIC_ADDRESS = "8.8.8.8"

Handler = Callable[[Request], Response]


async def _resolves_publicly(_host: str) -> tuple[str, ...]:
    """Answer any name with an ordinary public address."""
    return (_PUBLIC_ADDRESS,)


@pytest.fixture(autouse=True)
def _isolated_vault_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """No deployment-wide vault, and name lookups answered by the test.

    ``.example.test`` never resolves, so without the stub every stored vault
    would degrade to the local fallback for the request-forgery guard's reason
    rather than for the reason a test names.
    """
    for name in (
        "CREEK_VAULT_URL",
        "CREEK_VAULT_API_KEY",
        "CREEK_VAULT_PROTOCOL",
        "CREEK_VAULT_OWNER_USER_ID",
    ):
        monkeypatch.delenv(name, raising=False)
    creek_vault_url_resolution.reset_resolution_cache()
    monkeypatch.setattr(creek_vault_url_resolution, "resolve_host_addresses", _resolves_publicly)
    yield
    creek_vault_url_resolution.reset_resolution_cache()


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a fresh user and return its auth header and id."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _managed_vault(
    client: AsyncClient,
    session: AsyncSession,
    username: str,
    url: str = _VAULT_A_URL,
    api_key: str = _KEY_A,
) -> tuple[dict[str, str], int]:
    """A signed-up writer whose ready managed vault lives at ``url``."""
    headers, user_id = await _signup(client, username)
    resp = await client.put(
        _CONNECTION_PATH, json={"vault_url": url, "api_key": api_key}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    config = (
        await session.execute(
            select(UserVaultConfig).where(col(UserVaultConfig.user_id) == user_id)
        )
    ).scalar_one()
    config.provisioned = True
    session.add(
        VaultActivation(
            user_id=user_id,
            activation_id=f"reach-{user_id}",
            consumer_identity=f"reach-{user_id}",
            state=VaultActivationState.READY.value,
        )
    )
    await session.commit()
    return headers, user_id


def _healthy(_incoming: Request) -> Response:
    """A vault that answers its capability probe."""
    return Response(HTTPStatus.OK, json=_handshake_payload(capabilities=["journal"]))


def _refused(incoming: Request) -> Response:
    raise httpx.ConnectError(_ERROR_SENTINEL, request=incoming)


def _timed_out(incoming: Request) -> Response:
    raise httpx.ReadTimeout(_ERROR_SENTINEL, request=incoming)


def _server_error(_incoming: Request) -> Response:
    return Response(HTTPStatus.SERVICE_UNAVAILABLE, text=_ERROR_SENTINEL)


def _reports_unavailable(_incoming: Request) -> Response:
    return Response(
        HTTPStatus.OK, json=_handshake_payload(capabilities=["journal"], available=False)
    )


def _credential_refused(_incoming: Request) -> Response:
    return Response(HTTPStatus.UNAUTHORIZED, text=_ERROR_SENTINEL)


def _malformed(_incoming: Request) -> Response:
    return Response(HTTPStatus.OK, json=[_ERROR_SENTINEL])


def _skewed(_incoming: Request) -> Response:
    return Response(
        HTTPStatus.OK, json=_handshake_payload(capabilities=["journal"], contract_version="0.3.0")
    )


class _Recorder:
    """Route every vault request to ``handler`` and record which host it was for."""

    def __init__(self, handler: Handler) -> None:
        self.hosts: list[str] = []
        self._handler = handler

    def __call__(self, incoming: Request) -> Response:
        self.hosts.append(incoming.url.host)
        return self._handler(incoming)


async def _check(
    async_client: AsyncClient,
    headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    recorder: _Recorder,
    *,
    body: dict[str, object] | None = None,
) -> Response:
    """Run one check with every vault the app builds bound to ``recorder``."""
    async with AsyncClient(transport=MockTransport(recorder)) as http:
        monkeypatch.setattr(
            vault_client_module,
            "HttpCreekVaultClient",
            partial(HttpCreekVaultClient, http_client=http),
        )
        return await async_client.post(_CHECK_PATH, headers=headers, json=body)


# ---------------------------------------------------------------------------
# The three states
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("handler", "expected"),
    [
        pytest.param(_healthy, VaultReachability.REACHABLE, id="handshake-succeeds"),
        pytest.param(_refused, VaultReachability.UNREACHABLE, id="connection-refused"),
        pytest.param(_timed_out, VaultReachability.UNREACHABLE, id="timed-out"),
        pytest.param(_server_error, VaultReachability.UNREACHABLE, id="5xx"),
        pytest.param(_reports_unavailable, VaultReachability.UNREACHABLE, id="vault-says-down"),
        pytest.param(_credential_refused, VaultReachability.UNKNOWN, id="credential-refused"),
        pytest.param(_malformed, VaultReachability.UNKNOWN, id="malformed-document"),
        pytest.param(_skewed, VaultReachability.UNKNOWN, id="contract-skew"),
    ],
)
async def test_a_check_reports_what_the_handshake_found(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    handler: Handler,
    expected: VaultReachability,
) -> None:
    """Each handshake outcome lands in exactly one of the three states, after one dial."""
    headers, _ = await _managed_vault(async_client, db_session, "reach-state")
    recorder = _Recorder(handler)
    before = datetime.now(UTC)

    resp = await _check(async_client, headers, monkeypatch, recorder)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["state"] == expected.value
    checked_at = datetime.fromisoformat(body["checked_at"])
    assert checked_at.tzinfo is not None
    assert checked_at >= before
    assert recorder.hosts == [_VAULT_A_HOST]


@pytest.mark.asyncio
async def test_an_account_with_no_vault_gets_unknown_and_dials_nothing(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nothing to dial is not an outage: the answer is "couldn't tell"."""
    headers, _ = await _signup(async_client, "reach-none")
    recorder = _Recorder(_healthy)

    resp = await _check(async_client, headers, monkeypatch, recorder)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["state"] == VaultReachability.UNKNOWN.value
    assert recorder.hosts == []


@pytest.mark.asyncio
async def test_a_managed_vault_not_yet_ready_gets_unknown_and_dials_nothing(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A handed-off credential stays inert until its allocation is ready, check included."""
    headers, user_id = await _managed_vault(async_client, db_session, "reach-pending")
    activation = (
        await db_session.execute(
            select(VaultActivation).where(col(VaultActivation.user_id) == user_id)
        )
    ).scalar_one()
    activation.state = VaultActivationState.PROVISIONING.value
    await db_session.commit()
    recorder = _Recorder(_healthy)

    resp = await _check(async_client, headers, monkeypatch, recorder)

    assert resp.json()["state"] == VaultReachability.UNKNOWN.value
    assert recorder.hosts == []


# Where each degrade reason belongs, stated here independently of the module's
# own table: an outage is "unreachable", and a call that landed without settling
# the question is "unknown".
_EXPECTED_STATE_BY_REASON = {
    HandshakeDegradeReason.UNREACHABLE: VaultReachability.UNREACHABLE,
    HandshakeDegradeReason.TIMED_OUT: VaultReachability.UNREACHABLE,
    HandshakeDegradeReason.VAULT_REPORTED_UNAVAILABLE: VaultReachability.UNREACHABLE,
    HandshakeDegradeReason.AUTH: VaultReachability.UNKNOWN,
    HandshakeDegradeReason.MALFORMED_PAYLOAD: VaultReachability.UNKNOWN,
    HandshakeDegradeReason.INCOMPATIBLE_VERSION: VaultReachability.UNKNOWN,
}


def test_every_degrade_reason_is_placed_deliberately() -> None:
    """A reason added later fails here until somebody decides where it goes."""
    assert set(_EXPECTED_STATE_BY_REASON) == set(HandshakeDegradeReason)


@pytest.mark.parametrize(("reason", "expected"), list(_EXPECTED_STATE_BY_REASON.items()))
def test_each_degrade_reason_maps_to_its_state(
    reason: HandshakeDegradeReason, expected: VaultReachability
) -> None:
    """The table, reason by reason."""
    assert reachability_for_degrade(reason) is expected


def test_an_unattributed_degrade_cannot_tell() -> None:
    """A degraded handshake nobody attributed is "couldn't tell"."""
    assert reachability_for_degrade(None) is VaultReachability.UNKNOWN


@pytest.mark.asyncio
async def test_the_local_fallback_cannot_tell() -> None:
    """No vault behind the client is "couldn't tell", never "unreachable"."""
    state = await check_vault_reachability(LocalFallbackCreekVaultClient())
    assert state is VaultReachability.UNKNOWN


# ---------------------------------------------------------------------------
# Content-free
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("handler", [_healthy, _refused, _server_error, _credential_refused])
async def test_the_answer_carries_no_address_error_text_or_credential(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    handler: Handler,
) -> None:
    """Exactly two fields, and nothing a vault or its transport said."""
    headers, _ = await _managed_vault(async_client, db_session, "reach-content-free")

    resp = await _check(async_client, headers, monkeypatch, _Recorder(handler))

    assert set(resp.json()) == {"state", "checked_at"}
    for forbidden in (_VAULT_A_HOST, _KEY_A, _ERROR_SENTINEL, "creek", "fly"):
        assert forbidden not in resp.text.lower()


# ---------------------------------------------------------------------------
# Ownership
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_check_only_ever_dials_the_callers_own_vault(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two writers, two vaults: each check reaches the caller's vault and no other.

    The request also names the other account's id and vault in a body,
    which the endpoint takes no notice of -- the vault is resolved from the JWT.
    """
    headers_a, user_a = await _managed_vault(async_client, db_session, "reach-owner-a")
    headers_b, _ = await _managed_vault(
        async_client, db_session, "reach-owner-b", url=_VAULT_B_URL, api_key=_KEY_B
    )
    recorder = _Recorder(_healthy)

    resp = await _check(
        async_client,
        headers_b,
        monkeypatch,
        recorder,
        body={"user_id": user_a, "vault_url": _VAULT_A_URL},
    )
    assert resp.status_code == HTTPStatus.OK
    assert recorder.hosts == [_VAULT_B_HOST]

    recorder.hosts.clear()
    await _check(async_client, headers_a, monkeypatch, recorder)
    assert recorder.hosts == [_VAULT_A_HOST]


@pytest.mark.asyncio
async def test_a_check_requires_authentication(async_client: AsyncClient) -> None:
    """No caller, no vault to resolve."""
    resp = await async_client.post(_CHECK_PATH)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ---------------------------------------------------------------------------
# Rate limit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_checks_are_rate_limited_per_user_and_a_refused_check_dials_nothing(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One writer's spent budget refuses their next check without waking the vault.

    Another writer's budget is untouched: the bucket follows the identity.
    """
    headers_a, _ = await _managed_vault(async_client, db_session, "reach-limit-a")
    headers_b, _ = await _managed_vault(
        async_client, db_session, "reach-limit-b", url=_VAULT_B_URL, api_key=_KEY_B
    )
    recorder = _Recorder(_healthy)
    for _ in range(VAULT_REACHABILITY_CHECKS_PER_MINUTE):
        resp = await _check(async_client, headers_a, monkeypatch, recorder)
        assert resp.status_code == HTTPStatus.OK
    dialled = len(recorder.hosts)

    refused = await _check(async_client, headers_a, monkeypatch, recorder)

    assert refused.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert len(recorder.hosts) == dialled
    other = await _check(async_client, headers_b, monkeypatch, recorder)
    assert other.status_code == HTTPStatus.OK
