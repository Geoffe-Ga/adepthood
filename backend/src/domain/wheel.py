"""Domain logic for the Wheel of Wholeness balance view.

The wheel expresses per-Aspect *fullness*: for each of the ten stages, how
engaged the user is (habits, practice, course), reusing the same
``overall_progress`` signal the stage list already computes. Items are always
returned in canonical stage order (1..10), never sorted by fullness, so the
frontend can lay them out on a fixed wheel.

Chord-tag weighting: a stage's chord tags nudge its fullness upward. Each
primary tag on a stage is worth ``WHEEL_PRIMARY_TAG_WEIGHT`` and each secondary
tag ``WHEEL_SECONDARY_TAG_WEIGHT``; their weighted sum per stage is
``weighted = WHEEL_PRIMARY_TAG_WEIGHT * n_primary + WHEEL_SECONDARY_TAG_WEIGHT
* n_secondary``. That count is normalized against ``WHEEL_CHORD_SATURATION_TAGS``
and scaled by ``WHEEL_CHORD_SIGNAL_CAP`` to yield ``chord_signal =
WHEEL_CHORD_SIGNAL_CAP * min(weighted / WHEEL_CHORD_SATURATION_TAGS, 1.0)``,
which saturates at the cap. Final fullness is ``min(overall_progress +
chord_signal, 1.0)``. Only non-deleted entries count, across all
classifications — the wheel is the user's own private aggregate. With no tagged
entries ``chord_signal`` is exactly ``0.0``, so fullness equals
``overall_progress``.
"""

from __future__ import annotations

from typing import TypedDict

from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.constants import TOTAL_STAGES
from domain.stage_progress import compute_stage_progress_batch
from models.course_stage import CourseStage
from models.journal_entry import JournalEntry

# Per-tag weights: a primary Aspect carries full weight, a secondary half.
WHEEL_PRIMARY_TAG_WEIGHT = 1.0
WHEEL_SECONDARY_TAG_WEIGHT = 0.5
# The most a stage's chord tags can add to its fullness, and the weighted tag
# count at which that cap is reached.
WHEEL_CHORD_SIGNAL_CAP = 0.2
WHEEL_CHORD_SATURATION_TAGS = 10.0


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


async def _primary_aspect_counts(session: AsyncSession, user_id: int) -> dict[int, int]:
    """Count non-deleted entries per stage tagged with that stage as primary.

    One ``GROUP BY`` aggregate over ``primary_aspect`` (no per-stage loop).
    """
    result = await session.execute(
        select(JournalEntry.primary_aspect, func.count())
        .where(
            JournalEntry.user_id == user_id,
            col(JournalEntry.deleted_at).is_(None),
            col(JournalEntry.primary_aspect).is_not(None),
        )
        .group_by(col(JournalEntry.primary_aspect))
    )
    return {row[0]: row[1] for row in result.all()}


async def _secondary_aspect_counts(session: AsyncSession, user_id: int) -> dict[int, int]:
    """Count non-deleted entries per stage tagged with that stage as secondary.

    One ``GROUP BY`` aggregate over ``secondary_aspect`` (no per-stage loop).
    """
    result = await session.execute(
        select(JournalEntry.secondary_aspect, func.count())
        .where(
            JournalEntry.user_id == user_id,
            col(JournalEntry.deleted_at).is_(None),
            col(JournalEntry.secondary_aspect).is_not(None),
        )
        .group_by(col(JournalEntry.secondary_aspect))
    )
    return {row[0]: row[1] for row in result.all()}


async def _chord_tag_weighted_counts(session: AsyncSession, user_id: int) -> dict[int, float]:
    """Return ``{stage_number: weighted_tag_count}`` for the user's chord tags.

    ``weighted = WHEEL_PRIMARY_TAG_WEIGHT * n_primary + WHEEL_SECONDARY_TAG_WEIGHT
    * n_secondary`` per stage, over non-deleted entries only, using two constant
    grouped-count queries (no N+1).
    """
    primary = await _primary_aspect_counts(session, user_id)
    secondary = await _secondary_aspect_counts(session, user_id)
    weighted: dict[int, float] = {}
    for stage, count in primary.items():
        weighted[stage] = weighted.get(stage, 0.0) + WHEEL_PRIMARY_TAG_WEIGHT * count
    for stage, count in secondary.items():
        weighted[stage] = weighted.get(stage, 0.0) + WHEEL_SECONDARY_TAG_WEIGHT * count
    return weighted


def _chord_signal(weighted: float) -> float:
    """Scale a stage's weighted tag count into its capped fullness lift."""
    return WHEEL_CHORD_SIGNAL_CAP * min(weighted / WHEEL_CHORD_SATURATION_TAGS, 1.0)


async def compute_wheel_balance(session: AsyncSession, user_id: int) -> list[WheelItem]:
    """Return per-Aspect fullness for all ten stages in canonical order.

    Each item is ``{"stage_number", "aspect", "fullness"}``. ``fullness`` blends
    the stage's ``overall_progress`` from :func:`compute_stage_progress_batch` (a
    single batched pass, no N+1) with a capped chord-tag signal:
    ``fullness = min(overall_progress + chord_signal, 1.0)`` where
    ``chord_signal = WHEEL_CHORD_SIGNAL_CAP * min(weighted /
    WHEEL_CHORD_SATURATION_TAGS, 1.0)`` and ``weighted =
    WHEEL_PRIMARY_TAG_WEIGHT * n_primary + WHEEL_SECONDARY_TAG_WEIGHT *
    n_secondary`` over the user's non-deleted tagged entries. With no chord tags
    ``chord_signal`` is exactly ``0.0``, so fullness equals ``overall_progress``.
    ``aspect`` is the stage's label from ``CourseStage``; stages with no
    engagement report ``0.0``. Ordering follows ``stage_number`` ascending
    regardless of fullness.

    ``aspect`` falls back to ``""`` only if a ``CourseStage`` row is absent for a
    stage in 1..10 — a misconfigured-seed sentinel; the seeder guarantees all ten.
    """
    stage_numbers = list(range(1, TOTAL_STAGES + 1))
    batch = await compute_stage_progress_batch(session, user_id, stage_numbers)
    aspects = await _aspect_labels_by_stage(session, stage_numbers)
    weighted_counts = await _chord_tag_weighted_counts(session, user_id)
    return [
        {
            "stage_number": stage_number,
            "aspect": aspects.get(stage_number, ""),
            "fullness": min(
                float(batch[stage_number]["overall_progress"])
                + _chord_signal(weighted_counts.get(stage_number, 0.0)),
                1.0,
            ),
        }
        for stage_number in stage_numbers
    ]
