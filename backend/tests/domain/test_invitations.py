"""Pure-domain tests for :mod:`domain.invitations` — readiness-signal computation.

These tests FAIL on import until the implementation-specialist creates
``backend/src/domain/invitations.py`` with the contracts pinned below.
That is the correct RED state for Gate 1.

Pinned public surface:
  compute_invitation_candidates(aggregates: ReadinessAggregates) -> list[InvitationCandidate]
  InvitationCandidate(target_type: str, target_id: int | None, kind: str)
  HabitSignal(habit_id: int, streak_days: int)
  PracticeSignal(practice_id: int, sustained_weeks: int)
  ReadinessAggregates(habits: list[HabitSignal], practices: list[PracticeSignal],
                      active_days_in_window: int)
  SUSTAINED_HABIT_STREAK_DAYS = 21
  SUSTAINED_PRACTICE_WEEKS   = 4
  HIGH_ENGAGEMENT_ACTIVE_DAYS = 25
  ENGAGEMENT_WINDOW_DAYS      = 30
"""

from __future__ import annotations

import dataclasses
import inspect

import pytest

from domain.invitations import (
    HIGH_ENGAGEMENT_ACTIVE_DAYS,
    SUSTAINED_HABIT_STREAK_DAYS,
    SUSTAINED_PRACTICE_WEEKS,
    HabitSignal,
    InvitationCandidate,
    PracticeSignal,
    ReadinessAggregates,
    compute_invitation_candidates,
)
from models.invitation_signal import InvitationKind, InvitationTargetType

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_EMPTY = ReadinessAggregates(habits=[], practices=[], active_days_in_window=0)


def _agg(
    *,
    habit_id: int = 1,
    streak: int = 0,
    practice_id: int = 1,
    weeks: int = 0,
    active_days: int = 0,
) -> ReadinessAggregates:
    """Build a minimal aggregates object for a single-signal scenario."""
    return ReadinessAggregates(
        habits=[HabitSignal(habit_id=habit_id, streak_days=streak)] if streak else [],
        practices=[PracticeSignal(practice_id=practice_id, sustained_weeks=weeks)] if weeks else [],
        active_days_in_window=active_days,
    )


# ---------------------------------------------------------------------------
# 1. Empty aggregates → silence by default
# ---------------------------------------------------------------------------


def test_empty_aggregates_returns_empty_list() -> None:
    """No signals → no candidates (silence-by-default)."""
    result = compute_invitation_candidates(_EMPTY)
    assert result == []


# ---------------------------------------------------------------------------
# 2. Habit streak threshold boundary
# ---------------------------------------------------------------------------


def test_habit_streak_below_threshold_produces_no_candidate() -> None:
    """A streak of threshold-1 must not generate a habit candidate."""
    below = ReadinessAggregates(
        habits=[HabitSignal(habit_id=7, streak_days=SUSTAINED_HABIT_STREAK_DAYS - 1)],
        practices=[],
        active_days_in_window=0,
    )
    candidates = compute_invitation_candidates(below)
    assert not any(c.target_type == "habit" for c in candidates)


def test_habit_streak_at_threshold_produces_one_candidate() -> None:
    """A streak of exactly SUSTAINED_HABIT_STREAK_DAYS (21) triggers one candidate."""
    at_threshold = ReadinessAggregates(
        habits=[HabitSignal(habit_id=42, streak_days=SUSTAINED_HABIT_STREAK_DAYS)],
        practices=[],
        active_days_in_window=0,
    )
    candidates = compute_invitation_candidates(at_threshold)
    assert len(candidates) == 1
    assert candidates[0].target_type == "habit"
    assert candidates[0].target_id == 42
    assert candidates[0].kind == "consistency"


# ---------------------------------------------------------------------------
# 3. Practice sustained-weeks threshold boundary
# ---------------------------------------------------------------------------


def test_practice_weeks_below_threshold_produces_no_candidate() -> None:
    """Sustained weeks below 4 must not generate a practice candidate."""
    below = ReadinessAggregates(
        habits=[],
        practices=[PracticeSignal(practice_id=5, sustained_weeks=SUSTAINED_PRACTICE_WEEKS - 1)],
        active_days_in_window=0,
    )
    candidates = compute_invitation_candidates(below)
    assert not any(c.target_type == "practice" for c in candidates)


def test_practice_weeks_at_threshold_produces_one_candidate() -> None:
    """Exactly SUSTAINED_PRACTICE_WEEKS (4) weeks produces one mastery candidate."""
    at_threshold = ReadinessAggregates(
        habits=[],
        practices=[PracticeSignal(practice_id=99, sustained_weeks=SUSTAINED_PRACTICE_WEEKS)],
        active_days_in_window=0,
    )
    candidates = compute_invitation_candidates(at_threshold)
    assert len(candidates) == 1
    assert candidates[0].target_type == "practice"
    assert candidates[0].target_id == 99
    assert candidates[0].kind == "mastery"


# ---------------------------------------------------------------------------
# 4. Engagement / embodied-community threshold boundary
# ---------------------------------------------------------------------------


def test_active_days_below_threshold_produces_no_community_candidate() -> None:
    """Active days below HIGH_ENGAGEMENT_ACTIVE_DAYS must not trigger the outward signal."""
    below = ReadinessAggregates(
        habits=[],
        practices=[],
        active_days_in_window=HIGH_ENGAGEMENT_ACTIVE_DAYS - 1,
    )
    candidates = compute_invitation_candidates(below)
    assert not any(c.target_type == "embodied_community" for c in candidates)


