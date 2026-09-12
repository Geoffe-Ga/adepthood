"""Required, content-free withdrawal of a mirrored journal entry from Creek.

Ordinary replication is best effort because Postgres remains authoritative.
Withdrawal is different: once ``JournalEntry.vault_ref`` proves a connected
vault accepted plaintext, a privacy upgrade or delete may not report completion
until that vault confirms the stable external identity absent. This service
keeps that stricter policy out of the transport adapter and returns one boolean
the journal router can turn into either completion or a durable retry state.
"""

from __future__ import annotations

import logging

from domain.creek_vault import CreekCapability, CreekVaultClient, CreekVaultError

_LOGGER = logging.getLogger(__name__)

_WITHDRAWAL_DEGRADED_EVENT = "creek vault journal withdrawal degraded"
_WITHDRAWAL_CONFIRMED_EVENT = "creek vault journal withdrawal confirmed"


def _degraded(entry_id: int, reason: str) -> bool:
    """Record one closed, content-free failure reason and return ``False``."""
    _LOGGER.warning(
        _WITHDRAWAL_DEGRADED_EVENT,
        extra={"entry_id": entry_id, "reason": reason},
    )
    return False


async def _withdrawal_is_supported(client: CreekVaultClient, entry_id: int) -> bool:
    """Negotiate the destructive capability without leaking a vault exception."""
    try:
        handshake = await client.handshake()
    except CreekVaultError:
        return _degraded(entry_id, "handshake_error")
    if not handshake.available or not client.supports(CreekCapability.JOURNAL_WITHDRAW):
        return _degraded(entry_id, "capability_unavailable")
    return True


async def _withdrawal_is_confirmed(client: CreekVaultClient, entry_id: int) -> bool:
    """Attempt one supported withdrawal and require Creek's closed confirmation."""
    try:
        result = await client.withdraw_journal_entry(entry_id)
    except CreekVaultError:
        return _degraded(entry_id, "vault_error")
    if not result.withdrawn:
        return _degraded(entry_id, "unconfirmed")
    return True


async def withdraw_journal_from_vault(client: CreekVaultClient, *, entry_id: int) -> bool:
    """Return whether Creek confirmed ``entry_id`` absent from every derived surface.

    The stable id is the only request value; no body, title, vault ref, tag, or
    user-selected prose enters this signature. Every failure is collapsed to
    ``False`` after a content-free record so the caller can preserve its durable
    retry marker and return a stable 503 rather than leaking a transport detail.
    """
    if not await _withdrawal_is_supported(client, entry_id):
        return False
    if not await _withdrawal_is_confirmed(client, entry_id):
        return False
    _LOGGER.info(_WITHDRAWAL_CONFIRMED_EVENT, extra={"entry_id": entry_id})
    return True
