"""Tests for the program-calendar domain (issue #386).

The frontend (#384) made the date-derived calendar canonical for display:
``programWeek()`` / ``programStage()`` walk ``STAGE_DURATIONS_DAYS``
against one program-start anchor.  These tests pin the backend mirror of
that math plus the cross-stack constants contract, so server gating can
agree with what the user sees.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

from domain.constants import STAGE_DURATIONS_DAYS, TOTAL_PROGRAM_DAYS, TOTAL_STAGES
from domain.program_calendar import (
    calendar_day_in_stage,
    calendar_stage,
    calendar_week,
    elapsed_days,
    resolve_program_anchor,
)
from domain.weekly_prompts import TOTAL_WEEKS
from models.stage_progress import StageProgress

_ANCHOR = datetime(2026, 1, 1, tzinfo=UTC)
# Deterministic non-UTC offset (no ZoneInfo/tzdata/DST dependency).
_NON_UTC = timezone(timedelta(hours=-8))


def _at(days: int) -> datetime:
    """Moment ``days`` after the anchor (mid-day to dodge boundary jitter)."""
    return _ANCHOR + timedelta(days=days, hours=12)


# ── Cross-stack constants contract ──────────────────────────────────────


def test_stage_durations_mirror_the_frontend_contract() -> None:
    """One schedule, two stacks (issue #386).

    ``frontend/src/constants/program.ts`` declares
    ``STAGE_DURATIONS_DAYS = [21 x 8, 42 x 2]``.  This pins the backend copy
    to the identical literals so the two cannot drift silently; any
    schedule change must touch both files and both pins.
    """
    assert STAGE_DURATIONS_DAYS == (21, 21, 21, 21, 21, 21, 21, 21, 42, 42)
    assert len(STAGE_DURATIONS_DAYS) == TOTAL_STAGES
    assert sum(STAGE_DURATIONS_DAYS) == TOTAL_PROGRAM_DAYS
    # 252 days == exactly the 36-week curriculum.
    assert TOTAL_PROGRAM_DAYS == TOTAL_WEEKS * 7


def test_total_stages_matches_the_seeded_curriculum() -> None:
    """The curriculum seeds stages 1..10 — TOTAL_STAGES must agree.

    The previous value (36) conflated weeks with stages, letting
    ``current_stage`` advance past every real stage and schema payloads
    carry phantom stage numbers.
    """
    assert TOTAL_STAGES == 10


# ── calendar_week ───────────────────────────────────────────────────────


def test_calendar_week_boundaries() -> None:
    assert calendar_week(_ANCHOR, _at(0)) == 1
    assert calendar_week(_ANCHOR, _at(6)) == 1
    assert calendar_week(_ANCHOR, _at(7)) == 2
    assert calendar_week(_ANCHOR, _at(245)) == 36
    assert calendar_week(_ANCHOR, _at(251)) == 36


def test_calendar_week_clamps_outside_the_program() -> None:
    assert calendar_week(_ANCHOR, _at(252)) == TOTAL_WEEKS
    assert calendar_week(_ANCHOR, _at(10_000)) == TOTAL_WEEKS
    # A clock-skewed pre-anchor moment clamps to week 1, never 0/negative.
    assert calendar_week(_ANCHOR, _ANCHOR - timedelta(days=3)) == 1


def test_calendar_week_accepts_naive_anchor() -> None:
    """SQLite returns naive datetimes; the math must not raise (issue #412 class)."""
    naive_anchor = _ANCHOR.replace(tzinfo=None)
    assert calendar_week(naive_anchor, _at(7)) == 2


def test_calendar_week_uses_instant_not_wall_clock_for_non_utc_aware_now() -> None:
    """A non-UTC aware ``now`` counts elapsed days by INSTANT, not wall clock.

    2026-01-07T20:00-08:00 is the instant 2026-01-08T04:00Z: 7 elapsed days
    from the anchor by instant (week 2), even though its naive wall-clock
    reading (2026-01-07T20:00 minus 2026-01-01T00:00) is only 6 days (week 1).
    """
    now = datetime(2026, 1, 7, 20, 0, tzinfo=_NON_UTC)
    assert calendar_week(_ANCHOR, now) == 2


# ── calendar_stage ──────────────────────────────────────────────────────


def test_calendar_stage_walks_the_duration_schedule() -> None:
    assert calendar_stage(_ANCHOR, _at(0)) == 1
    assert calendar_stage(_ANCHOR, _at(20)) == 1
    assert calendar_stage(_ANCHOR, _at(21)) == 2
    assert calendar_stage(_ANCHOR, _at(167)) == 8
    assert calendar_stage(_ANCHOR, _at(168)) == 9
    assert calendar_stage(_ANCHOR, _at(209)) == 9
    assert calendar_stage(_ANCHOR, _at(210)) == 10
    assert calendar_stage(_ANCHOR, _at(251)) == 10


def test_calendar_stage_clamps_outside_the_program() -> None:
    assert calendar_stage(_ANCHOR, _at(252)) == TOTAL_STAGES
    assert calendar_stage(_ANCHOR, _at(10_000)) == TOTAL_STAGES
    assert calendar_stage(_ANCHOR, _ANCHOR - timedelta(days=3)) == 1


# ── calendar_day_in_stage ───────────────────────────────────────────────


def test_calendar_day_in_stage_is_one_based_within_the_window() -> None:
    # Stage 1 opens on the anchor day: day 1 there, day 21 at its close.
    assert calendar_day_in_stage(_ANCHOR, 1, _at(0)) == 1
    assert calendar_day_in_stage(_ANCHOR, 1, _at(20)) == 21
    # Stage 2's window starts 21 days in — that day is day 1 of stage 2.
    assert calendar_day_in_stage(_ANCHOR, 2, _at(21)) == 1
    assert calendar_day_in_stage(_ANCHOR, 2, _at(24)) == 4


def test_calendar_day_in_stage_caps_at_the_stage_duration() -> None:
    # Past a stage's window the day saturates at its duration (all open).
    assert calendar_day_in_stage(_ANCHOR, 1, _at(100)) == STAGE_DURATIONS_DAYS[0]
    # The two integration stages run 42 days.
    assert calendar_day_in_stage(_ANCHOR, 9, _at(10_000)) == STAGE_DURATIONS_DAYS[8]


def test_calendar_day_in_stage_is_non_positive_before_the_window() -> None:
    # A stage the calendar has not yet reached reads as a non-positive day,
    # so the proportional drip opens nothing there.
    assert calendar_day_in_stage(_ANCHOR, 2, _at(0)) <= 0
    assert calendar_day_in_stage(_ANCHOR, 3, _at(21)) <= 0


def test_calendar_day_in_stage_accepts_naive_anchor() -> None:
    """SQLite returns naive datetimes; the math must not raise (issue #412 class)."""
    naive_anchor = _ANCHOR.replace(tzinfo=None)
    assert calendar_day_in_stage(naive_anchor, 2, _at(21)) == 1


def test_calendar_day_in_stage_uses_instant_not_wall_clock_for_non_utc_aware_now() -> None:
    """The same instant-crossing boundary carries through to the day-in-stage math.

    See ``test_calendar_week_uses_instant_not_wall_clock_for_non_utc_aware_now``:
    7 elapsed days by instant (day 8 of stage 1) versus 6 by stripped wall
    clock (day 7).
    """
    now = datetime(2026, 1, 7, 20, 0, tzinfo=_NON_UTC)
    assert calendar_day_in_stage(_ANCHOR, 1, now) == 8


def test_calendar_math_agrees_across_naive_and_aware_utc_representations() -> None:
    """Naive, aware-UTC, and mixed inputs must agree for real UTC instants.

    Pins that unifying the naive/aware normalization changes nothing
    observable when every input already represents UTC.
    """
    naive_anchor = _ANCHOR.replace(tzinfo=None)
    naive_now = naive_anchor + timedelta(days=10)
    aware_now = naive_now.replace(tzinfo=UTC)

    assert calendar_week(naive_anchor, naive_now) == calendar_week(_ANCHOR, aware_now)
    assert calendar_week(naive_anchor, aware_now) == calendar_week(_ANCHOR, aware_now)
    assert calendar_stage(naive_anchor, naive_now) == calendar_stage(_ANCHOR, aware_now)
    assert calendar_stage(naive_anchor, aware_now) == calendar_stage(_ANCHOR, aware_now)
    assert calendar_day_in_stage(naive_anchor, 1, naive_now) == calendar_day_in_stage(
        _ANCHOR, 1, aware_now
    )
    assert calendar_day_in_stage(naive_anchor, 1, aware_now) == calendar_day_in_stage(
        _ANCHOR, 1, aware_now
    )


# ── tz-aware calendar math (local-midnight boundary) ────────────────────

_TZ_LA = "America/Los_Angeles"
# Deliberately non-midnight UTC so a UTC-date diff and a PT-date diff can
# disagree: 2026-01-01T20:00Z is still 2026-01-01 in Pacific (noon PST).
_TZ_ANCHOR = datetime(2026, 1, 1, 20, 0, tzinfo=UTC)


def test_elapsed_days_and_stage_flip_at_pacific_local_midnight() -> None:
    """The stage flips at PT local midnight, not at a UTC-timedelta floor."""
    now = datetime(2026, 1, 22, 8, 0, tzinfo=UTC)  # 2026-01-22T00:00 PST
    assert elapsed_days(_TZ_ANCHOR, now, tz=_TZ_LA) == 21
    assert calendar_stage(_TZ_ANCHOR, now, tz=_TZ_LA) == 2


def test_elapsed_days_and_stage_one_local_second_before_the_flip() -> None:
    now = datetime(2026, 1, 22, 7, 59, 59, tzinfo=UTC)  # 2026-01-21T23:59:59 PST
    assert elapsed_days(_TZ_ANCHOR, now, tz=_TZ_LA) == 20
    assert calendar_stage(_TZ_ANCHOR, now, tz=_TZ_LA) == 1


def test_calendar_stage_does_not_unlock_early_west_of_utc() -> None:
    """UTC's date has already rolled to the 22nd, but Pacific has not."""
    now = datetime(2026, 1, 22, 5, 0, tzinfo=UTC)  # 2026-01-21T21:00 PST
    assert calendar_stage(_TZ_ANCHOR, now, tz=_TZ_LA) == 1


def test_elapsed_days_defaults_to_utc_calendar_dates() -> None:
    """``tz=None`` still fixes the wall-clock-truncation mismatch, via UTC dates."""
    now = datetime(2026, 1, 22, 0, 30, tzinfo=UTC)
    assert elapsed_days(_TZ_ANCHOR, now) == 21


def test_elapsed_days_with_tz_floors_a_pre_anchor_now_at_zero() -> None:
    assert elapsed_days(_TZ_ANCHOR, _TZ_ANCHOR - timedelta(days=3), tz=_TZ_LA) == 0


def test_elapsed_days_with_tz_accepts_a_naive_anchor() -> None:
    naive_anchor = _TZ_ANCHOR.replace(tzinfo=None)
    now = datetime(2026, 1, 22, 8, 0, tzinfo=UTC)
    assert elapsed_days(naive_anchor, now, tz=_TZ_LA) == 21


def test_calendar_week_forwards_tz_to_the_local_midnight_boundary() -> None:
    now = datetime(2026, 1, 22, 8, 0, tzinfo=UTC)
    assert calendar_week(_TZ_ANCHOR, now, tz=_TZ_LA) == 4


def test_calendar_day_in_stage_forwards_tz_to_the_local_midnight_boundary() -> None:
    now = datetime(2026, 1, 22, 8, 0, tzinfo=UTC)
    assert calendar_day_in_stage(_TZ_ANCHOR, 2, now, tz=_TZ_LA) == 1


# ── resolve_program_anchor ──────────────────────────────────────────────


def test_resolve_anchor_prefers_stored_program_start() -> None:
    progress = StageProgress(
        user_id=1,
        current_stage=1,
        completed_stages=[],
        stage_started_at=_at(30),
        program_started_at=_ANCHOR,
    )
    assert resolve_program_anchor(progress) == _ANCHOR


def test_resolve_anchor_falls_back_to_stage_started_at() -> None:
    """Legacy rows (pre-migration) anchor on the per-stage timestamp."""
    progress = StageProgress(
        user_id=1,
        current_stage=1,
        completed_stages=[],
        stage_started_at=_ANCHOR,
        program_started_at=None,
    )
    assert resolve_program_anchor(progress) == _ANCHOR
