"""Optional, short-lived confirmation of a managed vault's public agent address.

Connection reads also gate Journal/import surfaces. Their local binding must
not wait on the ordinary content client's 30-second deadline. Ownership and
READY are checked afresh, the database is released, and only DNS plus discovery
spend the separate one-second budget. Cache entries contain no credentials or
clients and never survive an expired positive as a fallback.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass, field
from time import monotonic
from typing import Final, TypeGuard

from sqlalchemy.ext.asyncio import AsyncSession

from models.user_vault_config import UserVaultConfig
from models.vault_activation import VaultActivation, VaultActivationState
from services.creek_provisioning import load_vault_activation
from services.creek_vault_agent_discovery import matching_agent_resource
from services.creek_vault_stored_client import build_stored_vault_client
from services.oauth_authorization import configured_issuer, vault_oauth_resource

AGENT_DISCOVERY_BUDGET_SECONDS: Final = 1.0
POSITIVE_DISCOVERY_TTL_SECONDS: Final = 15.0
NEGATIVE_DISCOVERY_TTL_SECONDS: Final = 5.0
MAX_DISCOVERY_CACHE_ENTRIES: Final = 256
_CACHE_DOMAIN: Final = "adepthood/managed-agent-discovery/v1"


@dataclass(frozen=True, repr=False)
class _OwnedSnapshot:
    """Owned, READY scalars copied before releasing the request's database session."""

    user_id: int
    vault_url: str
    api_key: str = field(repr=False)
    resource: str
    issuer: str
    generation: tuple[str, str | None]


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
            return matching_agent_resource(
                handshake.agent_mcp, resource=snapshot.resource, issuer=snapshot.issuer
            )
    except TimeoutError:
        return None


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
    address = await _probe(session, snapshot)
    _remember_address(key, address)
    return address
