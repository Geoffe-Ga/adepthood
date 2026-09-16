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

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

from domain.care import MEDICATION_GUARDRAIL
from domain.detection_facts import DetectionClock, facts_from_model
from domain.resonance import ResonanceLLM, _load_json_list, _overlaps, _quote_span, resonance_prompt
from security import TextTooLongError, sanitize_user_text

# Domain-level literals so this module stays free of DB/model imports (mirrors
# ``resonance.VALID_KINDS``); ``test_detection_service`` guards them against
# ``models.completion_suggestion.CompletionTargetType`` drift.
VALID_TARGET_TYPES = frozenset({"habit", "practice"})
# Must match ``CompletionSuggestion.label``'s ``_LABEL_MAX`` (255). The column
# is now ``EncryptedString`` (Text), because the label is journal text and is
# encrypted at rest — so the DB no longer backstops the bound, and the sanitizer
# below is the only thing enforcing it. ``test_detection_service`` pins the two
# constants together.
LABEL_MAX = 255
MAX_HITS = 5
# The task marker the stub provider uses after instructions and journal material
# are separated across provider roles.  One canonical literal prevents prompt
# wording and local-development recognition from drifting apart.
DETECTION_JSON_SHAPE = (
    '{"hits": [{"index": 0, "quote": "...", "amount": 0, "unit": "...", "when": "..."}]}'
)


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
    # The unit this target's goal is denominated in ("oz", "minutes", "units"),
    # or ``None`` for a practice, which tracks none. It is shown to the model so
    # a stated amount can be checked against what the goal actually counts, and
    # it is what makes a practice structurally incapable of carrying an AMOUNT
    # (the day is decided without the unit, so the router drops that one).
    # Defaulted so every existing construction and test keeps compiling.
    target_unit: str | None = None


@dataclass(frozen=True)
class _HitDraft:
    """A model-proposed hit before resolution: a candidate index + verbatim quote.

    The three fact fields are deliberately typed ``object``: they arrive
    straight from the model's JSON and have survived no validation at all.
    Every rule that decides whether one may be believed lives in
    :func:`domain.detection_facts.facts_from_model`, so there is exactly one
    place to read, and no second gate to forget.
    """

    index: int
    quote: str
    amount: object = None
    unit: object = None
    when: object = None


@dataclass(frozen=True)
class CompletionDetected:
    """A resolved, anchored detection: a candidate the writer attested to doing.

    ``completed_units`` / ``completed_on`` are the extras the entry may also
    have stated — how much, and on which user-local day. Two flat optional
    fields rather than a value object: every downstream spelling of the pair
    is an ORM, migration, Pydantic, JSON or Zod boundary that could not accept
    one. Both default to ``None``, which is the ordinary case: a writer who
    says "I ran" has attested to the run and to nothing else.
    """

    target_type: str
    target_id: int
    label: str
    anchor_start: int
    anchor_end: int
    anchor_text: str
    completed_units: float | None = None
    completed_on: date | None = None


def render_candidate_line(candidate: DetectionCandidate) -> str:
    """One numbered candidate line, carrying its tracked unit when it has one.

    Shared with nothing else on purpose: the stub provider parses this shape
    back with its own independently-written regex, because the stub's job is
    to prove an outsider can read the wire format. A round-trip test pins the
    two together over both shapes.
    """
    if candidate.target_unit is None:
        return f"{candidate.index}. {candidate.name} ({candidate.target_type})"
    return f"{candidate.index}. {candidate.name} ({candidate.target_type}, {candidate.target_unit})"


def build_detection_prompt(body: str, candidates: Sequence[DetectionCandidate]) -> str:
    """Build the prompt: pick the candidates the writer actually completed.

    Candidates are numbered by ``index``; the model returns that index plus a
    verbatim quote. The instruction excludes intentions, plans, and avoidance so
    "I want to meditate" or "I skipped sugar" is not read as a completion.

    Leads with :data:`~domain.care.MEDICATION_GUARDRAIL`; the botmason adapter also
    injects it at the system role, so it is intentionally present twice on this
    path (defense-in-depth) — do not remove either copy.
    """
    listed = "\n".join(render_candidate_line(c) for c in candidates)
    instructions = (
        f"{MEDICATION_GUARDRAIL}\n\n"
        "You read a journal entry and decide which of the listed habits or "
        "practices the writer actually DID or COMPLETED in it.\n\n"
        "Rules:\n"
        "- Only count things the writer actually did/completed — NOT things they "
        "planned, intended, wanted, hoped, or AVOIDED (skipping a bad habit is "
        "not a completion).\n"
        '- "index" is the number of the candidate from the list below.\n'
        '- "quote" is a VERBATIM substring copied exactly from the entry that '
        "shows they did it.\n"
        '- "amount" is a number the writer states — NEVER converted, NEVER '
        "estimated. Omit it if they state no number.\n"
        '- "unit" is the writer\'s own word for what that number counts, copied '
        "VERBATIM as they wrote it, even if it differs from the unit shown "
        "beside the candidate. Omit it if they state no unit.\n"
        '- "when" is a relative phrase the writer uses for the day, such as '
        '"yesterday" or "on Friday". Omit it if the day is unclear or unstated.'
        "\n\n"
        f"Return JSON: {DETECTION_JSON_SHAPE}"
    )
    material = f"Candidates:\n{listed}\n\nEntry:\n{body}"
    return resonance_prompt(instructions, material)


def _hit_from_item(item: object) -> _HitDraft | None:
    """Parse one model item into a draft, or None if it isn't well-formed."""
    if not isinstance(item, dict):
        return None
    index, quote = item.get("index"), item.get("quote")
    if isinstance(index, int) and not isinstance(index, bool) and isinstance(quote, str):
        # The three extras pass through raw. A malformed *item* is still
        # dropped whole by the gate above; a malformed *field* is not, because
        # a hit rests on its index and quote alone.
        return _HitDraft(
            index=index,
            quote=quote,
            amount=item.get("amount"),
            unit=item.get("unit"),
            when=item.get("when"),
        )
    return None


def _parse_hit_drafts(raw: str) -> list[_HitDraft]:
    """Turn the raw payload into well-formed drafts, dropping malformed items."""
    return [
        draft
        for item in _load_json_list(raw, "hits")
        if (draft := _hit_from_item(item)) is not None
    ]


def _sanitize_label(quote: str) -> str | None:
    """Sanitize the quote into a label, or None if it can't fit after cleaning."""
    try:
        cleaned = sanitize_user_text(quote, max_len=LABEL_MAX)
    except TextTooLongError:
        return None
    return cleaned or None


def _anchor_hit(
    body: str,
    draft: _HitDraft,
    by_index: dict[int, DetectionCandidate],
    clock: DetectionClock,
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
    completed_units, completed_on = facts_from_model(
        draft, target_unit=candidate.target_unit, clock=clock
    )
    return CompletionDetected(
        target_type=candidate.target_type,
        target_id=candidate.target_id,
        label=label,
        anchor_start=start,
        anchor_end=end,
        anchor_text=body[start:end],
        completed_units=completed_units,
        completed_on=completed_on,
    )


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
    clock: DetectionClock,
    max_hits: int,
) -> list[CompletionDetected]:
    """Resolve drafts to anchored hits, dropping dupes and capping at ``max_hits``."""
    kept: list[CompletionDetected] = []
    seen_targets: set[tuple[str, int]] = set()
    for draft in drafts:
        hit = _anchor_hit(body, draft, by_index, clock)
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
    clock: DetectionClock,
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
    return _collect_hits(body, _parse_hit_drafts(raw), by_index, clock, max_hits)
