"""The multi-level reflection hierarchy — when a review falls due and what feeds it.

The APTITUDE curriculum is a nested calendar. Ten stages
(:data:`domain.constants.STAGE_DURATIONS_DAYS`) group in threes into three
*sections* — stages ``3n-2``..``3n`` — and the tenth stage, Clear Light, falls
outside every section and closes the whole *course* on its own. That leftover is
the remainder of :data:`domain.constants.SECTION_COUNT`'s floor division, not a
separate rule.

The cadence is stage-local (issue #2866). Inside a stage a review comes due:

* on every seventh day of the stage — a plain WEEK review;
* on the day BEFORE the stage closes — that stage's FINAL week, which otherwise
  would never be keyed at all, because its seventh day is the closing day;
* on the closing day itself, at the widest layer that closes there. **Course
  beats section beats stage.** A stage that is a third stage closes its section;
  the tenth closes the course; every other stage closes only itself.

Forty-six review days across the 252-day program: 36 weekly (every program week
exactly once), 6 stage, 3 section, 1 course.

This module is pure. It reads an anchor datetime, a wall clock, and immutable
value objects, and it never touches the database. Three ideas drive it:

* **Everything derives from the duration schedule.** Week spans, section
  membership and the program length are all computed from
  ``STAGE_DURATIONS_DAYS`` so a schedule change ripples through automatically —
  there are no hand-written week numbers and no per-stage literals. The one
  thing the schedule *cannot* tell us is how many stages make a section: the
  three-turn Wavelength cadence is a curriculum design choice, so it lives in
  the single named constant :data:`domain.constants.STAGES_PER_SECTION`, beside
  the schedule it cannot be derived from.

* **The key grammar is composed from the level table, never typed out.**
  :data:`_KEY_PATTERN` and :data:`_TOKEN_TO_LEVEL` are both built from
  :data:`_LEVEL_SPECS`, so a level retired from the enum is retired from the
  grammar in the same edit. That matters more than it looks: a pattern that
  still admits a token the table no longer knows would raise ``KeyError``, and
  :func:`routers.reflections._parsed_reflection_ref` catches only ``ValueError``
  — one stale row would 500 a whole sources feed rather than degrade itself.
  Hence :func:`_token_to_level_index` raises ``ValueError`` for anything the
  table does not hold.

* **Uniform recursion, no special cases.** :func:`resolve_sources` answers "what
  raw material feeds this review?" by walking the hierarchy top-down: if a child
  layer already has its own completed review, that review stands in for its
  whole span; otherwise we recurse into the child. The recursion bottoms out at
  a week, which yields either its own weekly review or that week's raw daily
  entries. A stage's final week now DOES carry its own weekly review, written
  the day before the stage closes — and when it exists it stands in for the
  whole of that week, the stage's closing day included, which is exactly the
  period that weekly's own declared window promises. Because that is true
  uniformly, the walk still needs no boundary special-casing, and ascending
  child order yields chronologically ordered output with reviews ahead of the
  raw entries they summarize.

Keys are strings of the form ``"c{cycle}:{token}"`` where ``token`` is
``course``, ``w<week>``, ``s<stage>`` or ``x<section>``. A section is spelled
``x`` because ``s`` already names a stage and ``c`` already prefixes the cycle.
The ``c{cycle}`` prefix isolates repeat runs of the program: a review from cycle
one never satisfies a cycle-two lookup.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from enum import StrEnum

from domain.constants import (
    DAYS_PER_WEEK,
    SECTION_COUNT,
    STAGE_DURATIONS_DAYS,
    STAGES_PER_SECTION,
    TOTAL_PROGRAM_WEEKS,
    TOTAL_STAGES,
    WEEKS_PER_STAGE,
)
from domain.program_calendar import elapsed_days, stage_position

# ``DAYS_PER_WEEK``, ``WEEKS_PER_STAGE`` and ``TOTAL_PROGRAM_WEEKS`` used to be
# derived here from ``STAGE_DURATIONS_DAYS``. They now come from
# :mod:`domain.constants`, which owns the schedule, so the week grid has one
# definition rather than one per module that needs it.


class ReflectionLevel(StrEnum):
    """One layer of the nested review calendar, narrowest first.

    A single WEEK, a Wavelength STAGE, a SECTION of three stages, and the whole
    COURSE. When several layers close on the same day the widest one wins.
    This enum ships to clients as the ``ReflectionLevel`` schema, and its
    members are pinned in the database by a CHECK derived from it.
    """

    WEEK = "week"
    STAGE = "stage"
    SECTION = "section"
    COURSE = "course"


class SourceKind(StrEnum):
    """What kind of source material a resolved item points at.

    A REFLECTION already summarizes its span; an ENTRY is a single raw daily
    journal entry that no reflection has yet gathered up.
    """

    REFLECTION = "reflection"
    ENTRY = "entry"


@dataclass(frozen=True)
class _LevelSpec:
    """How one level spells itself in a scope key.

    ``token`` is the leading letter of an indexed level (``w5``, ``s3``, ``x2``)
    or the WHOLE token of an index-free one. ``max_index`` is the largest valid
    1-based index, so a stray ``s11`` or ``x4`` is rejected rather than silently
    scoping an empty span; zero marks the index-free level.
    """

    token: str
    max_index: int


# The single table every other name in this module's grammar is derived from:
# the regex, the token→level map, key composition and index validation. Retiring
# a level from :class:`ReflectionLevel` retires it from all four at once, which
# is the property that keeps a stale stored key a rejected key rather than an
# uncaught ``KeyError`` (see the module docstring).
_LEVEL_SPECS: Mapping[ReflectionLevel, _LevelSpec] = {
    ReflectionLevel.WEEK: _LevelSpec("w", TOTAL_PROGRAM_WEEKS),
    ReflectionLevel.STAGE: _LevelSpec("s", TOTAL_STAGES),
    ReflectionLevel.SECTION: _LevelSpec("x", SECTION_COUNT),
    ReflectionLevel.COURSE: _LevelSpec("course", 0),
}

# ``{"w": WEEK, "s": STAGE, "x": SECTION, "course": COURSE}`` — indexed levels
# keyed by their leading letter, the index-free one by its whole token.
_TOKEN_TO_LEVEL: Mapping[str, ReflectionLevel] = {
    spec.token: level for level, spec in _LEVEL_SPECS.items()
}


def _token_alternative(spec: _LevelSpec) -> str:
    """The regex alternative matching one level's token."""
    return spec.token if spec.max_index == 0 else rf"{spec.token}\d+"


