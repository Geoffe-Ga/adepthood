"""Optional, short-lived confirmation of a managed vault's public agent address.

Connection reads also gate Journal/import surfaces. Their local binding must
not wait on the ordinary content client's 30-second deadline. Ownership and
READY are checked afresh, the database is released, and only DNS plus discovery
spend the separate one-second budget. Cache entries contain no credentials or
clients and never survive an expired positive as a fallback.

Discovery is also where an allocation's own MCP resource (Creek-Vault#2002,
``/a/<slug>/mcp``) is learned, because Creek's ``/v1`` handoff has no field for
it. The first time a READY allocation with no adopted resource advertises one on
its own edge, it is stored with a guarded ``UPDATE``: only for the owner's row,
only for the activation generation the probe started from, and never over a
resource already adopted. Thereafter only that resource is confirmed -- a later
advertisement of the shared edge or of another slug shows no address and is not
adopted, so the audience never silently moves. The unique column refuses a
resource another account already holds.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass, field
from time import monotonic
from typing import TYPE_CHECKING, Any, Final, TypeGuard, cast

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select, update

from models.user_vault_config import UserVaultConfig
from models.vault_activation import VaultActivation, VaultActivationState
from services.creek_provisioning import load_vault_activation
from services.creek_vault_agent_discovery import is_allocation_resource_of, owned_agent_resource
from services.creek_vault_stored_client import build_stored_vault_client
from services.oauth_authorization import configured_issuer, vault_oauth_resource
from services.user_vault_config import load_vault_config

if TYPE_CHECKING:
    from sqlalchemy.engine import CursorResult

logger = logging.getLogger(__name__)

AGENT_DISCOVERY_BUDGET_SECONDS: Final = 1.0
POSITIVE_DISCOVERY_TTL_SECONDS: Final = 15.0
NEGATIVE_DISCOVERY_TTL_SECONDS: Final = 5.0
MAX_DISCOVERY_CACHE_ENTRIES: Final = 256
_CACHE_DOMAIN: Final = "adepthood/managed-agent-discovery/v1"
ADOPTION_REFUSED_EVENT: Final = "agent_resource_adoption_refused"


@dataclass(frozen=True, repr=False)
class _OwnedSnapshot:
    """Owned, READY scalars copied before releasing the request's database session."""

    user_id: int
    vault_url: str
    api_key: str = field(repr=False)
    resource: str
    issuer: str
    generation: tuple[str, str | None]
    allocation: str | None = None


@dataclass(frozen=True)
class _CachedAddress:
    """A public owned resource, or a brief address-unconfirmed result."""

    address: str | None
    expires_at: float


_addresses: dict[str, _CachedAddress] = {}


def reset_agent_discovery_cache() -> None:
    """Forget transient discovery confirmations, including during test/lifespan cleanup."""
    _addresses.clear()


def _owned_managed_config(
    config: UserVaultConfig | None, user_id: int
) -> TypeGuard[UserVaultConfig]:
    """Never accept another account's row, even from an internal caller."""
    return config is not None and config.user_id == user_id and config.provisioned


def _ready_generation(
    activation: VaultActivation | None, user_id: int
) -> tuple[str, str | None] | None:
    """Identify the ready allocation without noisy status-projection timestamps."""
    if (
        activation is None
        or activation.user_id != user_id
        or activation.state != VaultActivationState.READY.value
    ):
        return None
    return activation.activation_id, activation.creek_job_id


async def _snapshot(
    session: AsyncSession, user_id: int, config: UserVaultConfig | None
) -> _OwnedSnapshot | None:
    """Share the route's owner-scoped config and read its activation exactly once."""
    issuer = configured_issuer()
    if not _owned_managed_config(config, user_id) or issuer is None:
        return None
    generation = _ready_generation(await load_vault_activation(session, user_id), user_id)
    if generation is None:
        return None
    resource = vault_oauth_resource(config.vault_url)
    if resource is None:
        return None
    return _OwnedSnapshot(
        user_id=user_id,
        vault_url=config.vault_url,
        api_key=config.api_key,
        resource=resource,
        issuer=issuer,
        generation=generation,
        allocation=config.agent_mcp_resource,
    )


def _cache_key(snapshot: _OwnedSnapshot) -> str:
    """Hash unambiguously framed identity; no raw credential remains in the cache."""
    identity = json.dumps(
        (
            _CACHE_DOMAIN,
            snapshot.user_id,
            snapshot.vault_url,
            snapshot.api_key,
            snapshot.resource,
            snapshot.issuer,
            snapshot.generation,
            snapshot.allocation,
        ),
        separators=(",", ":"),
    )
    return hashlib.sha256(identity.encode()).hexdigest()


def _fresh_address(key: str) -> _CachedAddress | None:
    """An expired positive is removed, never returned if a new probe fails."""
    entry = _addresses.get(key)
    if entry is not None and entry.expires_at > monotonic():
        return entry
    _addresses.pop(key, None)
    return None


