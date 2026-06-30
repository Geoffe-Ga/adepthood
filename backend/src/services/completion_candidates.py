"""Gather a user's tracked habits as detection candidates.

Turns the caller's current habits into the ``DetectionCandidate`` list that
:func:`domain.detection.detect_completions` consumes, so the check-off endpoint
(#817) stays thin. Habits only for now; practices ride a dormant
``include_practices`` flag that issue #821 fills in.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.detection import DetectionCandidate
from load_options import HABIT_WITH_GOALS
from models.goal import Goal, GoalTier
from models.habit import Habit

logger = logging.getLogger(__name__)

# Upper bound on the candidate list handed to the LLM, to keep the prompt (and
# its cost) bounded for users with many habits.
MAX_CANDIDATES = 25

_HABIT_TARGET = "habit"


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

    ``include_practices`` is a dormant seam (default off) wired up by issue #821:
    journal-attested PracticeSessions will become candidates here. It is a no-op
    today so the endpoint (#817) can already pass the flag through.
    """
    result = await session.execute(
        select(Habit)
        .where(Habit.user_id == user_id)
        .options(HABIT_WITH_GOALS)
        .order_by(col(Habit.id)),
    )
    habits = list(result.scalars().all())
    _ = include_practices  # dormant until #821
    return _capped(_habit_candidates(habits), user_id)
