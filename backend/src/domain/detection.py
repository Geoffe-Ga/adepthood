"""Completion detection over a journal entry.

Read an entry and decide which of the user's tracked habits or practices the
writer actually *did*.

Pure, injected-LLM domain with the same trust model as :mod:`domain.resonance`:
the model proposes a candidate **index** (into the supplied candidate list) plus
a **verbatim quote**; the server resolves the index against the candidates it
supplied and anchors the quote itself in the body. Model-supplied ids and
character offsets are never trusted, and anything that doesn't resolve cleanly is
dropped.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass

from domain.resonance import ResonanceLLM, _quote_span
from security import TextTooLongError, sanitize_user_text

# Domain-level literals so this module stays free of DB/model imports (mirrors
# ``resonance.VALID_KINDS``); ``test_detection_service`` guards them against
# ``models.completion_suggestion.CompletionTargetType`` drift.
VALID_TARGET_TYPES = frozenset({"habit", "practice"})
# A detected label is a verbatim quote, so it shares resonance's anchor bound.
LABEL_MAX = 280
MAX_HITS = 5


@dataclass(frozen=True)
class DetectionCandidate:
    """One tracked habit/practice offered to the model, addressed by ``index``.

    The server builds these from real rows, so ``target_type``/``target_id`` are
    trusted; the model only ever picks an ``index`` and copies a quote.
    """

    index: int
    target_type: str
    target_id: int
    name: str


@dataclass(frozen=True)
class _HitDraft:
    """A model-proposed hit before resolution: a candidate index + verbatim quote."""

    index: int
    quote: str


@dataclass(frozen=True)
class CompletionDetected:
    """A resolved, anchored detection: a candidate the writer attested to doing."""

    target_type: str
    target_id: int
    label: str
    anchor_start: int
    anchor_end: int
    anchor_text: str


def build_detection_prompt(body: str, candidates: Sequence[DetectionCandidate]) -> str:
    """Build the prompt: pick the candidates the writer actually completed.

    Candidates are numbered by ``index``; the model returns that index plus a
    verbatim quote. The instruction excludes intentions, plans, and avoidance so
    "I want to meditate" or "I skipped sugar" is not read as a completion.
    """
    listed = "\n".join(f"{c.index}. {c.name} ({c.target_type})" for c in candidates)
    return (
        "You read a journal entry and decide which of the listed habits or "
        "practices the writer actually DID or COMPLETED in it.\n\n"
        "Rules:\n"
        "- Only count things the writer actually did/completed — NOT things they "
        "planned, intended, wanted, hoped, or AVOIDED (skipping a bad habit is "
        "not a completion).\n"
        '- "index" is the number of the candidate from the list below.\n'
        '- "quote" is a VERBATIM substring copied exactly from the entry that '
        "shows they did it.\n\n"
        f"Candidates:\n{listed}\n\n"
        f"Entry:\n{body}\n\n"
        'Return JSON: {"hits": [{"index": 0, "quote": "..."}]}'
    )


def _hit_from_item(item: object) -> _HitDraft | None:
    """Parse one model item into a draft, or None if it isn't well-formed."""
    if not isinstance(item, dict):
        return None
    index, quote = item.get("index"), item.get("quote")
    if isinstance(index, int) and not isinstance(index, bool) and isinstance(quote, str):
        return _HitDraft(index=index, quote=quote)
    return None


def _load_hits(raw: str) -> list[object]:
    """Defensively parse the model payload into a list of items (empty on junk)."""
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    hits = payload.get("hits") if isinstance(payload, dict) else None
    return hits if isinstance(hits, list) else []


def _parse_hit_drafts(raw: str) -> list[_HitDraft]:
    """Turn the raw payload into well-formed drafts, dropping malformed items."""
    return [draft for item in _load_hits(raw) if (draft := _hit_from_item(item)) is not None]


def _sanitize_label(quote: str) -> str | None:
    """Sanitize the quote into a label, or None if it can't fit after cleaning."""
    try:
        cleaned = sanitize_user_text(quote, max_len=LABEL_MAX)
    except TextTooLongError:
        return None
    return cleaned or None


def _anchor_hit(
    body: str, draft: _HitDraft, by_index: dict[int, DetectionCandidate]
) -> CompletionDetected | None:
    """Resolve a draft against the candidates + body, or None if it can't.

    The index must address a supplied candidate and the quote must occur verbatim
    in the body — neither the model's id nor any offset it might claim is trusted.
    """
    candidate = by_index.get(draft.index)
    span = _quote_span(body, draft.quote)
    label = _sanitize_label(draft.quote)
    if candidate is None or span is None or label is None:
        return None
    start, end = span
    return CompletionDetected(
        target_type=candidate.target_type,
        target_id=candidate.target_id,
        label=label,
        anchor_start=start,
        anchor_end=end,
        anchor_text=body[start:end],
    )


def _overlaps(a: CompletionDetected, b: CompletionDetected) -> bool:
    """True when two anchored spans intersect."""
    return a.anchor_start < b.anchor_end and b.anchor_start < a.anchor_end


def _is_duplicate(
    hit: CompletionDetected, kept: list[CompletionDetected], seen_targets: set[tuple[str, int]]
) -> bool:
    """True when ``hit`` repeats a kept target or overlaps a kept span."""
    if (hit.target_type, hit.target_id) in seen_targets:
        return True
    return any(_overlaps(hit, other) for other in kept)


def _collect_hits(
    body: str,
    drafts: list[_HitDraft],
    by_index: dict[int, DetectionCandidate],
    max_hits: int,
) -> list[CompletionDetected]:
    """Resolve drafts to anchored hits, dropping dupes and capping at ``max_hits``."""
    kept: list[CompletionDetected] = []
    seen_targets: set[tuple[str, int]] = set()
    for draft in drafts:
        hit = _anchor_hit(body, draft, by_index)
        if hit is None or _is_duplicate(hit, kept, seen_targets):
            continue
        kept.append(hit)
        seen_targets.add((hit.target_type, hit.target_id))
        if len(kept) >= max_hits:
            break
    return kept


async def detect_completions(
    body: str,
    *,
    candidates: Sequence[DetectionCandidate],
    llm: ResonanceLLM,
    max_hits: int = MAX_HITS,
) -> list[CompletionDetected]:
    """Detect which ``candidates`` the writer did in ``body``; anchored + deduped.

    With no candidates the LLM is never called and ``[]`` is returned — a hard
    cost guard the endpoint relies on. Otherwise hits are resolved against the
    supplied candidates (bad index/quote dropped), de-duplicated by target and by
    overlapping span, and capped at ``max_hits``.
    """
    if not candidates:
        return []
    raw = await llm.complete(build_detection_prompt(body, candidates))
    by_index = {c.index: c for c in candidates}
    return _collect_hits(body, _parse_hit_drafts(raw), by_index, max_hits)
