"""Pure-Python tests for the per-practice all-time stats aggregator.

The rule under test is the one the codebase had never had to state: which
sessions count toward "how much have I put into this practice".  Two existing
readers disagreed -- ``domain.practice_insights`` skips ``duration_minutes <=
0`` rows, ``GET /practice-sessions/week-count`` counts every row by timestamp
-- and a total had to pick one.  These tests pin the choice so a later edit
cannot drift it back without going red.
"""

from __future__ import annotations

from datetime import UTC, datetime

from domain.practice_stats import (
    MIN_COUNTED_DURATION_MINUTES,
    PracticeStats,
    compute_practice_stats,
)
from models.practice_session import PracticeSession

_WHEN = datetime(2026, 5, 18, 12, 0, tzinfo=UTC)

# Named so the assertions read as arithmetic rather than as magic numbers.
_LONG_SIT = 20.0
_SHORT_SIT = 12.5
_TWO_SITS_COUNT = 2
_TWO_SITS_TOTAL = _LONG_SIT + _SHORT_SIT
_ONE_SIT = 15.0
_SKEWED_SIT = -30.0
_THREE_SITS_COUNT = 3
_THREE_SITS_TOTAL = 100.0
_THREE_SITS_MEAN = _THREE_SITS_TOTAL / _THREE_SITS_COUNT


def _session(duration_minutes: float) -> PracticeSession:
    """Build an in-memory session row of the given length (no DB write)."""
    return PracticeSession(
        user_id=1,
        user_practice_id=1,
        duration_minutes=duration_minutes,
        timestamp=_WHEN,
    )


def test_no_sessions_is_a_zeroed_total() -> None:
    """An untouched practice reports zeros rather than an absent payload."""
    stats = compute_practice_stats([])

    assert stats == PracticeStats(total_sessions=0, total_minutes=0.0)


def test_counts_sessions_and_sums_their_minutes() -> None:
    """The happy path: every positive-duration row lands in both numbers."""
    stats = compute_practice_stats([_session(_LONG_SIT), _session(_SHORT_SIT)])

    assert stats.total_sessions == _TWO_SITS_COUNT
    assert stats.total_minutes == _TWO_SITS_TOTAL


def test_zero_duration_aborts_move_neither_number() -> None:
    """A quick-cancel is not investment, so it counts for nothing.

    This is the deliberate divergence from ``GET /practice-sessions/week-count``
    (which filters on nothing) and the deliberate agreement with
    ``domain.practice_insights``, whose weekly bar and 30-day rollup are the
    numbers a practitioner already sees.
    """
    stats = compute_practice_stats([_session(0.0), _session(_ONE_SIT)])

    assert stats.total_sessions == 1
    assert stats.total_minutes == _ONE_SIT


def test_negative_duration_rows_are_excluded_too() -> None:
    """A clock-skewed negative row must not subtract from the total."""
    stats = compute_practice_stats([_session(_SKEWED_SIT), _session(_ONE_SIT)])

    assert stats.total_sessions == 1
    assert stats.total_minutes == _ONE_SIT


def test_the_counted_population_is_the_summed_population() -> None:
    """``total_minutes / total_sessions`` has to be a real average length.

    Counting rows on one rule and summing minutes on another would make the
    ratio meaningless, which is the bug this asserts against directly.
    """
    rows = [_session(0.0), _session(30.0), _session(30.0), _session(40.0)]

    stats = compute_practice_stats(rows)

    assert stats.total_sessions == _THREE_SITS_COUNT
    assert stats.total_minutes == _THREE_SITS_TOTAL
    assert stats.total_minutes / stats.total_sessions == _THREE_SITS_MEAN


def test_threshold_constant_is_the_boundary_the_rule_names() -> None:
    """The predicate is strictly greater than the constant, not ``>=``.

    A session recorded as exactly the threshold length is the abort case, so
    relaxing the comparison has to be visible here.
    """
    stats = compute_practice_stats([_session(MIN_COUNTED_DURATION_MINUTES)])

    assert stats.total_sessions == 0
