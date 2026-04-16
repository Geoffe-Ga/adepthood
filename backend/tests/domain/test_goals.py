"""Unit tests for goal progress domain logic."""

from __future__ import annotations

import pytest

from domain.goals import compute_progress


def test_additive_progress() -> None:
    progress, code = compute_progress(5, 10, is_additive=True)
    assert code == "additive_progress"
    assert progress == 0.5  # noqa: PLR2004


def test_subtractive_progress() -> None:
    progress, code = compute_progress(3, 10, is_additive=False)
    assert code == "subtractive_progress"
    assert progress == 0.7  # noqa: PLR2004


def test_target_must_be_positive() -> None:
    with pytest.raises(ValueError, match="target must be positive"):
        compute_progress(5, 0)


# ── BUG-GOAL-002: Subtractive goal progress parameterized ──────────────

_SUBTRACTIVE_CASES = [
    (0, 100, 1.0),
    (50, 100, 0.5),
    (100, 100, 0.0),
    (200, 100, 0.0),
]


@pytest.mark.parametrize(
    ("current", "target", "expected"),
    _SUBTRACTIVE_CASES,
    ids=["zero_consumed", "half_consumed", "at_limit", "over_limit"],
)
def test_subtractive_progress_parameterized(current: float, target: float, expected: float) -> None:
    """BUG-GOAL-002: Subtractive goals must report 1.0 when current=0,
    0.0 when current>=target, proportional between."""
    progress, code = compute_progress(current, target, is_additive=False)
    assert code == "subtractive_progress"
    assert progress == pytest.approx(expected, abs=1e-9)


_ADDITIVE_CASES = [
    (0, 100, 0.0),
    (50, 100, 0.5),
    (100, 100, 1.0),
    (200, 100, 1.0),
]


@pytest.mark.parametrize(
    ("current", "target", "expected"),
    _ADDITIVE_CASES,
    ids=["zero", "half", "full", "over"],
)
def test_additive_progress_parameterized(current: float, target: float, expected: float) -> None:
    progress, code = compute_progress(current, target, is_additive=True)
    assert code == "additive_progress"
    assert progress == pytest.approx(expected, abs=1e-9)
