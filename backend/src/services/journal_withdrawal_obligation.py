"""Durable bookkeeping for a journal page's owed vault withdrawal (#3098, #3094).

The request paths and the background sweep share these helpers so one
lifecycle -- ``pending_delete`` / ``unconfirmed`` -> ``confirmed`` -- is written
in one place. Every write is content-free: ids, a closed state, an opaque
destination fingerprint, timestamps. Every transition logs one record whose
extras are drawn from :data:`OBLIGATION_LOG_EXTRAS` and nothing else.

None of these helpers commits unless its docstring says so; the caller owns the
transaction, so the obligation lands in the same commit as the local change it
describes.
"""

from __future__ import annotations

import enum
import logging
from datetime import UTC, datetime
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.journal_entry import JournalEntry
from models.journal_withdrawal_obligation import (
    OPEN_STATES,
    JournalWithdrawalObligation,
    JournalWithdrawalState,
)
from models.voice_draft_retraction import VoiceDraftRetraction, VoiceDraftRetractionState

_LOGGER = logging.getLogger(__name__)

OBLIGATION_TRANSITION_EVENT: Final = "journal withdrawal obligation transition"

#: The only ``extra`` keys an obligation record may carry: ids and closed codes.
OBLIGATION_LOG_EXTRAS: Final = frozenset({"entry_id", "from_state", "to_state"})

_NO_STATE: Final = "none"
_CONFIRMED: Final = JournalWithdrawalState.CONFIRMED.value


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _log_transition(entry_id: int, from_state: str, to_state: str) -> None:
    _LOGGER.info(
        OBLIGATION_TRANSITION_EVENT,
        extra={"entry_id": entry_id, "from_state": from_state, "to_state": to_state},
    )


async def open_obligation(
    session: AsyncSession, *, user_id: int, entry_id: int
) -> JournalWithdrawalObligation | None:
    """The entry's obligation while it still owes a withdrawal, else ``None``."""
    result = await session.execute(
        select(JournalWithdrawalObligation).where(
            col(JournalWithdrawalObligation.user_id) == user_id,
            col(JournalWithdrawalObligation.journal_entry_id) == entry_id,
            col(JournalWithdrawalObligation.state).in_(OPEN_STATES),
        )
    )
    return result.scalars().first()


async def _any_obligation(
    session: AsyncSession, *, user_id: int, entry_id: int
) -> JournalWithdrawalObligation | None:
    result = await session.execute(
        select(JournalWithdrawalObligation).where(
            col(JournalWithdrawalObligation.user_id) == user_id,
            col(JournalWithdrawalObligation.journal_entry_id) == entry_id,
        )
    )
    return result.scalars().first()


async def record_obligation(
    session: AsyncSession,
    *,
    user_id: int,
    entry_id: int,
    state: JournalWithdrawalState,
    destination: str | None,
) -> None:
    """Stage the entry's obligation in ``state`` bound to ``destination``. Does not commit.

    One row per (account, entry): a repeat request updates it in place, so a
    second DELETE or a later "I can't reach it" never forks the record. A row
    already in ``state`` with the same binding is left exactly as it was.
    """
    row = await _any_obligation(session, user_id=user_id, entry_id=entry_id)
    if row is None:
        row = JournalWithdrawalObligation(user_id=user_id, journal_entry_id=entry_id)
        previous = _NO_STATE
    else:
        previous = row.state
        if previous == state.value and row.destination == destination:
            return
    row.state = state.value
    row.destination = destination
    row.confirmed_at = None
    row.updated_at = _utcnow()
    session.add(row)
    _log_transition(entry_id, previous, state.value)


async def settle_confirmed(session: AsyncSession, *, user_id: int, entry_id: int) -> None:
    """Mark the entry's open obligation confirmed, if it has one. Does not commit."""
    row = await open_obligation(session, user_id=user_id, entry_id=entry_id)
    if row is None:
        return
    previous = row.state
    now = _utcnow()
    row.state = _CONFIRMED
    row.confirmed_at = now
    row.updated_at = now
    session.add(row)
    _log_transition(entry_id, previous, _CONFIRMED)


class CopyLocation(enum.StrEnum):
    """Where an unconfirmed copy lives, said in terms the writer already knows.

    Content-free and relational on purpose: the vault's URL is not stored once
    a connection is replaced, and its fingerprint means nothing to a person.
    What they do know is which vault they are connected to now.
    """

    #: The vault connected now holds the copy and has not confirmed yet.
    CONNECTED_VAULT = "connected_vault"
    #: A vault connected before the current one holds the copy.
    PREVIOUS_VAULT = "previous_vault"
    #: No vault is connected now; the one that was holds the copy.
    DISCONNECTED_VAULT = "disconnected_vault"


#: The stable 503 detail each location answers with. ``vault_withdrawal_pending``
#: keeps its existing meaning: the connected vault simply has not confirmed yet.
WITHDRAWAL_PENDING_DETAILS: Final[dict[CopyLocation, str]] = {
    CopyLocation.CONNECTED_VAULT: "vault_withdrawal_pending",
    CopyLocation.PREVIOUS_VAULT: "vault_withdrawal_previous_vault",
    CopyLocation.DISCONNECTED_VAULT: "vault_withdrawal_disconnected_vault",
}


async def _owed_destinations(session: AsyncSession, entry: JournalEntry) -> set[str | None]:
    """Every destination a copy of ``entry`` is still owed to: the page and its essays."""
    owed: set[str | None] = set()
    if entry.vault_ref is not None or entry.vault_destination is not None:
        owed.add(entry.vault_destination)
    result = await session.execute(
        select(VoiceDraftRetraction.destination).where(
            col(VoiceDraftRetraction.user_id) == entry.user_id,
            col(VoiceDraftRetraction.journal_entry_id) == entry.id,
            col(VoiceDraftRetraction.state) == VoiceDraftRetractionState.PENDING.value,
        )
    )
    owed.update(result.scalars().all())
    return owed


async def copy_location(
    session: AsyncSession,
    entry: JournalEntry,
    destination: str | None,
    *,
    vault_connected: bool,
) -> CopyLocation:
    """Say where ``entry``'s unconfirmed copies live relative to the vault connected now.

    ``destination`` is the connected vault's fingerprint and
    ``vault_connected`` whether this request resolved a vault it can dial at
    all. With none connected, every owed copy is in the one that was.
    Otherwise a copy recorded to a different vault is in a previous one;
    anything else -- including a legacy copy with no recorded vault -- is the
    connected vault's to confirm. Reads only; does not commit.
    """
    if not vault_connected:
        return CopyLocation.DISCONNECTED_VAULT
    owed = await _owed_destinations(session, entry)
    if any(recorded not in {None, destination} for recorded in owed):
        return CopyLocation.PREVIOUS_VAULT
    return CopyLocation.CONNECTED_VAULT
