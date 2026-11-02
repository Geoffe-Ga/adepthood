"""Sort a vault-bound writer's backlog: hand the vault the writing it does not have.

:mod:`services.corpus_backfill` sorts by asking the app provider's classifier,
which a vault-bound writer has forbidden (#3156) -- so for them it stops before
its first offer, every time, and ``POST /corpus/sweep`` used to report "nothing
sorted" against a remainder counted in app-side fragments they can never have.
The button did nothing, forever, for exactly the writers who connected a vault
to have their writing sorted.

For that writer, sorting is the vault's job, and Adepthood's part is to make
sure the vault *has* the writing. An entry saved before the vault was
connected, or whose save could not reach it, has no ``vault_ref`` and nothing
will ever send it. This module is what does: it offers each such entry down
the journal save's own path, :func:`services.journal_vault_write.record_vault_outcome`,
so binding, masking, ref reconciliation and the pipeline nudge that has the
vault classify what it received are the save's, not a second copy of them.

**What is pending.** A live, human-written, non-intimate entry with no vault
copy, that is not owed to a *different* vault than the one connected now --
the save path withholds those (#3095), so counting them would quote a
remainder no pass could move. Intimate writing never leaves the deployment, so
it is never pending either.

**Gated like the app-side sweep.** The pass runs only under a standing journal
corpus grant, re-read per entry inside the account barrier, so a revocation or
an erasure arriving mid-pass stops it at the next entry -- the ordering
:func:`services.corpus_backfill._offer_one` argues for.

**Bounded like it too, for now.** :data:`VAULT_SORT_ENTRY_CEILING` and
:data:`VAULT_SORT_DEADLINE_SECONDS` keep a pass inside the client's request
timeout; the remainder is reached by asking again, and a pass is idempotent
because a sent entry carries a ``vault_ref`` and stops being a candidate.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Final

from sqlalchemy import ColumnElement, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import resolved_vault_destination
from domain.creek_vault import CreekVaultClient
from models.corpus_fragment import RETRIEVABLE_TIERS
from models.journal_entry import JournalEntry
from services.account_egress_barrier import ensure_account_live, hold_account
from services.corpus_backfill import BACKFILL_DEADLINE_SECONDS, BACKFILL_ENTRY_CEILING
from services.corpus_consent import load_consent
from services.corpus_ingest import INGEST_SOURCE
from services.creek_vault_write import VaultWriteStatus
from services.journal_vault_write import record_vault_outcome
from services.journal_withdrawal_obligation import deletion_in_progress_clause
from services.voice_draft_privacy import journal_vault_mutations

logger = logging.getLogger(__name__)

#: The most entries one pass offers the vault. The app-side sweep's ceiling, so
#: both kinds of writer see the same "Sort the next N" on the same screen.
VAULT_SORT_ENTRY_CEILING: Final[int] = BACKFILL_ENTRY_CEILING

#: How long one pass may go on starting entries, in seconds: the app-side
#: sweep's deadline, for the same reason -- inside the client's request timeout.
VAULT_SORT_DEADLINE_SECONDS: Final[float] = BACKFILL_DEADLINE_SECONDS

#: The log line a pass writes, in ids and counts only.
VAULT_SORT_EVENT: Final[str] = "corpus_vault_sort"

_HUMAN_SENDER: Final[str] = "user"
_SENDABLE_TIER_VALUES: Final = tuple(tier.value for tier in RETRIEVABLE_TIERS)

#: Write outcomes that are facts about the vault rather than the entry: it was
#: not ready, or an operator suspended vault sends. The next entry would be
#: refused the same way, so the pass stops instead of walking the batch.
_VAULT_WIDE_REFUSALS: Final = frozenset({VaultWriteStatus.UNAVAILABLE, VaultWriteStatus.SUSPENDED})


@dataclass(frozen=True, slots=True)
class VaultSortOutcome:
    """What one pass handed the vault, and what it left without a vault copy."""

    entries_sent: int
    entries_remaining: int


def _pending_conditions(user_id: int, destination: str | None) -> list[ColumnElement[bool]]:
    """Everything that makes an entry one this account's vault still lacks.

    Shared by the count and the batch, so the number quoted is the number over
    the rows a pass would actually take.
    """
    sendable_destination: ColumnElement[bool] = col(JournalEntry.vault_destination).is_(None)
    if destination is not None:
        sendable_destination = or_(
            sendable_destination, col(JournalEntry.vault_destination) == destination
        )
    return [
        col(JournalEntry.user_id) == user_id,
        col(JournalEntry.deleted_at).is_(None),
        ~deletion_in_progress_clause(col(JournalEntry.id)),
        col(JournalEntry.sender) == _HUMAN_SENDER,
        col(JournalEntry.classification).in_(_SENDABLE_TIER_VALUES),
        col(JournalEntry.vault_ref).is_(None),
        sendable_destination,
    ]


async def count_vault_pending(session: AsyncSession, user_id: int) -> int:
    """How much of ``user_id``'s writing its connected vault does not have yet."""
    destination = await resolved_vault_destination(session, user_id)
    result = await session.execute(
        select(func.count())
        .select_from(JournalEntry)
        .where(*_pending_conditions(user_id, destination))
    )
    return int(result.scalar_one())


