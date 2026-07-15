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

from domain.care import MEDICATION_GUARDRAIL
from security import TextTooLongError, sanitize_user_text

# Kept as literals (not imported from models.marginalia) so the domain stays
# free of DB imports; ``test_resonance_service`` guards this against enum drift.
VALID_KINDS = frozenset({"theme", "connection", "symbol"})
ANCHOR_TEXT_MAX = 280
NOTE_MAX = 600
ESSAY_MAX = 10_000
_DEFAULT_MAX_NOTES = 5
# Bound the prompt cost: at most this many prior entries, each truncated, so a
# caller passing a long history can't blow up the context window / token bill.
MAX_PRIOR_ENTRIES = 5
_PRIOR_ENTRY_CHARS = 1000


class _AnchoredSpan(Protocol):
    """Structural type for anything carrying integer ``anchor_start`` / ``anchor_end``.

    Lets :func:`_overlaps` serve both :class:`MarginaliaAnchored` and the
    detection module's ``CompletionDetected`` without either importing the
    other's concrete type -- the half-open span check is identical for both.
    Both concrete types are frozen dataclasses, so the members are declared
    read-only to stay structurally compatible under strict typing.
    """

    @property
    def anchor_start(self) -> int:
        """Inclusive start offset of the span in the source text."""

    @property
    def anchor_end(self) -> int:
        """Exclusive end offset of the span in the source text."""


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
    """Build the structured prompt asking for up to ``max_notes`` margin notes.

    Leads with :data:`~domain.care.MEDICATION_GUARDRAIL`. The botmason adapter
    (:class:`services.marginalia.BotmasonResonanceLLM`) also injects the same
    guardrail at the system role, so it is intentionally present twice on this
    path (defense-in-depth) — do not "deduplicate" by removing either copy.
    """
    prior_block = ""
    if prior_entries:
        capped = [entry[:_PRIOR_ENTRY_CHARS] for entry in prior_entries[:MAX_PRIOR_ENTRIES]]
        joined = "\n---\n".join(capped)
        prior_block = (
            "\n\nEarlier entries (context for 'connection' notes only):\n"
            f"<prior>\n{joined}\n</prior>"
        )
    return (
        f"{MEDICATION_GUARDRAIL}\n\n"
        "You are a thoughtful reader leaving margin notes on someone's journal "
        "page. Read the entry and surface up to "
        f"{max_notes} of the most resonant observations.\n\n"
        "For each note:\n"
        '- "kind" is one of: theme, connection, symbol.\n'
        '- "quote" is a VERBATIM substring copied exactly from the entry '
        f"(<= {ANCHOR_TEXT_MAX} characters), never paraphrased.\n"
        '- "note" is 1-2 warm, second-person sentences spoken to the writer. '
        'Never refer to yourself or say "as an AI".\n'
        "- Use 'connection' only when linking to an earlier entry.\n\n"
        "Return STRICT JSON only, no prose, of the form:\n"
        '{"notes": [{"kind": "theme", "quote": "...", "note": "..."}]}\n\n'
        f"<entry>\n{body}\n</entry>{prior_block}"
    )


def _draft_from_item(item: object) -> MarginaliaDraft | None:
    """Build a draft from one parsed JSON item, or None if it's the wrong shape."""
    if not isinstance(item, dict):
        return None
    kind, quote, note = item.get("kind"), item.get("quote"), item.get("note")
    if isinstance(kind, str) and isinstance(quote, str) and isinstance(note, str):
        return MarginaliaDraft(kind=kind, quote=quote, note=note)
    return None


def _load_json_list(raw: str, key: str) -> list[object]:
    """Parse ``raw`` JSON and return its ``key`` list; [] on any malformed input."""
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    value = payload.get(key) if isinstance(payload, dict) else None
    return value if isinstance(value, list) else []


def _parse_drafts(raw: str) -> list[MarginaliaDraft]:
    """Defensively parse the model's JSON into drafts; never raise on bad input."""
    return [
        draft
        for item in _load_json_list(raw, "notes")
        if (draft := _draft_from_item(item)) is not None
    ]


def _sanitize_note(note: str) -> str | None:
    """Sanitize a note; return None if it can't fit the column after sanitizing."""
    try:
        cleaned = sanitize_user_text(note, max_len=NOTE_MAX)
    except TextTooLongError:
        return None
    return cleaned or None


def _quote_span(body: str, quote: str) -> tuple[int, int] | None:
    """Locate ``quote`` verbatim in ``body``; return its offsets or None."""
    if not quote or len(quote) > ANCHOR_TEXT_MAX:
        return None
    start = body.find(quote)
    return None if start == -1 else (start, start + len(quote))


def _anchor(body: str, draft: MarginaliaDraft) -> MarginaliaAnchored | None:
    """Resolve a draft to a span, or None if it can't anchor / validate."""
    if draft.kind not in VALID_KINDS:
        return None
    span = _quote_span(body, draft.quote)
    note = _sanitize_note(draft.note)
    if span is None or note is None:
        return None
    start, end = span
    return MarginaliaAnchored(
        kind=draft.kind,
        anchor_start=start,
        anchor_end=end,
        anchor_text=body[start:end],
        note=note,
    )


def _overlaps(a: _AnchoredSpan, b: _AnchoredSpan) -> bool:
    """True when two anchored spans intersect."""
    return a.anchor_start < b.anchor_end and b.anchor_start < a.anchor_end


def _overlaps_any(candidate: MarginaliaAnchored, kept: list[MarginaliaAnchored]) -> bool:
    """True when ``candidate`` overlaps any already-kept anchor."""
    return any(_overlaps(candidate, other) for other in kept)


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
        if candidate is None or _overlaps_any(candidate, anchored):
            continue
        anchored.append(candidate)
        if len(anchored) >= max_notes:
            break
    return anchored


def _build_essay_prompt(body: str, anchor_text: str, kind: str, note: str) -> str:
    """Build the prompt expanding one margin note into a short letter-like essay.

    Leads with :data:`~domain.care.MEDICATION_GUARDRAIL`; the botmason adapter also
    injects it at the system role, so it is intentionally present twice on this
    path (defense-in-depth) — do not remove either copy.
    """
    return (
        f"{MEDICATION_GUARDRAIL}\n\n"
        "You are writing a short, warm letter to the person whose journal this is, "
        f"expanding on a margin note you left. Stay grounded in the passage you "
        f"anchored to; speak in second person; never refer to yourself as an AI.\n\n"
        f"Margin note kind: {kind}\n"
        f"Your margin note: {note}\n"
        f"The passage it anchors to:\n<passage>\n{anchor_text}\n</passage>\n\n"
        f"The full entry for context:\n<entry>\n{body}\n</entry>\n\n"
        "Write a few warm paragraphs. Plain prose only, no headings or JSON."
    )


def _sanitize_essay(text: str) -> str:
    """Sanitize + cap an essay to ESSAY_MAX, truncating rather than raising."""
    truncated = text[:ESSAY_MAX]
    try:
        return sanitize_user_text(truncated, max_len=ESSAY_MAX)
    except TextTooLongError:
        # NFC expansion pushed it back over the cap; trim with headroom.
        return sanitize_user_text(truncated[: ESSAY_MAX // 2], max_len=ESSAY_MAX)


async def generate_essay(
    *, llm: ResonanceLLM, body: str, anchor_text: str, kind: str, note: str
) -> str:
    """Ask ``llm`` to expand a margin note into a sanitized, length-capped essay."""
    raw = await llm.complete(_build_essay_prompt(body, anchor_text, kind, note))
    return _sanitize_essay(raw)
