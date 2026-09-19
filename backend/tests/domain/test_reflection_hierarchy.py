"""Pure-domain tests for the multi-level reflection due-date and source hierarchy.

Pinned public surface:
  ReflectionLevel(StrEnum): week, stage, section, course
  SourceKind(StrEnum): reflection, entry
  DueReflection(level, key, week) -- frozen dataclass
  ReflectionRef(id, level, key, week) -- frozen dataclass
  EntryRef(id, week, date) -- frozen dataclass
  SourceItem(kind, id, week, level=None, key=None) -- frozen dataclass
  due_reflection(anchor, now=None, cycle=1) -> DueReflection | None
  scope_weeks(level, key) -> range
  resolve_sources(level, key, existing, entries) -> list[SourceItem]

Program shape: ten stages (``domain.constants.STAGE_DURATIONS_DAYS``) group in
threes into three *sections* (stages ``3n-2``..``3n``); the tenth stage falls
outside every section and closes the *course* on its own. A key is
``"c{cycle}:{token}"`` where token is ``w<week>``, ``s<stage>``, ``x<section>``
or the index-free ``course``.

The cadence is stage-local (issue #2866): inside a stage a review comes due on
every seventh day, on the day BEFORE the stage closes (that stage's final week
gets its own review), and on the stage's closing day itself -- which is a plain
STAGE review, a SECTION review every third stage, and the COURSE review at the
tenth. Forty-six review days across the 252-day program: 36 weekly, 6 stage, 3
section, 1 course.
"""

from __future__ import annotations

from collections import Counter
from datetime import UTC, date, datetime, timedelta

import pytest

from domain.constants import (
    SECTION_COUNT,
    STAGE_DURATIONS_DAYS,
    STAGES_PER_SECTION,
    TOTAL_PROGRAM_DAYS,
    TOTAL_STAGES,
)
from domain.reflection_hierarchy import (
    _KEY_PATTERN,
    DueReflection,
    EntryRef,
    ReflectionLevel,
    ReflectionRef,
    SourceItem,
    SourceKind,
    _key,
    _token_to_level_index,
    due_reflection,
    resolve_sources,
    scope_cycle,
    scope_weeks,
)
from domain.weekly_prompts import TOTAL_WEEKS

_DAYS_PER_WEEK = 7
_ANCHOR = datetime(2026, 1, 5, tzinfo=UTC)

# Stages group in threes into sections; the leftover tenth stage closes the
# course on its own. That shape is what is under test here, so the expected
# section spans below are re-derived from the duration schedule rather than
# borrowed from the module they check.
_STAGES_PER_SECTION = 3


def _stage_week_span(stage_number: int) -> tuple[int, int]:
    """Derive the inclusive (start, end) program-week span for a stage."""
    week = 1
    for index, duration_days in enumerate(STAGE_DURATIONS_DAYS, start=1):
        span_weeks = duration_days // _DAYS_PER_WEEK
        end = week + span_weeks - 1
        if index == stage_number:
            return (week, end)
        week = end + 1
    raise ValueError(stage_number)


def _section_week_span(section_number: int) -> tuple[int, int]:
    """Derive the inclusive (start, end) program-week span for a section."""
    last_stage = _STAGES_PER_SECTION * section_number
    first_stage = last_stage - _STAGES_PER_SECTION + 1
    return (_stage_week_span(first_stage)[0], _stage_week_span(last_stage)[1])


def _stage_close_day(stage_number: int) -> datetime:
    """The instant that is the final day of ``stage_number``, from the anchor."""
    return _ANCHOR + timedelta(days=sum(STAGE_DURATIONS_DAYS[:stage_number]) - 1)


def _stage_day(stage_number: int, day_in_stage: int) -> datetime:
    """The instant that is 1-based ``day_in_stage`` of ``stage_number``."""
    opened = sum(STAGE_DURATIONS_DAYS[: stage_number - 1])
    return _ANCHOR + timedelta(days=opened + day_in_stage - 1)


def _end_of_week(week: int) -> datetime:
    """The instant that is day 7 of program week ``week``, from the anchor."""
    return _ANCHOR + timedelta(days=_DAYS_PER_WEEK * week - 1)


def _week_entries(week: int) -> list[EntryRef]:
    """Build the seven raw daily EntryRefs for one program week, date-ordered."""
    base = date(2026, 1, 1) + timedelta(days=(week - 1) * _DAYS_PER_WEEK)
    return [
        EntryRef(id=week * 10 + day, week=week, date=base + timedelta(days=day))
        for day in range(_DAYS_PER_WEEK)
    ]


def _reflection_ref(ref_id: int, level: ReflectionLevel, key: str, week: int) -> ReflectionRef:
    """Build a completed ReflectionRef with the given identity fields."""
    return ReflectionRef(id=ref_id, level=level, key=key, week=week)


