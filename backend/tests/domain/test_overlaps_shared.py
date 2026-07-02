"""Pins domain.resonance._overlaps as the single shared span-overlap check."""

from __future__ import annotations

from domain.detection import CompletionDetected
from domain.detection import _overlaps as _detection_overlaps
from domain.resonance import MarginaliaAnchored, _overlaps


def _marginalia(start: int, end: int) -> MarginaliaAnchored:
    return MarginaliaAnchored(
        kind="theme", anchor_start=start, anchor_end=end, anchor_text="x", note="n"
    )


def _completion(start: int, end: int) -> CompletionDetected:
    return CompletionDetected(
        target_type="habit",
        target_id=1,
        label="x",
        anchor_start=start,
        anchor_end=end,
        anchor_text="x",
    )


def test_overlaps_true_for_overlapping_marginalia_spans() -> None:
    assert _overlaps(_marginalia(0, 10), _marginalia(5, 15)) is True


def test_overlaps_false_for_disjoint_marginalia_spans() -> None:
    assert _overlaps(_marginalia(0, 5), _marginalia(10, 15)) is False


def test_overlaps_false_for_adjacent_marginalia_spans() -> None:
    assert _overlaps(_marginalia(0, 5), _marginalia(5, 10)) is False


def test_overlaps_true_for_overlapping_completion_spans() -> None:
    assert _overlaps(_completion(0, 10), _completion(5, 15)) is True


def test_overlaps_false_for_disjoint_completion_spans() -> None:
    assert _overlaps(_completion(0, 5), _completion(10, 15)) is False


def test_overlaps_false_for_adjacent_completion_spans() -> None:
    assert _overlaps(_completion(0, 5), _completion(5, 10)) is False


def test_detection_module_imports_overlaps_from_resonance_not_duplicating_it() -> None:
    assert _detection_overlaps is _overlaps
