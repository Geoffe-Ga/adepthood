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

import logging
from datetime import UTC, datetime
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.journal_withdrawal_obligation import (
    OPEN_STATES,
    JournalWithdrawalObligation,
    JournalWithdrawalState,
)

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
