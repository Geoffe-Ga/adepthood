"""Domain logic for computing stage progress and unlock status."""

from __future__ import annotations

from datetime import datetime
from typing import cast

from sqlalchemy import case, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.constants import TOTAL_STAGES
from domain.program_calendar import calendar_stage, resolve_program_anchor
from models.content_completion import ContentCompletion
from models.course_stage import CourseStage
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.practice import Practice
from models.practice_session import PracticeSession
from models.stage_content import StageContent
from models.stage_progress import StageProgress
from models.user_practice import UserPractice
from schemas.stage import HabitHistoryItem, PracticeHistoryItem

# Stage 1 is always unlocked regardless of progress state.
_STAGE_1 = 1

__all__ = [
    "TOTAL_STAGES",
    "AllStagesCompletedError",
    "compute_stage_progress",
    "compute_stage_progress_batch",
    "ensure_user_progress",
    "get_stage_habit_history",
    "get_stage_practice_history",
    "get_user_progress",
    "get_user_progress_for_update",
    "is_stage_unlocked",
    "next_stage_for",
    "stage_exists",
]


class AllStagesCompletedError(Exception):
    """Raised by :func:`next_stage_for` when every stage is already completed.

    Keeping this as a plain domain exception — not ``HTTPException`` — lets
    non-HTTP callers (admin tooling, async tasks, tests) use the helper
    without pulling in FastAPI's transport layer.  Router code is responsible
    for catching this and mapping it to the appropriate HTTP response.
    """


async def get_user_progress(session: AsyncSession, user_id: int) -> StageProgress | None:
    """Fetch the StageProgress record for a user, or None."""
    result = await session.execute(select(StageProgress).where(StageProgress.user_id == user_id))
    return result.scalars().first()


async def get_user_progress_for_update(session: AsyncSession, user_id: int) -> StageProgress | None:
    """Fetch the StageProgress record with a ``FOR UPDATE`` row lock.

    Use this in mutation endpoints to prevent TOCTOU races (e.g. two
    concurrent advance requests both reading the same current_stage).
    The lock is held until the transaction commits or rolls back.
    """
    result = await session.execute(
        select(StageProgress).where(StageProgress.user_id == user_id).with_for_update()
    )
    return result.scalars().first()


async def ensure_user_progress(session: AsyncSession, user_id: int) -> StageProgress:
    """Return the user's :class:`StageProgress`, provisioning a stage-1 row on first access.

    Commits the new row before returning: a concurrent caller that loses the
    SAVEPOINT race must re-read the winner's committed row, and ``get_session``
    does not auto-commit. Callers must therefore not hold uncommitted writes
    across this call. Mirrors ``_create_initial_progress`` in ``stages.py``.
    """
    progress = await get_user_progress(session, user_id)
    if progress is not None:
        return progress
    progress = StageProgress(user_id=user_id, current_stage=_STAGE_1, completed_stages=[])
    try:
        async with session.begin_nested():
            session.add(progress)
        await session.commit()
        await session.refresh(progress)
    except IntegrityError as exc:
        existing = await get_user_progress(session, user_id)
        if existing is None:
            msg = "StageProgress creation lost the race but the winner's row is missing"
            raise RuntimeError(msg) from exc
        return existing
    return progress


def expected_completed_stages(current_stage: int) -> set[int]:
    """Return the stages a row at ``current_stage`` must have completed.

    The invariant set is ``{1 .. current_stage - 1}``.
    """
    return set(range(1, current_stage))


def completed_stage_gap(completed: set[int], current_stage: int) -> tuple[set[int], set[int]]:
    """Return ``(missing, extra)`` for a stage-progress row.

    The invariant every stage mutation must preserve is
    ``set(completed) == {1..current_stage-1}``. ``missing`` are stages that
    should be marked complete but aren't; ``extra`` are stages credited beyond
    the expected range. Both empty means the row is contiguous. This is the
    canonical owner of the gap math the admin router used to inline twice.
    """
    expected = expected_completed_stages(current_stage)
    return expected - completed, completed - expected


