"""Tests for ``next_stage_for`` (BUG-STAGE-001 helper).

``next_stage_for`` returns the first *hole* in ``completed_stages`` — i.e.
``min({1..TOTAL_STAGES} - completed_stages)`` — not ``max(completed) + 1``.
The distinction matters for legacy rows with gaps (e.g. ``[1, 3]`` where
``max+1`` would incorrectly advance past stage 2).
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException, status

from domain.stage_progress import TOTAL_STAGES, next_stage_for
from models.stage_progress import StageProgress


def _progress(completed: list[int]) -> StageProgress:
    """Build a StageProgress with the given completed_stages."""
    return StageProgress(id=1, user_id=1, current_stage=1, completed_stages=completed)


def test_no_progress_returns_stage_1() -> None:
    """Fresh users (no progress row) start at stage 1."""
    assert next_stage_for(None) == 1


def test_empty_completed_returns_stage_1() -> None:
    """Progress row with empty completed_stages also starts at stage 1."""
    assert next_stage_for(_progress([])) == 1


def test_sequential_completions_return_next() -> None:
    """``[1, 2, 3]`` → 4 (the first unfinished stage)."""
    assert next_stage_for(_progress([1, 2, 3])) == 4


def test_gap_returns_min_missing_not_max_plus_one() -> None:
    """``[1, 3]`` → 2, not 4 — legacy-gap robustness (BUG-STAGE-001)."""
    assert next_stage_for(_progress([1, 3])) == 2


def test_single_completion_returns_next() -> None:
    """``[1]`` → 2."""
    assert next_stage_for(_progress([1])) == 2


def test_mid_chain_gap_returns_earliest_hole() -> None:
    """``[1, 2, 4, 5]`` → 3, the earliest hole."""
    assert next_stage_for(_progress([1, 2, 4, 5])) == 3


def test_all_stages_completed_raises_409() -> None:
    """Every stage completed → HTTP 409 ``all_stages_completed``."""
    everything = list(range(1, TOTAL_STAGES + 1))
    with pytest.raises(HTTPException) as exc_info:
        next_stage_for(_progress(everything))
    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    assert exc_info.value.detail == "all_stages_completed"


def test_last_stage_missing_returns_total_stages() -> None:
    """Only the final stage missing → returns ``TOTAL_STAGES``."""
    all_but_last = list(range(1, TOTAL_STAGES))
    assert next_stage_for(_progress(all_but_last)) == TOTAL_STAGES
