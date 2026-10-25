"""Managed agent addresses come only from the ready account's authenticated vault."""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from http import HTTPStatus
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import creek_vault as vault_dependency
from domain.creek_vault import CreekVaultPipelineClient
from models.vault_activation import VaultActivation, VaultActivationState
from services.creek_vault_client import HttpCreekVaultClient
from services.oauth_authorization import OAUTH_ISSUER_ENV_VAR, account_vault_resource
from services.user_vault_config import store_vault_config
from tests.helpers.oauth import ISSUER, VAULT_KEY, signup

_BASE = Path(__file__).parent.parent / "fixtures" / "creek_discovery_0_24" / "agent-mcp-ready.json"
_VAULT = "https://1.1.1.1/v1"
_RESOURCE = "https://1.1.1.1/mcp"
_CONNECTION = "/vault/connection"


class DiscoveryBoundary:
    """The external allocation answers discovery through the real HTTP adapter."""

    def __init__(self) -> None:
        """Start with one enabled allocation and record every departure."""
        self.metadata: object = {"resource": _RESOURCE, "authorization_server": ISSUER}
        self.requests: list[httpx.Request] = []
        self.status = HTTPStatus.OK
        self.session: AsyncSession | None = None

    def answer(self, request: httpx.Request) -> httpx.Response:
        """Return the producer's extension beside a compatible content handshake."""
        self.requests.append(request)
        if self.session is not None:
            assert not self.session.in_transaction(), "discovery held a database connection"
        payload = json.loads(_BASE.read_text())
        payload["agent_mcp"] = self.metadata
        return httpx.Response(self.status, json=payload)


@pytest_asyncio.fixture
async def boundary(monkeypatch: pytest.MonkeyPatch) -> AsyncGenerator[DiscoveryBoundary, None]:
    """Replace only external HTTP; ownership and managed readiness remain production code."""
    remote = DiscoveryBoundary()
    async with httpx.AsyncClient(transport=httpx.MockTransport(remote.answer)) as http:

        def _build(url: str, key: str) -> CreekVaultPipelineClient:
            return HttpCreekVaultClient(url, key, http_client=http)

        monkeypatch.setattr(vault_dependency, "build_connected_vault_client", _build)
        monkeypatch.setenv(OAUTH_ISSUER_ENV_VAR, ISSUER)
        yield remote


async def _managed(session: AsyncSession, user_id: int, *, state: str = "ready") -> None:
    """Arrange a provisioned binding and its authoritative lifecycle state."""
    await store_vault_config(
        session, user_id, vault_url=_VAULT, api_key=VAULT_KEY, provisioned=True
    )
    session.add(
        VaultActivation(
            user_id=user_id,
            activation_id=f"activation-{user_id}",
            consumer_identity=f"consumer-{user_id}",
            state=state,
        )
    )
    await session.commit()


@pytest.mark.asyncio
async def test_ready_managed_address_equals_the_authorized_resource(
    async_client: httpx.AsyncClient, db_session: AsyncSession, boundary: DiscoveryBoundary
) -> None:
    """The private /v1 URL stays hidden while its public agent resource is usable."""
    headers, user_id = await signup(async_client, "managed_agent_ready")
    await _managed(db_session, user_id)
    expected = await account_vault_resource(db_session, user_id)
    boundary.session = db_session

    response = await async_client.get(_CONNECTION, headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json() == {"connected": True, "vault_url": None, "mcp_address": expected}
    assert expected == _RESOURCE
    assert len(boundary.requests) == 1
    assert str(boundary.requests[0].url) == f"{_VAULT}/capabilities"
    assert boundary.requests[0].headers["authorization"] == f"Bearer {VAULT_KEY}"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "metadata",
    [
        None,
        {},
        {"resource": "https://other.vault.example/mcp", "authorization_server": ISSUER},
        {"resource": _RESOURCE, "authorization_server": "https://other.issuer.example"},
    ],
)
async def test_missing_or_mismatched_discovery_keeps_the_address_unavailable(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
    metadata: object,
) -> None:
    """Never echo a foreign resource or issuer, and never infer readiness from a row."""
    headers, user_id = await signup(async_client, "managed_agent_mismatch")
    await _managed(db_session, user_id)
    boundary.metadata = metadata

    response = await async_client.get(_CONNECTION, headers=headers)

    assert response.json() == {"connected": True, "vault_url": None, "mcp_address": None}


