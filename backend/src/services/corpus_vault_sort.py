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

**Walked by a background run.** :mod:`services.corpus_sort_run` walks the
pending ids with :func:`pending_vault_entry_ids` and offers each through
:func:`offer_to_vault`, so one press reaches the whole backlog. Offering is
idempotent: a sent entry carries a ``vault_ref`` and stops being a candidate.
"""

from __future__ import annotations

import logging
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
from services.corpus_consent import load_consent
from services.corpus_ingest import INGEST_SOURCE
from services.creek_vault_pipeline import VaultPipelineTrigger, drive_vault_pipeline
from services.creek_vault_write import VaultWriteStatus
from services.journal_vault_write import record_vault_outcome
from services.journal_withdrawal_obligation import deletion_in_progress_clause
from services.voice_draft_privacy import journal_vault_mutations

logger = logging.getLogger(__name__)

_HUMAN_SENDER: Final[str] = "user"
_SENDABLE_TIER_VALUES: Final = tuple(tier.value for tier in RETRIEVABLE_TIERS)


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


async def pending_vault_entry_ids(
    session: AsyncSession,
    user_id: int,
    destination: str | None,
    *,
    below_id: int | None,
    limit: int,
) -> list[int]:
    """The next ``limit`` ids the vault lacks under ``below_id``, highest first.

    The cursor :mod:`services.corpus_sort_run` walks a whole backlog by: each row
    is visited at most once, so a write the vault dropped -- which leaves the
    entry pending -- is not retried within one run, and the walk ends.
    """
    statement = select(col(JournalEntry.id)).where(*_pending_conditions(user_id, destination))
    if below_id is not None:
        statement = statement.where(col(JournalEntry.id) < below_id)
    result = await session.execute(statement.order_by(col(JournalEntry.id).desc()).limit(limit))
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


@dataclass(frozen=True, slots=True)
class VaultTarget:
    """Where a sort sends: the account, the vault it is bound to, and the client that dials it.

    ``destination`` is the fingerprint :func:`resolved_vault_destination`
    answered when the run began; an entry owed to any other vault is not sent.
    """

    user_id: int
    destination: str | None
    client: CreekVaultClient


async def offer_to_vault(
    session: AsyncSession,
    target: VaultTarget,
    entry_id: int,
    *,
    drive_pipeline: bool = True,
) -> VaultWriteStatus | None:
    """Offer one entry under the save path's own locks; ``None`` when nothing was offered.

    ``drive_pipeline`` is passed to
    :func:`services.journal_vault_write.record_vault_outcome`: a caller sending
    many entries in a row passes ``False`` and calls :func:`nudge_vault_pipeline`
    once afterwards.

    The account barrier outermost and the entry's vault-mutation lock inside
    it -- the nesting every journal write uses -- so a concurrent edit, delete,
    re-tier or revocation is ordered against this send rather than raced.
    """
    user_id = target.user_id
    await session.commit()
    async with (
        hold_account(session, user_id),
        journal_vault_mutations.hold(session, entry_id),
    ):
        await ensure_account_live(session, user_id)
        if not (await load_consent(session, user_id=user_id, source=INGEST_SOURCE)).granted:
            return None
        entry = await _still_pending(
            session, entry_id=entry_id, user_id=user_id, destination=target.destination
        )
        if entry is None:
            return None
        outcome = await record_vault_outcome(
            session, entry, target.client, drive_pipeline=drive_pipeline
        )
        return None if outcome is None else outcome.status


async def nudge_vault_pipeline(session: AsyncSession, target: VaultTarget) -> None:
    """Ask the vault to classify what it was sent, once, after a batch of sends.

    The nudge a journal save makes after each write, made once for many:
    :func:`services.creek_vault_pipeline.drive_vault_pipeline` with the save's
    own trigger, so it joins a classification already running or starts the
    one this batch made due, and never raises. Inside the account barrier, as
    every dial to this account's vault is.
    """
    await session.commit()
    async with hold_account(session, target.user_id):
        await ensure_account_live(session, target.user_id)
        await drive_vault_pipeline(
            session,
            target.client,
            user_id=target.user_id,
            trigger=VaultPipelineTrigger.JOURNAL_WRITE,
        )
