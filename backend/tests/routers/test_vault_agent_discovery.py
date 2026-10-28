"""Managed agent addresses come only from the ready account's authenticated vault."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from domain.creek_vault import CreekVaultPipelineClient
from models.vault_activation import VaultActivation, VaultActivationState
from services import creek_vault_agent_connection as agent_connection
from services.creek_provisioning import load_vault_activation
from services.creek_vault_client import HttpCreekVaultClient
from services.oauth_authorization import OAUTH_ISSUER_ENV_VAR, account_vault_resource
from services.user_vault_config import load_vault_config, store_vault_config
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
        self.pause: asyncio.Event | None = None
        self.cancelled = False
        self.started = asyncio.Event()

    async def answer(self, request: httpx.Request) -> httpx.Response:
        """Return the producer's extension beside a compatible content handshake."""
        self.requests.append(request)
        self.started.set()
        if self.session is not None:
            assert not self.session.in_transaction(), "discovery held a database connection"
        if self.pause is not None:
            try:
                await self.pause.wait()
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        payload = json.loads(_BASE.read_text())
        payload["agent_mcp"] = self.metadata
        return httpx.Response(self.status, json=payload)


@pytest_asyncio.fixture
async def boundary(monkeypatch: pytest.MonkeyPatch) -> AsyncGenerator[DiscoveryBoundary, None]:
    """Replace only external HTTP; ownership and managed readiness remain production code."""
    agent_connection.reset_agent_discovery_cache()
    remote = DiscoveryBoundary()
    async with httpx.AsyncClient(transport=httpx.MockTransport(remote.answer)) as http:

        def _build(url: str, key: str, *, managed: bool) -> CreekVaultPipelineClient:
            return HttpCreekVaultClient(url, key, http_client=http, managed=managed)

        monkeypatch.setattr(
            "services.creek_vault_stored_client.build_connected_vault_client", _build
        )
        monkeypatch.setenv(OAUTH_ISSUER_ENV_VAR, ISSUER)
        yield remote
    agent_connection.reset_agent_discovery_cache()


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Move only cache time, without changing asyncio's actual deadline clock."""
    now = [1000.0]
    monkeypatch.setattr(agent_connection, "monotonic", lambda: now[0])
    return now


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
    assert response.json() == {
        "connected": True,
        "vault_url": None,
        "mcp_address": expected,
        "classification_key_rejected": False,
    }
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

    assert response.json() == {
        "connected": True,
        "vault_url": None,
        "mcp_address": None,
        "classification_key_rejected": False,
    }


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
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
    clock: list[float],
) -> None:
    """The brief negative cache expires and observes a roll without a new handoff."""
    headers, user_id = await signup(async_client, "managed_agent_rolled")
    await _managed(db_session, user_id)
    boundary.metadata = None
    before = await async_client.get(_CONNECTION, headers=headers)
    assert before.json()["mcp_address"] is None

    boundary.metadata = {"resource": _RESOURCE, "authorization_server": ISSUER}
    within_backoff = await async_client.get(_CONNECTION, headers=headers)
    assert within_backoff.json()["mcp_address"] is None
    assert len(boundary.requests) == 1
    clock[0] += agent_connection.NEGATIVE_DISCOVERY_TTL_SECONDS
    after = await async_client.get(_CONNECTION, headers=headers)

    assert after.json() == {
        "connected": True,
        "vault_url": None,
        "mcp_address": _RESOURCE,
        "classification_key_rejected": False,
    }
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
    assert response.json() == {
        "connected": True,
        "vault_url": None,
        "mcp_address": None,
        "classification_key_rejected": False,
    }


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

    assert response.json() == {
        "connected": True,
        "vault_url": _VAULT,
        "mcp_address": _RESOURCE,
        "classification_key_rejected": False,
    }
    assert not boundary.requests


@pytest.mark.asyncio
async def test_repeated_connection_reads_reuse_confirmed_agent_discovery(
    async_client: httpx.AsyncClient, db_session: AsyncSession, boundary: DiscoveryBoundary
) -> None:
    """Journal, import and Settings reads do not each make the same external request."""
    headers, user_id = await signup(async_client, "cached_agent_address")
    await _managed(db_session, user_id)
    boundary.session = db_session
    first = await async_client.get(_CONNECTION, headers=headers)
    second = await async_client.get(_CONNECTION, headers=headers)
    assert first.json()["mcp_address"] == second.json()["mcp_address"] == _RESOURCE
    assert len(boundary.requests) == 1
    assert not db_session.in_transaction()