async def _pending_ids(session: AsyncSession, user_id: int, destination: str | None) -> list[int]:
    """The ids one pass will offer, newest first, up to the ceiling."""
    result = await session.execute(
        select(col(JournalEntry.id))
        .where(*_pending_conditions(user_id, destination))
        .order_by(col(JournalEntry.timestamp).desc(), col(JournalEntry.id).desc())
        .limit(VAULT_SORT_ENTRY_CEILING)
    )
    return [entry_id for entry_id in result.scalars().all() if entry_id is not None]


async def _still_pending(
    session: AsyncSession, *, entry_id: int, user_id: int, destination: str | None
) -> JournalEntry | None:
    """Re-read one row under the locks, against the predicate that selected it."""
    result = await session.execute(
        select(JournalEntry)
        .where(col(JournalEntry.id) == entry_id, *_pending_conditions(user_id, destination))
        .execution_options(populate_existing=True)
    )
    return result.scalars().first()


async def _offer_one(
    session: AsyncSession,
    *,
    entry_id: int,
    user_id: int,
    destination: str | None,
    client: CreekVaultClient,
) -> VaultWriteStatus | None:
    """Offer one entry under the save path's own locks; ``None`` when nothing was offered.

    The account barrier outermost and the entry's vault-mutation lock inside
    it -- the nesting every journal write uses -- so a concurrent edit, delete,
    re-tier or revocation is ordered against this send rather than raced.
    """
    await session.commit()
    async with (
        hold_account(session, user_id),
        journal_vault_mutations.hold(session, entry_id),
    ):
        await ensure_account_live(session, user_id)
        if not (await load_consent(session, user_id=user_id, source=INGEST_SOURCE)).granted:
            return None
        entry = await _still_pending(
            session, entry_id=entry_id, user_id=user_id, destination=destination
        )
        if entry is None:
            return None
        outcome = await record_vault_outcome(session, entry, client)
        return None if outcome is None else outcome.status


async def _send_batch(session: AsyncSession, *, user_id: int, client: CreekVaultClient) -> int:
    """Offer the next batch, one entry at a time; return how many the vault stored.

    Stops before the ceiling's end when the deadline has passed, and at the
    first refusal that is about the vault rather than the entry.
    """
    destination = await resolved_vault_destination(session, user_id)
    deadline = time.monotonic() + VAULT_SORT_DEADLINE_SECONDS
    sent = 0
    for entry_id in await _pending_ids(session, user_id, destination):
        status = await _offer_one(
            session, entry_id=entry_id, user_id=user_id, destination=destination, client=client
        )
        if status is VaultWriteStatus.INGESTED:
            sent += 1
        if status in _VAULT_WIDE_REFUSALS or time.monotonic() > deadline:
            break
    return sent


async def sort_into_vault(
    session: AsyncSession, *, user_id: int, client: CreekVaultClient
) -> VaultSortOutcome:
    """Hand this account's vault the next bounded share of writing it lacks.

    Nothing is sent without a standing journal corpus grant. The pass stops at
    the ceiling, before starting an entry the deadline could not cover, and at
    the first refusal that is about the vault rather than the entry. Every
    failure short of that leaves the entry pending for the next pass.
    """
    granted = (await load_consent(session, user_id=user_id, source=INGEST_SOURCE)).granted
    sent = await _send_batch(session, user_id=user_id, client=client) if granted else 0
    outcome = VaultSortOutcome(
        entries_sent=sent, entries_remaining=await count_vault_pending(session, user_id)
    )
    logger.info(
        VAULT_SORT_EVENT,
        extra={
            "user_id": user_id,
            "entries_sent": outcome.entries_sent,
            "entries_remaining": outcome.entries_remaining,
        },
    )
    return outcome
