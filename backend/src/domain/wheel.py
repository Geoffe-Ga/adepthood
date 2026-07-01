"""Domain logic for the Wheel of Wholeness balance view.

The wheel expresses per-Aspect *fullness*: for each of the ten stages, how
engaged the user is (habits, practice, course), reusing the same
``overall_progress`` signal the stage list already computes. Items are always
returned in canonical stage order (1..10), never sorted by fullness, so the
frontend can lay them out on a fixed wheel.
"""

from __future__ import annotations

from typing import TypedDict

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.constants import TOTAL_STAGES
from domain.stage_progress import compute_stage_progress_batch
from models.course_stage import CourseStage


class WheelItem(TypedDict):
    """One wheel item: its stage index, Aspect label, and fullness (0..1)."""

    stage_number: int
    aspect: str
    fullness: float


async def _aspect_labels_by_stage(
    session: AsyncSession, stage_numbers: list[int]
) -> dict[int, str]:
    """Return ``{stage_number: aspect}`` for the given stages in one query."""
    result = await session.execute(
        select(CourseStage.stage_number, CourseStage.aspect).where(
            col(CourseStage.stage_number).in_(stage_numbers)
        )
    )
    return {row.stage_number: row.aspect for row in result.all()}


async def compute_wheel_balance(session: AsyncSession, user_id: int) -> list[WheelItem]:
    """Return per-Aspect fullness for all ten stages in canonical order.

    Each item is ``{"stage_number", "aspect", "fullness"}``. ``fullness`` is the
    stage's ``overall_progress`` from :func:`compute_stage_progress_batch` (a
    single batched pass, no N+1); ``aspect`` is the stage's label from
    ``CourseStage``. Stages with no engagement report ``0.0``. Ordering follows
    ``stage_number`` ascending regardless of fullness.

    ``aspect`` falls back to ``""`` only if a ``CourseStage`` row is absent for a
    stage in 1..10 — a misconfigured-seed sentinel; the seeder guarantees all ten.
    """
    stage_numbers = list(range(1, TOTAL_STAGES + 1))
    batch = await compute_stage_progress_batch(session, user_id, stage_numbers)
    aspects = await _aspect_labels_by_stage(session, stage_numbers)
    return [
        {
            "stage_number": stage_number,
            "aspect": aspects.get(stage_number, ""),
            "fullness": float(batch[stage_number]["overall_progress"]),
        }
        for stage_number in stage_numbers
    ]
