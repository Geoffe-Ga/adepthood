"""Public copy says the Course follows a schedule, because it does (#3057 C18, B20).

The Course is a depth a person may turn off, but its readings are not all open
at once: a stage's chapters drip out across the stage's days. The owner kept
that schedule and asked that the copy say so plainly -- "Some readings follow a
schedule." -- rather than describe everything as ungated. This pins the
repository's front page to that wording and to the drip that makes it true.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

from domain.course import unlocked_chapter_count

_README = Path(__file__).resolve().parents[2] / "README.md"

_SCHEDULE_SENTENCE: Final = "some readings follow a schedule."
_UNGATED_CLAIM: Final = "nothing is gated"

# A three-week stage with three chapters, on its first day.
_CHAPTERS: Final = 3
_STAGE_DAYS: Final = 21
_FIRST_DAY: Final = 1


def test_the_course_drips_its_readings() -> None:
    """On a stage's first day, not every chapter is open: the schedule is real."""
    opened = unlocked_chapter_count(
        total=_CHAPTERS, duration_days=_STAGE_DAYS, day_in_stage=_FIRST_DAY
    )

    assert 0 < opened < _CHAPTERS


def test_the_readme_says_some_readings_follow_a_schedule() -> None:
    """The front page names the schedule and no longer calls everything ungated."""
    readme = " ".join(_README.read_text(encoding="utf-8").lower().split())

    assert _SCHEDULE_SENTENCE in readme
    assert _UNGATED_CLAIM not in readme