def is_stage_unlocked(
    stage_number: int, progress: StageProgress | None, now: datetime | None = None
) -> bool:
    """Return True iff the stage is open by advancement OR by the calendar.

    Advancement: ``N <= current_stage``, which only moves via the
    validated router path (advance must equal ``current + 1``).
    Calendar (issue #386): ``N <= calendar_stage(anchor)``, the same
    date-derived schedule the frontend renders, so the server never 403s
    a stage the user can see is open.  ``max`` of the two means time can
    OPEN stages but never revoke advancement-granted access — and the
    calendar itself is server-computed, so a client cannot skip ahead of
    the schedule.
    """
    if stage_number == _STAGE_1:
        return True
    if progress is None:
        return False
    unlocked_through = max(
        progress.current_stage,
        calendar_stage(resolve_program_anchor(progress), now),
    )
    return stage_number <= unlocked_through


def next_stage_for(progress: StageProgress | None) -> int:
    """Return ``current_stage + 1`` (or 1 for fresh users); raises at the curriculum end."""
    if progress is None:
        return _STAGE_1
    if progress.current_stage >= TOTAL_STAGES:
        raise AllStagesCompletedError
    return progress.current_stage + 1


async def _compute_habits_progress(
    session: AsyncSession, user_id: int, stage_number: int
) -> tuple[float, bool]:
    """Return ``(progress, present)`` for the stage's habit component.

    ``progress`` is the ratio of habits with ≥1 completion to total habits;
    ``present`` is whether the stage has any habits at all. A stage with no
    habits reports ``(0.0, False)`` so it is excluded from the overall average
    rather than dragging it down as a 0% component.
    """
    stage_str = str(stage_number)
    # Count total habits for this stage
    total_result = await session.execute(
        select(func.count())
        .select_from(Habit)
        .where(Habit.user_id == user_id, Habit.stage == stage_str)
    )
    total_habits: int = total_result.scalar() or 0
    if total_habits == 0:
        return 0.0, False

    # Count habits that have at least one GoalCompletion (via Goal)
    active_result = await session.execute(
        select(func.count(func.distinct(Habit.id)))
        .select_from(Habit)
        .join(Goal, col(Goal.habit_id) == col(Habit.id))
        .join(
            GoalCompletion,
            (col(GoalCompletion.goal_id) == col(Goal.id))
            & (col(GoalCompletion.user_id) == user_id),
        )
        .where(Habit.user_id == user_id, Habit.stage == stage_str)
    )
    active_habits: int = active_result.scalar() or 0
    return min(active_habits / total_habits, 1.0), True


async def _compute_course_items_completed(
    session: AsyncSession, user_id: int, stage_number: int
) -> int:
    """Count content items completed by the user for a given stage."""
    result = await session.execute(
        select(func.count())
        .select_from(ContentCompletion)
        .join(StageContent, col(ContentCompletion.content_id) == col(StageContent.id))
        .join(CourseStage, col(StageContent.course_stage_id) == col(CourseStage.id))
        .where(
            ContentCompletion.user_id == user_id,
            CourseStage.stage_number == stage_number,
        )
    )
    return result.scalar() or 0


async def _compute_course_items_total(session: AsyncSession, stage_number: int) -> int:
    """Count the content items that exist for a stage (the course denominator).

    Stage content is global (not per-user), so this is the total a user's
    completed count is measured against to derive a ``[0, 1]`` fraction.
    """
    result = await session.execute(
        select(func.count())
        .select_from(StageContent)
        .join(CourseStage, col(StageContent.course_stage_id) == col(CourseStage.id))
        .where(CourseStage.stage_number == stage_number)
    )
    return result.scalar() or 0


async def _count_user_practices(session: AsyncSession, user_id: int, stage_number: int) -> int:
    """Count the user's selected practices for a stage (the practice presence signal).

    Used to decide whether the practice component is part of the stage at all —
    a stage the user has selected practices for counts practice in the overall
    average (as 0% until they log a session), whereas a stage with none excludes
    it entirely rather than reporting a permanent 0.
    """
    result = await session.execute(
        select(func.count())
        .select_from(UserPractice)
        .where(UserPractice.user_id == user_id, UserPractice.stage_number == stage_number)
    )
    return result.scalar() or 0


