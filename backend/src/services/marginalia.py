"""Marginalia maintenance hooks.

The re-anchoring seam is intentionally a no-op here: editing a journal entry's
body can shift or invalidate the character spans that marginalia anchor to, but
the actual re-anchor / mark-stale logic lands in a later issue. This module
exists so the PATCH endpoint can call a stable, documented seam now.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from domain.marginalia_anchoring import reanchor_one
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaStatus
from services.botmason import generate_response


class BotmasonResonanceLLM:
    """Adapts the BotMason provider to the resonance domain's ``ResonanceLLM``.

    The domain only needs ``complete(prompt) -> text``; this maps that onto
    ``generate_response`` (no conversation history, no system prompt) so the
    resonance feature reuses the single LLM integration / BYOK seam.
    """

    def __init__(self, api_key: str | None) -> None:
        """Store the optional BYOK key used for each completion."""
        self._api_key = api_key

    async def complete(self, prompt: str) -> str:
        response = await generate_response(prompt, [], system_prompt=None, api_key=self._api_key)
        return response.text


async def reanchor_entry_marginalia(
    entry: JournalEntry,
    old_message: str,
    new_message: str,
    session: AsyncSession,
) -> None:
    """Re-anchor (or mark stale) the entry's marginalia after a body edit.

    Each active note re-anchors to its span if its ``anchor_text`` still occurs
    in ``new_message``; otherwise it is marked stale. Stale notes stay stale and
    nothing is deleted. Matching is on ``anchor_text`` (the snapshot), never on
    offsets alone, so the new body is the only input the logic needs.
    """
    # The match is against the snapshot text in the new body, so the pre-edit
    # body isn't consulted here.
    del old_message
    result = await session.execute(
        select(Marginalia).where(Marginalia.journal_entry_id == entry.id)
    )
    for note in result.scalars().all():
        if note.status == MarginaliaStatus.STALE:
            continue  # once stale, stays stale
        outcome = reanchor_one(note.anchor_text, note.anchor_start, new_message)
        if outcome.stale:
            note.status = MarginaliaStatus.STALE
        else:
            note.anchor_start = outcome.anchor_start
            note.anchor_end = outcome.anchor_end
