"""Gather a user's tracked habits as detection candidates.

Turns the caller's current habits into the ``DetectionCandidate`` list that
:func:`domain.detection.detect_completions` consumes, so the check-off endpoint
(#817) stays thin. Covers habits and, with ``include_practices``, the user's
active practices too (#821) — sharing one candidate budget.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.detection import DetectionCandidate
from domain.practice_resolution import effective_name
from load_options import HABIT_WITH_GOALS
from models.goal import Goal, GoalTier
from models.habit import Habit
from models.practice import Practice
from models.user_practice import UserPractice

logger = logging.getLogger(__name__)

# Upper bound on the candidate list handed to the LLM, to keep the prompt (and
# its cost) bounded for users with many habits + practices (shared budget).
MAX_CANDIDATES = 25

_HABIT_TARGET = "habit"
_PRACTICE_TARGET = "practice"


def _pick_representative(goals: list[Goal]) -> Goal | None:
    """Return the goal that stands for a habit: clear-tier, else first, else None.

    The single source of truth for "which goal represents this habit", shared by
    :func:`gather_candidates` (over eager-loaded goals) and
    :func:`representative_goal` (querying), so the accept path checks off exactly
    the goal detection matched.
    """
    if not goals:
        return None
    clear = next((g for g in goals if g.tier == GoalTier.CLEAR), None)
    return clear if clear is not None else goals[0]


async def representative_goal(session: AsyncSession, habit: Habit) -> Goal | None:
    """The goal that represents ``habit`` for completion check-off.

    Clear-tier goal preferred, else the first goal (by id), else ``None`` when the
    habit has no goals. Exported so the accept path (#818/#820) targets the same
    goal :func:`gather_candidates` offered. Queries the goals so it is safe on a
    habit loaded without them.
    """
    result = await session.execute(
        select(Goal).where(Goal.habit_id == habit.id).order_by(col(Goal.id)),
    )
    return _pick_representative(list(result.scalars().all()))


def _habit_candidates(habits: list[Habit]) -> list[DetectionCandidate]:
    """Dense, ordered habit candidates keyed by the representative goal.

    Goal-less habits are skipped; surviving habits get dense 0-based indices in
    the order given (the caller sorts deterministically by habit id).
    """
    candidates: list[DetectionCandidate] = []
    for habit in habits:
        goal = _pick_representative(sorted(habit.goals, key=lambda g: g.id or 0))
        if goal is None or goal.id is None:
            continue  # goal-less habits have nothing to check off
        candidates.append(
            DetectionCandidate(
                index=len(candidates),
                target_type=_HABIT_TARGET,
                target_id=goal.id,
                name=habit.name,
            ),
        )
    return candidates


async def _practice_candidates(
    session: AsyncSession, user_id: int, *, start_index: int
) -> list[DetectionCandidate]:
    """The user's active practices as candidates, dense-indexed after the habits.

    A practice is active while ``end_date IS NULL``; its display name is the
    user's custom name or the catalog name (:func:`effective_name`). The target
    is the ``UserPractice`` row, so accept logs a journal-attested
    ``PracticeSession`` against it (#821).
    """
    result = await session.execute(
        select(UserPractice, Practice)
        .join(Practice, col(Practice.id) == UserPractice.practice_id)
        .where(UserPractice.user_id == user_id, col(UserPractice.end_date).is_(None))
        .order_by(col(UserPractice.id)),
    )
    candidates: list[DetectionCandidate] = []
    for user_practice, practice in result.all():
        if user_practice.id is None:
            continue
        candidates.append(
            DetectionCandidate(
                index=start_index + len(candidates),
                target_type=_PRACTICE_TARGET,
                target_id=user_practice.id,
                name=effective_name(practice, user_practice),
            ),
        )
    return candidates


def _capped(candidates: list[DetectionCandidate], user_id: int) -> list[DetectionCandidate]:
    """Truncate to :data:`MAX_CANDIDATES`, warning when habits are dropped."""
    if len(candidates) <= MAX_CANDIDATES:
        return candidates
    logger.warning(
        "completion_candidates_truncated",
        extra={"user_id": user_id, "found": len(candidates), "cap": MAX_CANDIDATES},
    )
    return candidates[:MAX_CANDIDATES]


async def gather_candidates(
    session: AsyncSession,
    user_id: int,
    *,
    include_practices: bool = False,
) -> list[DetectionCandidate]:
    """Build the user's active habits into dense, capped detection candidates.

    Loads habits with their goals eager (no N+1), picks the representative goal
    per habit (clear-tier, else first), skips goal-less habits, stamps dense
    0-based indices in habit-id order, and truncates to :data:`MAX_CANDIDATES`.

    With ``include_practices`` (default off), the user's active practices are
    appended after the habits, sharing the same :data:`MAX_CANDIDATES` budget and
    continuing the dense index, so accept can log a journal-attested
    PracticeSession against the resolved UserPractice (#821).
    """
    result = await session.execute(
        select(Habit)
        .where(Habit.user_id == user_id)
        .options(HABIT_WITH_GOALS)
        .order_by(col(Habit.id)),
    )
    habits = list(result.scalars().all())
    candidates = _habit_candidates(habits)
    if include_practices:
        candidates += await _practice_candidates(session, user_id, start_index=len(candidates))
    return _capped(candidates, user_id)
