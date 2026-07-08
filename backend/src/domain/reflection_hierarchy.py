"""The multi-level reflection hierarchy — when a reflection falls due and what feeds it.

The APTITUDE curriculum is a nested calendar. Ten stages
(:data:`domain.constants.STAGE_DURATIONS_DAYS`) pair up into five *components*
(stages ``2n-1`` and ``2n``), and those components split into two *tiers* — the
first six stages, then the last four. Every layer closes with an invitation to
reflect: at a plain week's end, at a stage's end, and — when several layers close
on the very same day — at the most encompassing layer that closes there. The
precedence is fixed: **program beats tier beats component beats stage beats a
plain week.** A user who reaches day seven of week eighteen is not asked for four
reflections; they are offered the single tier reflection that subsumes the rest.

This module is pure. It reads an anchor datetime, a wall clock, and immutable
value objects, and it never touches the database. Two ideas drive it:

* **Everything derives from the duration schedule.** Week spans, component
  membership, and the program length are all computed from
  ``STAGE_DURATIONS_DAYS`` so a schedule change ripples through automatically —
  there are no hand-written week numbers. The one thing the schedule *cannot*
  tell us is where tier one ends: the six-then-four split is a curriculum design
  choice, not a consequence of any duration, so it lives in the single named
  constant :data:`_TIER_ONE_LAST_STAGE`.

* **Uniform recursion, no special cases.** :func:`resolve_sources` answers "what
  raw material feeds this reflection?" by walking the hierarchy top-down: if a
  child layer already has its own completed reflection, that reflection stands in
  for its whole span; otherwise we recurse into the child. The recursion bottoms
  out at a week, which yields either its own weekly reflection or that week's raw
  daily entries. Crucially, a stage's *final* week can never carry its own weekly
  reflection — that day resolved to the STAGE (or higher) layer instead — so the
  final week simply recurses to its dailies like any other gap. Because that is
  true uniformly, the walk needs no boundary special-casing, and ascending child
  order yields chronologically ordered output with reflections ahead of the raw
  entries they summarize.

Keys are strings of the form ``"c{cycle}:{token}"`` where ``token`` is ``prog``,
``w<week>``, ``s<stage>``, ``p<component>``, or ``t<tier>``. The ``c{cycle}``
prefix isolates repeat runs of the program: a reflection from cycle one never
satisfies a cycle-two lookup.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from enum import StrEnum

from domain.constants import STAGE_DURATIONS_DAYS, TOTAL_STAGES
from domain.program_calendar import elapsed_days

# Seven days to a program week; the whole calendar is a multiple of this.
_DAYS_PER_WEEK = 7

# Weeks each stage lasts, derived straight from the day schedule so a
# curriculum edit never needs a matching edit here: (3,)*8 + (6, 6).
_WEEKS_PER_STAGE: tuple[int, ...] = tuple(
    duration // _DAYS_PER_WEEK for duration in STAGE_DURATIONS_DAYS
)

# The full curriculum length in weeks (36) — the sum of the per-stage spans.
TOTAL_PROGRAM_WEEKS = sum(_WEEKS_PER_STAGE)

# Two consecutive stages make one component; the second (even) stage of a
# pair is the one whose end closes the component.
_STAGES_PER_COMPONENT = 2

# Five components across the ten stages.
_COMPONENT_COUNT = TOTAL_STAGES // _STAGES_PER_COMPONENT

# The components split into exactly two tiers (two halves of the journey).
_TIER_COUNT = 2

# Tier one is the first SIX stages; tier two is the remaining four. This
# six-then-four split is a curriculum design decision — it is NOT derivable
# from STAGE_DURATIONS_DAYS (the two long stages sit in tier two, but their
# length is what makes them long, not what makes them tier two). Hence a
# named constant rather than a computed value.
_TIER_ONE_LAST_STAGE = 6

# The token that names a whole-program reflection (it carries no index).
_PROGRAM_TAG = "prog"

# A key is "c<cycle>:<token>"; the token names one layer of the hierarchy.
_KEY_PATTERN = re.compile(r"^c(\d+):(prog|w\d+|s\d+|p\d+|t\d+)$")


class ReflectionLevel(StrEnum):
    """One layer of the nested reflection calendar, widest last but for WEEK.

    Ordered here from the narrowest span (a single WEEK) outward through STAGE,
    COMPONENT, and TIER to the all-encompassing PROGRAM. When several layers
    close on the same day the widest one wins.
    """

    WEEK = "week"
    STAGE = "stage"
    COMPONENT = "component"
    TIER = "tier"
    PROGRAM = "program"


class SourceKind(StrEnum):
    """What kind of source material a resolved item points at.

    A REFLECTION already summarizes its span; an ENTRY is a single raw daily
    journal entry that no reflection has yet gathered up.
    """

    REFLECTION = "reflection"
    ENTRY = "entry"


# The leading token letter that names each indexed layer (``prog`` is handled
# separately as it carries no index).
_LETTER_TO_LEVEL = {
    "w": ReflectionLevel.WEEK,
    "s": ReflectionLevel.STAGE,
    "p": ReflectionLevel.COMPONENT,
    "t": ReflectionLevel.TIER,
}

# The largest valid 1-based index for each indexed layer, so a stray ``s11`` or
# ``t3`` is rejected rather than silently scoping an empty span.
_LEVEL_MAX_INDEX = {
    ReflectionLevel.WEEK: TOTAL_PROGRAM_WEEKS,
    ReflectionLevel.STAGE: TOTAL_STAGES,
    ReflectionLevel.COMPONENT: _COMPONENT_COUNT,
    ReflectionLevel.TIER: _TIER_COUNT,
}


@dataclass(frozen=True)
class DueReflection:
    """A reflection that has just come due, at a given layer and program week."""

    level: ReflectionLevel
    key: str
    week: int


@dataclass(frozen=True)
class ReflectionRef:
    """A reference to a reflection that already exists, for source resolution."""

    id: int
    level: ReflectionLevel
    key: str
    week: int


@dataclass(frozen=True)
class EntryRef:
    """A reference to one raw daily journal entry, tagged with its program week."""

    id: int
    week: int
    date: date


@dataclass(frozen=True)
class SourceItem:
    """One item feeding a reflection: either a child reflection or a raw entry.

    ``level`` and ``key`` are populated only for REFLECTION items (identifying
    which child reflection stood in for its span); ENTRY items leave them unset.
    """

    kind: SourceKind
    id: int
    week: int
    level: ReflectionLevel | None = None
    key: str | None = None


def _stage_week_span(stage_number: int) -> tuple[int, int]:
    """Return the inclusive (start, end) program-week span for a stage.

    The start is one past the weeks of every earlier stage, mirroring the
    cumulative-window idiom the calendar uses for day-in-stage math; callers pass
    a validated stage number, so no out-of-range guard is needed.
    """
    start = sum(_WEEKS_PER_STAGE[: stage_number - 1]) + 1
    end = start + _WEEKS_PER_STAGE[stage_number - 1] - 1
    return (start, end)


def _component_week_span(component_number: int) -> tuple[int, int]:
    """Return the inclusive (start, end) program-week span for a component."""
    first_stage = _STAGES_PER_COMPONENT * component_number - 1
    second_stage = first_stage + 1
    return (_stage_week_span(first_stage)[0], _stage_week_span(second_stage)[1])


def _tier_week_span(tier_number: int) -> tuple[int, int]:
    """Return the inclusive (start, end) program-week span for a tier."""
    if tier_number == 1:
        return (1, _stage_week_span(_TIER_ONE_LAST_STAGE)[1])
    return (_stage_week_span(_TIER_ONE_LAST_STAGE + 1)[0], TOTAL_PROGRAM_WEEKS)


def _stage_component(stage_number: int) -> int:
    """Return the 1-based component number a stage belongs to (its pair index)."""
    return (stage_number + _STAGES_PER_COMPONENT - 1) // _STAGES_PER_COMPONENT


def _stage_ending_at_week(week: int) -> int | None:
    """Return the stage that closes on ``week``, or None if none does."""
    start = 1
    for index, weeks in enumerate(_WEEKS_PER_STAGE, start=1):
        end = start + weeks - 1
        if end == week:
            return index
        start = end + 1
    return None


def _stage_boundary_level(stage_number: int) -> tuple[ReflectionLevel, str]:
    """Return the widest layer (and its token) that a stage's end closes.

    A stage that also caps a tier resolves to TIER; a stage that also caps a
    component (the even stage of a pair) resolves to COMPONENT; otherwise the
    stage stands on its own.
    """
    if stage_number in (_TIER_ONE_LAST_STAGE, TOTAL_STAGES):
        return (ReflectionLevel.TIER, f"t{1 if stage_number == _TIER_ONE_LAST_STAGE else 2}")
    if stage_number % _STAGES_PER_COMPONENT == 0:
        return (ReflectionLevel.COMPONENT, f"p{_stage_component(stage_number)}")
    return (ReflectionLevel.STAGE, f"s{stage_number}")


def _closing_level(week: int) -> tuple[ReflectionLevel, str]:
    """Return the widest layer (and its token) that program ``week`` closes.

    The whole program wins at the final week; a mid-stage week is a plain WEEK;
    otherwise the stage boundary decides the layer.
    """
    if week == TOTAL_PROGRAM_WEEKS:
        return (ReflectionLevel.PROGRAM, _PROGRAM_TAG)
    stage_number = _stage_ending_at_week(week)
    if stage_number is None:
        return (ReflectionLevel.WEEK, f"w{week}")
    return _stage_boundary_level(stage_number)


def due_reflection(
    anchor: datetime,
    now: datetime | None = None,
    cycle: int = 1,
) -> DueReflection | None:
    """Return the reflection that comes due on the day ``now`` falls in, if any.

    Reflections come due only on the seventh day of a program week; every other
    day (and any clock skew that puts ``now`` before ``anchor``) yields None, as
    does any day past the curriculum's final week. On a due day the widest layer
    that closes that week wins. ``now`` defaults to the current UTC wall clock.
    """
    reference = now if now is not None else datetime.now(UTC)
    elapsed = elapsed_days(anchor, reference)
    if elapsed % _DAYS_PER_WEEK + 1 != _DAYS_PER_WEEK:
        return None
    week = elapsed // _DAYS_PER_WEEK + 1
    if week > TOTAL_PROGRAM_WEEKS:
        return None
    level, token = _closing_level(week)
    return DueReflection(level=level, key=f"c{cycle}:{token}", week=week)


def _token_to_level_index(token: str) -> tuple[ReflectionLevel, int]:
    """Map a validated token to its (level, numeric index); ``prog`` has index 0."""
    if token == _PROGRAM_TAG:
        return (ReflectionLevel.PROGRAM, 0)
    return (_LETTER_TO_LEVEL[token[0]], int(token[1:]))


def _validate_index(level: ReflectionLevel, index: int) -> None:
    """Raise ValueError if ``index`` is out of range for its level."""
    if level is ReflectionLevel.PROGRAM:
        return
    if not 1 <= index <= _LEVEL_MAX_INDEX[level]:
        raise ValueError(f"index {index} out of range for {level}")


def _parse_key(key: str) -> tuple[ReflectionLevel, int]:
    """Parse a ``c<cycle>:<token>`` key into (level, index), validating the range.

    Raises ValueError for a missing cycle prefix, an unknown token, or an index
    past the curriculum's bounds. The cycle number itself is not returned — scope
    and hierarchy are cycle-agnostic; callers that need the prefix read it back
    off the raw key.
    """
    match = _KEY_PATTERN.match(key)
    if match is None:
        raise ValueError(f"malformed reflection key: {key!r}")
    level, index = _token_to_level_index(match.group(2))
    _validate_index(level, index)
    return (level, index)


def _span_for(level: ReflectionLevel, index: int) -> tuple[int, int]:
    """Return the inclusive (start, end) week span for a (level, index) pair."""
    if level is ReflectionLevel.WEEK:
        return (index, index)
    if level is ReflectionLevel.STAGE:
        return _stage_week_span(index)
    if level is ReflectionLevel.COMPONENT:
        return _component_week_span(index)
    if level is ReflectionLevel.TIER:
        return _tier_week_span(index)
    return (1, TOTAL_PROGRAM_WEEKS)


def scope_weeks(level: ReflectionLevel, key: str) -> range:
    """Return the program weeks a reflection covers, as ``range(start, end + 1)``.

    The ``level`` argument must agree with the key's own token; a mismatch (say a
    STAGE level with a ``w5`` key) is rejected so callers cannot silently scope
    the wrong span. The result is cycle-agnostic.
    """
    parsed_level, index = _parse_key(key)
    if parsed_level is not level:
        raise ValueError(f"level {level} does not match key {key!r}")
    start, end = _span_for(parsed_level, index)
    return range(start, end + 1)


def _tier_component_numbers(tier_number: int) -> range:
    """Return the component numbers that make up a tier."""
    if tier_number == 1:
        return range(1, _stage_component(_TIER_ONE_LAST_STAGE) + 1)
    return range(_stage_component(_TIER_ONE_LAST_STAGE + 1), _COMPONENT_COUNT + 1)


def _component_stage_numbers(component_number: int) -> range:
    """Return the stage numbers that make up a component (its consecutive pair)."""
    first_stage = _STAGES_PER_COMPONENT * component_number - 1
    return range(first_stage, first_stage + _STAGES_PER_COMPONENT)


def _child_spec(level: ReflectionLevel, index: int) -> tuple[ReflectionLevel, str, range]:
    """Return a node's child level, token letter, and ascending child numbers.

    Program decomposes into tiers, a tier into its components, a component into
    its stage pair, and a stage into every week it spans. The numbers come back
    in ascending program order so the caller's walk stays chronological.
    """
    if level is ReflectionLevel.PROGRAM:
        return (ReflectionLevel.TIER, "t", range(1, _TIER_COUNT + 1))
    if level is ReflectionLevel.TIER:
        return (ReflectionLevel.COMPONENT, "p", _tier_component_numbers(index))
    if level is ReflectionLevel.COMPONENT:
        return (ReflectionLevel.STAGE, "s", _component_stage_numbers(index))
    start, end = _stage_week_span(index)
    return (ReflectionLevel.WEEK, "w", range(start, end + 1))


def _child_scopes(level: ReflectionLevel, key: str) -> list[tuple[ReflectionLevel, str]]:
    """Return the (level, key) children of a node, carrying its cycle prefix."""
    prefix = key.partition(":")[0]
    _, index = _parse_key(key)
    child_level, letter, numbers = _child_spec(level, index)
    return [(child_level, f"{prefix}:{letter}{number}") for number in numbers]


def _index_reflections(
    existing: Sequence[ReflectionRef],
) -> dict[tuple[ReflectionLevel, str], ReflectionRef]:
    """Index existing reflections by (level, key); the first ref for a slot wins."""
    lookup: dict[tuple[ReflectionLevel, str], ReflectionRef] = {}
    for ref in existing:
        lookup.setdefault((ref.level, ref.key), ref)
    return lookup


def _index_entries(entries: Sequence[EntryRef]) -> dict[int, list[EntryRef]]:
    """Group entries by program week, each week's list sorted by (date, id)."""
    by_week: dict[int, list[EntryRef]] = {}
    for entry in entries:
        by_week.setdefault(entry.week, []).append(entry)
    for week_entries in by_week.values():
        week_entries.sort(key=lambda entry: (entry.date, entry.id))
    return by_week