@pytest.mark.asyncio
async def test_nonready_managed_binding_dials_nothing(
    async_client: httpx.AsyncClient, db_session: AsyncSession, boundary: DiscoveryBoundary
) -> None:
    """A handed-off credential remains inert until the allocation reaches ready."""
    headers, user_id = await signup(async_client, "managed_agent_pending")
    await _managed(db_session, user_id, state=VaultActivationState.PENDING.value)

    response = await async_client.get(_CONNECTION, headers=headers)

    assert response.json()["mcp_address"] is None
    assert not boundary.requests


@pytest.mark.asyncio
async def test_a_rolled_allocation_acquires_an_address_without_a_new_handoff(
    async_client: httpx.AsyncClient, db_session: AsyncSession, boundary: DiscoveryBoundary
) -> None:
    """Fresh authenticated discovery observes the operator's per-allocation OAuth rollout."""
    headers, user_id = await signup(async_client, "managed_agent_rolled")
    await _managed(db_session, user_id)
    boundary.metadata = None
    before = await async_client.get(_CONNECTION, headers=headers)
    assert before.json()["mcp_address"] is None

    boundary.metadata = {"resource": _RESOURCE, "authorization_server": ISSUER}
    after = await async_client.get(_CONNECTION, headers=headers)

    assert after.json() == {"connected": True, "vault_url": None, "mcp_address": _RESOURCE}
    assert len(boundary.requests) == 2


@pytest.mark.asyncio
async def test_unreachable_discovery_keeps_the_managed_binding_connected(
    async_client: httpx.AsyncClient, db_session: AsyncSession, boundary: DiscoveryBoundary
) -> None:
    """An unavailable agent surface never erases the account's stored vault binding."""
    headers, user_id = await signup(async_client, "managed_agent_offline")
    await _managed(db_session, user_id)
    boundary.status = HTTPStatus.SERVICE_UNAVAILABLE

    response = await async_client.get(_CONNECTION, headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json() == {"connected": True, "vault_url": None, "mcp_address": None}


@pytest.mark.asyncio
async def test_shared_edge_discovery_uses_only_the_request_accounts_credential(
    async_client: httpx.AsyncClient, db_session: AsyncSession, boundary: DiscoveryBoundary
) -> None:
    """A shared resource URL does not let Alice discover OAuth readiness through Bob's vault."""
    alice, alice_id = await signup(async_client, "discovery_alice")
    _bob, bob_id = await signup(async_client, "discovery_bob")
    await _managed(db_session, alice_id)
    await _managed(db_session, bob_id)
    bob_key = "bob-vault-key-0123456789"  # pragma: allowlist secret
    await store_vault_config(
        db_session, bob_id, vault_url=_VAULT, api_key=bob_key, provisioned=True
    )

    response = await async_client.get(_CONNECTION, headers=alice)

    assert response.json()["mcp_address"] == _RESOURCE
    assert [request.headers["authorization"] for request in boundary.requests] == [
        f"Bearer {VAULT_KEY}"
    ]


@pytest.mark.asyncio
async def test_missing_production_issuer_does_not_probe_or_advertise_an_agent_address(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unconfigured authorization server cannot approve agents for this discovery."""
    headers, user_id = await signup(async_client, "managed_agent_no_issuer")
    await _managed(db_session, user_id)
    monkeypatch.setenv("ENV", "production")
    monkeypatch.delenv(OAUTH_ISSUER_ENV_VAR)

    response = await async_client.get(_CONNECTION, headers=headers)

    assert response.json()["mcp_address"] is None
    assert not boundary.requests


@pytest.mark.asyncio
async def test_self_connected_address_does_not_require_managed_discovery(
    async_client: httpx.AsyncClient, db_session: AsyncSession, boundary: DiscoveryBoundary
) -> None:
    """The new allocation probe does not add a departure to a local-only BYO binding read."""
    headers, user_id = await signup(async_client, "self_connected_agent_address")
    await store_vault_config(db_session, user_id, vault_url=_VAULT, api_key=VAULT_KEY)

    response = await async_client.get(_CONNECTION, headers=headers)

    assert response.json() == {"connected": True, "vault_url": _VAULT, "mcp_address": _RESOURCE}
    assert not boundary.requests