# A key is "c<cycle>:<token>"; the token names one layer of the hierarchy. The
# alternatives are COMPOSED from the level table rather than typed out, so the
# grammar cannot outlive the vocabulary it spells.
_KEY_PATTERN = re.compile(
    r"^c(\d+):(" + "|".join(_token_alternative(spec) for spec in _LEVEL_SPECS.values()) + r")$"
)


def _key(prefix: str, level: ReflectionLevel, index: int) -> str:
    """Compose a scope key from its ``c<cycle>`` prefix, level and 1-based index.

    The one place a key is spelled, so no caller hand-writes ``f"s{n}"`` and no
    level's token appears twice in this module. ``index`` is ignored for the
    index-free COURSE.
    """
    spec = _LEVEL_SPECS[level]
    token = spec.token if spec.max_index == 0 else f"{spec.token}{index}"
    return f"{prefix}:{token}"


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
    start = sum(WEEKS_PER_STAGE[: stage_number - 1]) + 1
    end = start + WEEKS_PER_STAGE[stage_number - 1] - 1
    return (start, end)


def _section_stage_span(section_number: int) -> tuple[int, int]:
    """Return the inclusive (first, last) STAGE numbers a section covers."""
    last_stage = STAGES_PER_SECTION * section_number
    return (last_stage - STAGES_PER_SECTION + 1, last_stage)


def _section_week_span(section_number: int) -> tuple[int, int]:
    """Return the inclusive (start, end) program-week span for a section."""
    first_stage, last_stage = _section_stage_span(section_number)
    return (_stage_week_span(first_stage)[0], _stage_week_span(last_stage)[1])


