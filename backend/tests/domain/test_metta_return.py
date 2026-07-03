"""Pure-domain tests for the Metta "Return" arc sequence and eligibility.

The import of ``RETURN_TOTAL_DAYS`` and ``is_return_complete`` FAILs until the
implementation-specialist adds them to ``backend/src/domain/metta_return.py``.
That is the correct RED state for Gate 1 (warm completion state).

Eligibility is now MARK-ONLY: ``is_return_eligible(progress)`` reads solely
``progress.highest_stage_reached`` against ``RETURN_MINIMUM_STAGE``.
``current_stage`` and ``completed_stages`` no longer factor into the domain
eligibility check at all (the mark is guaranteed >= current_stage by the
monotone bump on advance plus the migration backfill, so re-deriving from
them here would be redundant). Every ``StageProgress`` constructed below for
an eligibility assertion sets ``highest_stage_reached`` explicitly. Until the
model gains that field and ``is_return_eligible`` reads it (mark-only, with
the old ``current_stage``/``completed_stages``/``cycle_number`` special-casing
removed entirely), the tests below that pin a low current_stage with a high
mark — or a high current_stage with a low mark — fail.

Pinned public surface:
  MettaFocus(StrEnum): self, benefactor, stranger, antagonist, all_beings
  ReturnWeek(week_number: int, focus: MettaFocus, title: str, framing: str)
  RETURN_SEQUENCE: tuple[ReturnWeek, ...]  (5 entries, ordered)
  RETURN_WEEK_COUNT = 5
  RETURN_MINIMUM_STAGE = 5
  DAYS_PER_WEEK = 7
  RETURN_TOTAL_DAYS = RETURN_WEEK_COUNT * DAYS_PER_WEEK  (== 35)
  is_return_eligible(progress: StageProgress | None) -> bool
  active_return_week(started_at, paused_at, now) -> int
  current_offer_episode(progress: StageProgress | None) -> str | None
  is_return_complete(started_at, paused_at, now) -> bool
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

import pytest

from domain.metta_return import (
    DAYS_PER_WEEK,
    RETURN_MINIMUM_STAGE,
    RETURN_SEQUENCE,
    RETURN_TOTAL_DAYS,
    RETURN_WEEK_COUNT,
    MettaFocus,
    ReturnWeek,
    active_return_week,
    current_offer_episode,
    is_return_complete,
    is_return_eligible,
    resumed_start,
)
from models.stage_progress import StageProgress

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


def test_return_week_count_constant_matches_sequence_length() -> None:
    """RETURN_WEEK_COUNT pins the arc to exactly five weeks."""
    assert RETURN_WEEK_COUNT == 5
    assert len(RETURN_SEQUENCE) == RETURN_WEEK_COUNT


def test_return_minimum_stage_is_orange() -> None:
    """RETURN_MINIMUM_STAGE pins eligibility to Stage 5 (Orange) or higher."""
    assert RETURN_MINIMUM_STAGE == 5


def test_days_per_week_constant() -> None:
    """DAYS_PER_WEEK pins the week-length used by active_return_week."""
    assert DAYS_PER_WEEK == 7


# ---------------------------------------------------------------------------
# RETURN_SEQUENCE shape
# ---------------------------------------------------------------------------


def test_return_sequence_has_five_entries_in_week_order() -> None:
    """Weeks are numbered 1..5 in ascending, contiguous order."""
    week_numbers = [week.week_number for week in RETURN_SEQUENCE]
    assert week_numbers == [1, 2, 3, 4, 5]


def test_return_sequence_focus_progression() -> None:
    """The owner-specified focus progression: self, benefactor, stranger, antagonist, all beings."""
    expected = [
        MettaFocus.SELF,
        MettaFocus.BENEFACTOR,
        MettaFocus.STRANGER,
        MettaFocus.ANTAGONIST,
        MettaFocus.ALL_BEINGS,
    ]
    actual = [week.focus for week in RETURN_SEQUENCE]
    assert actual == expected


def test_return_sequence_titles_and_framings_are_non_empty() -> None:
    """Every week carries a real title and framing string, not a placeholder."""
    for week in RETURN_SEQUENCE:
        assert week.title.strip() != ""
        assert week.framing.strip() != ""


# ---------------------------------------------------------------------------
# Eligibility gate for offering the Return.
# ---------------------------------------------------------------------------


def test_eligibility_none_progress_is_ineligible() -> None:
    """A user with no StageProgress row has never advanced — ineligible."""
    assert is_return_eligible(None) is False


def test_eligibility_boundary_mark_four_ineligible_mark_five_eligible() -> None:
    """The mark alone decides the boundary: 4 is ineligible, 5 (RETURN_MINIMUM_STAGE) is eligible.

    ``current_stage`` is held fixed at 1 for both rows so only the mark
    varies — proof that the boundary check reads the mark, not current_stage.
    """
    assert RETURN_MINIMUM_STAGE == 5
    below = StageProgress(
        user_id=1,
        current_stage=1,
        completed_stages=[],
        highest_stage_reached=4,
    )
    at_threshold = StageProgress(
        user_id=1,
        current_stage=1,
        completed_stages=[],
        highest_stage_reached=5,
    )
    assert is_return_eligible(below) is False
    assert is_return_eligible(at_threshold) is True


def test_eligibility_orange_burnout_mid_cycle_is_eligible() -> None:
    """Reaching Orange (mark 5) this cycle is eligible via the persisted mark."""
    progress = StageProgress(
        user_id=1,
        current_stage=5,
        completed_stages=[1, 2, 3, 4],
        highest_stage_reached=5,
    )
    assert is_return_eligible(progress) is True


def test_eligibility_persisted_high_water_mark_counts_even_at_stage_one() -> None:
    """A persisted lifetime high-water mark, not cycle_number, grants eligibility.

    A cycle-2 row whose mark was bumped to 10 by advancement (the migration
    only floors a legacy completed-prior-cycle row's mark to 5; a mark this
    high reflects further advancement since). Eligibility reads solely the
    persisted mark — ``current_stage`` and ``cycle_number`` are not
    consulted by the domain check at all.
    """
    progress = StageProgress(
        user_id=1,
        current_stage=1,
        completed_stages=[],
        cycle_number=2,
        highest_stage_reached=10,
    )
    assert is_return_eligible(progress) is True


def test_eligibility_survives_begin_again_loop_to_stage_one() -> None:
    """A begin-again loop resets current_stage to 1 but the mark survives it."""
    progress = StageProgress(
        user_id=1,
        current_stage=1,
        completed_stages=[],
        cycle_number=2,
        highest_stage_reached=10,
    )
    assert is_return_eligible(progress) is True


def test_eligibility_high_water_mark_dominates_a_lower_current_run() -> None:
    """Crux case: a prior run reached Green (mark 6), the current run burned out in Red (3).

    Current stage alone (3) sits below Blue, yet the lifetime high-water mark
    (6) makes the user eligible — eligibility is a lifetime property, not a
    per-cycle or per-current-stage one.
    """
    progress = StageProgress(
        user_id=1,
        current_stage=3,
        completed_stages=[1, 2],
        cycle_number=1,
        highest_stage_reached=6,
    )
    assert is_return_eligible(progress) is True


def test_eligibility_never_passed_blue_stays_ineligible_at_stage_four() -> None:
    """A first-run user working Blue (mark 4) has never passed it — ineligible."""
    progress = StageProgress(
        user_id=1,
        current_stage=4,
        completed_stages=[1, 2, 3],
        highest_stage_reached=4,
    )
    assert is_return_eligible(progress) is False


def test_eligibility_never_passed_blue_stays_ineligible_at_stage_one() -> None:
    """A brand-new user at stage 1 with a mark of 1 has never passed Blue — ineligible."""
    progress = StageProgress(
        user_id=1,
        current_stage=1,
        completed_stages=[],
        highest_stage_reached=1,
    )
    assert is_return_eligible(progress) is False


def test_eligibility_mark_dominates_a_lower_current_stage_read() -> None:
    """A lower current_stage is irrelevant when the persisted mark already clears the bar.

    Eligibility is mark-only: ``current_stage`` is not read at all, so a high
    mark with a low current_stage is eligible exactly like a high mark with a
    high current_stage would be.
    """
    progress = StageProgress(
        user_id=1,
        current_stage=2,
        completed_stages=[],
        highest_stage_reached=7,
    )
    assert is_return_eligible(progress) is True


def test_eligibility_completed_stages_are_not_consulted() -> None:
    """A rich completed_stages history does not by itself grant eligibility.

    Only the persisted mark matters now; a low mark stays ineligible even
    with a completed_stages array that reaches stage 5.
    """
    progress = StageProgress(
        user_id=1,
        current_stage=6,
        completed_stages=[1, 2, 3, 4, 5],
        highest_stage_reached=4,
    )
    assert is_return_eligible(progress) is False


# ---------------------------------------------------------------------------
# current_offer_episode — the per-episode key backing dismissal.
# ---------------------------------------------------------------------------


def test_current_offer_episode_none_progress_is_none() -> None:
    """No StageProgress row at all means there is no episode to key."""
    assert current_offer_episode(None) is None


def test_current_offer_episode_ineligible_progress_is_none() -> None:
    """An ineligible mark has no offer, so there is no episode key either."""
    progress = StageProgress(
        user_id=1,
        current_stage=3,
        completed_stages=[],
        cycle_number=1,
        highest_stage_reached=3,
    )
    assert current_offer_episode(progress) is None


def test_current_offer_episode_eligible_progress_returns_cycle_stage_key() -> None:
    """An eligible progress row keys the episode as ``{cycle_number}:{current_stage}``."""
    progress = StageProgress(
        user_id=1,
        current_stage=5,
        completed_stages=[1, 2, 3, 4],
        cycle_number=1,
        highest_stage_reached=5,
    )
    assert current_offer_episode(progress) == "1:5"


def test_current_offer_episode_key_changes_when_stage_advances() -> None:
    """Advancing from stage 5 to stage 6 produces a distinct episode key."""
    at_five = StageProgress(
        user_id=1,
        current_stage=5,
        completed_stages=[1, 2, 3, 4],
        cycle_number=1,
        highest_stage_reached=5,
    )
    at_six = StageProgress(
        user_id=1,
        current_stage=6,
        completed_stages=[1, 2, 3, 4, 5],
        cycle_number=1,
        highest_stage_reached=6,
    )
    assert current_offer_episode(at_five) == "1:5"
    assert current_offer_episode(at_six) == "1:6"
    assert current_offer_episode(at_six) != current_offer_episode(at_five)


def test_current_offer_episode_key_changes_when_cycle_bumps() -> None:
    """A second-cycle user at stage 2 is eligible via the persisted mark and keys distinctly."""
    progress = StageProgress(
        user_id=1,
        current_stage=2,
        completed_stages=[],
        cycle_number=2,
        highest_stage_reached=10,
    )
    assert current_offer_episode(progress) == "2:2"


# ---------------------------------------------------------------------------
# Week derivation from elapsed and paused time.
# ---------------------------------------------------------------------------


def test_active_return_week_day_zero_is_week_one() -> None:
    """No elapsed time — the arc starts in week 1."""
    now = datetime(2026, 1, 1, tzinfo=UTC)
    assert active_return_week(now, None, now) == 1


def test_active_return_week_day_seven_rolls_to_week_two() -> None:
    """A full seven days elapsed advances to week 2."""
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    now = started_at + timedelta(days=7)
    assert active_return_week(started_at, None, now) == 2


def test_active_return_week_day_eight_is_still_week_two() -> None:
    """Eight elapsed days is within week 2, not yet week 3."""
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    now = started_at + timedelta(days=8)
    assert active_return_week(started_at, None, now) == 2


def test_active_return_week_day_thirty_four_is_week_five() -> None:
    """Day 34 (weeks 5's interior) lands on week 5."""
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    now = started_at + timedelta(days=34)
    assert active_return_week(started_at, None, now) == 5


def test_active_return_week_clamps_past_five_weeks() -> None:
    """Far beyond the arc length, the week clamps to 5 rather than climbing forever."""
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    now = started_at + timedelta(days=100)
    assert active_return_week(started_at, None, now) == 5


def test_active_return_week_paused_freezes_at_pause_time() -> None:
    """A paused arc reports the week it was paused at, ignoring further elapsed time."""
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    paused_at = started_at + timedelta(days=10)  # inside week 2
    now = started_at + timedelta(days=40)  # would otherwise be week 5+
    assert active_return_week(started_at, paused_at, now) == 2


def test_active_return_week_handles_naive_and_aware_datetime_mix() -> None:
    """Mixed naive/aware inputs must not raise (mirrors program_calendar normalization)."""
    started_at_naive = datetime(2026, 1, 1)  # noqa: DTZ001 - deliberately naive
    now_aware = datetime(2026, 1, 8, tzinfo=UTC)
    week = active_return_week(started_at_naive, None, now_aware)
    assert week == 2


# ---------------------------------------------------------------------------
# RETURN_TOTAL_DAYS and is_return_complete.
# ---------------------------------------------------------------------------


def test_return_total_days_constant() -> None:
    """RETURN_TOTAL_DAYS pins the full arc length to five weeks of seven days."""
    assert RETURN_TOTAL_DAYS == 35
    assert RETURN_TOTAL_DAYS == RETURN_WEEK_COUNT * DAYS_PER_WEEK


def test_is_return_complete_day_thirty_four_is_not_complete() -> None:
    """One day short of the full arc length has not yet completed."""
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    now = started_at + timedelta(days=34)
    assert is_return_complete(started_at, None, now) is False


def test_is_return_complete_day_thirty_five_is_complete() -> None:
    """Exactly RETURN_TOTAL_DAYS elapsed is the completion boundary, inclusive."""
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    now = started_at + timedelta(days=35)
    assert is_return_complete(started_at, None, now) is True


def test_is_return_complete_day_one_hundred_is_complete() -> None:
    """Far beyond the arc length remains complete."""
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    now = started_at + timedelta(days=100)
    assert is_return_complete(started_at, None, now) is True


def test_is_return_complete_day_thirty_is_week_five_but_not_complete() -> None:
    """Day 30 sits in week 5 but has not finished living it: week5 != complete."""
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    now = started_at + timedelta(days=30)
    assert active_return_week(started_at, None, now) == 5
    assert is_return_complete(started_at, None, now) is False


def test_is_return_complete_paused_before_boundary_stays_incomplete() -> None:
    """A pause frozen before day 35 keeps completion frozen at False."""
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    paused_at = started_at + timedelta(days=30)
    now = started_at + timedelta(days=50)
    assert is_return_complete(started_at, paused_at, now) is False


def test_is_return_complete_paused_at_or_after_boundary_is_complete() -> None:
    """A pause frozen at or after day 35 reports the arc as already complete."""
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    paused_at = started_at + timedelta(days=40)
    now = started_at + timedelta(days=50)
    assert is_return_complete(started_at, paused_at, now) is True


def test_is_return_complete_handles_naive_and_aware_datetime_mix() -> None:
    """Mixed naive/aware inputs past the boundary must not raise."""
    started_at_naive = datetime(2026, 1, 1)  # noqa: DTZ001 - deliberately naive
    now_aware = datetime(2026, 2, 10, tzinfo=UTC)  # 40 days later
    assert is_return_complete(started_at_naive, None, now_aware) is True


# ---------------------------------------------------------------------------
# resumed_start
# ---------------------------------------------------------------------------


def test_resumed_start_shifts_start_forward_by_pause_duration() -> None:
    """Resuming pushes started_at forward by exactly the time spent paused.

    With started_at = T, paused_at = T+2d and now = T+5d (three paused days),
    the shifted start is T+3d, so elapsed-since-shifted-start at now equals the
    two pre-pause days — the frozen week is preserved and ticks from there.
    """
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    paused_at = started_at + timedelta(days=2)
    now = started_at + timedelta(days=5)
    resumed = resumed_start(started_at, paused_at, now)
    assert resumed == started_at + timedelta(days=3)
    # Elapsed since the shifted start equals the pre-pause elapsed (2 days).
    assert active_return_week(resumed, None, now) == active_return_week(
        started_at, paused_at, paused_at
    )


def test_resumed_start_preserves_frozen_week_after_resume() -> None:
    """A week frozen at pause resumes at that same week and ticks onward.

    Paused inside week 2 (day 10) then resumed a long time later, the arc still
    reports week 2 immediately at resume, and advances one week after a further
    seven days — no elapsed weeks are lost or gained across the pause.
    """
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    paused_at = started_at + timedelta(days=10)  # inside week 2
    now = started_at + timedelta(days=40)
    resumed = resumed_start(started_at, paused_at, now)
    assert active_return_week(resumed, None, now) == 2
    assert active_return_week(resumed, None, now + timedelta(days=7)) == 3


def test_resumed_start_handles_naive_and_aware_datetime_mix() -> None:
    """Mixed naive/aware inputs must not raise and yield the same day-delta."""
    started_at_naive = datetime(2026, 1, 1)  # noqa: DTZ001 - deliberately naive
    paused_at_naive = datetime(2026, 1, 3)  # noqa: DTZ001 - deliberately naive
    now_aware = datetime(2026, 1, 6, tzinfo=UTC)
    resumed = resumed_start(started_at_naive, paused_at_naive, now_aware)
    # Three paused days push the start to Jan 4; week stays frozen at week 1.
    assert resumed == started_at_naive + timedelta(days=3)
    assert active_return_week(resumed, None, now_aware) == 1


# ---------------------------------------------------------------------------
# Copy guard: the Return must never rank, shame, or penalize
# ---------------------------------------------------------------------------

# Words/phrases that would turn a declinable invitation into gamified
# pressure or moral judgment. This is an intent rule, not a fragile literal
# check: any future week copy is held to the same non-shaming standard the
# product principle ("you choose your depth") requires.
_BANNED_VOCABULARY: tuple[str, ...] = (
    "fail",
    "failure",
    "shame",
    "behind",
    "penalty",
    "penalized",
    "rank",
    "ranked",
    "should have",
    "catch up",
    "fell",
    "fell behind",
    "lost",
    "loser",
    "weak",
    "quitter",
    "giving up",
)

_BANNED_PATTERN = re.compile(
    "|".join(re.escape(word) for word in _BANNED_VOCABULARY),
    re.IGNORECASE,
)


@pytest.mark.parametrize("week", RETURN_SEQUENCE, ids=lambda w: f"week_{w.week_number}")
def test_return_week_copy_never_ranks_or_shames(week: ReturnWeek) -> None:
    """No week's title or framing contains shaming, ranking, or penalty language.

    The Return is an explicitly declinable invitation — pause/resume/leave
    carry no penalty. Copy that implies falling behind, failing, or being
    ranked would contradict that guarantee, so this guards the whole
    banned-vocabulary surface rather than one hard-coded phrase.
    """
    assert _BANNED_PATTERN.search(week.title) is None, f"banned word found in title: {week.title!r}"
    assert _BANNED_PATTERN.search(week.framing) is None, (
        f"banned word found in framing: {week.framing!r}"
    )