def _remember_address(key: str, address: str | None) -> None:
    """Bound both retention time and entry count; old bindings retain no secrets."""
    _addresses.pop(key, None)
    if len(_addresses) >= MAX_DISCOVERY_CACHE_ENTRIES:
        _addresses.pop(next(iter(_addresses)))
    ttl = POSITIVE_DISCOVERY_TTL_SECONDS if address is not None else NEGATIVE_DISCOVERY_TTL_SECONDS
    _addresses[key] = _CachedAddress(address, monotonic() + ttl)


async def _probe(session: AsyncSession, snapshot: _OwnedSnapshot) -> str | None:
    """Bound DNS and the whole optional HTTP read, including cancellation cleanup."""
    try:
        async with asyncio.timeout(AGENT_DISCOVERY_BUDGET_SECONDS):
            client = await build_stored_vault_client(
                session, snapshot.vault_url, snapshot.api_key, managed=True
            )
            handshake = await client.handshake()
            if not handshake.available:
                return None
            return owned_agent_resource(
                handshake.agent_mcp, shared_resource=snapshot.resource, issuer=snapshot.issuer
            )
    except TimeoutError:
        return None


async def _adopt(session: AsyncSession, snapshot: _OwnedSnapshot, resource: str) -> bool:
    """Store ``resource`` for the probed generation only; ``False`` if anything moved."""
    activation_id, job_id = snapshot.generation
    same_generation = (
        select(VaultActivation.id)
        .where(
            col(VaultActivation.user_id) == snapshot.user_id,
            col(VaultActivation.activation_id) == activation_id,
            col(VaultActivation.creek_job_id).is_not_distinct_from(job_id),
            col(VaultActivation.state) == VaultActivationState.READY.value,
        )
        .exists()
    )
    statement = (
        update(UserVaultConfig)
        .where(
            col(UserVaultConfig.user_id) == snapshot.user_id,
            col(UserVaultConfig.provisioned).is_(True),
            col(UserVaultConfig.vault_url) == snapshot.vault_url,
            col(UserVaultConfig.agent_mcp_resource).is_(None),
            same_generation,
        )
        .values(agent_mcp_resource=resource)
        .execution_options(synchronize_session="fetch")
    )
    try:
        result = cast("CursorResult[Any]", await session.execute(statement))
        await session.commit()
    except IntegrityError:
        # Another account holds this audience: never share one, never say whose.
        await session.rollback()
        logger.warning(ADOPTION_REFUSED_EVENT, extra={"user_id": snapshot.user_id})
        return False
    return bool(result.rowcount == 1)


async def _confirmed(
    session: AsyncSession, snapshot: _OwnedSnapshot, advertised: str
) -> str | None:
    """The address to show: the adopted resource, the shared edge, or a fresh adoption."""
    if snapshot.allocation is not None:
        return advertised if advertised == snapshot.allocation else None
    if advertised == snapshot.resource:
        return advertised
    return advertised if await _adopt(session, snapshot, advertised) else None


async def managed_agent_address(
    session: AsyncSession, user_id: int, config: UserVaultConfig | None
) -> str | None:
    """Confirm an address after fresh ownership/readiness checks, off the database pool."""
    snapshot = await _snapshot(session, user_id, config)
    # Release on every exit, including a cache hit, missing issuer or nonready row.
    # No ORM attribute is read after this point.
    await session.commit()
    if snapshot is None:
        return None
    key = _cache_key(snapshot)
    entry = _fresh_address(key)
    if entry is not None:
        return entry.address
    advertised = await _probe(session, snapshot)
    address = None if advertised is None else await _confirmed(session, snapshot, advertised)
    _remember_address(key, address)
    return address


async def adopt_requested_allocation(session: AsyncSession, user_id: int, requested: str) -> None:
    """Re-run discovery when an agent names an allocation of this account's edge.

    The vault's own challenge tells an agent the new per-allocation resource
    before the person may have opened Settings since the roll. Only a READY
    managed account with nothing adopted yet, asked for a resource on its own
    edge's allocation grammar, dials -- and only its own vault, with its own
    credential; what the vault says still goes through the same guarded
    adoption, so naming a resource proves nothing by itself.
    """
    config = await load_vault_config(session, user_id)
    if _awaits_adoption(config, requested):
        await managed_agent_address(session, user_id, config)


def _awaits_adoption(config: UserVaultConfig | None, requested: str) -> TypeGuard[UserVaultConfig]:
    """A managed binding with nothing adopted, asked for an allocation on its own edge."""
    if config is None or not config.provisioned or config.agent_mcp_resource is not None:
        return False
    shared = vault_oauth_resource(config.vault_url)
    return shared is not None and is_allocation_resource_of(requested, shared)