def _entry_items(entries: list[EntryRef]) -> list[SourceItem]:
    """Wrap raw EntryRefs as the ENTRY SourceItems resolve_sources should emit."""
    return [SourceItem(kind=SourceKind.ENTRY, id=entry.id, week=entry.week) for entry in entries]


def _reflection_item(ref: ReflectionRef) -> SourceItem:
    """Wrap a ReflectionRef as the REFLECTION SourceItem resolve_sources should emit."""
    return SourceItem(
        kind=SourceKind.REFLECTION, id=ref.id, week=ref.week, level=ref.level, key=ref.key
    )


# ---------------------------------------------------------------------------
# Program shape sanity
# ---------------------------------------------------------------------------


def test_program_constants_pin_curriculum_shape() -> None:
    """The reflection hierarchy is built on ten stages summing to 36 weeks."""
    assert len(STAGE_DURATIONS_DAYS) == TOTAL_STAGES
    assert TOTAL_WEEKS == 36
    assert sum(duration // _DAYS_PER_WEEK for duration in STAGE_DURATIONS_DAYS) == TOTAL_WEEKS


def test_the_final_stage_falls_outside_every_section_as_a_remainder() -> None:
    """Sections tile the stages in threes; the leftover stage is the remainder.

    ``SECTION_COUNT`` is floor division, so the tenth stage being section-less
    is a CONSEQUENCE of the shape rather than a third hand-written constant.
    Guarding it here is what stops someone "fixing" the arithmetic into a
    fourth, one-stage section.
    """
    assert STAGES_PER_SECTION == _STAGES_PER_SECTION
    assert SECTION_COUNT == TOTAL_STAGES // STAGES_PER_SECTION
    assert SECTION_COUNT * STAGES_PER_SECTION < TOTAL_STAGES


# ---------------------------------------------------------------------------
# due_reflection -- mid-week and clock-skew short-circuits
# ---------------------------------------------------------------------------


def test_due_reflection_mid_week_day_one_is_none() -> None:
    """Day 1 of a program week (day_in_week=1) is never a due day."""
    assert due_reflection(_ANCHOR, now=_ANCHOR) is None


@pytest.mark.parametrize("day_in_stage", [1, 2, 3, 4, 5, 6, 8, 13, 15, 19])
def test_due_reflection_quiet_days_of_a_three_week_stage_are_none(day_in_stage: int) -> None:
    """A 21-day stage is due on days 7, 14, 20 and 21 -- and on no other day."""
    assert due_reflection(_ANCHOR, now=_stage_day(1, day_in_stage)) is None


@pytest.mark.parametrize("day_in_stage", [7, 14, 20, 21])
def test_due_reflection_the_four_due_days_of_a_three_week_stage(day_in_stage: int) -> None:
    """The same 21-day stage IS due on each of its four review days."""
    assert due_reflection(_ANCHOR, now=_stage_day(1, day_in_stage)) is not None


@pytest.mark.parametrize("day_in_stage", [7, 14, 21, 28, 35, 41, 42])
def test_due_reflection_the_seven_due_days_of_a_six_week_stage(day_in_stage: int) -> None:
    """A 42-day stage is due on days 7, 14, 21, 28, 35 (weeks), 41 and 42."""
    assert due_reflection(_ANCHOR, now=_stage_day(9, day_in_stage)) is not None


@pytest.mark.parametrize("day_in_stage", [1, 6, 8, 20, 22, 34, 36, 40])
def test_due_reflection_quiet_days_of_a_six_week_stage_are_none(day_in_stage: int) -> None:
    """Every other day of that 42-day stage is quiet -- no per-stage literal."""
    assert due_reflection(_ANCHOR, now=_stage_day(9, day_in_stage)) is None


def test_due_reflection_day_before_a_stage_closes_is_that_stages_last_weekly_review() -> None:
    """A stage's final week gets its own review the day BEFORE the stage closes.

    Without this the final week of every stage would never be keyed at all --
    its seventh day is the stage's closing day, which resolves upward.
    """
    day_before_close = _stage_day(1, STAGE_DURATIONS_DAYS[0] - 1)
    assert due_reflection(_ANCHOR, now=day_before_close) == DueReflection(
        ReflectionLevel.WEEK, "c1:w3", 3
    )


def test_due_reflection_day_before_a_six_week_stage_closes_keys_its_sixth_week() -> None:
    """The same rule on a 42-day stage keys week 30, not week 29."""
    day_before_close = _stage_day(9, STAGE_DURATIONS_DAYS[8] - 1)
    assert due_reflection(_ANCHOR, now=day_before_close) == DueReflection(
        ReflectionLevel.WEEK, "c1:w30", 30
    )


def test_due_reflection_mid_week_day_four_is_none() -> None:
    """Day 4 of a program week (day_in_week=4) is never a due day."""
    assert due_reflection(_ANCHOR, now=_ANCHOR + timedelta(days=3)) is None


def test_due_reflection_now_before_anchor_is_none() -> None:
    """Clock skew that puts ``now`` before the anchor never reports due."""
    assert due_reflection(_ANCHOR, now=_ANCHOR - timedelta(days=1)) is None


# ---------------------------------------------------------------------------
# due_reflection -- plain week ends
# ---------------------------------------------------------------------------


def test_due_reflection_end_of_week_one_is_plain_week() -> None:
    """The end of week 1 is due at the plain WEEK level."""
    result = due_reflection(_ANCHOR, now=_end_of_week(1))
    assert result == DueReflection(ReflectionLevel.WEEK, "c1:w1", 1)


def test_due_reflection_end_of_week_twenty_seven_is_plain_week() -> None:
    """Week 27 sits mid-stage-9, so it is due at the plain WEEK level."""
    result = due_reflection(_ANCHOR, now=_end_of_week(27))
    assert result == DueReflection(ReflectionLevel.WEEK, "c1:w27", 27)


def test_due_reflection_end_of_week_thirty_three_is_plain_week() -> None:
    """Week 33 sits mid-stage-10, so it is due at the plain WEEK level."""
    result = due_reflection(_ANCHOR, now=_end_of_week(33))
    assert result == DueReflection(ReflectionLevel.WEEK, "c1:w33", 33)


# ---------------------------------------------------------------------------
# due_reflection -- stage ends (odd-numbered stages, not absorbed upward)
# ---------------------------------------------------------------------------


def test_due_reflection_end_of_week_three_is_stage_one() -> None:
    """Week 3 closes stage 1 (odd), so STAGE outranks the plain week."""
    result = due_reflection(_ANCHOR, now=_end_of_week(3))
    assert result == DueReflection(ReflectionLevel.STAGE, "c1:s1", 3)


def test_due_reflection_end_of_week_nine_is_section_one() -> None:
    """Week 9 closes stage 3, the third stage -- so SECTION outranks STAGE."""
    result = due_reflection(_ANCHOR, now=_end_of_week(9))
    assert result == DueReflection(ReflectionLevel.SECTION, "c1:x1", 9)
    assert result is not None
    assert result.key != "c1:s3"


def test_due_reflection_end_of_week_thirty_is_section_three() -> None:
    """Week 30 closes the six-week stage 9 -- the ninth stage, so SECTION again."""
    result = due_reflection(_ANCHOR, now=_end_of_week(30))
    assert result == DueReflection(ReflectionLevel.SECTION, "c1:x3", 30)
    assert result is not None
    assert result.key != "c1:s9"


# ---------------------------------------------------------------------------
# due_reflection -- every stage now closes with a review of its own
# ---------------------------------------------------------------------------


def test_due_reflection_end_of_week_six_is_stage_two() -> None:
    """Week 6 closes stage 2, which under the old cadence had no review at all."""
    result = due_reflection(_ANCHOR, now=_end_of_week(6))
    assert result == DueReflection(ReflectionLevel.STAGE, "c1:s2", 6)
    assert result is not None
    assert result.level is not ReflectionLevel.WEEK


def test_due_reflection_end_of_week_twenty_four_is_stage_eight() -> None:
    """Week 24 closes stage 8 -- an even stage, and not a third one, so STAGE."""
    result = due_reflection(_ANCHOR, now=_end_of_week(24))
    assert result == DueReflection(ReflectionLevel.STAGE, "c1:s8", 24)


@pytest.mark.parametrize("stage_number", [2, 4, 5, 7, 8])
def test_due_reflection_every_non_section_stage_closes_with_its_own_stage_review(
    stage_number: int,
) -> None:
    """Stages 2, 4, 5, 7 and 8 each key ``s{n}`` on their closing day.

    Under the retired cadence only the odd stages 1, 3, 5, 7, 9 were ever
    reachable, and 3 and 9 were absorbed upward -- so five of these six stage
    reviews could never be offered.
    """
    result = due_reflection(_ANCHOR, now=_stage_close_day(stage_number))
    assert result is not None
    assert (result.level, result.key) == (ReflectionLevel.STAGE, f"c1:s{stage_number}")


# ---------------------------------------------------------------------------
# due_reflection -- section and course precedence
# ---------------------------------------------------------------------------


def test_due_reflection_end_of_week_eighteen_is_section_two_not_stage_six() -> None:
    """Week 18 closes stage 6; SECTION outranks the plain stage review."""
    result = due_reflection(_ANCHOR, now=_end_of_week(18))
    assert result == DueReflection(ReflectionLevel.SECTION, "c1:x2", 18)
    assert result is not None
    assert result.key != "c1:s6"


def test_due_reflection_end_of_week_thirty_six_is_course_not_stage_or_section() -> None:
    """Week 36 closes the whole course; COURSE outranks stage 10 and section 3."""
    result = due_reflection(_ANCHOR, now=_end_of_week(36))
    assert result == DueReflection(ReflectionLevel.COURSE, "c1:course", 36)
    assert result is not None
    assert result.key not in {"c1:s10", "c1:x3"}


def test_due_reflection_day_seven_past_week_thirty_six_is_none() -> None:
    """There is no week 37 -- past the curriculum's end, nothing is due."""
    assert due_reflection(_ANCHOR, now=_end_of_week(37)) is None


@pytest.mark.parametrize("days_past_the_end", [0, 1, 6, 7, 148])
def test_due_reflection_every_day_past_the_program_is_none(days_past_the_end: int) -> None:
    """Nothing is ever due again after the final day -- no clamped course close.

    ``calendar_stage`` and ``calendar_day_in_stage`` both CLAMP, so a cadence
    built on them reports *stage 10, day 42* forever and offers a course review
    every single day past the program. ``stage_position`` returns None instead,
    which is why this holds for an arbitrary day rather than only the next one.
    """
    past = _ANCHOR + timedelta(days=TOTAL_PROGRAM_DAYS + days_past_the_end)
    assert due_reflection(_ANCHOR, now=past) is None


# ---------------------------------------------------------------------------
# due_reflection -- the whole-curriculum walk (completeness, not examples)
# ---------------------------------------------------------------------------


def test_due_reflection_across_the_whole_program_keys_every_week_exactly_once() -> None:
    """Walk all 252 days: 46 review days, and every one of the 36 weeks keyed once.

    This is the test that proves the change is COMPLETE rather than merely
    right on the examples. At HEAD only 26 of the 36 weeks were ever keyed and
    the reachable stage keys were exactly ``{s1, s3, s5, s7, s9}``.
    """
    due = [
        result
        for day in range(TOTAL_PROGRAM_DAYS)
        if (result := due_reflection(_ANCHOR, now=_ANCHOR + timedelta(days=day))) is not None
    ]

    assert len(due) == 46
    assert Counter(item.level for item in due) == {
        ReflectionLevel.WEEK: TOTAL_WEEKS,
        ReflectionLevel.STAGE: 6,
        ReflectionLevel.SECTION: SECTION_COUNT,
        ReflectionLevel.COURSE: 1,
    }
    week_keys = [item.key for item in due if item.level is ReflectionLevel.WEEK]
    assert week_keys == [f"c1:w{n}" for n in range(1, TOTAL_WEEKS + 1)]
    assert [item.key for item in due if item.level is not ReflectionLevel.WEEK] == [
        "c1:s1",
        "c1:s2",
        "c1:x1",
        "c1:s4",
        "c1:s5",
        "c1:x2",
        "c1:s7",
        "c1:s8",
        "c1:x3",
        "c1:course",
    ]


def test_due_reflection_week_label_agrees_with_the_emitted_week_token() -> None:
    """Every emitted ``w{n}`` key's number IS the DueReflection's own week.

    The two are computed by different arithmetic -- the key from the stage-local
    day, the week from elapsed days -- so their agreement is a real claim.
    """
    for day in range(TOTAL_PROGRAM_DAYS):
        result = due_reflection(_ANCHOR, now=_ANCHOR + timedelta(days=day))
        if result is not None and result.level is ReflectionLevel.WEEK:
            assert result.key == f"c1:w{result.week}"


# ---------------------------------------------------------------------------
# due_reflection -- cycle prefixing
# ---------------------------------------------------------------------------


def test_due_reflection_cycle_two_prefixes_the_key() -> None:
    """A second cycle produces a ``c2:`` prefixed key at the same offset."""
    result = due_reflection(_ANCHOR, now=_end_of_week(1), cycle=2)
    assert result == DueReflection(ReflectionLevel.WEEK, "c2:w1", 1)


# ---------------------------------------------------------------------------
# due_reflection -- naive/aware normalization and default now
# ---------------------------------------------------------------------------


def test_due_reflection_naive_anchor_with_aware_now() -> None:
    """A naive anchor combined with an aware ``now`` still resolves correctly."""
    naive_anchor = datetime(2026, 1, 5)  # noqa: DTZ001 - deliberately naive
    result = due_reflection(naive_anchor, now=_end_of_week(1))
    assert result == DueReflection(ReflectionLevel.WEEK, "c1:w1", 1)


def test_due_reflection_default_now_end_of_week_one_is_due() -> None:
    """With ``now`` omitted, the wall clock stands in for ``now``."""
    anchor = datetime.now(UTC) - timedelta(days=6)
    result = due_reflection(anchor)
    assert result == DueReflection(ReflectionLevel.WEEK, "c1:w1", 1)


def test_due_reflection_default_now_mid_week_is_none() -> None:
    """With ``now`` omitted and only three elapsed days, nothing is due."""
    anchor = datetime.now(UTC) - timedelta(days=3)
    assert due_reflection(anchor) is None


# ---------------------------------------------------------------------------
# scope_weeks -- one range per level
# ---------------------------------------------------------------------------


def test_scope_weeks_week_level_is_a_single_week() -> None:
    """A WEEK-level key scopes to exactly that one week."""
    assert scope_weeks(ReflectionLevel.WEEK, "c1:w5") == range(5, 6)


def test_scope_weeks_stage_three_spans_its_derived_range() -> None:
    """A STAGE-level key scopes to that stage's derived week span."""
    start, end = _stage_week_span(3)
    assert scope_weeks(ReflectionLevel.STAGE, "c1:s3") == range(start, end + 1)


def test_scope_weeks_stage_nine_spans_its_derived_range() -> None:
    """Stage 9's six-week span scopes correctly too."""
    start, end = _stage_week_span(9)
    assert scope_weeks(ReflectionLevel.STAGE, "c1:s9") == range(start, end + 1)


def test_scope_weeks_stage_ten_spans_its_derived_range() -> None:
    """Stage 10's six-week span scopes correctly too."""
    start, end = _stage_week_span(10)
    assert scope_weeks(ReflectionLevel.STAGE, "c1:s10") == range(start, end + 1)


@pytest.mark.parametrize(
    ("section_number", "expected"),
    [(1, range(1, 10)), (2, range(10, 19)), (3, range(19, 31))],
)
def test_scope_weeks_section_spans_its_three_stages(section_number: int, expected: range) -> None:
    """Each SECTION-level key scopes to its three constituent stages.

    Both ends are asserted: a mutation that slips the section's FIRST stage
    leaves the end untouched, so an end-only assertion would miss it.
    """
    start, end = _section_week_span(section_number)
    assert scope_weeks(ReflectionLevel.SECTION, f"c1:x{section_number}") == range(start, end + 1)
    assert scope_weeks(ReflectionLevel.SECTION, f"c1:x{section_number}") == expected


def test_scope_weeks_course_spans_the_whole_curriculum() -> None:
    """A COURSE-level key scopes to every week, wider than any single section."""
    assert scope_weeks(ReflectionLevel.COURSE, "c1:course") == range(1, TOTAL_WEEKS + 1)
    assert len(scope_weeks(ReflectionLevel.COURSE, "c1:course")) > len(
        scope_weeks(ReflectionLevel.SECTION, "c1:x3")
    )


def test_scope_weeks_is_cycle_agnostic() -> None:
    """The scope of a level/key pair does not depend on the cycle prefix."""
    same_stage_other_cycle = scope_weeks(ReflectionLevel.STAGE, "c2:s3")
    assert same_stage_other_cycle == scope_weeks(ReflectionLevel.STAGE, "c1:s3")


# ---------------------------------------------------------------------------
# scope_weeks -- rejected inputs
# ---------------------------------------------------------------------------


def test_scope_weeks_missing_cycle_prefix_raises() -> None:
    """A key with no ``cN:`` prefix is rejected."""
    with pytest.raises(ValueError, match="malformed"):
        scope_weeks(ReflectionLevel.STAGE, "s3")


def test_scope_weeks_unknown_token_raises() -> None:
    """A key whose token does not match any known letter is rejected."""
    with pytest.raises(ValueError, match="malformed"):
        scope_weeks(ReflectionLevel.STAGE, "c1:q3")


@pytest.mark.parametrize("key", ["c1:p2", "c1:t1", "c1:prog", "c2:p5", "c1:t2", "c1:p1"])
def test_scope_weeks_rejects_every_retired_token_with_a_value_error(key: str) -> None:
    """A retired token raises ValueError from every entry point -- never KeyError.

    All three public readers of the grammar are tried, because each parses the
    key by its own route: ``scope_weeks`` and ``resolve_sources`` through
    ``_parse_key``, ``scope_cycle`` through the pattern alone.

    ``ValueError`` is load-bearing and must not be widened to ``Exception``:
    :func:`routers.reflections._parsed_reflection_ref` catches ONLY ValueError,
    so a token the regex still admits but the level table no longer knows would
    escape as ``KeyError`` and 500 ``GET /reflections/sources`` for that user --
    the exact regression this pins. Every level is tried because a single-level
    call raises for the unrelated level/token-mismatch reason and so proves
    nothing about the grammar.
    """
    for level in ReflectionLevel:
        with pytest.raises(ValueError, match="malformed reflection key"):
            scope_weeks(level, key)
        with pytest.raises(ValueError, match="malformed reflection key"):
            resolve_sources(level, key, existing=[], entries=[])
    with pytest.raises(ValueError, match="malformed reflection key"):
        scope_cycle(key)


# One logical scope, spelled five ways the OLD pattern accepted. ``\d`` is
# Unicode-aware and ``$`` matches before a trailing newline, so every one of
# these was a DISTINCT string under the partial unique index that is supposed to
# mean "one live review per scope" -- and only the canonical spelling is ever
# generated by ``_child_scopes``, so the other four became reviews no feed could
# ever reach again.
_NON_CANONICAL_WEEK_FIVE = (
    "c1:w5\n",  # trailing newline: ``$`` admits it, ``\Z`` does not
    "c1:w\u0665",  # ARABIC-INDIC DIGIT FIVE
    "c1:w\uff15",  # FULLWIDTH DIGIT FIVE
    "c1:w05",  # leading zero
    "c01:w5",  # leading zero in the cycle
)


@pytest.mark.parametrize("key", _NON_CANONICAL_WEEK_FIVE)
def test_scope_weeks_refuses_a_non_canonical_spelling_of_a_week(key: str) -> None:
    """Only ONE string may name a scope, or the unique index stops meaning anything.

    ``ix_journalentry_user_reflection_scope`` is what enforces "one live review
    per scope", and it compares STRINGS. Four extra spellings of week five were
    four extra live reviews it could not see -- each unreachable forever,
    because ``_child_scopes`` only ever generates the canonical form, and each
    invisible to ``GET /reflections/due``, which then invited the writer to
    compose week five yet again over material they had already reflected on.

    Refusing them at the grammar is what makes the index's promise true. The
    review-cadence migration canonicalises the rows that were already stored.
    """
    for level in ReflectionLevel:
        with pytest.raises(ValueError, match="malformed reflection key"):
            scope_weeks(level, key)
        with pytest.raises(ValueError, match="malformed reflection key"):
            resolve_sources(level, key, existing=[], entries=[])
    with pytest.raises(ValueError, match="malformed reflection key"):
        scope_cycle(key)


def test_scope_weeks_still_accepts_the_canonical_spelling() -> None:
    """The tightening refuses only the alternatives -- the real key still parses."""
    assert scope_weeks(ReflectionLevel.WEEK, "c1:w5") == range(5, 6)
    assert scope_cycle("c1:w5") == 1
    assert scope_cycle("c12:w5") == 12


def test_key_grammar_is_derived_from_the_level_table() -> None:
    """Every level's own index-1 key round-trips through the composed pattern.

    ``_KEY_PATTERN`` is composed FROM the level table rather than typed out, so
    this holds by construction: a level added to (or retired from) the table
    cannot leave the pattern disagreeing with it.
    """
    for level in ReflectionLevel:
        composed = _key("c1", level, 1)
        assert _KEY_PATTERN.match(composed) is not None
        assert scope_weeks(level, composed) is not None


def test_key_grammar_admits_no_token_outside_the_level_table() -> None:
    """The pattern's alternatives are exactly the table's tokens, nothing more."""
    for token in ("prog", "p2", "t1", "c1", "course2", "x", ""):
        assert _KEY_PATTERN.match(f"c1:{token}") is None


def test_an_unknown_token_letter_raises_value_error_not_key_error() -> None:
    """The token table is the single authority, and it raises ValueError.

    Indexing a plain dict here would raise ``KeyError`` for a retired letter,
    which no caller catches. Pinned directly because the regex normally screens
    these out first -- leaving the raise reachable only from here.
    """
    for token in ("p2", "t1", "z9", ""):
        with pytest.raises(ValueError, match="unknown reflection token"):
            _token_to_level_index(token)


def test_scope_weeks_out_of_range_week_raises() -> None:
    """A week number past the curriculum's end is rejected."""
    with pytest.raises(ValueError, match="out of range"):
        scope_weeks(ReflectionLevel.WEEK, "c1:w37")


def test_scope_weeks_out_of_range_stage_raises() -> None:
    """A stage number past the curriculum's end is rejected."""
    with pytest.raises(ValueError, match="out of range"):
        scope_weeks(ReflectionLevel.STAGE, "c1:s11")


def test_scope_weeks_out_of_range_section_raises() -> None:
    """A section number past the third is rejected -- there is no fourth."""
    with pytest.raises(ValueError, match="out of range"):
        scope_weeks(ReflectionLevel.SECTION, f"c1:x{SECTION_COUNT + 1}")


def test_scope_weeks_zero_indexed_section_raises() -> None:
    """Sections are 1-based; ``x0`` is not a scope, and neither is ``x00``.

    Refused one step earlier than it used to be: a zero index is now outside
    the GRAMMAR (``[1-9][0-9]*``) rather than inside it and caught by the range
    check, so the message is "malformed" rather than "out of range". The
    tightening is what stops ``x01`` and ``x1`` being two spellings of section
    one; both halves are asserted here so the refusal cannot quietly narrow to
    the single-digit case.
    """
    for key in ("c1:x0", "c1:x00", "c1:x01"):
        with pytest.raises(ValueError, match="malformed reflection key"):
            scope_weeks(ReflectionLevel.SECTION, key)


def test_scope_weeks_level_key_mismatch_raises() -> None:
    """A level argument that disagrees with the key's own token is rejected."""
    with pytest.raises(ValueError, match="does not match"):
        scope_weeks(ReflectionLevel.STAGE, "c1:w5")


# ---------------------------------------------------------------------------
# resolve_sources -- week level, sorted and scope-filtered
# ---------------------------------------------------------------------------


def test_resolve_sources_week_level_sorts_dailies_and_filters_scope() -> None:
    """WEEK-level resolution returns only that week's dailies, in date order."""
    week_five = _week_entries(5)
    order = [3, 0, 6, 1, 5, 2, 4]
    scrambled = [week_five[i] for i in order]
    entries = [*_week_entries(4), *scrambled, *_week_entries(6)]
    result = resolve_sources(ReflectionLevel.WEEK, "c1:w5", existing=[], entries=entries)
    assert result == _entry_items(week_five)


def test_resolve_sources_orders_several_pages_written_on_one_day_by_id() -> None:
    """Two entries sharing a DATE come back oldest-first, by id.

    ``EntryRef.date`` is a calendar date -- the router builds it with
    ``to_user_date`` -- so several pages a day is the ordinary case for a
    journal, and the id tie-break is the only thing ordering them. Every other
    fixture in this module gives each entry its own date, which leaves the
    tie-break unpinned: reverse it and a composer opening a week review reads
    the day's pages backwards, with nothing objecting.

    The ids are supplied out of order so the assertion is about the SORT, not
    about the input sequence.
    """
    same_day = date(2026, 2, 2)
    later = EntryRef(id=91, week=5, date=same_day)
    earlier = EntryRef(id=90, week=5, date=same_day)
    next_day = EntryRef(id=92, week=5, date=same_day + timedelta(days=1))

    result = resolve_sources(
        ReflectionLevel.WEEK, "c1:w5", existing=[], entries=[next_day, later, earlier]
    )

    assert [item.id for item in result] == [90, 91, 92]


# ---------------------------------------------------------------------------
# resolve_sources -- a skipped week inside a covered stage
# ---------------------------------------------------------------------------


def test_resolve_sources_stage_with_one_skipped_week_decomposes_only_that_week() -> None:
    """Stage 1: week 1 has a reflection, week 2 is skipped, week 3 is stage-final raw."""
    w1_ref = _reflection_ref(1, ReflectionLevel.WEEK, "c1:w1", 1)
    entries = [*_week_entries(1), *_week_entries(2), *_week_entries(3)]
    result = resolve_sources(ReflectionLevel.STAGE, "c1:s1", existing=[w1_ref], entries=entries)
    expected = [
        _reflection_item(w1_ref),
        *_entry_items(_week_entries(2)),
        *_entry_items(_week_entries(3)),
    ]
    assert result == expected


# ---------------------------------------------------------------------------
# resolve_sources -- a fully skipped stage inside a section
# ---------------------------------------------------------------------------


def test_resolve_sources_section_with_fully_skipped_stage_decomposes_deeply() -> None:
    """Section 1: stage 1 has no reflection at all, so it decomposes to 21 dailies."""
    w4_ref = _reflection_ref(1, ReflectionLevel.WEEK, "c1:w4", 4)
    w5_ref = _reflection_ref(2, ReflectionLevel.WEEK, "c1:w5", 5)
    s3_ref = _reflection_ref(3, ReflectionLevel.STAGE, "c1:s3", 9)
    entries = [week for n in range(1, 10) for week in _week_entries(n)]
    result = resolve_sources(
        ReflectionLevel.SECTION,
        "c1:x1",
        existing=[w4_ref, w5_ref, s3_ref],
        entries=entries,
    )
    expected = [
        *_entry_items(_week_entries(1)),
        *_entry_items(_week_entries(2)),
        *_entry_items(_week_entries(3)),
        _reflection_item(w4_ref),
        _reflection_item(w5_ref),
        *_entry_items(_week_entries(6)),
        _reflection_item(s3_ref),
    ]
    assert result == expected


def test_stage_review_sources_let_the_final_weekly_stand_in_for_the_closing_day() -> None:
    """Stage 1's final week now HAS its own review, and it stands in for week 3.

    The day-before rule means week 3 carries a weekly review written on program
    day 20, while the stage's own closing day is program day 21 -- inside that
    same week. The weekly's declared window runs to the end of week 3, so it
    represents day 21's dailies too and they do not appear separately. The
    module's old invariant -- "a stage's final week can never carry its own
    weekly reflection" -- is what this replaces.
    """
    w3_ref = _reflection_ref(9, ReflectionLevel.WEEK, "c1:w3", 3)
    entries = [week for n in range(1, 4) for week in _week_entries(n)]
    result = resolve_sources(ReflectionLevel.STAGE, "c1:s1", existing=[w3_ref], entries=entries)
    expected = [
        *_entry_items(_week_entries(1)),
        *_entry_items(_week_entries(2)),
        _reflection_item(w3_ref),
    ]
    assert result == expected
    assert not any(item.week == 3 and item.kind is SourceKind.ENTRY for item in result)


# ---------------------------------------------------------------------------
# resolve_sources -- a deep course chain mixing every level
# ---------------------------------------------------------------------------


def test_resolve_sources_course_level_walks_the_full_chain() -> None:
    """COURSE resolution stops early at each existing ref and recurses past each gap."""
    x1_ref = _reflection_ref(1, ReflectionLevel.SECTION, "c1:x1", 9)
    x2_ref = _reflection_ref(2, ReflectionLevel.SECTION, "c1:x2", 18)
    s8_ref = _reflection_ref(3, ReflectionLevel.STAGE, "c1:s8", 24)
    s9_ref = _reflection_ref(4, ReflectionLevel.STAGE, "c1:s9", 30)
    w31_ref = _reflection_ref(5, ReflectionLevel.WEEK, "c1:w31", 31)
    entries = [week for n in range(19, 37) for week in _week_entries(n)]
    result = resolve_sources(
        ReflectionLevel.COURSE,
        "c1:course",
        existing=[x1_ref, x2_ref, s8_ref, s9_ref, w31_ref],
        entries=entries,
    )
    expected = [
        _reflection_item(x1_ref),
        _reflection_item(x2_ref),
        *(item for n in range(19, 22) for item in _entry_items(_week_entries(n))),
        _reflection_item(s8_ref),
        _reflection_item(s9_ref),
        _reflection_item(w31_ref),
        *(item for n in range(32, 37) for item in _entry_items(_week_entries(n))),
    ]
    assert result == expected


def test_resolve_sources_course_decomposes_into_three_sections_and_the_final_stage() -> None:
    """With nothing reflected at all, the course reaches EVERY week's dailies.

    The decomposition is heterogeneous -- three sections plus the tenth stage,
    which no section covers. Run with no child reflections so every leg has to
    recurse all the way down: a seeded section ref would short-circuit before
    the final-stage leg is ever reached, and the omission would go unseen.
    """
    entries = [week for n in range(1, TOTAL_WEEKS + 1) for week in _week_entries(n)]
    result = resolve_sources(ReflectionLevel.COURSE, "c1:course", existing=[], entries=entries)
    assert result == [
        item for n in range(1, TOTAL_WEEKS + 1) for item in _entry_items(_week_entries(n))
    ]
    assert {item.week for item in result} == set(range(1, TOTAL_WEEKS + 1))


# ---------------------------------------------------------------------------
# resolve_sources -- a fully skipped section decomposes to every daily
# ---------------------------------------------------------------------------


def test_resolve_sources_section_two_fully_skipped_decomposes_to_all_dailies() -> None:
    """SECTION 2 with no lower reflection walks stages 4-6 down to weeks 10-18."""
    entries = [week for n in range(1, 19) for week in _week_entries(n)]
    result = resolve_sources(ReflectionLevel.SECTION, "c1:x2", existing=[], entries=entries)
    expected = [item for n in range(10, 19) for item in _entry_items(_week_entries(n))]
    assert result == expected


# ---------------------------------------------------------------------------
# resolve_sources -- cycle isolation and duplicate refs
# ---------------------------------------------------------------------------


def test_resolve_sources_ignores_a_reflection_ref_from_another_cycle() -> None:
    """A ``c1:`` ref never satisfies a ``c2:`` lookup -- it falls through to dailies."""
    other_cycle_ref = _reflection_ref(1, ReflectionLevel.WEEK, "c1:w5", 5)
    week_five = _week_entries(5)
    result = resolve_sources(
        ReflectionLevel.WEEK,
        "c2:w5",
        existing=[other_cycle_ref],
        entries=week_five,
    )
    assert result == _entry_items(week_five)


def test_resolve_sources_duplicate_ref_for_the_same_slot_keeps_the_first() -> None:
    """Two ReflectionRefs claiming the same (level, key) resolve deterministically."""
    first_ref = _reflection_ref(1, ReflectionLevel.WEEK, "c1:w5", 5)
    second_ref = _reflection_ref(2, ReflectionLevel.WEEK, "c1:w5", 5)
    result = resolve_sources(
        ReflectionLevel.WEEK,
        "c1:w5",
        existing=[first_ref, second_ref],
        entries=[],
    )
    assert result == [_reflection_item(first_ref)]


def test_resolve_sources_level_key_mismatch_raises() -> None:
    """A level that disagrees with the key's own token is rejected."""
    with pytest.raises(ValueError, match="does not match"):
        resolve_sources(ReflectionLevel.STAGE, "c1:w5", existing=[], entries=[])