def test_active_days_at_threshold_produces_community_candidate_with_null_target() -> None:
    """Exactly HIGH_ENGAGEMENT_ACTIVE_DAYS (25) active days yields the outward candidate."""
    at_threshold = ReadinessAggregates(
        habits=[],
        practices=[],
        active_days_in_window=HIGH_ENGAGEMENT_ACTIVE_DAYS,
    )
    candidates = compute_invitation_candidates(at_threshold)
    assert len(candidates) == 1
    assert candidates[0].target_type == "embodied_community"
    assert candidates[0].target_id is None  # outward / no concrete target
    assert candidates[0].kind == "readiness"


# ---------------------------------------------------------------------------
# 5. Combined signals: one candidate each, coexist correctly
# ---------------------------------------------------------------------------


def test_all_three_signals_produce_three_candidates() -> None:
    """When all signals cross threshold, exactly three candidates are returned."""
    combined = ReadinessAggregates(
        habits=[HabitSignal(habit_id=10, streak_days=SUSTAINED_HABIT_STREAK_DAYS)],
        practices=[PracticeSignal(practice_id=20, sustained_weeks=SUSTAINED_PRACTICE_WEEKS)],
        active_days_in_window=HIGH_ENGAGEMENT_ACTIVE_DAYS,
    )
    candidates = compute_invitation_candidates(combined)
    assert len(candidates) == 3
    types = {c.target_type for c in candidates}
    assert types == {"habit", "practice", "embodied_community"}


def test_multiple_habits_above_threshold_produce_one_candidate_each() -> None:
    """Each habit that clears the streak threshold gets its own candidate."""
    two_habits = ReadinessAggregates(
        habits=[
            HabitSignal(habit_id=1, streak_days=SUSTAINED_HABIT_STREAK_DAYS),
            HabitSignal(habit_id=2, streak_days=SUSTAINED_HABIT_STREAK_DAYS + 10),
        ],
        practices=[],
        active_days_in_window=0,
    )
    candidates = compute_invitation_candidates(two_habits)
    habit_candidates = [c for c in candidates if c.target_type == "habit"]
    assert len(habit_candidates) == 2
    assert {c.target_id for c in habit_candidates} == {1, 2}


# ---------------------------------------------------------------------------
# 6. Enum-drift guard: every candidate's fields are valid enum values
# ---------------------------------------------------------------------------


def test_all_candidate_values_are_valid_enum_members() -> None:
    """All target_type / kind values in candidates are valid InvitationTargetType / InvitationKind.

    Mirrors the drift guard pattern from domain.detection (VALID_TARGET_TYPES).
    """
    all_signals = ReadinessAggregates(
        habits=[HabitSignal(habit_id=1, streak_days=SUSTAINED_HABIT_STREAK_DAYS)],
        practices=[PracticeSignal(practice_id=2, sustained_weeks=SUSTAINED_PRACTICE_WEEKS)],
        active_days_in_window=HIGH_ENGAGEMENT_ACTIVE_DAYS,
    )
    valid_types = {t.value for t in InvitationTargetType}
    valid_kinds = {k.value for k in InvitationKind}

    candidates = compute_invitation_candidates(all_signals)
    for c in candidates:
        assert c.target_type in valid_types, f"unexpected target_type: {c.target_type!r}"
        assert c.kind in valid_kinds, f"unexpected kind: {c.kind!r}"


# ---------------------------------------------------------------------------
# 7. Purity: deterministic, no I/O, accepts only ReadinessAggregates
# ---------------------------------------------------------------------------


def test_calling_twice_with_same_input_returns_equal_output() -> None:
    """Pure fn: same input always yields equal output (no hidden state)."""
    agg = ReadinessAggregates(
        habits=[HabitSignal(habit_id=3, streak_days=SUSTAINED_HABIT_STREAK_DAYS)],
        practices=[PracticeSignal(practice_id=4, sustained_weeks=SUSTAINED_PRACTICE_WEEKS)],
        active_days_in_window=HIGH_ENGAGEMENT_ACTIVE_DAYS,
    )
    first = compute_invitation_candidates(agg)
    second = compute_invitation_candidates(agg)
    assert first == second


def test_function_signature_accepts_only_aggregates_not_a_session() -> None:
    """The pure fn must accept ReadinessAggregates, not a session object (structural)."""
    sig = inspect.signature(compute_invitation_candidates)
    params = list(sig.parameters.keys())
    # Exactly one positional parameter named 'aggregates'.
    assert params == ["aggregates"], (
        f"expected signature compute_invitation_candidates(aggregates), got {params}"
    )


def test_candidate_is_frozen_dataclass() -> None:
    """InvitationCandidate is a frozen dataclass (immutable value object)."""
    assert dataclasses.is_dataclass(InvitationCandidate), "InvitationCandidate must be a dataclass"
    # frozen=True means __setattr__ raises FrozenInstanceError.
    c = InvitationCandidate(target_type="habit", target_id=1, kind="consistency")
    with pytest.raises((dataclasses.FrozenInstanceError, AttributeError)):
        c.__setattr__("target_type", "mutated")
