"""Which weekly questions have become historical across recorded program cycles."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from domain.constants import DAYS_PER_WEEK, TOTAL_PROGRAM_WEEKS
from domain.cycle_calendar import CycleWindow, resolve_cycle_window
from domain.dates import ensure_aware
from domain.program_calendar import elapsed_days

if TYPE_CHECKING:
    from models.stage_progress import StageProgress


def _weeks_in_window(window: CycleWindow | None, now: datetime, tz: str) -> int:
    """Count completed local weeks, stopping when a closed cycle actually ended."""
    if window is None:
        return 0
    end = min(window.ended_at or now, now)
    return min(
        TOTAL_PROGRAM_WEEKS,
        elapsed_days(window.started_at, end, tz=tz) // DAYS_PER_WEEK,
    )


def past_prompt_weeks(progress: StageProgress | None, now: datetime, tz: str) -> int:
    """The largest recorded past week, without aging a closed cycle into the future.

    Questions are a shared curriculum library, so once a week has passed in
    any recorded cycle its question stays available. Missing old dates are
    never guessed from answers. Visit only retained slots and the live cycle,
    rather than iterating a possibly much larger legacy cycle number.
    """
    if progress is None:
        return 0
    retained = min(len(progress.past_cycle_anchors or []), progress.cycle_number - 1)
    cycles = (*range(1, retained + 1), progress.cycle_number)
    moment = ensure_aware(now)
    return max(
        _weeks_in_window(resolve_cycle_window(progress, cycle)[0], moment, tz) for cycle in cycles
    )
