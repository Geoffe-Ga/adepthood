"""Resonance generation: turn a journal entry into anchored margin notes.

Pure domain logic with the LLM injected — no FastAPI, no DB. The model proposes
short notes with a verbatim ``quote`` from the body; we resolve each quote to
character offsets *ourselves* (never trusting model-supplied indices) and drop
anything that doesn't anchor cleanly.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from security import TextTooLongError, sanitize_user_text

# Kept as literals (not imported from models.marginalia) so the domain stays
# free of DB imports; ``test_resonance_service`` guards this against enum drift.
VALID_KINDS = frozenset({"theme", "connection", "symbol"})
_ANCHOR_TEXT_MAX = 280
_NOTE_MAX = 600
_DEFAULT_MAX_NOTES = 5


@dataclass(frozen=True)
class MarginaliaDraft:
    """A model-proposed note before anchoring: a kind, a verbatim quote, a note."""

    kind: str
    quote: str
    note: str


@dataclass(frozen=True)
class MarginaliaAnchored:
    """A note resolved to a character span of the entry body."""

    kind: str
    anchor_start: int
    anchor_end: int
    anchor_text: str
    note: str


class ResonanceLLM(Protocol):
    """Minimal injected LLM seam: prompt in, raw completion text out."""

    async def complete(self, prompt: str) -> str: ...


def build_prompt(
    body: str, prior_entries: Sequence[str] | None = None, max_notes: int = _DEFAULT_MAX_NOTES
) -> str:
    """Build the structured prompt asking for up to ``max_notes`` margin notes."""
    prior_block = ""
    if prior_entries:
        joined = "\n---\n".join(prior_entries)
        prior_block = (
            "\n\nEarlier entries (context for 'connection' notes only):\n"
            f"<prior>\n{joined}\n</prior>"
        )
    return (
        "You are a thoughtful reader leaving margin notes on someone's journal "
        "page. Read the entry and surface up to "
        f"{max_notes} of the most resonant observations.\n\n"
        "For each note:\n"
        '- "kind" is one of: theme, connection, symbol.\n'
        '- "quote" is a VERBATIM substring copied exactly from the entry '
        f"(<= {_ANCHOR_TEXT_MAX} characters), never paraphrased.\n"
        '- "note" is 1-2 warm, second-person sentences spoken to the writer. '
        'Never refer to yourself or say "as an AI".\n'
        "- Use 'connection' only when linking to an earlier entry.\n\n"
        "Return STRICT JSON only, no prose, of the form:\n"
        '{"notes": [{"kind": "theme", "quote": "...", "note": "..."}]}\n\n'
        f"<entry>\n{body}\n</entry>{prior_block}"
    )


def _parse_drafts(raw: str) -> list[MarginaliaDraft]:
    """Defensively parse the model's JSON into drafts; never raise on bad input."""
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    notes = payload.get("notes") if isinstance(payload, dict) else None
    if not isinstance(notes, list):
        return []
    drafts: list[MarginaliaDraft] = []
    for item in notes:
        if not isinstance(item, dict):
            continue
        kind, quote, note = item.get("kind"), item.get("quote"), item.get("note")
        if isinstance(kind, str) and isinstance(quote, str) and isinstance(note, str):
            drafts.append(MarginaliaDraft(kind=kind, quote=quote, note=note))
    return drafts


def _sanitize_note(note: str) -> str | None:
    """Sanitize a note; return None if it can't fit the column after sanitizing."""
    try:
        cleaned = sanitize_user_text(note, max_len=_NOTE_MAX)
    except TextTooLongError:
        return None
    return cleaned or None


def _anchor(body: str, draft: MarginaliaDraft) -> MarginaliaAnchored | None:
    """Resolve a draft to a span, or None if it can't anchor / validate."""
    if draft.kind not in VALID_KINDS or not draft.quote or len(draft.quote) > _ANCHOR_TEXT_MAX:
        return None
    start = body.find(draft.quote)
    if start == -1:
        return None
    note = _sanitize_note(draft.note)
    if note is None:
        return None
    end = start + len(draft.quote)
    return MarginaliaAnchored(
        kind=draft.kind,
        anchor_start=start,
        anchor_end=end,
        anchor_text=body[start:end],
        note=note,
    )


def _overlaps(a: MarginaliaAnchored, b: MarginaliaAnchored) -> bool:
    """True when two anchored spans intersect."""
    return a.anchor_start < b.anchor_end and b.anchor_start < a.anchor_end


async def generate_marginalia(
    body: str,
    *,
    llm: ResonanceLLM,
    prior_entries: Sequence[str] | None = None,
    max_notes: int = _DEFAULT_MAX_NOTES,
) -> list[MarginaliaAnchored]:
    """Ask ``llm`` to read ``body`` and return anchored, validated margin notes.

    Quotes are located verbatim in ``body`` (model indices are never trusted);
    notes that don't anchor, have an unknown kind, or can't be sanitized are
    dropped. Overlapping spans are de-duplicated (first wins) and the result is
    capped at ``max_notes``.
    """
    raw = await llm.complete(build_prompt(body, prior_entries, max_notes))
    anchored: list[MarginaliaAnchored] = []
    for draft in _parse_drafts(raw):
        candidate = _anchor(body, draft)
        if candidate is None or any(_overlaps(candidate, kept) for kept in anchored):
            continue
        anchored.append(candidate)
        if len(anchored) >= max_notes:
            break
    return anchored
