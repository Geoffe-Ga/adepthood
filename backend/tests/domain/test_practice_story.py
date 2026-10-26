"""Practice Story keeps every figure on the positive-duration population."""

from datetime import UTC, date, datetime, timedelta

import pytest

from domain.practice_story import PracticeStageScope, build_practice_story
from models.practice_session import PracticeSession


def _session(**overrides: object) -> PracticeSession:
    """Build an unsaved session with an explicit UTC timestamp."""
    values: dict[str, object] = {
        "user_id": 1,
        "user_practice_id": 1,
        "duration_minutes": 15.0,
        "timestamp": datetime(2026, 10, 25, 12, tzinfo=UTC),
    }
    values.update(overrides)
    return PracticeSession.model_validate(values)


def test_empty_story_keeps_the_full_weekly_shape() -> None:
    """An untouched practice has a complete response, without a fictitious average."""
    story = build_practice_story(
        [], tz="UTC", stage_ask_minutes=20, stage_scope=PracticeStageScope(1)
    )

    assert story.total_minutes == 0
    assert story.total_sessions == 0
    assert len(story.weekly) == 8
    assert all(week.count == 0 and week.week_start.weekday() == 0 for week in story.weekly)
    assert story.weekly_target == 4
    assert story.stage_ask_minutes == 20
    assert story.stage_average_minutes is None
    assert story.first_session_on is None
    assert story.recent_sits == []
    assert story.modes == {}
    assert story.mode_totals == {}
    assert story.last_insight is None
    assert story.insight_count == story.partial_sessions == 0
    assert story.time_of_day == {"dawn": 0, "day": 0, "dusk": 0, "night": 0}


def test_positive_partials_count_and_aborts_do_not() -> None:
    """Lifetime, insights, patterns and stage average all describe the same rows."""
    rows = [
        _session(duration_minutes=0, completed=False, insight="abort"),
        _session(duration_minutes=-1, completed=False, insight="clock skew"),
        _session(duration_minutes=5, completed=False, insight="I noticed my breath."),
        _session(duration_minutes=25, user_practice_id=2),
    ]
    story = build_practice_story(
        rows, tz="UTC", stage_ask_minutes=20, stage_scope=PracticeStageScope(1)
    )

    assert story.total_sessions == 2
    assert story.total_minutes == 30
    assert story.partial_sessions == 1
    assert story.stage_average_minutes == 5
    assert story.insight_count == 1
    assert story.last_insight == "I noticed my breath."
    assert story.modes == {"meditation_timer": 2}
    assert sum(story.time_of_day.values()) == 2
    assert len(story.recent_sits) == 2


@pytest.mark.parametrize(
    ("hour", "bucket"),
    [
        (4, "night"),
        (5, "dawn"),
        (8, "dawn"),
        (9, "day"),
        (16, "day"),
        (17, "dusk"),
        (20, "dusk"),
        (21, "night"),
    ],
)
def test_time_of_day_boundaries(hour: int, bucket: str) -> None:
    """Named dawn, day, dusk and night intervals are half-open."""
    story = build_practice_story(
        [_session(timestamp=datetime(2026, 10, 25, hour, tzinfo=UTC))],
        tz="UTC",
        stage_ask_minutes=20,
        stage_scope=PracticeStageScope(1),
    )
    assert story.time_of_day[bucket] == 1


def test_pacific_night_uses_the_local_day_and_week(monkeypatch: pytest.MonkeyPatch) -> None:
    """Sunday 23:30 Pacific is still Sunday, even when UTC is already Monday."""
    monkeypatch.setattr("domain.practice_story.today_in_tz", lambda _tz: date(2026, 10, 26))
    story = build_practice_story(
        [_session(timestamp=datetime(2026, 10, 26, 6, 30, tzinfo=UTC))],
        tz="America/Los_Angeles",
        stage_ask_minutes=20,
        stage_scope=PracticeStageScope(1),
    )

    assert story.first_session_on == date(2026, 10, 25)
    assert story.time_of_day["night"] == 1
    assert story.weekly[-1].count == 0
    assert story.weekly[-2].count == 1