def _average_present(components: list[tuple[float, bool]]) -> float:
    """Average the ``value`` of every present component, or ``0.0`` if none are.

    The overall stage percentage is the mean of the components that actually
    have data for the stage (habits, practice, course) — so the divisor adapts
    instead of always being a hardcoded 2, and a stage with a single component
    reports that component's progress directly.
    """
    present = [value for value, is_present in components if is_present]
    return sum(present) / len(present) if present else 0.0


async def compute_stage_progress(
    session: AsyncSession,
    user_id: int,
    stage_number: int,
) -> dict[str, float | int]:
    """Compute detailed progress for a user in a specific stage."""
    # Count practice sessions for this stage (join through UserPractice)
    ps_result = await session.execute(
        select(func.count())
        .select_from(PracticeSession)
        .join(UserPractice, col(PracticeSession.user_practice_id) == col(UserPractice.id))
        .where(
            PracticeSession.user_id == user_id,
            UserPractice.stage_number == stage_number,
        )
    )
    practice_count: int = ps_result.scalar() or 0

    habits_progress, habits_present = await _compute_habits_progress(session, user_id, stage_number)
    practice_present = await _count_user_practices(session, user_id, stage_number) > 0
    course_items = await _compute_course_items_completed(session, user_id, stage_number)
    course_total = await _compute_course_items_total(session, stage_number)

    # Overall = mean of the components that have data; course completion now
    # moves the headline number, and the divisor adapts to what's present.
    course_progress = min(course_items / course_total, 1.0) if course_total else 0.0
    overall = _average_present(
        [
            (habits_progress, habits_present),
            (1.0 if practice_count > 0 else 0.0, practice_present),
            (course_progress, course_total > 0),
        ]
    )

    return {
        "habits_progress": round(habits_progress, 2),
        "practice_sessions_completed": practice_count,
        "course_items_completed": course_items,
        "overall_progress": round(overall, 2),
    }


async def _batch_habit_metrics(session: AsyncSession, user_id: int) -> dict[str, tuple[int, int]]:
    """Per-stage ``(total_habits, active_habits)`` for a user in one query.

    ``active_habits`` counts habits with ≥1 of the user's completions; an
    outer join keeps habits with no goals/completions in the total. Keyed by
    the habit's ``stage`` string (habits store stage as text).
    """
    result = await session.execute(
        select(
            Habit.stage,
            func.count(func.distinct(Habit.id)).label("total"),
            func.count(func.distinct(case((col(GoalCompletion.id).isnot(None), Habit.id)))).label(
                "active"
            ),
        )
        .select_from(Habit)
        .outerjoin(Goal, col(Goal.habit_id) == col(Habit.id))
        .outerjoin(
            GoalCompletion,
            (col(GoalCompletion.goal_id) == col(Goal.id))
            & (col(GoalCompletion.user_id) == user_id),
        )
        .where(Habit.user_id == user_id)
        .group_by(col(Habit.stage))
    )
    return {row.stage: (row.total, row.active) for row in result.all()}


async def _batch_practice_metrics(
    session: AsyncSession, user_id: int
) -> dict[int, tuple[int, int]]:
    """Per-stage ``(selected_practices, sessions)`` for a user in one query.

    Based on ``UserPractice`` (outer-joined to sessions) so the practice
    component's *presence* is "the user selected a practice for this stage",
    independent of whether any session was logged — matching the per-stage
    :func:`_count_user_practices` presence signal.
    """
    result = await session.execute(
        select(
            UserPractice.stage_number,
            func.count(func.distinct(UserPractice.id)).label("selected"),
            func.count(col(PracticeSession.id)).label("sessions"),
        )
        .select_from(UserPractice)
        .outerjoin(
            PracticeSession,
            (col(PracticeSession.user_practice_id) == col(UserPractice.id))
            & (col(PracticeSession.user_id) == user_id),
        )
        .where(UserPractice.user_id == user_id)
        .group_by(col(UserPractice.stage_number))
    )
    return {row.stage_number: (row.selected, row.sessions) for row in result.all()}


