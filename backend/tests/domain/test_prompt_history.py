"""Past-question availability follows recorded calendar spans, never lifetime answer counts."""

from datetime import UTC, datetime, timedelta

import pytest

from domain.prompt_history import past_prompt_weeks
from models.stage_progress import StageProgress

NOW = datetime(2026, 10, 21, 12, tzinfo=UTC)


def progress(*, days: float = 0, anchors: list[str | None] | None = None) -> StageProgress:
    """A live cycle with optional retained earlier start dates."""
    return StageProgress(
        user_id=1,
        current_stage=1,
        program_started_at=NOW - timedelta(days=days),
        stage_started_at=NOW - timedelta(days=days),
        cycle_number=len(anchors or []) + 1,
        past_cycle_anchors=anchors,
    )


@pytest.mark.parametrize(("days", "expected"), [(0, 0), (6, 0), (7, 1), (251, 35), (252, 36)])
def test_live_cycle_counts_only_completed_weeks(days: int, expected: int) -> None:
    assert past_prompt_weeks(progress(days=days), NOW, "UTC") == expected


def test_no_program_has_no_dated_past_questions() -> None:
    assert past_prompt_weeks(None, NOW, "UTC") == 0


@pytest.mark.parametrize("anchor", [None, "not-a-date"])
def test_unknown_history_never_invents_a_cycle(anchor: str | None) -> None:
    assert past_prompt_weeks(progress(anchors=[anchor]), NOW, "UTC") == 0


def test_closed_early_cycle_does_not_keep_aging_after_the_restart() -> None:
    # The old cycle lasted 210 days; 21 days in the new one do not make it 231.
    prior = (NOW - timedelta(days=231)).isoformat()
    assert past_prompt_weeks(progress(days=21, anchors=[prior]), NOW, "UTC") == 30


def test_an_older_complete_cycle_keeps_all_its_questions_available() -> None:
    first = (NOW - timedelta(days=300)).isoformat()
    second = (NOW - timedelta(days=30)).isoformat()
    assert past_prompt_weeks(progress(anchors=[first, second]), NOW, "UTC") == 36


def test_a_hole_in_retained_dates_does_not_hide_a_later_recorded_cycle() -> None:
    second = (NOW - timedelta(days=70)).isoformat()
    assert past_prompt_weeks(progress(anchors=[None, second]), NOW, "UTC") == 10


def test_a_short_legacy_anchor_list_does_not_guess_missing_cycles() -> None:
    state = progress(anchors=[(NOW - timedelta(days=300)).isoformat()])
    state.cycle_number = 100_000
    assert past_prompt_weeks(state, NOW, "UTC") == 0


def test_local_midnights_define_when_a_past_week_exists() -> None:
    state = progress(days=6 + 9 / 24)
    assert past_prompt_weeks(state, NOW, "UTC") == 0
    assert past_prompt_weeks(state, NOW, "America/Los_Angeles") == 1
