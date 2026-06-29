"""Unit tests for the stage-gap invariant helpers (#785)."""

from __future__ import annotations

from domain.stage_progress import completed_stage_gap, expected_completed_stages


def test_expected_completed_stages_is_one_to_current_minus_one() -> None:
    assert expected_completed_stages(1) == set()
    assert expected_completed_stages(4) == {1, 2, 3}


def test_gap_contiguous_is_empty() -> None:
    missing, extra = completed_stage_gap({1, 2}, 3)
    assert missing == set()
    assert extra == set()


def test_gap_reports_missing_stage() -> None:
    missing, extra = completed_stage_gap({1}, 3)
    assert missing == {2}
    assert extra == set()


def test_gap_reports_extra_stage() -> None:
    missing, extra = completed_stage_gap({1, 2, 3}, 3)
    assert missing == set()
    assert extra == {3}


def test_gap_reports_missing_and_extra_together() -> None:
    missing, extra = completed_stage_gap({1, 3}, 3)
    assert missing == {2}
    assert extra == {3}
