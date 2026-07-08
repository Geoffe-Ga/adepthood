"""Pure-domain tests for the multi-level reflection due-date and source hierarchy.

The import of ``domain.reflection_hierarchy`` FAILs until the
implementation-specialist creates that module. That is the correct RED state
for Gate 1.

Pinned public surface:
  ReflectionLevel(StrEnum): week, stage, component, tier, program
  SourceKind(StrEnum): reflection, entry
  DueReflection(level, key, week) -- frozen dataclass
  ReflectionRef(id, level, key, week) -- frozen dataclass
  EntryRef(id, week, date) -- frozen dataclass
  SourceItem(kind, id, week, level=None, key=None) -- frozen dataclass
  due_reflection(anchor, now=None, cycle=1) -> DueReflection | None
  scope_weeks(level, key) -> range
  resolve_sources(level, key, existing, entries) -> list[SourceItem]

Program shape: ten stages (``domain.constants.STAGE_DURATIONS_DAYS``) pair up
into five components (stages 2n-1, 2n), which split into two tiers (stages
1-6 and 7-10). A key is ``"c{cycle}:{token}"`` where token is ``w<week>``,
``s<stage>``, ``p<component>``, ``t<tier>``, or ``prog``. When several levels
become due on the same day, the most encompassing one wins: program beats
tier beats component beats stage beats a plain week.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from domain.constants import STAGE_DURATIONS_DAYS, TOTAL_STAGES
from domain.reflection_hierarchy import (
    DueReflection,
    EntryRef,
    ReflectionLevel,
    ReflectionRef,
    SourceItem,
    SourceKind,
    due_reflection,
    resolve_sources,
    scope_weeks,
)
from domain.weekly_prompts import TOTAL_WEEKS

_DAYS_PER_WEEK = 7
_ANCHOR = datetime(2026, 1, 5, tzinfo=UTC)

# Components pair consecutive stages; tiers group the resulting five
# components into two halves of the curriculum. This split (six stages then
# four) is the shape under test here, not a value borrowed from elsewhere.
_TIER_1_LAST_STAGE = 6


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


def _component_week_span(component_number: int) -> tuple[int, int]:
    """Derive the inclusive (start, end) program-week span for a component."""
    first_stage = 2 * component_number - 1
    second_stage = first_stage + 1
    return (_stage_week_span(first_stage)[0], _stage_week_span(second_stage)[1])


def _tier_week_span(tier_number: int) -> tuple[int, int]:
    """Derive the inclusive (start, end) program-week span for a tier."""
    if tier_number == 1:
        return (1, _stage_week_span(_TIER_1_LAST_STAGE)[1])
    return (_stage_week_span(_TIER_1_LAST_STAGE + 1)[0], TOTAL_WEEKS)


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


# ---------------------------------------------------------------------------
# due_reflection -- mid-week and clock-skew short-circuits
# ---------------------------------------------------------------------------


def test_due_reflection_mid_week_day_one_is_none() -> None:
    """Day 1 of a program week (day_in_week=1) is never a due day."""
    assert due_reflection(_ANCHOR, now=_ANCHOR) is None


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


def test_due_reflection_end_of_week_nine_is_stage_three() -> None:
    """Week 9 closes stage 3 (odd), so STAGE outranks the plain week."""
    result = due_reflection(_ANCHOR, now=_end_of_week(9))
    assert result == DueReflection(ReflectionLevel.STAGE, "c1:s3", 9)


def test_due_reflection_end_of_week_thirty_is_stage_nine() -> None:
    """Week 30 closes the six-week stage 9 (odd), still STAGE not COMPONENT."""
    result = due_reflection(_ANCHOR, now=_end_of_week(30))
    assert result == DueReflection(ReflectionLevel.STAGE, "c1:s9", 30)


# ---------------------------------------------------------------------------
# due_reflection -- component ends (even-numbered stages)
# ---------------------------------------------------------------------------


def test_due_reflection_end_of_week_six_is_component_one() -> None:
    """Week 6 closes stage 2, completing component 1 -- COMPONENT outranks STAGE."""
    result = due_reflection(_ANCHOR, now=_end_of_week(6))
    assert result == DueReflection(ReflectionLevel.COMPONENT, "c1:p1", 6)
    assert result is not None
    assert result.level is not ReflectionLevel.STAGE


def test_due_reflection_end_of_week_twenty_four_is_component_four() -> None:
    """Week 24 closes stage 8, completing component 4."""
    result = due_reflection(_ANCHOR, now=_end_of_week(24))
    assert result == DueReflection(ReflectionLevel.COMPONENT, "c1:p4", 24)


# ---------------------------------------------------------------------------
# due_reflection -- tier and program precedence
# ---------------------------------------------------------------------------


def test_due_reflection_end_of_week_eighteen_is_tier_not_component() -> None:
    """Week 18 closes tier 1; TIER outranks the component (p3) it also closes."""
    result = due_reflection(_ANCHOR, now=_end_of_week(18))
    assert result == DueReflection(ReflectionLevel.TIER, "c1:t1", 18)
    assert result is not None
    assert result.key != "c1:p3"


def test_due_reflection_end_of_week_thirty_six_is_program_not_tier_or_component() -> None:
    """Week 36 closes the whole program; PROGRAM outranks tier 2 and component 5."""
    result = due_reflection(_ANCHOR, now=_end_of_week(36))
    assert result == DueReflection(ReflectionLevel.PROGRAM, "c1:prog", 36)
    assert result is not None
    assert result.key not in {"c1:t2", "c1:p5"}


def test_due_reflection_day_seven_past_week_thirty_six_is_none() -> None:
    """There is no week 37 -- past the curriculum's end, nothing is due."""
    assert due_reflection(_ANCHOR, now=_end_of_week(37)) is None


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


