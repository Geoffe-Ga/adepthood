"""Marginalia maintenance hooks.

When a journal entry's body changes, the character spans that marginalia anchor
to can shift or disappear. ``reanchor_entry_marginalia`` re-anchors each active
note by re-finding its snapshot text in the new body (via ``reanchor_one``),
updating the anchor span when it moves and marking the note stale when the text
can no longer be found. Notes are never deleted — a stale note stays for the
user to resolve. The PATCH endpoint calls this after persisting a body edit.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from domain.marginalia_anchoring import reanchor_one
from models.completion_suggestion import CompletionSuggestion, SuggestionStatus
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaStatus
from services.botmason import LLMResponse, generate_response


class BotmasonResonanceLLM:
    """Adapts the BotMason provider to the resonance domain's ``ResonanceLLM``.

    The domain only needs ``complete(prompt) -> text``; this maps that onto
    ``generate_response`` (no conversation history, no system prompt) so the
    resonance feature reuses the single LLM integration / BYOK seam.  The
    adapter also accumulates each call's full ``LLMResponse`` in ``self.usage``
    (one entry per successful provider call) so the caller can meter cost.
    """

    def __init__(self, api_key: str | None) -> None:
        """Store the optional BYOK key and the per-instance usage accumulator."""
        self._api_key = api_key
        self.usage: list[LLMResponse] = []

    async def complete(self, prompt: str) -> str:
        response = await generate_response(prompt, [], system_prompt=None, api_key=self._api_key)
        self.usage.append(response)
        return response.text


async def reanchor_entry_marginalia(
    entry: JournalEntry,
    new_message: str,
    session: AsyncSession,
) -> None:
    """Re-anchor (or mark stale) the entry's marginalia after a body edit.

    Each active note re-anchors to its span if its ``anchor_text`` still occurs
    in ``new_message``; otherwise it is marked stale. Stale notes stay stale and
    nothing is deleted. Matching is on ``anchor_text`` (the snapshot), never on
    offsets alone, so the new body is the only input the logic needs.
    """
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


async def reanchor_entry_suggestions(
    entry: JournalEntry,
    new_message: str,
    session: AsyncSession,
) -> None:
    """Re-anchor (or auto-dismiss) the entry's PENDING completion suggestions.

    Mirrors :func:`reanchor_entry_marginalia`: each pending suggestion re-anchors
    to its span if its ``anchor_text`` still occurs in ``new_message``; if the
    mention was deleted the suggestion auto-flips to ``dismissed`` (the user never
    attested to a completion the edited entry no longer claims). Accepted and
    already-dismissed suggestions are left untouched.
    """
    result = await session.execute(
        select(CompletionSuggestion).where(
            CompletionSuggestion.journal_entry_id == entry.id,
            CompletionSuggestion.status == SuggestionStatus.PENDING,
        )
    )
    for suggestion in result.scalars().all():
        outcome = reanchor_one(suggestion.anchor_text, suggestion.anchor_start, new_message)
        if outcome.stale:
            suggestion.status = SuggestionStatus.DISMISSED
        else:
            suggestion.anchor_start = outcome.anchor_start
            suggestion.anchor_end = outcome.anchor_end