@pytest.mark.asyncio
async def test_repeated_connection_reads_back_off_unavailable_discovery(
    async_client: httpx.AsyncClient, db_session: AsyncSession, boundary: DiscoveryBoundary
) -> None:
    """An outage is cached briefly without changing whether a vault is connected."""
    headers, user_id = await signup(async_client, "cached_unavailable_agent_address")
    await _managed(db_session, user_id)
    boundary.status = HTTPStatus.SERVICE_UNAVAILABLE
    first = await async_client.get(_CONNECTION, headers=headers)
    second = await async_client.get(_CONNECTION, headers=headers)
    assert (
        first.json()
        == second.json()
        == {
            "connected": True,
            "vault_url": None,
            "mcp_address": None,
            "classification_key_rejected": False,
        }
    )
    assert len(boundary.requests) == 1
    assert not db_session.in_transaction()


@pytest.mark.asyncio
async def test_agent_discovery_reads_each_owned_binding_and_readiness_at_most_once(
    async_client: httpx.AsyncClient, db_session: AsyncSession, boundary: DiscoveryBoundary
) -> None:
    """Address discovery shares the route's owned row instead of resolving it again."""
    headers, user_id = await signup(async_client, "single_agent_snapshot")
    await _managed(db_session, user_id)
    boundary.session = db_session
    reads = {"uservaultconfig": 0, "vaultactivation": 0}

    def count_reads(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        for table in reads:
            if f"from {table}" in statement.lower():
                reads[table] += 1

    bind = db_session.sync_session.get_bind()
    event.listen(bind, "before_cursor_execute", count_reads)
    try:
        response = await async_client.get(_CONNECTION, headers=headers)
    finally:
        event.remove(bind, "before_cursor_execute", count_reads)
    assert response.json()["mcp_address"] == _RESOURCE
    assert all(count <= 1 for count in reads.values()), reads


@pytest.mark.asyncio
async def test_optional_discovery_cancels_slow_dns_off_the_database_pool(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A resolver stall cannot spend the content client's deadline on a connection read."""
    headers, user_id = await signup(async_client, "agent_dns_budget")
    await _managed(db_session, user_id)
    cancelled = asyncio.Event()

    async def stalled(session: AsyncSession, _url: str) -> bool:
        assert not session.in_transaction()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
        return False

    monkeypatch.setattr("services.creek_vault_stored_client.stored_host_is_undialable", stalled)
    response = await asyncio.wait_for(async_client.get(_CONNECTION, headers=headers), timeout=3.0)
    assert response.json() == {
        "connected": True,
        "vault_url": None,
        "mcp_address": None,
        "classification_key_rejected": False,
    }
    assert cancelled.is_set()
    assert not boundary.requests
    assert not db_session.in_transaction()


@pytest.mark.asyncio
async def test_optional_discovery_cancels_slow_handshake_off_the_database_pool(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
    clock: list[float],
) -> None:
    """The whole optional HTTP read is cancelled, while the stored connection still answers."""
    headers, user_id = await signup(async_client, "agent_http_budget")
    await _managed(db_session, user_id)
    boundary.session = db_session
    boundary.pause = asyncio.Event()
    response = await asyncio.wait_for(async_client.get(_CONNECTION, headers=headers), timeout=3.0)
    assert response.json() == {
        "connected": True,
        "vault_url": None,
        "mcp_address": None,
        "classification_key_rejected": False,
    }
    assert boundary.cancelled
    assert len(boundary.requests) == 1
    assert not db_session.in_transaction()
    boundary.pause = None
    assert (await async_client.get(_CONNECTION, headers=headers)).json()["mcp_address"] is None
    assert len(boundary.requests) == 1
    clock[0] += agent_connection.NEGATIVE_DISCOVERY_TTL_SECONDS
    assert (await async_client.get(_CONNECTION, headers=headers)).json()["mcp_address"] == _RESOURCE
    assert len(boundary.requests) == 2


@pytest.mark.asyncio
async def test_expired_confirmation_is_not_a_fallback_for_a_failed_probe(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
    clock: list[float],
) -> None:
    """A positive confirmation lasts at most fifteen seconds, even during an outage."""
    headers, user_id = await signup(async_client, "expired_agent_confirmation")
    await _managed(db_session, user_id)
    assert (await async_client.get(_CONNECTION, headers=headers)).json()["mcp_address"] == _RESOURCE
    boundary.status = HTTPStatus.SERVICE_UNAVAILABLE
    clock[0] += agent_connection.POSITIVE_DISCOVERY_TTL_SECONDS
    response = await async_client.get(_CONNECTION, headers=headers)
    assert response.json()["mcp_address"] is None
    assert len(boundary.requests) == 2


@pytest.mark.asyncio
async def test_credential_rotation_cannot_reuse_a_confirmed_address(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
) -> None:
    """The same owner and edge with a new credential requires a new authenticated proof."""
    headers, user_id = await signup(async_client, "rotated_agent_credential")
    await _managed(db_session, user_id)
    assert (await async_client.get(_CONNECTION, headers=headers)).json()["mcp_address"] == _RESOURCE
    rotated_key = VAULT_KEY + "-rotated"
    await store_vault_config(
        db_session, user_id, vault_url=_VAULT, api_key=rotated_key, provisioned=True
    )
    boundary.metadata = None
    response = await async_client.get(_CONNECTION, headers=headers)
    assert response.json()["mcp_address"] is None
    assert len(boundary.requests) == 2
    assert boundary.requests[-1].headers["authorization"] == f"Bearer {rotated_key}"


@pytest.mark.asyncio
async def test_issuer_rotation_cannot_reuse_a_confirmed_address(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An old issuer's confirmation cannot authorize the display after an issuer change."""
    headers, user_id = await signup(async_client, "rotated_agent_issuer")
    await _managed(db_session, user_id)
    assert (await async_client.get(_CONNECTION, headers=headers)).json()["mcp_address"] == _RESOURCE
    monkeypatch.setenv(OAUTH_ISSUER_ENV_VAR, ISSUER + "/replacement")
    response = await async_client.get(_CONNECTION, headers=headers)
    assert response.json()["mcp_address"] is None
    assert len(boundary.requests) == 2


@pytest.mark.asyncio
async def test_missing_issuer_revokes_use_of_a_cached_confirmation(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The current issuer gate runs before cache hits and releases its transaction."""
    headers, user_id = await signup(async_client, "disabled_agent_issuer")
    await _managed(db_session, user_id)
    assert (await async_client.get(_CONNECTION, headers=headers)).json()["mcp_address"] == _RESOURCE
    monkeypatch.setenv("ENV", "production")
    monkeypatch.delenv(OAUTH_ISSUER_ENV_VAR)
    response = await async_client.get(_CONNECTION, headers=headers)
    assert response.json()["mcp_address"] is None
    assert len(boundary.requests) == 1
    assert not db_session.in_transaction()


@pytest.mark.asyncio
async def test_binding_change_uses_only_the_new_owned_resource(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
) -> None:
    """Replacing the binding cannot return the earlier resource from memory."""
    headers, user_id = await signup(async_client, "replaced_agent_binding")
    await _managed(db_session, user_id)
    assert (await async_client.get(_CONNECTION, headers=headers)).json()["mcp_address"] == _RESOURCE
    new_vault = "https://8.8.8.8/v1"
    new_resource = "https://8.8.8.8/mcp"
    await store_vault_config(
        db_session, user_id, vault_url=new_vault, api_key=VAULT_KEY, provisioned=True
    )
    boundary.metadata = {"resource": new_resource, "authorization_server": ISSUER}
    response = await async_client.get(_CONNECTION, headers=headers)
    assert response.json() == {
        "connected": True,
        "vault_url": None,
        "mcp_address": new_resource,
        "classification_key_rejected": False,
    }
    assert str(boundary.requests[-1].url) == new_vault + "/capabilities"
    assert len(boundary.requests) == 2


@pytest.mark.asyncio
async def test_other_account_does_not_use_a_shared_edge_cache_entry(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
) -> None:
    """Even identical shared-edge URLs and credentials do not join two owners' proofs."""
    alice, alice_id = await signup(async_client, "cached_discovery_alice")
    bob, bob_id = await signup(async_client, "cached_discovery_bob")
    await _managed(db_session, alice_id)
    await _managed(db_session, bob_id)
    assert (await async_client.get(_CONNECTION, headers=alice)).json()["mcp_address"] == _RESOURCE
    boundary.metadata = None
    response = await async_client.get(_CONNECTION, headers=bob)
    assert response.json()["mcp_address"] is None
    assert len(boundary.requests) == 2


@pytest.mark.asyncio
async def test_ready_state_is_rechecked_before_using_a_cached_confirmation(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
) -> None:
    """A local readiness revocation wins immediately over the fifteen-second positive TTL."""
    headers, user_id = await signup(async_client, "agent_readiness_revoked")
    await _managed(db_session, user_id)
    assert (await async_client.get(_CONNECTION, headers=headers)).json()["mcp_address"] == _RESOURCE
    activation = await load_vault_activation(db_session, user_id)
    assert activation is not None
    activation.state = VaultActivationState.PENDING.value
    await db_session.commit()
    response = await async_client.get(_CONNECTION, headers=headers)
    assert response.json()["mcp_address"] is None
    assert len(boundary.requests) == 1
    assert not db_session.in_transaction()


@pytest.mark.asyncio
async def test_new_activation_job_invalidates_confirmation_without_a_credential_change(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
) -> None:
    """A new allocation generation needs its own discovery even on the same public edge."""
    headers, user_id = await signup(async_client, "agent_generation_changed")
    await _managed(db_session, user_id)
    assert (await async_client.get(_CONNECTION, headers=headers)).json()["mcp_address"] == _RESOURCE
    activation = await load_vault_activation(db_session, user_id)
    assert activation is not None
    activation.creek_job_id = "replacement-job"
    await db_session.commit()
    boundary.metadata = None
    response = await async_client.get(_CONNECTION, headers=headers)
    assert response.json()["mcp_address"] is None
    assert len(boundary.requests) == 2


@pytest.mark.asyncio
async def test_status_projection_timestamp_does_not_discard_confirmation(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
) -> None:
    """Ordinary status projections cannot defeat the short cache by touching updated_at."""
    headers, user_id = await signup(async_client, "agent_projection_refreshed")
    await _managed(db_session, user_id)
    assert (await async_client.get(_CONNECTION, headers=headers)).json()["mcp_address"] == _RESOURCE
    activation = await load_vault_activation(db_session, user_id)
    assert activation is not None
    activation.updated_at = datetime.now(UTC) + timedelta(seconds=1)
    await db_session.commit()
    assert (await async_client.get(_CONNECTION, headers=headers)).json()["mcp_address"] == _RESOURCE
    assert len(boundary.requests) == 1


@pytest.mark.asyncio
async def test_internal_foreign_row_cannot_borrow_a_cached_confirmation(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
) -> None:
    """The snapshot itself checks owner identity, independently of the caller's SELECT."""
    alice, alice_id = await signup(async_client, "foreign_snapshot_alice")
    _bob, bob_id = await signup(async_client, "foreign_snapshot_bob")
    await _managed(db_session, alice_id)
    assert (await async_client.get(_CONNECTION, headers=alice)).json()["mcp_address"] == _RESOURCE
    foreign = await load_vault_config(db_session, alice_id)
    assert await agent_connection.managed_agent_address(db_session, bob_id, foreign) is None
    assert len(boundary.requests) == 1
    assert not db_session.in_transaction()


@pytest.mark.asyncio
async def test_discovery_cache_evicts_at_its_hard_entry_bound(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Small configured capacity evicts the oldest proof instead of growing with tenants."""
    monkeypatch.setattr(agent_connection, "MAX_DISCOVERY_CACHE_ENTRIES", 2)
    owners: list[dict[str, str]] = []
    for index in range(3):
        headers, user_id = await signup(async_client, f"bounded_discovery_{index}")
        await _managed(db_session, user_id)
        owners.append(headers)
        assert (await async_client.get(_CONNECTION, headers=headers)).json()[
            "mcp_address"
        ] == _RESOURCE
    assert len(boundary.requests) == 3
    await async_client.get(_CONNECTION, headers=owners[1])
    await async_client.get(_CONNECTION, headers=owners[2])
    assert len(boundary.requests) == 3
    await async_client.get(_CONNECTION, headers=owners[0])
    assert len(boundary.requests) == 4


@pytest.mark.asyncio
async def test_caller_cancellation_propagates_without_caching_a_failure(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
    boundary: DiscoveryBoundary,
) -> None:
    """Abandoning one caller's request is not evidence that the allocation is unavailable."""
    headers, user_id = await signup(async_client, "cancelled_agent_reader")
    await _managed(db_session, user_id)
    boundary.session = db_session
    boundary.pause = asyncio.Event()
    pending = asyncio.create_task(async_client.get(_CONNECTION, headers=headers))
    await asyncio.wait_for(boundary.started.wait(), timeout=3.0)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert boundary.cancelled
    assert not db_session.in_transaction()
    boundary.pause = None
    assert (await async_client.get(_CONNECTION, headers=headers)).json()["mcp_address"] == _RESOURCE
    assert len(boundary.requests) == 2