def test_scope_weeks_component_two_spans_its_derived_range() -> None:
    """A COMPONENT-level key scopes to its two constituent stages."""
    start, end = _component_week_span(2)
    assert scope_weeks(ReflectionLevel.COMPONENT, "c1:p2") == range(start, end + 1)


def test_scope_weeks_component_five_spans_its_derived_range() -> None:
    """Component 5 (the final, six-week-stage pair) scopes correctly too."""
    start, end = _component_week_span(5)
    assert scope_weeks(ReflectionLevel.COMPONENT, "c1:p5") == range(start, end + 1)


def test_scope_weeks_tier_one_spans_its_derived_range() -> None:
    """A TIER-level key scopes to its half of the curriculum."""
    start, end = _tier_week_span(1)
    assert scope_weeks(ReflectionLevel.TIER, "c1:t1") == range(start, end + 1)


def test_scope_weeks_tier_two_spans_its_derived_range() -> None:
    """Tier 2 scopes correctly too."""
    start, end = _tier_week_span(2)
    assert scope_weeks(ReflectionLevel.TIER, "c1:t2") == range(start, end + 1)


def test_scope_weeks_program_spans_the_whole_curriculum() -> None:
    """A PROGRAM-level key scopes to every week."""
    assert scope_weeks(ReflectionLevel.PROGRAM, "c1:prog") == range(1, TOTAL_WEEKS + 1)


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
        scope_weeks(ReflectionLevel.STAGE, "c1:x3")


def test_scope_weeks_out_of_range_week_raises() -> None:
    """A week number past the curriculum's end is rejected."""
    with pytest.raises(ValueError, match="out of range"):
        scope_weeks(ReflectionLevel.WEEK, "c1:w37")


def test_scope_weeks_out_of_range_stage_raises() -> None:
    """A stage number past the curriculum's end is rejected."""
    with pytest.raises(ValueError, match="out of range"):
        scope_weeks(ReflectionLevel.STAGE, "c1:s11")


def test_scope_weeks_out_of_range_component_raises() -> None:
    """A component number past the curriculum's end is rejected."""
    with pytest.raises(ValueError, match="out of range"):
        scope_weeks(ReflectionLevel.COMPONENT, "c1:p6")


def test_scope_weeks_out_of_range_tier_raises() -> None:
    """A tier number past the curriculum's end is rejected."""
    with pytest.raises(ValueError, match="out of range"):
        scope_weeks(ReflectionLevel.TIER, "c1:t3")


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
# resolve_sources -- a fully skipped stage inside a component
# ---------------------------------------------------------------------------


def test_resolve_sources_component_with_fully_skipped_stage_decomposes_deeply() -> None:
    """Component 1: stage 1 has no reflection at all, so it decomposes to 21 dailies."""
    w4_ref = _reflection_ref(1, ReflectionLevel.WEEK, "c1:w4", 4)
    w5_ref = _reflection_ref(2, ReflectionLevel.WEEK, "c1:w5", 5)
    entries = [week for n in range(1, 7) for week in _week_entries(n)]
    result = resolve_sources(
        ReflectionLevel.COMPONENT,
        "c1:p1",
        existing=[w4_ref, w5_ref],
        entries=entries,
    )
    expected = [
        *_entry_items(_week_entries(1)),
        *_entry_items(_week_entries(2)),
        *_entry_items(_week_entries(3)),
        _reflection_item(w4_ref),
        _reflection_item(w5_ref),
        *_entry_items(_week_entries(6)),
    ]
    assert result == expected


# ---------------------------------------------------------------------------
# resolve_sources -- a deep program chain mixing every level
# ---------------------------------------------------------------------------


def test_resolve_sources_program_level_walks_the_full_chain() -> None:
    """PROGRAM resolution stops early at each existing ref and recurses past each gap."""
    t1_ref = _reflection_ref(1, ReflectionLevel.TIER, "c1:t1", 18)
    p4_ref = _reflection_ref(2, ReflectionLevel.COMPONENT, "c1:p4", 24)
    s9_ref = _reflection_ref(3, ReflectionLevel.STAGE, "c1:s9", 30)
    w31_ref = _reflection_ref(4, ReflectionLevel.WEEK, "c1:w31", 31)
    entries = [week for n in range(32, 37) for week in _week_entries(n)]
    result = resolve_sources(
        ReflectionLevel.PROGRAM,
        "c1:prog",
        existing=[t1_ref, p4_ref, s9_ref, w31_ref],
        entries=entries,
    )
    expected = [
        _reflection_item(t1_ref),
        _reflection_item(p4_ref),
        _reflection_item(s9_ref),
        _reflection_item(w31_ref),
        *(item for n in range(32, 37) for item in _entry_items(_week_entries(n))),
    ]
    assert result == expected


# ---------------------------------------------------------------------------
# resolve_sources -- a fully skipped first tier decomposes to every daily
# ---------------------------------------------------------------------------


def test_resolve_sources_tier_one_fully_skipped_decomposes_to_all_dailies() -> None:
    """TIER 1 with no lower reflection walks p1-p3 down to weeks 1-18 dailies."""
    entries = [week for n in range(1, 19) for week in _week_entries(n)]
    result = resolve_sources(ReflectionLevel.TIER, "c1:t1", existing=[], entries=entries)
    expected = [item for n in range(1, 19) for item in _entry_items(_week_entries(n))]
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
