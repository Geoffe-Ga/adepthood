"""Tests for ``next_stage_for``.

Under BUG-STAGE-002's single-source-of-truth model the helper derives
the next stage from ``current_stage`` alone (``current_stage + 1``,
capped by ``TOTAL_STAGES``).  ``completed_stages`` is ignored.
"""

from __future__ import annotations

import pytest

from domain.stage_progress import (
    TOTAL_STAGES,
    AllStagesCompletedError,
    next_stage_for,
)
from models.stage_progress import StageProgress


def _progress(current: int) -> StageProgress:
    """Build a StageProgress at the given current stage."""
    return StageProgress(id=1, user_id=1, current_stage=current, completed_stages=[])


def test_no_progress_returns_stage_1() -> None:
    """Fresh users (no progress row) start at stage 1."""
    assert next_stage_for(None) == 1


def test_current_stage_one_returns_two() -> None:
    """A user at stage 1 advances to stage 2."""
    assert next_stage_for(_progress(1)) == 2


def test_current_stage_three_returns_four() -> None:
    """``current_stage=3`` advances to 4 -- the helper does not consult ``completed_stages``."""
    assert next_stage_for(_progress(3)) == 4


def test_completed_stages_drift_is_ignored() -> None:
    """A drifted ``completed_stages`` value cannot tilt the answer.

    Pre-fix this would have read the list and returned the first hole;
    under the BUG-STAGE-002 contract ``current_stage + 1`` is the only
    signal that matters.
    """
    progress = StageProgress(id=1, user_id=1, current_stage=5, completed_stages=[1, 99])
    assert next_stage_for(progress) == 6


def test_at_final_stage_raises_domain_error() -> None:
    """``current_stage == TOTAL_STAGES`` -> :class:`AllStagesCompletedError`."""
    with pytest.raises(AllStagesCompletedError):
        next_stage_for(_progress(TOTAL_STAGES))


def test_one_before_last_returns_total_stages() -> None:
    """``current_stage = TOTAL_STAGES - 1`` advances to ``TOTAL_STAGES``."""
    assert next_stage_for(_progress(TOTAL_STAGES - 1)) == TOTAL_STAGES