def _stage_close_level(stage_number: int) -> tuple[ReflectionLevel, int]:
    """Return the widest layer (and its index) that a stage's final day closes.

    The last stage closes the whole COURSE; every third stage closes its
    SECTION; any other stage closes only itself. Precedence is decided here and
    nowhere else — there is no separate "which layers end this week" walk.
    """
    if stage_number == TOTAL_STAGES:
        return (ReflectionLevel.COURSE, 0)
    if stage_number % STAGES_PER_SECTION == 0:
        return (ReflectionLevel.SECTION, stage_number // STAGES_PER_SECTION)
    return (ReflectionLevel.STAGE, stage_number)


def _due_in_stage(stage_number: int, day_in_stage: int) -> tuple[ReflectionLevel, int] | None:
    """Return what comes due on ``day_in_stage`` of ``stage_number``, or None.

    Three branches, all derived from the stage's own duration:

    * its final day closes the stage (and whatever wider layer ends with it);
    * every seventh day closes a program week;
    * the day BEFORE the final day closes the stage's LAST week, which has no
      seventh day of its own to be closed on — that day belongs to the stage.

    The last two provably never collide: every stage duration is a multiple of
    ``DAYS_PER_WEEK``, so ``duration - 1`` is congruent to six, never zero, mod
    seven. Weeks are numbered globally by adding the weeks of every earlier
    stage, so no stage needs a literal of its own.
    """
    duration = STAGE_DURATIONS_DAYS[stage_number - 1]
    if day_in_stage == duration:
        return _stage_close_level(stage_number)
    weeks_before = sum(WEEKS_PER_STAGE[: stage_number - 1])
    if day_in_stage % DAYS_PER_WEEK == 0:
        return (ReflectionLevel.WEEK, weeks_before + day_in_stage // DAYS_PER_WEEK)
    if day_in_stage == duration - 1:
        return (ReflectionLevel.WEEK, weeks_before + WEEKS_PER_STAGE[stage_number - 1])
    return None


def due_reflection(
    anchor: datetime,
    now: datetime | None = None,
    cycle: int = 1,
) -> DueReflection | None:
    """Return the review that comes due on the day ``now`` falls in, if any.

    The cadence is stage-local: a review falls due on every seventh day of a
    stage, on the day before the stage closes (its final week), and on the
    closing day itself at the widest layer that ends there. Every other day
    yields None, as does any clock skew that puts ``now`` before ``anchor``
    (:func:`domain.program_calendar.elapsed_days` floors at zero) and every day
    once the program is over. ``now`` defaults to the current UTC wall clock.

    The returned ``week`` is the program week the day itself falls in, counted
    from the anchor — including on a day-before-close, where it is the final
    week the returned key names.
    """
    reference = now if now is not None else datetime.now(UTC)
    elapsed = elapsed_days(anchor, reference)
    position = stage_position(elapsed)
    if position is None:
        return None
    stage_number, day_in_stage = position
    due = _due_in_stage(stage_number, day_in_stage)
    if due is None:
        return None
    level, index = due
    return DueReflection(
        level=level,
        key=_key(f"c{cycle}", level, index),
        week=elapsed // DAYS_PER_WEEK + 1,
    )


def _token_to_level_index(token: str) -> tuple[ReflectionLevel, int]:
    """Map a token to its (level, numeric index); the index-free COURSE has index 0.

    Raises ``ValueError`` — never ``KeyError`` — for a token the level table
    does not hold, because :func:`routers.reflections._parsed_reflection_ref`
    catches only ``ValueError``: a ``KeyError`` here would escape and 500 a
    whole sources feed over one stale row.
    """
    indexless = _TOKEN_TO_LEVEL.get(token)
    if indexless is not None:
        return (indexless, 0)
    level = _TOKEN_TO_LEVEL.get(token[:1])
    if level is None:
        raise ValueError(f"unknown reflection token: {token!r}")
    return (level, int(token[1:]))


def _validate_index(level: ReflectionLevel, index: int) -> None:
    """Raise ValueError if ``index`` is out of range for its level."""
    max_index = _LEVEL_SPECS[level].max_index
    if max_index == 0:
        return
    if not 1 <= index <= max_index:
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


def scope_cycle(key: str) -> int:
    """The cycle number a ``c<cycle>:<token>`` key belongs to.

    :func:`_parse_key` deliberately discards the prefix — scope and hierarchy
    are cycle-agnostic — but a caller that owns a program ANCHOR is not: an
    anchor belongs to exactly one cycle, so windowing a ``c1:`` key against the
    current cycle's anchor serves the wrong period's entries (issue #2886).
    This is the one accessor that reads the prefix back off the key; the
    hierarchy itself stays cycle-free. What the caller does with the answer has
    changed: it once drove a blanket refusal to serve any past cycle's raw
    material, and now selects WHICH retained anchor to window against
    (:mod:`domain.cycle_calendar`, issue #2894).

    Raises ValueError for a malformed key, exactly as :func:`scope_weeks` does.
    """
    match = _KEY_PATTERN.match(key)
    if match is None:
        raise ValueError(f"malformed reflection key: {key!r}")
    return int(match.group(1))


def _span_for(level: ReflectionLevel, index: int) -> tuple[int, int]:
    """Return the inclusive (start, end) week span for a (level, index) pair."""
    if level is ReflectionLevel.WEEK:
        return (index, index)
    if level is ReflectionLevel.STAGE:
        return _stage_week_span(index)
    if level is ReflectionLevel.SECTION:
        return _section_week_span(index)
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


def _course_child_indices() -> list[tuple[ReflectionLevel, int]]:
    """Return the course's children: its sections, then every stage none covers.

    Heterogeneous by necessity. The tail is derived from the same floor division
    ``SECTION_COUNT`` is, so a curriculum whose stage count divided evenly would
    simply produce no tail — the tenth stage standing alone is the remainder,
    not a rule written for it.
    """
    sections = [(ReflectionLevel.SECTION, n) for n in range(1, SECTION_COUNT + 1)]
    uncovered = range(SECTION_COUNT * STAGES_PER_SECTION + 1, TOTAL_STAGES + 1)
    return sections + [(ReflectionLevel.STAGE, n) for n in uncovered]


def _child_scope_indices(level: ReflectionLevel, index: int) -> list[tuple[ReflectionLevel, int]]:
    """Return a node's ``(child level, child index)`` pairs in ascending program order.

    A course decomposes into :func:`_course_child_indices`, a section into its
    three stages, and a stage into every week it spans. Ascending order is what
    keeps the caller's walk chronological.
    """
    if level is ReflectionLevel.COURSE:
        return _course_child_indices()
    if level is ReflectionLevel.SECTION:
        first_stage, last_stage = _section_stage_span(index)
        return [(ReflectionLevel.STAGE, n) for n in range(first_stage, last_stage + 1)]
    start, end = _stage_week_span(index)
    return [(ReflectionLevel.WEEK, n) for n in range(start, end + 1)]


def _child_scopes(level: ReflectionLevel, key: str) -> list[tuple[ReflectionLevel, str]]:
    """Return the (level, key) children of a node, carrying its cycle prefix."""
    prefix = key.partition(":")[0]
    _, index = _parse_key(key)
    return [
        (child_level, _key(prefix, child_level, child_index))
        for child_level, child_index in _child_scope_indices(level, index)
    ]


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
    entries belonging to this reflection's cycle. The router satisfies that by
    windowing on the anchor of the KEY's own cycle, retained across begin-again
    (issue #2894) and clamped at the instant that cycle closed, so the entries it
    hands over cannot span two laps.
    """
    parsed_level, _ = _parse_key(key)
    if parsed_level is not level:
        raise ValueError(f"level {level} does not match key {key!r}")
    lookup = _index_reflections(existing)
    by_week = _index_entries(entries)
    return _collect_sources(level, key, lookup, by_week)
