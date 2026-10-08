"""Attempt every owed vault withdrawal for one journal page (#3060, #3094).

The request paths that owe a withdrawal -- the Intimate reclassification,
DELETE, and ``erase-locally`` -- all ask the same question: did every vault
copy of this page, the page's own and its essays', confirm absent? This module
answers it in one place. The caller resolves the connected vault's fingerprint
and passes it in, so this service never reaches into request dependencies.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from domain.creek_vault import CreekVaultPipelineClient
from models.journal_entry import JournalEntry
from services.creek_vault_voice_drafts import EntryRef, retract_pending_voice_drafts
from services.creek_vault_withdraw import withdraw_journal_copy


async def withdraw_owed_copies(
    session: AsyncSession,
    entry: JournalEntry,
    client: CreekVaultPipelineClient,
    *,
    destination: str | None,
) -> bool:
    """Attempt every owed withdrawal for ``entry``; ``True`` only when all are confirmed.

    Both the essay withdrawals and the journal copy are attempted every time,
    so one failing never hides the other. Each is bound to the destination that
    received it: a replaced or removed connection leaves the copy pending
    rather than trusting the new vault's "unknown id, withdrawn". Callers have
    already committed the stricter local state, so a ``False`` here costs the
    writer nothing but a stable 503 and a retry.
    """
    if entry.id is None:
        raise RuntimeError("a persisted journal entry is required")
    drafts_withdrawn = await retract_pending_voice_drafts(
        session,
        client,
        EntryRef(user_id=entry.user_id, entry_id=entry.id),
        destination=destination,
    )
    journal_withdrawn = await withdraw_journal_copy(session, entry, client, destination=destination)
    return drafts_withdrawn and journal_withdrawn