async def _batch_course_metrics(session: AsyncSession, user_id: int) -> dict[int, tuple[int, int]]:
    """Per-stage ``(total_items, completed_items)`` for a user in one query.

    Based on ``StageContent`` (outer-joined to the user's completions) so the
    course component carries both its denominator (presence) and the user's
    completed count for the ``[0, 1]`` fraction folded into overall progress.
    """
    result = await session.execute(
        select(
            CourseStage.stage_number,
            func.count(func.distinct(StageContent.id)).label("total"),
            func.count(func.distinct(ContentCompletion.id)).label("completed"),
        )
        .select_from(StageContent)
        .join(CourseStage, col(StageContent.course_stage_id) == col(CourseStage.id))
        .outerjoin(
            ContentCompletion,
            (col(ContentCompletion.content_id) == col(StageContent.id))
            & (col(ContentCompletion.user_id) == user_id),
        )
        .group_by(col(CourseStage.stage_number))
    )
    return {row.stage_number: (row.total, row.completed) for row in result.all()}


def _assemble_stage_progress(
    stage_number: int,
    habit_metrics: dict[str, tuple[int, int]],
    practice_metrics: dict[int, tuple[int, int]],
    course_metrics: dict[int, tuple[int, int]],
) -> dict[str, float | int]:
    """Build one stage's progress dict from the batched lookups (parity with the loop)."""
    total_habits, active_habits = habit_metrics.get(str(stage_number), (0, 0))
    habits_progress = min(active_habits / total_habits, 1.0) if total_habits > 0 else 0.0
    selected, sessions = practice_metrics.get(stage_number, (0, 0))
    total_course, completed_course = course_metrics.get(stage_number, (0, 0))
    course_progress = min(completed_course / total_course, 1.0) if total_course > 0 else 0.0
    overall = _average_present(
        [
            (habits_progress, total_habits > 0),
            (1.0 if sessions > 0 else 0.0, selected > 0),
            (course_progress, total_course > 0),
        ]
    )
    return {
        "habits_progress": round(habits_progress, 2),
        "practice_sessions_completed": sessions,
        "course_items_completed": completed_course,
        "overall_progress": round(overall, 2),
    }


async def compute_stage_progress_batch(
    session: AsyncSession,
    user_id: int,
    stage_numbers: list[int],
) -> dict[int, dict[str, float | int]]:
    """Batched equivalent of :func:`compute_stage_progress` for many stages.

    Issues exactly three grouped queries (habits, practice sessions, course
    items) regardless of stage count, then assembles a per-stage mapping with
    values identical to calling :func:`compute_stage_progress` per stage —
    eliminating the N+1 on ``list_stages`` (issue #473). Returns ``{}`` for an
    empty ``stage_numbers``.

    The helpers deliberately ``GROUP BY`` the user's whole dataset with no
    ``IN (stage_numbers)`` filter: the curriculum is ≤36 stages, so the group
    set is tiny and one grouped scan beats a parameterised per-stage filter
    here. ``stage_numbers`` only selects which groups land in the result.
    """
    if not stage_numbers:
        return {}
    habit_metrics = await _batch_habit_metrics(session, user_id)
    practice_metrics = await _batch_practice_metrics(session, user_id)
    course_metrics = await _batch_course_metrics(session, user_id)
    return {
        stage_number: _assemble_stage_progress(
            stage_number, habit_metrics, practice_metrics, course_metrics
        )
        for stage_number in stage_numbers
    }


async def stage_exists(session: AsyncSession, stage_number: int) -> bool:
    """Check if a stage with the given number exists."""
    result = await session.execute(
        select(CourseStage).where(CourseStage.stage_number == stage_number)
    )
    return result.scalars().first() is not None


