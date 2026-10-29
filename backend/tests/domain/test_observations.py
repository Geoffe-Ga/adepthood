"""Templated observations and milestone rules (#3525).

Each sentence has a test named after what it says, which doubles as its
wise-friend check: the figure, its denominator, no flattery and no comparison
to anyone but the person's own past.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from domain import observations
from domain.observations import (
    HABIT_DAY_MILESTONES,
    PRACTICE_MINUTE_MILESTONES,
    PRACTICE_SESSION_MILESTONES,
    Milestone,
    PracticeFacts,
    RhythmFacts,
    habit_milestones,
    habit_observations,
    practice_milestones,
    practice_observations,
    rhythm_observations,
)
from schemas.habit_story import (
    HabitStoryContinuity,
    HabitStoryDay,
    HabitStoryPatterns,
    HabitStoryRate,
    HabitStoryRates,
    HabitStoryResponse,
    HabitStoryStage,
    HabitStoryTierCounts,
    HabitStoryTierDelta,
    HabitStoryTiers,
    StoryTier,
)

START = date(2026, 5, 18)
TODAY = date(2026, 10, 24)
FORBIDDEN = ("broken", "lost", "missed", "failed", "streak", "only", "just", "level")


def _day(
    when: date, *, tier: StoryTier | None = "clear", scheduled: bool = True, logged: bool = True
) -> HabitStoryDay:
    return HabitStoryDay(
        date=when,
        units=2 if logged else 0,
        unknown_time_units=0,
        tier=tier,
        logged=logged,
        scheduled=scheduled,
        met=tier is not None,
    )


@dataclass(frozen=True)
class Shape:
    """The figures a test story varies; everything else is a quiet default."""

    days: list[HabitStoryDay] = field(default_factory=list)
    days_with: int = 90
    met: int = 90
    scheduled: int = 159
    returns: int = 9
    delta: tuple[int, int, int] = (0, 9, 6)
    weekday_units: list[float] = field(default_factory=lambda: [31, 30, 29, 34, 20, 26, 20])
    stages: list[HabitStoryStage] = field(default_factory=list)

    def story(self) -> HabitStoryResponse:
        """Build the response these figures describe."""
        rate = HabitStoryRate(met=self.met, scheduled=self.scheduled)
        zero = HabitStoryTierCounts(low=0, clear=0, stretch=0, under=0, quiet=0)
        return HabitStoryResponse(
            polarity="additive",
            cadence="day",
            unit="pages",
            start_date=START,
            today=TODAY,
            logged_days=self.days_with,
            log_count=0,
            days=self.days,
            stages=self.stages,
            continuity=HabitStoryContinuity(
                current_run=0,
                longest_run=0,
                returns=self.returns,
                days_with=self.days_with,
                unit="days",
            ),
            rates=HabitStoryRates(
                last_7=rate, last_21=rate, last_30=rate, all_time=rate, unit="days"
            ),
            tiers=HabitStoryTiers(
                totals=zero,
                weekly=[],
                last_30_delta=HabitStoryTierDelta(
                    low=self.delta[0], clear=self.delta[1], stretch=self.delta[2]
                ),
            ),
            patterns=HabitStoryPatterns(
                weekday_units=self.weekday_units,
                weekday_by_time_of_day=[[0, 0, 0, 0]] * 7,
                unknown_time_units=0,
                time_of_day_available_since=None,
            ),
            logs=[],
            observations=[],
            milestones=[],
        )


# --- habit sentences -----------------------------------------------------------


def test_you_have_kept_it_on_n_of_m_scheduled_days_and_come_back_n_times() -> None:
    even = [30.0, 31.0, 29.0, 30.0, 30.0, 32.0, 28.0]
    assert habit_observations(
        Shape(delta=(0, 0, 0), weekday_units=even).story(), "Morning pages"
    ) == [
        (
            "You have kept Morning pages on 90 of 159 scheduled days, "
            "and come back after a rest 9 times."
        )
    ]


def test_coming_back_once_or_never_reads_naturally() -> None:
    even = [30.0, 31.0, 29.0, 30.0, 30.0, 32.0, 28.0]
    once = habit_observations(
        Shape(returns=1, delta=(0, 0, 0), weekday_units=even).story(), "Morning pages"
    )
    never = habit_observations(
        Shape(returns=0, delta=(0, 0, 0), weekday_units=even).story(), "Morning pages"
    )
    assert once == [
        "You have kept Morning pages on 90 of 159 scheduled days, and come back after a rest once."
    ]
    assert never == ["You have kept Morning pages on 90 of 159 scheduled days."]


def test_in_the_last_thirty_days_you_reached_clear_or_beyond_on_more_days() -> None:
    sentences = habit_observations(Shape().story(), "Morning pages")
    assert sentences[1] == (
        "In the last thirty days you reached Clear or beyond on 15 more days "
        "than in the thirty before."
    )


def test_the_deepening_sentence_is_withheld_without_a_gain() -> None:
    sentences = habit_observations(Shape(delta=(4, -2, 1)).story(), "Morning pages")
    assert all("Clear or beyond" not in sentence for sentence in sentences)


def test_you_log_most_pages_on_sundays_once_a_day_is_a_quarter_above_the_mean() -> None:
    leaning = Shape(delta=(0, 0, 0), weekday_units=[10, 10, 10, 10, 10, 10, 40]).story()
    assert habit_observations(leaning, "Morning pages")[1] == "You log most pages on Sundays."
    # The issue's example week: Thursday's 34 is 25.3% above the mean of 27.1, so it
    # clears the threshold the rule states (the issue's prose miscounted the mean).
    example = Shape(delta=(0, 0, 0)).story()
    assert habit_observations(example, "Morning pages")[1] == "You log most pages on Thursdays."


def test_the_weekday_sentence_is_withheld_for_an_even_week() -> None:
    even = Shape(delta=(0, 0, 0), weekday_units=[30, 31, 29, 30, 30, 32, 28]).story()
    assert habit_observations(even, "Morning pages") == [
        (
            "You have kept Morning pages on 90 of 159 scheduled days, "
            "and come back after a rest 9 times."
        )
    ]


def test_early_days_name_the_days_and_how_deep_they_went() -> None:
    days = [_day(START + timedelta(days=offset)) for offset in range(3)] + [
        _day(START + timedelta(days=3), tier="low")
    ]
    early = Shape(days=days, days_with=4, met=4, scheduled=4, returns=0).story()
    assert habit_observations(early, "Evening stretch") == [
        (
            "Four days of Evening stretch, three of them to Clear or beyond. "
            "The grid fills in as the days do."
        )
    ]


def test_an_empty_history_gets_the_early_days_sentence() -> None:
    empty = Shape(days_with=0, met=0, scheduled=0, returns=0, delta=(0, 0, 0)).story()
    assert habit_observations(empty, "Evening stretch") == [
        "No days of Evening stretch yet. The grid fills in as the days do."
    ]


def test_one_early_day_is_singular() -> None:
    early = Shape(
        days=[_day(START, tier="low")], days_with=1, met=1, scheduled=1, returns=0
    ).story()
    assert habit_observations(early, "Evening stretch") == [
        "One day of Evening stretch. The grid fills in as the days do."
    ]


def test_at_most_three_sentences() -> None:
    full = Shape(weekday_units=[10, 10, 10, 10, 10, 10, 40]).story()
    assert len(habit_observations(full, "Morning pages")) == observations.MAX_OBSERVATIONS


# --- habit milestones ----------------------------------------------------------


def _run(
    start: date,
    length: int,
    *,
    tier: StoryTier | None = "clear",
    scheduled: bool = True,
    logged: bool = True,
) -> list[HabitStoryDay]:
    return [
        _day(start + timedelta(days=offset), tier=tier, scheduled=scheduled, logged=logged)
        for offset in range(length)
    ]


def test_days_with_milestones_are_dated_the_day_they_were_reached() -> None:
    days = _run(START, 25)
    found = habit_milestones(Shape(days=days).story(), period_of=lambda day: day)
    assert [m for m in found if m.kind == "days_with"] == [
        Milestone("days_with", START + timedelta(days=6), 7),
        Milestone("days_with", START + timedelta(days=20), 21),
    ]
    assert HABIT_DAY_MILESTONES == (7, 21, 100)


def test_a_period_cadence_counts_each_kept_week_once() -> None:
    days = _run(START, 7 * 8)
    found = habit_milestones(
        Shape(days=days).story(), period_of=lambda day: day - timedelta(days=day.weekday())
    )
    assert [m.value for m in found if m.kind == "days_with"] == [7]


def test_first_stretch_day_is_marked_once() -> None:
    days = [*_run(START, 3), _day(START + timedelta(days=3), tier="stretch")]
    days.append(_day(START + timedelta(days=4), tier="stretch"))
    found = habit_milestones(Shape(days=days).story(), period_of=lambda day: day)
    assert [m for m in found if m.kind == "first_stretch"] == [
        Milestone("first_stretch", START + timedelta(days=3), 1)
    ]


def test_a_return_after_a_rest_of_seven_scheduled_days_carries_the_rest_length() -> None:
    days = [
        *_run(START, 3),
        *_run(START + timedelta(days=3), 12, tier=None, logged=False),
        *_run(START + timedelta(days=15), 2),
        *_run(START + timedelta(days=17), 3, tier=None, logged=False),
        *_run(START + timedelta(days=20), 1),
    ]
    found = habit_milestones(Shape(days=days).story(), period_of=lambda day: day)
    assert [m for m in found if m.kind == "return"] == [
        Milestone("return", START + timedelta(days=15), 12)
    ]


def test_unscheduled_days_do_not_count_as_rest() -> None:
    days = [
        *_run(START, 2),
        *_run(START + timedelta(days=2), 10, tier=None, logged=False, scheduled=False),
        *_run(START + timedelta(days=12), 1),
    ]
    found = habit_milestones(Shape(days=days).story(), period_of=lambda day: day)
    assert [m for m in found if m.kind == "return"] == []


def test_a_stage_kept_on_two_days_in_three_is_marked_when_it_closes() -> None:
    kept = [*_run(START, 14), *_run(START + timedelta(days=14), 7, tier=None, logged=False)]
    thin = [*_run(START + timedelta(days=21), 13), *_run(START + timedelta(days=34), 8, tier=None)]
    stages = [
        HabitStoryStage(stage_number=1, opens_on=START, closes_on=START + timedelta(days=20)),
        HabitStoryStage(
            stage_number=2,
            opens_on=START + timedelta(days=21),
            closes_on=START + timedelta(days=41),
        ),
        HabitStoryStage(stage_number=3, opens_on=TODAY, closes_on=TODAY + timedelta(days=20)),
    ]
    found = habit_milestones(
        Shape(days=kept + thin, stages=stages).story(), period_of=lambda day: day
    )
    assert [m for m in found if m.kind == "stage_complete"] == [
        Milestone("stage_complete", START + timedelta(days=20), 1)
    ]


def test_milestones_come_back_in_date_order() -> None:
    days = [*_run(START, 8), _day(START + timedelta(days=8), tier="stretch")]
    found = habit_milestones(Shape(days=days).story(), period_of=lambda day: day)
    assert [m.reached_on for m in found] == sorted(m.reached_on for m in found)


# --- practice ------------------------------------------------------------------


FACTS = PracticeFacts(
    total_minutes=600.0,
    total_sessions=20,
    stage_ask_minutes=45.0,
    stage_average_minutes=38.0,
    time_of_day={"dawn": 9, "day": 5, "dusk": 4, "night": 2},
    stage_name="Teal",
)


def test_ten_hours_of_practice_across_twenty_sits() -> None:
    assert practice_observations(FACTS)[0] == "10 hours of practice across 20 sits."


def test_teal_asks_for_45_minutes_your_sits_this_stage_average_38() -> None:
    assert practice_observations(FACTS)[1] == (
        "Teal asks for 45 minutes; your sits this stage average 38."
    )


def test_dawn_holds_nine_of_your_twenty_sits() -> None:
    assert practice_observations(FACTS)[2] == "Dawn holds 9 of your 20 sits."


def test_time_of_day_is_withheld_below_two_in_five() -> None:
    spread = replace(FACTS, time_of_day={"dawn": 6, "day": 5, "dusk": 5, "night": 4})
    assert all("holds" not in sentence for sentence in practice_observations(spread))


def test_minutes_under_an_hour_and_a_single_sit_read_naturally() -> None:
    assert practice_observations(
        replace(
            FACTS,
            total_minutes=25.0,
            total_sessions=1,
            stage_average_minutes=None,
            time_of_day={"dawn": 1, "day": 0, "dusk": 0, "night": 0},
        )
    ) == ["25 minutes of practice across 1 sit.", "Dawn holds 1 of your 1 sit."]
    assert practice_observations(replace(FACTS, total_minutes=95.0))[0] == (
        "1 hour 35 minutes of practice across 20 sits."
    )


def test_an_empty_practice_gets_its_first_sit_sentence() -> None:
    empty = replace(
        FACTS,
        total_minutes=0.0,
        total_sessions=0,
        stage_average_minutes=None,
        time_of_day={"dawn": 0, "day": 0, "dusk": 0, "night": 0},
    )
    assert practice_observations(empty) == [
        "No sits recorded yet. The record starts with the first one."
    ]


def test_practice_milestones_mark_minutes_and_sits_on_their_days() -> None:
    start = datetime(2026, 9, 1, 7, tzinfo=UTC)
    sits = [(start + timedelta(days=offset), 30.0) for offset in range(55)]
    found = practice_milestones(sits, tz="UTC")
    assert PRACTICE_MINUTE_MILESTONES == (60, 600, 3000)
    assert PRACTICE_SESSION_MILESTONES == (10, 50, 100)
    assert found == [
        Milestone("practice_minutes", date(2026, 9, 2), 60),
        Milestone("practice_sessions", date(2026, 9, 10), 10),
        Milestone("practice_minutes", date(2026, 9, 20), 600),
        Milestone("practice_sessions", date(2026, 10, 20), 50),
    ]


def test_practice_milestones_use_the_local_calendar() -> None:
    late = datetime(2026, 9, 2, 6, 30, tzinfo=UTC)  # 23:30 on Sep 1 in Los Angeles
    found = practice_milestones([(late, 60.0)], tz="America/Los_Angeles")
    assert found == [Milestone("practice_minutes", date(2026, 9, 1), 60)]


# --- rhythm --------------------------------------------------------------------


def test_your_fullest_week_was_late_june_you_rested_and_have_been_rising() -> None:
    facts = RhythmFacts(
        fullest_week_ending=date(2026, 6, 26),
        longest_rest=(date(2026, 8, 3), date(2026, 8, 24)),
        rising_since=date(2026, 9, 14),
        series_days=150,
    )
    assert rhythm_observations(facts, today=TODAY) == [
        (
            "Your fullest week was late June. You rested from 3 August to 24 August. "
            "You have been rising since 14 September."
        )
    ]


def test_a_date_in_another_year_names_the_year() -> None:
    facts = RhythmFacts(
        fullest_week_ending=date(2025, 11, 5),
        longest_rest=None,
        rising_since=None,
        series_days=400,
    )
    assert rhythm_observations(facts, today=TODAY) == ["Your fullest week was early November 2025."]


def test_a_young_rhythm_says_when_it_takes_shape() -> None:
    facts = RhythmFacts(None, None, None, series_days=9)
    assert rhythm_observations(facts, today=TODAY) == [
        "Your rhythm takes shape after four weeks of days."
    ]


def test_an_old_rhythm_without_facts_says_nothing() -> None:
    assert rhythm_observations(RhythmFacts(None, None, None, series_days=60), today=TODAY) == []


# --- the wise-friend sweep -----------------------------------------------------


def _all_sentences() -> list[str]:
    stretch_week = [*_run(START, 3), _day(START + timedelta(days=3), tier="low")]
    stories = [
        Shape(weekday_units=[10, 10, 10, 10, 10, 10, 40]).story(),
        Shape(days=stretch_week, days_with=4, met=4, scheduled=4, returns=0).story(),
        Shape(days_with=0, met=0, scheduled=0, returns=0, delta=(0, 0, 0)).story(),
    ]
    rhythm = RhythmFacts(
        date(2026, 6, 26), (date(2026, 8, 3), date(2026, 8, 24)), date(2026, 9, 14), 150
    )
    return [
        *(sentence for story in stories for sentence in habit_observations(story, "Pages")),
        *practice_observations(FACTS),
        *practice_observations(replace(FACTS, total_minutes=0.0, total_sessions=0)),
        *rhythm_observations(rhythm, today=TODAY),
        *rhythm_observations(RhythmFacts(None, None, None, 3), today=TODAY),
    ]


def _module_literals() -> list[str]:
    tree = ast.parse(Path(observations.__file__).read_text(encoding="utf-8"))
    docstrings = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Module | ast.FunctionDef | ast.ClassDef)
        and node.body
        and isinstance(node.body[0], ast.Expr)
    }
    return [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
    ]


@pytest.mark.parametrize("word", FORBIDDEN)
def test_no_sentence_or_template_says_a_forbidden_word(word: str) -> None:
    pattern = re.compile(rf"\b{word}\b", re.IGNORECASE)
    assert not [text for text in _all_sentences() if pattern.search(text)]
    assert not [text for text in _module_literals() if pattern.search(text)]


def test_no_sentence_compares_the_person_to_anyone_else() -> None:
    others = re.compile(
        r"\b(others|other people|everyone|average user|most people|users)\b", re.IGNORECASE
    )
    assert not [text for text in _all_sentences() if others.search(text)]
