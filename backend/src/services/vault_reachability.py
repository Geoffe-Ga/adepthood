"""Turn one handshake against the caller's own vault into a reachability state (#3406).

The handshake already exists and already degrades rather than raising: every
failure becomes :meth:`~domain.creek_vault.HandshakeResult.unavailable`, with
the reason kept on the HTTP adapter for operators
(:attr:`~services.creek_vault_client.HttpCreekVaultClient.last_degrade_reason`).
This module reads that reason, and only to place it in one of three states a
writer can act on:

* **reachable** -- the handshake succeeded.
* **unreachable** -- the call did not land, or landed on a vault that said it
  was down: a refused connection, a timeout, a 5xx, or a vault reporting itself
  unavailable. This is the outage a writer should be told is an outage.
* **unknown** -- the call landed and the answer did not settle the question: a
  refused credential, a malformed document, a contract skew, or no dialable
  vault behind the client at all. Saying "not reachable" for these would send a
  writer to wait out an outage that is not happening.

Nothing here dials anything but the client it is handed. Which client that is
belongs to :func:`~dependencies.creek_vault.resolve_creek_vault_client`, which
resolves it from the authenticated caller alone.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType

from domain.creek_vault import CreekVaultClient
from schemas.vault_config import VaultReachability
from services.creek_vault_client import HandshakeDegradeReason, HttpCreekVaultClient

# Every degrade reason, placed deliberately. A table rather than a branch tree,
# so a reason added later is one line here -- and the test that walks every
# member fails until somebody decides where it goes.
_STATE_BY_DEGRADE_REASON: Mapping[HandshakeDegradeReason, VaultReachability] = MappingProxyType(
    {
        HandshakeDegradeReason.UNREACHABLE: VaultReachability.UNREACHABLE,
        HandshakeDegradeReason.TIMED_OUT: VaultReachability.UNREACHABLE,
        HandshakeDegradeReason.VAULT_REPORTED_UNAVAILABLE: VaultReachability.UNREACHABLE,
        HandshakeDegradeReason.AUTH: VaultReachability.UNKNOWN,
        HandshakeDegradeReason.MALFORMED_PAYLOAD: VaultReachability.UNKNOWN,
        HandshakeDegradeReason.INCOMPATIBLE_VERSION: VaultReachability.UNKNOWN,
    }
)


def reachability_for_degrade(reason: HandshakeDegradeReason | None) -> VaultReachability:
    """Place one degrade reason, or its absence, in a reachability state.

    ``None`` on a degraded handshake means nothing attributed the failure,
    which is the definition of not being able to tell. A reason missing from
    the table reads the same way rather than raising on a writer's request.
    """
    if reason is None:
        return VaultReachability.UNKNOWN
    return _STATE_BY_DEGRADE_REASON.get(reason, VaultReachability.UNKNOWN)


async def check_vault_reachability(client: CreekVaultClient) -> VaultReachability:
    """Run one handshake against ``client`` and report what it found.

    Only the HTTP adapter records why a handshake degraded; any other client
    -- the local fallback a caller with no dialable vault is handed -- has no
    vault behind it to be reachable or not, so it is "couldn't tell".
    """
    result = await client.handshake()
    if result.available:
        return VaultReachability.REACHABLE
    if isinstance(client, HttpCreekVaultClient):
        return reachability_for_degrade(client.last_degrade_reason)
    return VaultReachability.UNKNOWN
