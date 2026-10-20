"""Whether a vault-bound writer's own key powers their vault for this request (#3437).

ADR 0009's 2026-10-16 amendment (owner decision): when a writer has their own
Anthropic or OpenAI key **and** a managed vault, every vault-bound AI operation
-- the Resonance pass, letters, and the classification that onboards new entries
and uploads -- runs through the vault's own grounding and voice pipeline,
**powered by the writer's key**, and is paid by that key rather than by credits.

:func:`vault_provider_key` is the one decision. It answers with the key to relay
only when all of these hold, and with ``None`` -- behaviour unchanged -- in every
other case:

* the caller is :attr:`~services.reflection_boundary.ReflectionBoundary.VAULT_BOUND`
  (an app-provider caller's key already pays its own provider directly);
* the request carries a well-formed key of a vendor a vault may be handed
  (:class:`~domain.creek_vault.VaultKeyProvider`);
* the vault's handshake says it will spend that vendor's key
  (``request_key_providers``, Creek contract 0.18). A self-connected vault and
  an older vault advertise none, so their writers are charged credits exactly as
  before and their key is never sent.

The boundary does not move. The writer still dials only their vault, and the
vault dials the vendor (the #3161 matrix). INTIMATE content never reaches here:
every caller applies :func:`~domain.privacy_tier.admits_egress` first, and the
vault forces any INTIMATE work it is asked for onto its local model or refuses
it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import HTTPException

from domain.creek_vault import VaultKeyProvider, VaultProviderKey
from services.botmason import provider_for_api_key, resolve_chat_api_key
from services.generation_access import disclosed_route_changed
from services.reflection_boundary import ReflectionBoundary

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from domain.creek_vault import CreekVaultClient


def key_vendor(supplied_key: str | None) -> tuple[str, VaultKeyProvider] | None:
    """Return a well-formed key and the vault vendor it belongs to, or ``None``.

    Raises the usual 400 for a malformed header (via
    :func:`~services.botmason.resolve_chat_api_key`); ``None`` for no key or a
    vendor a vault cannot be handed.
    """
    key = resolve_chat_api_key(supplied_key)
    if key is None:
        return None
    vendor = provider_for_api_key(key)
    known = {provider.value: provider for provider in VaultKeyProvider}
    if vendor is None or vendor not in known:
        return None
    return key, known[vendor]


async def vault_provider_key(
    session: AsyncSession,
    vault_client: CreekVaultClient,
    boundary: ReflectionBoundary,
    supplied_key: str | None,
) -> VaultProviderKey | None:
    """Return the writer's key to relay to their vault, or ``None`` when it would not be used.

    Probes the vault's capability document only when a vault-bound writer sent a
    usable key, and commits first so no pooled database connection is held
    across that outbound call (the session has only been read by now).

    Args:
        session: The request's session; committed before the probe.
        vault_client: The writer's vault client.
        boundary: The caller's server-derived boundary.
        supplied_key: The raw ``X-LLM-API-Key`` header.

    Returns:
        The key, bound to its vendor, when the vault advertised that vendor.
    """
    if boundary is not ReflectionBoundary.VAULT_BOUND:
        return None
    found = key_vendor(supplied_key)
    if found is None:
        return None
    key, vendor = found
    await session.commit()
    handshake = await vault_client.handshake()
    if not handshake.accepts_key(vendor):
        return None
    return VaultProviderKey(provider=vendor, _secret=key)


async def reading_vault_key(
    session: AsyncSession,
    vault_client: CreekVaultClient,
    boundary: ReflectionBoundary,
    supplied_key: str | None,
    *,
    refused_whatever_pays: bool,
) -> VaultProviderKey | None:
    """:func:`vault_provider_key` for a Resonance pass, never probing one already refused.

    A ``free_only`` pass (#3389) and one whose disclosed payer route is stale
    (#3385) are refused whatever would pay, and a refused reading must never
    reach the vault -- not even for its handshake. So such a pass is answered
    ``None`` here without a probe, and the refusals that follow are exactly the
    ones a keyless pass would meet.
    """
    if refused_whatever_pays:
        return None
    return await vault_provider_key(session, vault_client, boundary, supplied_key)


def refused_whatever_pays(
    *, free_only: bool, disclosed_route: str | None, boundary: ReflectionBoundary
) -> bool:
    """Whether a pass is refused whoever would pay: ``free_only`` or a stale disclosed route."""
    return free_only or disclosed_route_changed(disclosed_route, boundary)


def relayable_key(supplied_key: str | None) -> VaultProviderKey | None:
    """Return the caller's key, bound to its vendor, for an onboarding pass to relay.

    For the two routes that hand a vault new writing -- a journal save and a
    document import -- whose classification pass the vault runs with the
    writer's key (#3437). Lenient where :func:`key_vendor` is strict: a save
    must never fail because of a key header, so a malformed one relays nothing.
    Whether the key actually leaves is decided at send time by the vault
    client, which attaches it only to the classification call and only to a
    vault whose handshake advertised the vendor; no payment rides on it.
    """
    try:
        found = key_vendor(supplied_key)
    except HTTPException:
        return None
    if found is None:
        return None
    key, vendor = found
    return VaultProviderKey(provider=vendor, _secret=key)


def paying_key(
    supplied_key: str | None,
    boundary: ReflectionBoundary,
    vault_key: VaultProviderKey | None,
) -> str | None:
    """Return the caller's key when it pays for this pass, else ``None`` (credits pay).

    A key pays when the app's own provider answers with it, or when the
    caller's vault will spend it (``vault_key``, from :func:`vault_provider_key`).
    Any other vault-bound pass never uses the key, so it is charged whatever
    key header it carries (#3258).
    """
    spends_key = boundary is ReflectionBoundary.APP_PROVIDER or vault_key is not None
    return resolve_chat_api_key(supplied_key) if spends_key else None
