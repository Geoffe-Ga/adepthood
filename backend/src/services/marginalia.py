"""Marginalia maintenance hooks.

When a journal entry's body changes, the character spans that marginalia,
completion suggestions, and promoted quotes anchor to can shift or disappear.
``reanchor_entry_marginalia`` re-anchors each active note by re-finding its
snapshot text in the new body (via ``reanchor_one``), updating the anchor span
when it moves and marking the note stale when the text can no longer be found.
``reanchor_entry_suggestions`` and ``reanchor_entry_promoted_quotes`` apply the
same rule to pending suggestions and pending promoted quotes. Nothing is ever
deleted — a stale row stays for the user to resolve. The PATCH endpoint calls
these after persisting a body edit.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.marginalia_anchoring import reanchor_one
from models.completion_suggestion import CompletionSuggestion, SuggestionStatus
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaStatus
from models.promoted_quote import PromotedQuote
from services.botmason import LLMResponse, generate_response

# The system role every resonance-family call ships: margin notes, essay
# expansion, and completion detection.  It exists because ``generate_response``
# reads ``system_prompt=None`` as "use :func:`services.botmason.get_system_prompt`"
# -- BotMason's *chat* persona, which an operator can swap wholesale via
# ``BOTMASON_SYSTEM_PROMPT``.  Passing ``None`` therefore did not mean "no system
# prompt" the way this adapter's docstring claimed; it meant "whatever the chat
# surface is configured to be today", silently steering a task that deliberately
# is not chat (#2762).  An empty string would not fix it: ``or`` treats it as
# falsy and falls back just the same, so the prompt has to be real text.
#
# It is deliberately thin.  The authoritative instructions -- what to read, what
# shape to answer in -- belong to the per-call prompt the domain builds, and a
# second voice at the system role would compete with them.  The medication
# guardrail is not restated here: ``services.botmason._augment_system_prompt``
# appends it to whatever system prompt is supplied, so the defense-in-depth
# second copy travels with this one exactly as it did with the persona.
RESONANCE_SYSTEM_PROMPT = (
    "You are reading one person's journal at their invitation. Follow the "
    "instructions in the message exactly, including the output format it asks "
    "for, and reply with that and nothing else."
)


class BotmasonResonanceLLM:
    """Adapts the BotMason provider to the resonance domain's ``ResonanceLLM``.

    The domain only needs ``complete(prompt) -> text``; this maps that onto
    ``generate_response`` (no conversation history, and
    :data:`RESONANCE_SYSTEM_PROMPT` rather than the BotMason chat persona) so the
    resonance feature reuses the single LLM integration / BYOK seam.  The
    adapter also accumulates each call's full ``LLMResponse`` in ``self.usage``
    (one entry per successful provider call) so the caller can meter cost.
    """

    def __init__(self, api_key: str | None) -> None:
        """Store the optional BYOK key and the per-instance usage accumulator."""
        self._api_key = api_key
        self.usage: list[LLMResponse] = []

    async def complete(self, prompt: str) -> str:
        """Send ``prompt`` to the configured provider and return its text.

        Records the response in :attr:`usage` first, so a metered call is
        accounted for even though only its text goes back to the domain.
        """
        response = await generate_response(
            prompt, [], system_prompt=RESONANCE_SYSTEM_PROMPT, api_key=self._api_key
        )
        self.usage.append(response)
        return response.text


class _AnchoredRow(Protocol):
    """Structural view of a re-anchorable row (marginalia or suggestion)."""

    anchor_text: str
    anchor_start: int
    anchor_end: int
    status: str


def _reanchor(
    rows: Iterable[_AnchoredRow],
    new_message: str,
    terminal_status: str,
) -> None:
    """Re-anchor each row to ``new_message`` or flip it to ``terminal_status``."""
    for row in rows:
        outcome = reanchor_one(row.anchor_text, row.anchor_start, new_message)
        if outcome.stale:
            row.status = terminal_status
        else:
            row.anchor_start = outcome.anchor_start
            row.anchor_end = outcome.anchor_end


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
        select(Marginalia).where(
            Marginalia.journal_entry_id == entry.id,
            Marginalia.status == MarginaliaStatus.ACTIVE,
        )
    )
    _reanchor(result.scalars().all(), new_message, MarginaliaStatus.STALE)


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
    _reanchor(result.scalars().all(), new_message, SuggestionStatus.DISMISSED)


async def reanchor_entry_promoted_quotes(
    entry: JournalEntry,
    new_message: str,
    session: AsyncSession,
) -> None:
    """Re-anchor (or mark stale) the entry's pending promoted quotes after a body edit.

    Mirrors :func:`reanchor_entry_marginalia` for promoted quotes: each pending
    quote (not yet folded into a reflection, not already stale) re-anchors to its
    span if its ``anchor_text`` still occurs in ``new_message``; otherwise the
    ``stale`` flag flips True. Stale quotes stay stale and nothing is deleted. A
    quote already included in a reflection has a frozen span and is left untouched.

    A dedicated loop rather than ``_reanchor``: a promoted quote's terminal state
    is a boolean flag, not the string ``status`` field that ``_AnchoredRow`` models.
    """
    result = await session.execute(
        select(PromotedQuote).where(
            PromotedQuote.source_entry_id == entry.id,
            col(PromotedQuote.included_in_entry_id).is_(None),
            col(PromotedQuote.stale).is_(False),
        )
    )
    for quote in result.scalars().all():
        outcome = reanchor_one(quote.anchor_text, quote.anchor_start, new_message)
        if outcome.stale:
            quote.stale = True
        else:
            quote.anchor_start = outcome.anchor_start
            quote.anchor_end = outcome.anchor_end
