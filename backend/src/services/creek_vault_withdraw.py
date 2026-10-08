"""Required, content-free withdrawal of a mirrored journal entry from Creek.

Ordinary replication is best effort because Postgres remains authoritative.
Withdrawal is different: once ``JournalEntry.vault_ref`` proves a connected
vault accepted plaintext, a privacy upgrade or delete may not report completion
until that vault confirms the stable external identity absent. This service
keeps that stricter policy out of the transport adapter and returns one boolean
the journal router can turn into either completion or a durable retry state.

:func:`withdraw_journal_copy` is the destination-bound wrapper both the router
and the background retry use (#3060): ``vault_destination`` records which vault
was offered the entry, and only that vault's confirmation clears the marker. A
replaced connection answers "unknown id, withdrawn" for an id it never saw, so
trusting it would report a withdrawal while the old vault still holds the copy.

Known pre-migration limit: an entry ingested before ``vault_destination``
existed carries ``vault_ref`` with a NULL destination. Nothing records which
vault received it, so its withdrawal is still trusted from whichever vault is
connected now -- after a reconnect that is the old false confirmation. It is
pinned by ``test_legacy_unbound_marker_is_withdrawn_from_the_current_vault``
and left for an owner decision rather than widened here.

After a reconnect or disconnect, a copy bound to the old vault is never
dialled and never confirmed: the Intimate reclassification and DELETE answer a
503 that names where the copy is and log ``destination_changed`` (#3060
escalation 5). The writer can reconnect that vault, or -- if they cannot reach
it -- delete the page here with an ``unconfirmed`` obligation (#3094).
:func:`withdraw_unconfirmed_copy` is how such a copy is withdrawn later: only
from the vault recorded on the obligation, and only when that is the vault
connected now.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from domain.creek_vault import CreekCapability, CreekVaultClient, CreekVaultError
from models.journal_entry import JournalEntry

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


def _holds_no_remote_copy(entry: JournalEntry) -> bool:
    """Whether no vault was ever offered this entry, or its copy is already withdrawn."""
    return entry.vault_ref is None and entry.vault_destination is None


async def _clear_stale_tags(session: AsyncSession, entry: JournalEntry) -> None:
    """Drop orphaned vault tags from an entry that holds no remote marker."""
    if entry.vault_tags is None:
        return
    entry.vault_tags = None
    session.add(entry)
    await session.commit()
    await session.refresh(entry)


async def withdraw_journal_copy(
    session: AsyncSession,
    entry: JournalEntry,
    client: CreekVaultClient,
    *,
    destination: str | None,
) -> bool:
    """Withdraw ``entry``'s remote copy and report whether its absence is confirmed.

    An entry with neither ``vault_ref`` nor ``vault_destination`` has no known
    remote copy and needs no call. A recorded destination that differs from
    ``destination`` -- the vault currently connected, ``None`` for none -- is
    never dialled: the copy lives elsewhere, so the marker stays and the answer
    is ``False`` (``destination_changed``). Otherwise the session is committed
    before the HTTP call so no pooled connection rides across Creek latency,
    and the marker is cleared only on Creek's confirmation.
    """
    if _holds_no_remote_copy(entry):
        await _clear_stale_tags(session, entry)
        return True
    entry_id = entry.id
    if entry_id is None:
        raise RuntimeError("persisted vault reference requires a journal entry id")
    bound_elsewhere = entry.vault_destination not in {None, destination}
    await session.commit()
    if bound_elsewhere:
        return _degraded(entry_id, "destination_changed")
    if not await withdraw_journal_from_vault(client, entry_id=entry_id):
        return False
    await _clear_marker(session, entry)
    return True


async def _clear_marker(session: AsyncSession, entry: JournalEntry) -> None:
    """Drop every remote-copy column once its destination confirmed absence."""
    entry.vault_ref = None
    entry.vault_tags = None
    entry.vault_destination = None
    session.add(entry)
    await session.commit()
    await session.refresh(entry)


@dataclass(frozen=True)
class CopyBinding:
    """Where an owed copy was recorded to live, and which vault is connected now."""

    entry_id: int
    recorded: str | None
    current: str | None


async def withdraw_unconfirmed_copy(
    session: AsyncSession,
    entry: JournalEntry | None,
    client: CreekVaultClient,
    *,
    binding: CopyBinding,
) -> bool:
    """Withdraw a copy whose page is already gone here; ``True`` only on its vault's confirmation.

    The page was erased locally, so its own marker cannot be trusted to say
    where the copy lives -- the obligation's recorded destination does. A copy
    with no recorded destination cannot be attributed to any vault and is
    never confirmed by one; a copy recorded elsewhere is never dialled. On
    confirmation the soft-deleted row's marker, if the row still exists, is
    cleared as well.
    """
    await session.commit()
    if binding.recorded is None or binding.recorded != binding.current:
        return _degraded(binding.entry_id, "destination_changed")
    if not await withdraw_journal_from_vault(client, entry_id=binding.entry_id):
        return False
    if entry is not None:
        await _clear_marker(session, entry)
    return True