def _reflection_source(ref: ReflectionRef) -> SourceItem:
    """Wrap an existing reflection as a REFLECTION source item."""
    return SourceItem(
        kind=SourceKind.REFLECTION, id=ref.id, week=ref.week, level=ref.level, key=ref.key
    )


def _entry_source(entry: EntryRef) -> SourceItem:
    """Wrap a raw daily entry as an ENTRY source item."""
    return SourceItem(kind=SourceKind.ENTRY, id=entry.id, week=entry.week)


def _collect_sources(
    level: ReflectionLevel,
    key: str,
    lookup: dict[tuple[ReflectionLevel, str], ReflectionRef],
    by_week: dict[int, list[EntryRef]],
) -> list[SourceItem]:
    """Gather the sources for a node: its own reflection, else its children's.

    An existing reflection for this exact (level, key) stands in for its whole
    span. Otherwise a WEEK bottoms out in its raw dailies while any wider layer
    recurses into each child in turn — uniformly, with no boundary special-case.
    """
    ref = lookup.get((level, key))
    if ref is not None:
        return [_reflection_source(ref)]
    if level is ReflectionLevel.WEEK:
        _, week = _parse_key(key)
        return [_entry_source(entry) for entry in by_week.get(week, [])]
    items: list[SourceItem] = []
    for child_level, child_key in _child_scopes(level, key):
        items.extend(_collect_sources(child_level, child_key, lookup, by_week))
    return items


def resolve_sources(
    level: ReflectionLevel,
    key: str,
    existing: Sequence[ReflectionRef],
    entries: Sequence[EntryRef],
) -> list[SourceItem]:
    """Return the ordered source material feeding the reflection at (level, key).

    Walks the hierarchy top-down: wherever a child layer already has its own
    reflection, that reflection represents its span; every gap recurses until it
    reaches either a weekly reflection or the raw daily entries of a week. The
    result is chronological, with each reflection appearing ahead of the entries
    it summarizes.

    ``level`` must agree with the key's own token, mirroring ``scope_weeks``, so a
    caller cannot silently decompose the wrong span. Reflections are matched by
    their full ``c{cycle}:`` key, so refs from another cycle never satisfy a
    lookup; entries carry no cycle of their own, so the caller must pass only the
    entries belonging to this reflection's cycle.
    """
    parsed_level, _ = _parse_key(key)
    if parsed_level is not level:
        raise ValueError(f"level {level} does not match key {key!r}")
    lookup = _index_reflections(existing)
    by_week = _index_entries(entries)
    return _collect_sources(level, key, lookup, by_week)
