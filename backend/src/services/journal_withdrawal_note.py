"""Detached withdrawal notes: what an erased account's unconfirmed vault copies are owed (#3267).

Account deletion erases every withdrawal obligation with the account. Before
it does, :func:`detach_open_obligations` copies each open one into a
:class:`~models.journal_withdrawal_note.JournalWithdrawalNote` holding only the
vault fingerprint and the entry id -- nothing that names the account. Owner
decision (2026-10-14): keep it until the vault confirms, for at most 97 days.

How a confirmation can still reach a note once the account and its stored
vault credential are gone, per kind of vault:

* **The deployment-wide vault** (``CREEK_VAULT_URL`` bound to the erased
  account by ``CREEK_VAULT_OWNER_USER_ID``). Its credential is deployment
  configuration, not account data, so it survives the erasure.
  :func:`resume_detached_withdrawal_notes` asks that vault to withdraw each
  entry whose note carries its fingerprint, and deletes the note on the
  vault's confirmation. :func:`dependencies.creek_vault.detached_vaults` is
  what names it.
* **A vault the writer connected themselves.** Its URL and credential lived in
  ``uservaultconfig`` and are erased with the account, and a fingerprint folds
  in the account id, so a reconnect under a new account never matches it.
  Nothing can dial it; the deletion receipt tells the writer to run
  ``creek purge`` there, and the 97-day purge is the backstop.
* **A managed vault.** Account deletion tears the whole allocation down (the
  detached ``vaultteardownreceipt``), which removes every copy in it. The note
  is deliberately not joined to that receipt -- the only common key would be
  the account -- so it is cleared by the 97-day purge.
* **A copy that predates destination binding** names no vault (#3095), so no
  vault can confirm it; the 97-day purge is its only end.

:func:`purge_expired_withdrawal_notes` deletes any note older than
:data:`~domain.retention.DETACHED_WITHDRAWAL_NOTE_RETENTION_DAYS`, confirmed or
not. It is a service function for the nightly retention sweep (#3266) to call.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final, cast

from sqlalchemy import CursorResult, delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from domain.creek_vault import CreekVaultClient
from domain.retention import DETACHED_WITHDRAWAL_NOTE_RETENTION_DAYS
from models.journal_withdrawal_note import JournalWithdrawalNote
from models.journal_withdrawal_obligation import OPEN_STATES, JournalWithdrawalObligation
from services.creek_vault_voice_drafts import JournalRetrySchedule
from services.creek_vault_withdraw import withdraw_journal_from_vault

_LOGGER = logging.getLogger(__name__)

NOTE_SETTLED_EVENT: Final = "journal withdrawal note settled"
NOTES_PURGED_EVENT: Final = "journal withdrawal notes purged"

#: The only ``extra`` keys a record from this module may carry: an id and a count.
NOTE_LOG_EXTRAS: Final = frozenset({"entry_id", "purged_count"})

#: How many notes one background pass works, so one slow vault cannot hold it.
_RESUME_BATCH: Final = 50

#: This process's backoff for detached-note withdrawals, as for journal copies.
_NOTE_RETRIES = JournalRetrySchedule()


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class DetachedVault:
    """A vault that can still be dialled with no account: its fingerprint and a client factory."""

    destination: str
    connect: Callable[[], CreekVaultClient]


async def detach_open_obligations(session: AsyncSession, *, user_id: int) -> int:
    """Stage a detached note for each of the account's open obligations. Does not commit.

    Called by account deletion before the sweep erases the obligations, so the
    note lands in the same commit as the erasure. Confirmed obligations get no
    note. An entry that already has a note (a deletion reapplied after a
    restore) keeps the one it has, and with it the earlier clock. Returns how
    many of the account's open obligations are now held as notes.
    """
    owed = await session.execute(
        select(
            JournalWithdrawalObligation.journal_entry_id, JournalWithdrawalObligation.destination
        )
        .where(
            col(JournalWithdrawalObligation.user_id) == user_id,
            col(JournalWithdrawalObligation.state).in_(OPEN_STATES),
        )
        .order_by(col(JournalWithdrawalObligation.journal_entry_id))
    )
    pairs = owed.all()
    if not pairs:
        return 0
    noted = await session.execute(
        select(JournalWithdrawalNote.journal_entry_id).where(
            col(JournalWithdrawalNote.journal_entry_id).in_([entry_id for entry_id, _ in pairs])
        )
    )
    already = set(noted.scalars().all())
    detached_at = _utcnow()
    for entry_id, destination in pairs:
        if entry_id not in already:
            session.add(
                JournalWithdrawalNote(
                    journal_entry_id=entry_id, destination=destination, created_at=detached_at
                )
            )
    return len(pairs)


async def settle_detached_note(session: AsyncSession, *, entry_id: int, destination: str) -> bool:
    """Delete the note for ``entry_id`` bound to ``destination``; whether one went. Commits.

    Bound to the fingerprint, so only the vault the copy went to can clear it:
    a different vault answering "withdrawn" for an id it never held clears
    nothing.
    """
    result = cast(
        "CursorResult[Any]",
        await session.execute(
            delete(JournalWithdrawalNote).where(
                col(JournalWithdrawalNote.journal_entry_id) == entry_id,
                col(JournalWithdrawalNote.destination) == destination,
            )
        ),
    )
    await session.commit()
    settled = bool(result.rowcount)
    if settled:
        _LOGGER.info(NOTE_SETTLED_EVENT, extra={"entry_id": entry_id})
    return settled


async def purge_expired_withdrawal_notes(
    session: AsyncSession, *, now: datetime | None = None
) -> int:
    """Delete every note older than the ratified 97 days, confirmed or not. Commits.

    A note exactly 97 days old is kept; one a moment older goes. Returns how
    many were purged.
    """
    moment = now if now is not None else _utcnow()
    cutoff = moment - timedelta(days=DETACHED_WITHDRAWAL_NOTE_RETENTION_DAYS)
    result = cast(
        "CursorResult[Any]",
        await session.execute(
            delete(JournalWithdrawalNote).where(col(JournalWithdrawalNote.created_at) < cutoff)
        ),
    )
    await session.commit()
    purged = result.rowcount or 0
    if purged:
        _LOGGER.info(NOTES_PURGED_EVENT, extra={"purged_count": purged})
    return purged


async def _due_notes(
    session: AsyncSession,
    destinations: Sequence[str],
    retries: JournalRetrySchedule,
    moment: datetime,
) -> tuple[tuple[int, str], ...]:
    """Snapshot (entry, fingerprint) pairs a reachable vault owes, then end the transaction."""
    result = await session.execute(
        select(JournalWithdrawalNote.journal_entry_id, JournalWithdrawalNote.destination)
        .where(
            col(JournalWithdrawalNote.destination).in_(destinations),
            col(JournalWithdrawalNote.journal_entry_id).not_in(retries.backed_off(moment)),
        )
        .order_by(col(JournalWithdrawalNote.id))
        .limit(_RESUME_BATCH)
    )
    rows = tuple((entry_id, destination) for entry_id, destination in result.all() if destination)
    await session.commit()
    return rows


async def resume_detached_withdrawal_notes(
    factory: async_sessionmaker[AsyncSession],
    vaults: Sequence[DetachedVault],
    *,
    now: datetime | None = None,
    retries: JournalRetrySchedule | None = None,
) -> int:
    """Ask each still-dialable vault to withdraw its notes' copies; return how many settled.

    Only notes whose fingerprint is one of ``vaults`` are read, so a note no
    vault can reach is never dialled and never starves one that can. No
    database connection is held while a vault is dialled. A vault that does not
    confirm leaves its note, backed off on the same curve as journal copies.
    """
    if not vaults:
        return 0
    moment = now if now is not None else _utcnow()
    schedule = retries if retries is not None else _NOTE_RETRIES
    by_destination = {vault.destination: vault for vault in vaults}
    async with factory() as session:
        due = await _due_notes(session, tuple(by_destination), schedule, moment)
    settled = 0
    for entry_id, destination in due:
        client = by_destination[destination].connect()
        confirmed = await withdraw_journal_from_vault(client, entry_id=entry_id)
        schedule.record(entry_id, moment, confirmed=confirmed)
        if confirmed:
            async with factory() as session:
                settled += await settle_detached_note(
                    session, entry_id=entry_id, destination=destination
                )
    return settled
