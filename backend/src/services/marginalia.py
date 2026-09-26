"""Marginalia maintenance hooks.

When a journal entry's body changes, the character spans that marginalia,
completion suggestions, and promoted quotes anchor to can shift or disappear.
``reanchor_entry_marginalia`` places each active note by the edit window between
the old and new bodies (via ``reanchor_one``): kept when the edit is after it,
shifted when the edit is before it, relocated only when its passage is unique in
both bodies, and marked stale otherwise -- including when the passage repeats
and the edit leaves it ambiguous which copy was meant, so a row never jumps to
another copy. ``reanchor_entry_suggestions`` and
``reanchor_entry_promoted_quotes`` apply the same rule to pending suggestions
and pending promoted quotes. Nothing is ever deleted — a stale row stays for the
user to resolve. The PATCH endpoint calls these after persisting a body edit,
passing both bodies by keyword so the two strings cannot be silently swapped.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.marginalia_anchoring import reanchor_one
from domain.resonance import split_resonance_prompt
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
# It is deliberately thin.  The authoritative per-call instructions -- what to
# read and what shape to answer in -- are appended beside it at the system role
# by :class:`BotmasonResonanceLLM`.  The medication
# guardrail is not restated here: ``services.botmason._augment_system_prompt``
# appends it to whatever system prompt is supplied, so the defense-in-depth
# second copy travels with this one exactly as it did with the persona.
RESONANCE_SYSTEM_PROMPT = (
    "You are reading one person's journal at their invitation. Follow the task "
    "instructions below exactly and reply with only the requested output."
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
        task_instructions, user_message = split_resonance_prompt(prompt)
        if task_instructions:
            system_prompt = f"{RESONANCE_SYSTEM_PROMPT}\n\n{task_instructions}"
        else:
            # Preserve the narrow prompt-in/text-out protocol for injected
            # callers that do not use the resonance builders.
            system_prompt = RESONANCE_SYSTEM_PROMPT
        response = await generate_response(
            user_message, [], system_prompt=system_prompt, api_key=self._api_key
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
    *,
    old_message: str,
    new_message: str,
    terminal_status: str,
) -> None:
    """Re-anchor each row from ``old_message`` to ``new_message`` or flip it terminal."""
    for row in rows:
        outcome = reanchor_one(row.anchor_text, row.anchor_start, old_message, new_message)
        if outcome.stale:
            row.status = terminal_status
        else:
            row.anchor_start = outcome.anchor_start
            row.anchor_end = outcome.anchor_end


async def reanchor_entry_marginalia(
    entry: JournalEntry,
    session: AsyncSession,
    *,
    old_message: str,
    new_message: str,
) -> None:
    """Re-anchor (or mark stale) the entry's marginalia after a body edit.

    Each active note follows the edit window from ``old_message`` to
    ``new_message``; when the edit touches it, it relocates only to a passage
    unique in both bodies. If its text is gone, or two or more copies make the
    placement ambiguous, it is marked stale with its offsets unchanged. Stale
    notes stay stale and nothing is deleted.
    """
    result = await session.execute(
        select(Marginalia).where(
            Marginalia.journal_entry_id == entry.id,
            Marginalia.status == MarginaliaStatus.ACTIVE,
        )
    )
    _reanchor(
        result.scalars().all(),
        old_message=old_message,
        new_message=new_message,
        terminal_status=MarginaliaStatus.STALE,
    )


async def reanchor_entry_suggestions(
    entry: JournalEntry,
    session: AsyncSession,
    *,
    old_message: str,
    new_message: str,
) -> None:
    """Re-anchor (or auto-dismiss) the entry's PENDING completion suggestions.

    Mirrors :func:`reanchor_entry_marginalia`: each pending suggestion follows the
    edit window from ``old_message`` to ``new_message``. If the mention was
    deleted the suggestion auto-flips to ``dismissed`` (the user never attested
    to a completion the edited entry no longer claims) -- and so does one whose
    edit leaves two or more copies of the mention, since pinning it to another
    copy would be a guess. Accepted and already-dismissed suggestions are left
    untouched.
    """
    result = await session.execute(
        select(CompletionSuggestion).where(
            CompletionSuggestion.journal_entry_id == entry.id,
            CompletionSuggestion.status == SuggestionStatus.PENDING,
        )
    )
    _reanchor(
        result.scalars().all(),
        old_message=old_message,
        new_message=new_message,
        terminal_status=SuggestionStatus.DISMISSED,
    )


async def reanchor_entry_promoted_quotes(
    entry: JournalEntry,
    session: AsyncSession,
    *,
    old_message: str,
    new_message: str,
) -> None:
    """Re-anchor (or mark stale) the entry's pending promoted quotes after a body edit.

    Mirrors :func:`reanchor_entry_marginalia` for promoted quotes: each pending
    quote (not yet folded into a reflection, not already stale) follows the edit
    window from ``old_message`` to ``new_message``; when its text is gone or the
    edit leaves two or more candidate copies, the ``stale`` flag flips True with
    its offsets unchanged. Stale quotes stay stale and nothing is deleted.

    Folded quotes stay frozen by decision (#2945): a quote already included in a
    reflection is not re-anchored, because the reflection body carries its text
    and the client lists a folded quote whose offsets no longer spell it apart
    from the prose (``partitionQuotes``, #2965). A server-side "detached" marker
    would need a model and wire change, so it belongs to a separate issue.

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
        outcome = reanchor_one(quote.anchor_text, quote.anchor_start, old_message, new_message)
        if outcome.stale:
            quote.stale = True
        else:
            quote.anchor_start = outcome.anchor_start
            quote.anchor_end = outcome.anchor_end
