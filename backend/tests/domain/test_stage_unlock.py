"""Table-driven tests for ``is_stage_unlocked`` -- ``current_stage`` is the only signal."""

from __future__ import annotations

import pytest

from domain.stage_progress import is_stage_unlocked
from models.stage_progress import StageProgress


def _progress(current: int, completed: list[int]) -> StageProgress:
    """Build a StageProgress with the given fields (no DB needed)."""
    return StageProgress(id=1, user_id=1, current_stage=current, completed_stages=completed)


_CASES: list[tuple[str, int, StageProgress | None, bool]] = [
    ("stage 1 always unlocked (no progress)", 1, None, True),
    ("stage 1 always unlocked (with progress)", 1, _progress(3, [1, 2]), True),
    ("stage 2 locked without progress", 2, None, False),
    ("stage 2 unlocked when current=2", 2, _progress(2, [1]), True),
    ("stage 2 unlocked when current=2 (drifted completed list)", 2, _progress(2, []), True),
    ("stage 3 locked when current=2", 3, _progress(2, [1]), False),
    ("stage 3 unlocked when current=3", 3, _progress(3, [1, 2]), True),
    ("stage 3 unlocked when current=3 (drifted completed list)", 3, _progress(3, [1]), True),
    ("stage 4 locked when current=3", 4, _progress(3, [1, 2]), False),
    ("stage 4 unlocked when current=4", 4, _progress(4, [1, 2, 3]), True),
    # ``completed_stages`` is ignored.  These cases would have flipped
    # under the old chain-validation contract; the new contract derives
    # the answer from ``current_stage`` alone.
    ("stage 5 unlocked when current=5 (drifted completed list)", 5, _progress(5, [1, 2, 3]), True),
    ("stage 5 unlocked when current=5 (canonical)", 5, _progress(5, [1, 2, 3, 4]), True),
    ("stage 5 locked when current=4", 5, _progress(4, [1, 2, 3, 4]), False),
    ("stage 36 unlocked when current=36", 36, _progress(36, [35]), True),
]


@pytest.mark.parametrize(
    ("description", "stage_number", "progress", "expected"),
    _CASES,
    ids=[c[0] for c in _CASES],
)
def test_is_stage_unlocked(
    description: str,
    stage_number: int,
    progress: StageProgress | None,
    expected: bool,
) -> None:
    assert is_stage_unlocked(stage_number, progress) is expected, description