async def get_stage_practice_history(
    session: AsyncSession,
    user_id: int,
    stage_number: int,
) -> list[PracticeHistoryItem]:
    """Aggregate practice session history for a user in a specific stage."""
    # Get all user-practices for this stage, joined with Practice for names
    result = await session.execute(
        select(
            Practice.name,
            func.count(col(PracticeSession.id)).label("sessions_completed"),
            func.coalesce(func.sum(PracticeSession.duration_minutes), 0).label("total_minutes"),
            func.max(PracticeSession.timestamp).label("last_session"),
        )
        .select_from(PracticeSession)
        .join(UserPractice, col(PracticeSession.user_practice_id) == col(UserPractice.id))
        .join(Practice, col(UserPractice.practice_id) == col(Practice.id))
        .where(
            PracticeSession.user_id == user_id,
            UserPractice.stage_number == stage_number,
        )
        .group_by(Practice.name)
    )
    rows = result.all()
    return [
        PracticeHistoryItem(
            name=row.name,
            sessions_completed=row.sessions_completed,
            total_minutes=float(row.total_minutes),
            last_session=row.last_session,
        )
        for row in rows
    ]


async def _fetch_stage_habits(
    session: AsyncSession, user_id: int, stage_number: int
) -> list[Habit]:
    """Return the user's habits for a stage, ordered by id for deterministic output."""
    stage_str = str(stage_number)
    result = await session.execute(
        select(Habit)
        .where(Habit.user_id == user_id, Habit.stage == stage_str)
        .order_by(col(Habit.id).asc())
    )
    return list(result.scalars().all())


async def _fetch_goal_completion_stats(
    session: AsyncSession, user_id: int, habit_ids: list[int]
) -> dict[int, dict[str, int]]:
    """Return ``{habit_id: {tier: completion_count}}`` in a single JOIN query.

    A LEFT OUTER JOIN keeps goals without any completions in the result set,
    so callers can still mark their tier as ``False``. The user filter is on
    the join condition (not the WHERE clause) so a goal with only *other*
    users' completions still surfaces with ``count == 0``.
    """
    if not habit_ids:
        return {}

    result = await session.execute(
        select(
            Goal.habit_id,
            Goal.tier,
            func.count(col(GoalCompletion.id)).label("completion_count"),
        )
        .select_from(Goal)
        .outerjoin(
            GoalCompletion,
            (col(GoalCompletion.goal_id) == col(Goal.id))
            & (col(GoalCompletion.user_id) == user_id),
        )
        .where(col(Goal.habit_id).in_(habit_ids))
        .group_by(col(Goal.habit_id), col(Goal.tier))
    )

    stats: dict[int, dict[str, int]] = {hid: {} for hid in habit_ids}
    for row in result.all():
        stats[row.habit_id][row.tier] = int(row.completion_count or 0)
    return stats


def _build_history_item(habit: Habit, tier_counts: dict[str, int]) -> HabitHistoryItem:
    """Roll a habit's per-tier completion counts up into a history item."""
    return HabitHistoryItem(
        name=habit.name,
        icon=habit.icon,
        goals_achieved={tier: count > 0 for tier, count in tier_counts.items()},
        best_streak=habit.streak,
        total_completions=sum(tier_counts.values()),
    )


async def get_stage_habit_history(
    session: AsyncSession,
    user_id: int,
    stage_number: int,
) -> list[HabitHistoryItem]:
    """Aggregate habit and goal history for a user in a specific stage.

    Habits are matched by their ``stage`` field against the stage_number
    (converted to string). The previous implementation issued one query per
    habit *and* one per goal, scaling as ``1 + 2*habits + goals`` queries
    (26+ queries for a typical stage). This implementation collapses the work
    into two queries regardless of habit/goal count: one to fetch the habits,
    and one JOIN-aggregate to count completions per (habit, tier).
    """
    habits = await _fetch_stage_habits(session, user_id, stage_number)
    # Habits returned by SELECT always have a primary key assigned; the cast is
    # a static-typing hint, not a runtime guard, so it costs nothing here.
    habit_ids = [cast("int", h.id) for h in habits]
    stats_by_habit = await _fetch_goal_completion_stats(session, user_id, habit_ids)
    return [_build_history_item(h, stats_by_habit.get(cast("int", h.id), {})) for h in habits]