def test_metadata_totals_use_only_the_documented_measurements() -> None:
    """Senses are counted, numeric metadata is summed, unrelated outputs stay private."""
    rows = [
        _session(mode_metadata={"rep_count": 12, "bpm_used": 80, "senses_completed": ["sight"]}),
        _session(
            mode_metadata={
                "rep_count": 8,
                "intervals_struck": 4,
                "bells_struck": 2,
                "items_completed": 3,
                "senses_completed": ["touch", "taste"],
            }
        ),
        _session(duration_minutes=0, mode_metadata={"rep_count": 100}),
    ]
    story = build_practice_story(
        rows, tz="UTC", stage_ask_minutes=20, stage_scope=PracticeStageScope(1)
    )

    assert story.mode_totals == {
        "rep_count": 20,
        "intervals_struck": 4,
        "bells_struck": 2,
        "items_completed": 3,
        "senses_completed": 3,
    }


def test_last_thirty_sits_are_chronological_without_truncating_lifetime() -> None:
    """Recent marks are bounded, while lifetime figures and older insights remain."""
    first = datetime(2026, 1, 1, tzinfo=UTC)
    rows = [_session(timestamp=first + timedelta(days=index)) for index in range(35)]
    rows[0].insight = "An earlier observation."
    rows.reverse()
    story = build_practice_story(
        rows, tz="UTC", stage_ask_minutes=20, stage_scope=PracticeStageScope(1)
    )

    assert story.total_sessions == 35
    assert len(story.recent_sits) == 30
    assert story.recent_sits[0].timestamp == first + timedelta(days=5)
    assert story.recent_sits[-1].timestamp == first + timedelta(days=34)
    assert story.last_insight == "An earlier observation."
    assert story.first_session_on == first.date()


def test_naive_sqlite_timestamps_and_unknown_timezone_are_supported() -> None:
    """SQLite's naive UTC timestamps and a legacy bad timezone cannot crash the Story."""
    story = build_practice_story(
        [_session(timestamp=datetime(2026, 10, 25, 12, tzinfo=UTC).replace(tzinfo=None))],
        tz="not/a/timezone",
        stage_ask_minutes=20,
        stage_scope=PracticeStageScope(2),
    )
    assert story.time_of_day["day"] == 1
    assert story.recent_sits[0].timestamp.tzinfo is not None
    assert story.stage_average_minutes is None


def test_stage_window_is_half_open_and_can_include_sibling_adoptions() -> None:
    """Calendar bounds, rather than the adoption id, decide a known stage's population."""
    start = datetime(2026, 10, 1, tzinfo=UTC)
    end = start + timedelta(days=21)
    rows = [
        _session(timestamp=start - timedelta(seconds=1), duration_minutes=100),
        _session(timestamp=start, duration_minutes=5, completed=False, user_practice_id=2),
        _session(timestamp=end - timedelta(seconds=1), duration_minutes=15),
        _session(timestamp=end, duration_minutes=100),
    ]
    story = build_practice_story(
        rows, tz="UTC", stage_ask_minutes=20, stage_scope=PracticeStageScope(1, (start, end))
    )
    assert story.stage_session_count == 2
    assert story.stage_average_minutes == 10
    assert story.stage_partial_sessions == 1
    assert story.total_sessions == 4


def test_malformed_metadata_cannot_turn_flags_or_strings_into_counts() -> None:
    """Only numeric measurements contribute, even when legacy JSON was malformed."""
    story = build_practice_story(
        [
            _session(
                mode_metadata={"rep_count": True, "bells_struck": "12", "senses_completed": "sight"}
            )
        ],
        tz="UTC",
        stage_ask_minutes=20,
        stage_scope=PracticeStageScope(1),
    )
    assert story.mode_totals == {}
