"""Table-driven tests for is_stage_unlocked (BUG-STAGE-002).

Every combination of current_stage and completed_stages is tested to
prevent regressions in the unlock predicate.
"""

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
    ("stage 2 unlocked when current=2 and 1 completed", 2, _progress(2, [1]), True),
    ("stage 2 locked when current=2 but 1 NOT completed", 2, _progress(2, []), False),
    ("stage 3 locked when current=2 (not yet reached)", 3, _progress(2, [1]), False),
    ("stage 3 unlocked when 2 completed", 3, _progress(2, [1, 2]), True),
    ("stage 3 unlocked when current=3 and 2 completed", 3, _progress(3, [1, 2]), True),
    ("stage 3 locked when current=3 but 2 NOT completed", 3, _progress(3, [1]), False),
    ("stage 4 locked when current=3 and 3 not completed", 4, _progress(3, [1, 2]), False),
    ("stage 4 unlocked when 3 completed", 4, _progress(3, [1, 2, 3]), True),
    # Edge: current_stage jumped ahead (DB mutation) without completing predecessors
    ("stage 5 locked despite current=5 if 4 not completed", 5, _progress(5, [1, 2, 3]), False),
    ("stage 5 unlocked when current=5 and 4 completed", 5, _progress(5, [1, 2, 3, 4]), True),
    # BUG-STAGE-001: chain-validation — the immediate predecessor alone is not
    # enough.  ``completed_stages=[4]`` used to unlock stage 5 under the old
    # single-step check; the chain check requires every stage in {1..4}.
    ("BUG-STAGE-001 stage 5 locked when only 4 completed", 5, _progress(5, [4]), False),
    ("BUG-STAGE-001 stage 5 locked with mid-chain gap", 5, _progress(5, [1, 2, 4]), False),
    ("BUG-STAGE-001 stage 36 locked when only 35 completed", 36, _progress(36, [35]), False),
    (
        "BUG-STAGE-001 stage 5 unlocked only when {1,2,3,4} all completed",
        5,
        _progress(5, [1, 2, 3, 4]),
        True,
    ),
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
