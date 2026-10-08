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

from sqlalchemy import ColumnElement
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped
from sqlmodel import col, select

from errors import conflict
from models.journal_entry import JournalEntry
from models.journal_withdrawal_obligation import (
    OPEN_STATES,
    JournalWithdrawalObligation,
    JournalWithdrawalState,
)
from models.voice_draft_retraction import VoiceDraftRetraction, VoiceDraftRetractionState
from services.creek_vault_client import LocalFallbackCreekVaultClient

_LOGGER = logging.getLogger(__name__)

OBLIGATION_TRANSITION_EVENT: Final = "journal withdrawal obligation transition"
ERASED_UNCONFIRMED_EVENT: Final = "journal entry erased with unconfirmed vault copy"

#: The only ``extra`` keys a record from this module may carry: ids and closed codes.
OBLIGATION_LOG_EXTRAS: Final = frozenset({"entry_id", "from_state", "to_state", "reason"})

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


async def locate_owed_copy(
    session: AsyncSession, entry: JournalEntry, destination: str | None, client: object
) -> CopyLocation:
    """Where ``entry``'s unconfirmed copies live, relative to what this request can dial.

    No vault is connected only when there is no destination *and* the request
    resolved the local fallback, which dials nothing.
    """
    connected = destination is not None or type(client) is not LocalFallbackCreekVaultClient
    return await copy_location(session, entry, destination, vault_connected=connected)


async def owe_pending_delete(session: AsyncSession, entry: JournalEntry) -> None:
    """Record, durably, that this page's deletion waits only on its vault (#3098). Commits.

    Committed before the 503 so the background sweep can finish both the
    withdrawal and the ``deleted_at`` stamp for any classification, without
    the writer having to ask again. The page stays live until then.
    """
    await record_obligation(
        session,
        user_id=entry.user_id,
        entry_id=_entry_id(entry),
        state=JournalWithdrawalState.PENDING_DELETE,
        destination=entry.vault_destination,
    )
    await session.commit()


async def complete_confirmed_delete(session: AsyncSession, entry: JournalEntry) -> None:
    """Stamp a deletion whose every copy was confirmed absent; settle its obligation. Commits."""
    entry.deleted_at = _utcnow()
    session.add(entry)
    await settle_confirmed(session, user_id=entry.user_id, entry_id=_entry_id(entry))
    await session.commit()


async def erase_with_unconfirmed_copy(
    session: AsyncSession,
    entry: JournalEntry,
    *,
    destination: str | None,
    location: CopyLocation,
) -> None:
    """Erase the page here and keep a content-free ``unconfirmed`` obligation (#3094). Commits.

    Called only after the vault holding the copy could not confirm it absent.
    The obligation is bound to the vault the copy was recorded to -- or, for a
    legacy copy that recorded none, to the vault connected now (``destination``),
    the same guess its ordinary withdrawal already makes -- so only that vault's
    later confirmation can clear it. A page whose own copy is already gone owes
    only its essays, whose obligations are already durable; its journal
    obligation, if an earlier DELETE left one, is settled.
    """
    entry_id = _entry_id(entry)
    entry.deleted_at = _utcnow()
    session.add(entry)
    if entry.vault_ref is not None or entry.vault_destination is not None:
        await record_obligation(
            session,
            user_id=entry.user_id,
            entry_id=entry_id,
            state=JournalWithdrawalState.UNCONFIRMED,
            destination=entry.vault_destination or destination,
        )
    else:
        await settle_confirmed(session, user_id=entry.user_id, entry_id=entry_id)
    await session.commit()
    _LOGGER.warning(
        ERASED_UNCONFIRMED_EVENT, extra={"entry_id": entry_id, "reason": location.value}
    )


def _entry_id(entry: JournalEntry) -> int:
    if entry.id is None:
        raise RuntimeError("a persisted journal entry is required")
    return entry.id


async def withdrawal_pending_detail(
    session: AsyncSession, entry: JournalEntry, destination: str | None, client: object
) -> str:
    """The stable 503 detail for an unconfirmed withdrawal, naming where the copy lives.

    ``vault_withdrawal_pending`` when the connected vault simply has not
    confirmed; ``vault_withdrawal_previous_vault`` or
    ``vault_withdrawal_disconnected_vault`` when the copy is in a vault this
    account is no longer connected to (#3094). Relational and content-free: no
    URL, fingerprint or text. Commits its read.
    """
    location = await locate_owed_copy(session, entry, destination, client)
    await session.commit()
    return WITHDRAWAL_PENDING_DETAILS[location]


async def erase_here(
    session: AsyncSession, entry: JournalEntry, destination: str | None, client: object
) -> CopyLocation:
    """Locate the unconfirmed copy, erase the page here, and return the location. Commits."""
    location = await locate_owed_copy(session, entry, destination, client)
    await erase_with_unconfirmed_copy(session, entry, destination=destination, location=location)
    return location


#: The 409 every content write gets while a page's deletion is in progress.
DELETION_PENDING_DETAIL: Final = "journal_entry_deletion_pending"


async def refuse_if_deletion_pending(session: AsyncSession, entry: JournalEntry) -> None:
    """Refuse a content write to a page whose deletion is in progress (409).

    An open ``pending_delete`` obligation means the writer asked for this page
    to go and the background sweep will finish that once its vault confirms.
    Until then the page must not change underneath the deletion: no edit, no
    re-ingest into the corpus or the vault, no new derived writing. Retrying
    the DELETE (or taking ``erase-locally``) stays open. Reads only.
    """
    row = await open_obligation(session, user_id=entry.user_id, entry_id=_entry_id(entry))
    if row is not None and row.state == JournalWithdrawalState.PENDING_DELETE.value:
        raise conflict(DELETION_PENDING_DETAIL)


def deletion_in_progress_clause(
    entry_id: Mapped[int | None] | ColumnElement[int],
) -> ColumnElement[bool]:
    """SQL: the entry ``entry_id`` names has an open ``pending_delete`` obligation.

    For every server-side reader that would load a page body to send it to a
    provider or write it into the corpus: a page whose deletion is in progress
    must be skipped exactly like a soft-deleted one, or the copy written now
    outlives the deletion the background sweep is about to finish (#3098).
    Negate it (``~``) in a ``WHERE`` alongside ``deleted_at IS NULL``.
    """
    return (
        select(JournalWithdrawalObligation.id)
        .where(
            col(JournalWithdrawalObligation.journal_entry_id) == entry_id,
            col(JournalWithdrawalObligation.state) == JournalWithdrawalState.PENDING_DELETE.value,
        )
        .exists()
    )
