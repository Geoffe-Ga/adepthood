"""Shared goal check-in recording.

The streak / accumulation / milestone logic that backs
``POST /goal_completions/`` lives here so other callers (the journal resonance
accept flow, #818) record a completion through the EXACT same path — one stored
row per goal/day, identical streak + milestone math — rather than reimplementing
it. Legacy amount-less calls stay idempotent; explicit signed amounts adjust the
row on every call.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from datetime import date, datetime
from typing import cast

from fastapi import HTTPException, status
from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError, MultipleResultsFound
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.dates import (
    MAX_BACKFILL_DAYS,
    DayWindow,
    day_bounds_in_tz,
    day_window_verdict,
    today_in_tz,
)
from domain.streaks import is_scheduled_on
from errors import bad_request
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from schemas import CheckInResult
from schemas.checkin import CheckInReasonCode
from schemas.milestone import Milestone
from services.goal_completion_idempotency import (
    GoalCompletionIntent,
    claim_goal_completion_operation,
)
from services.streaks import (
    PendingCompletion,
    StreakScope,
    SubtractiveContext,
    check_milestones,
    compute_consecutive_streak,
    compute_habit_streak,
    compute_streak_before_and_after,
    subtractive_context_for_goals,
)

logger = logging.getLogger(__name__)

_DEFAULT_THRESHOLDS = [1, 3, 7, 14, 30]

# Refusal detail per non-``ok`` window verdict.  A mapping rather than a
# branch chain so the predicate (``domain.dates.day_window_verdict``) owns
# the day math and this module owns only the HTTP remedy.
_WINDOW_REFUSALS: dict[DayWindow, str] = {
    "future": "completion_date_in_future",
    "too_old": "completion_date_too_old",
}


@dataclass(frozen=True)
class _CheckInJob:
    """Inputs to ``_persist_and_build_response`` / ``_try_persist_or_idempotent``."""

    goal_id: int
    habit_id: int
    completed_units: float
    explicit_units: bool
    user_id: int
    user_timezone: str
    did_complete: bool
    old_streak: int
    new_streak: int
    # The user-local calendar day the completion belongs to; stored on the row
    # as the per-user-day uniqueness key.
    target_day: date
    # Explicit completion time for a backfilled past day; ``None`` lets the
    # ``GoalCompletion`` model default (``datetime.now(UTC)``) stand.
    timestamp: datetime | None
    # Subtractive-habit context for the streak computation: a no-log day
    # on an "abstain from sugar" habit is success, not a chain break.
    # ``None`` selects the additive code path.
    subtractive: SubtractiveContext | None


@dataclass(frozen=True)
class _ResponseScope:
    """Identity, calendar, and polarity needed to build a check-in response."""

    goal_id: int
    habit_id: int
    user_id: int
    user_timezone: str
    day: date
    subtractive: SubtractiveContext | None


async def _completion_on_day(
    session: AsyncSession,
    scope: _ResponseScope,
    *,
    lock: bool = False,
) -> GoalCompletion | None:
    """Load the canonical goal/day row, optionally locking it for adjustment.

    ``local_day`` is both the service's write key and the database uniqueness
    key. A timestamp is audit provenance, not a day identity: reinterpreting it
    after an account-timezone change can select the wrong historical row.
    """
    statement = select(GoalCompletion).where(
        GoalCompletion.goal_id == scope.goal_id,
        GoalCompletion.user_id == scope.user_id,
        GoalCompletion.local_day == scope.day,
    )
    if lock:
        statement = statement.with_for_update()
    result = await session.execute(statement)
    return result.scalar_one_or_none()


async def _habit_day_units(
    session: AsyncSession,
    habit_id: int,
    user_id: int,
    day: date,
) -> float:
    """Sum all tier rows into the authoritative habit total for ``day``."""
    result = await session.execute(
        select(func.coalesce(func.sum(GoalCompletion.completed_units), 0.0))
        .join(Goal, col(Goal.id) == col(GoalCompletion.goal_id))
        .where(
            Goal.habit_id == habit_id,
            GoalCompletion.user_id == user_id,
            GoalCompletion.local_day == day,
        )
    )
    return float(result.scalar_one())


async def _lock_habit_for_check_in(session: AsyncSession, habit_id: int) -> None:
    """Serialize every check-in mutation for one habit.

    Goal rows are tier provenance while the arithmetic belongs to the whole
    habit/day. Locking only one goal row cannot serialize a correction against a
    simultaneous write to another tier, and locking only existing completion
    rows cannot protect the first insert. The durable parent habit is the one
    stable lock target shared by every tier and every day-total mutation.
    """
    if session.get_bind().dialect.name == "sqlite":
        # SQLite ignores SELECT .. FOR UPDATE. A no-op DML statement acquires
        # its database writer lane before any completion row is read, which
        # gives local/test deployments the same serialization invariant.
        await session.execute(update(Habit).where(col(Habit.id) == habit_id).values(id=habit_id))
        return
    await session.execute(select(Habit.id).where(Habit.id == habit_id).with_for_update())


async def _habit_day_completions(
    session: AsyncSession,
    habit_id: int,
    user_id: int,
    day: date,
) -> list[GoalCompletion]:
    """Load every locked tier row contributing to one canonical habit/day."""
    result = await session.execute(
        select(GoalCompletion)
        .join(Goal, col(Goal.id) == col(GoalCompletion.goal_id))
        .where(
            Goal.habit_id == habit_id,
            GoalCompletion.user_id == user_id,
            GoalCompletion.local_day == day,
        )
        .order_by(col(GoalCompletion.id).desc())
        .with_for_update()
    )
    return list(result.scalars().all())


async def _habit_streak(
    session: AsyncSession,
    habit_id: int,
    user_id: int,
    user_timezone: str,
    subtractive: SubtractiveContext | None,
) -> int:
    """Compute the streak from every tier, matching the habit reload path."""
    result = await session.execute(
        select(GoalCompletion)
        .join(Goal, col(Goal.id) == col(GoalCompletion.goal_id))
        .where(
            Goal.habit_id == habit_id,
            GoalCompletion.user_id == user_id,
        )
    )
    return compute_habit_streak(
        list(result.scalars().all()),
        user_timezone,
        subtractive,
    )


async def _idempotent_already_logged_response(
    session: AsyncSession,
    scope: _ResponseScope,
) -> CheckInResult:
    """Build the ``already_logged_today`` response shape used by both fast + race paths."""
    streak = await compute_consecutive_streak(
        session,
        scope.goal_id,
        scope.user_id,
        scope.user_timezone,
        scope.subtractive,
    )
    return CheckInResult(
        streak=streak,
        milestones=[],
        reason_code="already_logged_today",
        day_units=await _habit_day_units(session, scope.habit_id, scope.user_id, scope.day),
    )


async def _subtractive_context_for_goal(
    session: AsyncSession, habit: Habit
) -> SubtractiveContext | None:
    """Build the subtractive-streak context for the habit, else ``None``.

    The parent habit arrives without eager relationships, so load its complete
    ladder explicitly and pass it to the same pure polarity helper used by the
    habit list. Looking only at the posted tier made partial direction flips
    report an additive check-in streak and a subtractive list streak.
    """
    result = await session.execute(
        select(Goal).where(Goal.habit_id == habit.id).order_by(col(Goal.id))
    )
    try:
        return subtractive_context_for_goals(result.scalars().all(), habit.start_date)
    except MultipleResultsFound as exc:
        logger.exception(
            "subtractive_check_in_duplicate_clear_goal",
            extra={"habit_id": habit.id, "user_id": habit.user_id},
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="duplicate_clear_tier_goals",
        ) from exc


def _held_response(
    current_user: int, goal_id: int, old_streak: int, day_units: float
) -> CheckInResult:
    """Return ``streak_held`` without inserting a row -- naturally idempotent on retry."""
    logger.info(
        "goal_completion_held",
        extra={"user_id": current_user, "goal_id": goal_id, "streak": old_streak},
    )
    return CheckInResult(
        streak=old_streak,
        milestones=[],
        reason_code="streak_held",
        day_units=day_units,
    )


def _resolve_target_day(completed_on: date | None, user_timezone: str) -> date:
    """Return the calendar day to log against.

    Defaults to the user's today when ``completed_on`` is omitted. Rejects a
    future date, and a backfill older than ``MAX_BACKFILL_DAYS`` days.
    """
    today = today_in_tz(user_timezone)
    target_day = completed_on or today
    verdict = day_window_verdict(target_day, today=today, max_backfill_days=MAX_BACKFILL_DAYS)
    refusal = _WINDOW_REFUSALS.get(verdict)
    if refusal is not None:
        raise bad_request(refusal)
    return target_day


def _completion_timestamp(completed_on: date | None, user_timezone: str) -> datetime | None:
    """Stored timestamp for the completion row.

    ``None`` lets the model default (now) stand for a same-day log. For a
    backfilled day, anchors mid-day in the user's TZ so the value lands
    unambiguously inside that local calendar day regardless of DST shoulder
    days. Per-day uniqueness is keyed off ``local_day``, not this timestamp.
    """
    if completed_on is None:
        return None
    start, end = day_bounds_in_tz(user_timezone, completed_on)
    return start + (end - start) / 2


def _reason_for_streak_transition(old_streak: int, new_streak: int) -> CheckInReasonCode:
    """Map the actual streak change to a reason code (#782).

    Derived from the real (subtractive-aware) ``new_streak`` rather than the
    additive ``update_streak`` heuristic, so the flag never contradicts the
    number it ships with: a subtractive transgression that zeroes the streak
    reads ``streak_reset``, not ``streak_incremented``. (The
    ``already_logged_today`` case is handled before this point.)
    """
    if new_streak > old_streak:
        return "streak_incremented"
    if new_streak < old_streak:
        return "streak_reset"
    return "streak_held"


async def _persist_and_build_response(session: AsyncSession, job: _CheckInJob) -> CheckInResult:
    """Persist the completion and build a CheckInResult; streak values arrive pre-computed."""
    completion = GoalCompletion(
        goal_id=job.goal_id,
        user_id=job.user_id,
        local_day=job.target_day,
        completed_units=max(0.0, job.completed_units)
        if job.explicit_units
        else job.completed_units,
    )
    if job.timestamp is not None:
        completion.timestamp = job.timestamp
    async with session.begin_nested():
        session.add(completion)
        await session.flush()
    await session.commit()
    # ``new_streak`` was computed alongside ``old_streak`` from one history read
    # (issue dedup); these are pure derivations, no DB recompute. The reason code
    # is derived from the actual transition so it can't contradict new_streak.
    reason = _reason_for_streak_transition(job.old_streak, job.new_streak)
    milestones = check_milestones(job.new_streak, _DEFAULT_THRESHOLDS, job.old_streak)
    logger.info(
        "goal_completion_recorded",
        extra={
            "user_id": job.user_id,
            "goal_id": job.goal_id,
            "did_complete": job.did_complete,
            "streak": job.new_streak,
        },
    )
    return CheckInResult(
        streak=job.new_streak,
        milestones=milestones,
        reason_code=reason,
        day_units=await _habit_day_units(session, job.habit_id, job.user_id, job.target_day),
    )


async def _try_persist_or_idempotent(session: AsyncSession, job: _CheckInJob) -> CheckInResult:
    """Persist a legacy write once; an insert-race loser returns the natural-key no-op."""
    try:
        return await _persist_and_build_response(session, job)
    except IntegrityError:
        # Rollback before the follow-up SELECT in case the integrity error
        # surfaced from the outer commit() rather than the savepoint flush --
        # SQLAlchemy marks the session as ``PendingRollbackError`` until
        # rollback() is called and any subsequent query would otherwise raise.
        await session.rollback()
        return await _idempotent_already_logged_response(
            session,
            _ResponseScope(
                job.goal_id,
                job.habit_id,
                job.user_id,
                job.user_timezone,
                job.target_day,
                job.subtractive,
            ),
        )


def _subtract_across_tiers(
    rows: list[GoalCompletion],
    provenance_goal_id: int,
    signed_delta: float,
) -> None:
    """Apply a negative habit/day delta across tier rows, never below zero.

    The posted row is consumed first because it records where the correction
    originated. If that row cannot satisfy the whole correction, the remaining
    newest tier rows are consumed in stable order. The exact distribution is
    provenance; the invariant exposed to the writer is the habit/day sum.
    """
    remaining = -signed_delta
    ordered = sorted(rows, key=lambda row: row.goal_id != provenance_goal_id)
    for row in ordered:
        if remaining <= 0:
            return
        available = max(0.0, row.completed_units)
        deduction = min(available, remaining)
        row.completed_units = available - deduction
        remaining -= deduction


async def _explicit_replay_response(session: AsyncSession, job: _CheckInJob) -> CheckInResult:
    """Return current authoritative state without reapplying a spent operation."""
    streak = await _habit_streak(
        session,
        job.habit_id,
        job.user_id,
        job.user_timezone,
        job.subtractive,
    )
    return CheckInResult(
        streak=streak,
        milestones=[],
        reason_code="units_adjusted",
        day_units=await _habit_day_units(session, job.habit_id, job.user_id, job.target_day),
    )


async def _replay_if_operation_spent(
    session: AsyncSession,
    job: _CheckInJob,
    idempotency_key: str | None,
) -> CheckInResult | None:
    """Claim a keyed delta, returning authoritative state when it was spent."""
    if idempotency_key is None:
        return None
    claimed = await claim_goal_completion_operation(
        session,
        job.user_id,
        idempotency_key,
        GoalCompletionIntent(job.goal_id, job.target_day, job.completed_units),
    )
    if claimed:
        return None
    # End the snapshot that observed/contended on the receipt before reading
    # the winner's arithmetic. SQLite can otherwise retain the pre-winner view.
    await session.rollback()
    return await _explicit_replay_response(session, job)


def _new_explicit_completion(job: _CheckInJob) -> GoalCompletion:
    """Build the canonical row for an explicit mutation's first tier/day write."""
    completion = GoalCompletion(
        goal_id=job.goal_id,
        user_id=job.user_id,
        local_day=job.target_day,
        completed_units=max(0.0, job.completed_units),
    )
    if job.timestamp is not None:
        completion.timestamp = job.timestamp
    return completion


async def _apply_explicit_delta(session: AsyncSession, job: _CheckInJob) -> bool:
    """Mutate canonical tier rows and report whether this adjusted an existing day."""
    rows = await _habit_day_completions(
        session,
        job.habit_id,
        job.user_id,
        job.target_day,
    )
    existing = next((row for row in rows if row.goal_id == job.goal_id), None)
    if job.completed_units < 0:
        _subtract_across_tiers(rows, job.goal_id, job.completed_units)
        return True
    if existing is not None:
        existing.completed_units = max(0.0, existing.completed_units + job.completed_units)
        return True
    session.add(_new_explicit_completion(job))
    return bool(rows)


def _explicit_response_metadata(
    old_streak: int,
    new_streak: int,
    *,
    adjusted_existing: bool,
) -> tuple[CheckInReasonCode, list[Milestone]]:
    """Derive one explicit write's reason and newly crossed milestones."""
    if adjusted_existing:
        return "units_adjusted", []
    return (
        _reason_for_streak_transition(old_streak, new_streak),
        check_milestones(new_streak, _DEFAULT_THRESHOLDS, old_streak),
    )


async def _record_explicit_completion(
    session: AsyncSession,
    job: _CheckInJob,
    idempotency_key: str | None,
) -> CheckInResult:
    """Apply one signed operation atomically under the caller's habit lock."""
    replay = await _replay_if_operation_spent(session, job, idempotency_key)
    if replay is not None:
        return replay
    # Resolve mutable state only after the operation claim. The caller's parent
    # lock owns the serialized writer lane; reading earlier would preserve a
    # stale row across that wait and reintroduce lost updates.
    old_streak = await _habit_streak(
        session,
        job.habit_id,
        job.user_id,
        job.user_timezone,
        job.subtractive,
    )
    adjusted_existing = await _apply_explicit_delta(session, job)
    await session.flush()
    new_streak = await _habit_streak(
        session,
        job.habit_id,
        job.user_id,
        job.user_timezone,
        job.subtractive,
    )
    await session.commit()
    reason, milestones = _explicit_response_metadata(
        old_streak,
        new_streak,
        adjusted_existing=adjusted_existing,
    )
    logger.info(
        "goal_completion_units_applied",
        extra={
            "user_id": job.user_id,
            "goal_id": job.goal_id,
            "streak": new_streak,
        },
    )
    return CheckInResult(
        streak=new_streak,
        milestones=milestones,
        reason_code=reason,
        day_units=await _habit_day_units(session, job.habit_id, job.user_id, job.target_day),
    )


@dataclass(frozen=True)
class CheckInContext:
    """An owned, loaded goal + the actor recording against it.

    Bundles the (goal, habit, user, timezone) tuple the recording helpers share
    so callers pass one context instead of four positional arguments.
    """

    goal: Goal
    habit: Habit
    user_id: int
    user_timezone: str


@dataclass(frozen=True)
class CheckInCommand:
    """Writer-supplied values for one check-in operation."""

    did_complete: bool = True
    completed_on: date | None = None
    completed_units: float | None = None
    idempotency_key: str | None = None


_DEFAULT_CHECK_IN_COMMAND = CheckInCommand()


async def current_check_in(session: AsyncSession, ctx: CheckInContext) -> CheckInResult:
    """Current streak for an already-recorded goal, WITHOUT writing a row.

    Used for the idempotent no-op view (e.g. re-accepting an already-accepted
    suggestion) so it never logs a fresh completion.
    """
    goal_id = cast("int", ctx.goal.id)
    subtractive = await _subtractive_context_for_goal(session, ctx.habit)
    return await _idempotent_already_logged_response(
        session,
        _ResponseScope(
            goal_id,
            cast("int", ctx.habit.id),
            ctx.user_id,
            ctx.user_timezone,
            today_in_tz(ctx.user_timezone),
            subtractive,
        ),
    )


async def _held_if_unscheduled(
    session: AsyncSession,
    ctx: CheckInContext,
    *,
    did_complete: bool,
    target_day: date,
    scope: _ResponseScope,
) -> CheckInResult | None:
    """Return the no-write response for an unscheduled miss, if applicable."""
    if did_complete or is_scheduled_on(ctx.habit.notification_days, target_day.strftime("%a")):
        return None
    old_streak = await compute_consecutive_streak(
        session, scope.goal_id, ctx.user_id, ctx.user_timezone, scope.subtractive
    )
    return _held_response(
        ctx.user_id,
        scope.goal_id,
        old_streak,
        await _habit_day_units(session, scope.habit_id, ctx.user_id, target_day),
    )


async def _legacy_existing_response(
    session: AsyncSession,
    scope: _ResponseScope,
    completed_units: float | None,
) -> CheckInResult | None:
    """Return the amount-less natural-key no-op, if this is one."""
    if completed_units is not None:
        return None
    existing = await _completion_on_day(session, scope)
    if existing is None:
        return None
    return await _idempotent_already_logged_response(session, scope)


def _requested_units(goal_target: float, *, did_complete: bool, explicit: float | None) -> float:
    """Resolve a legacy target-sized log or preserve an explicit signed delta."""
    if explicit is not None:
        return explicit
    return goal_target if did_complete else 0.0


def _pending_units(requested_units: float, *, explicit_units: bool) -> float:
    """Model the row an insert would expose to the streak calculation."""
    return max(0.0, requested_units) if explicit_units else requested_units


async def record_goal_completion(
    session: AsyncSession,
    ctx: CheckInContext,
    command: CheckInCommand = _DEFAULT_CHECK_IN_COMMAND,
) -> CheckInResult:
    """Record a check-in for an already-owned goal and return streak + milestones.

    This is the single source of truth for both ``POST /goal_completions/`` and
    the journal accept flow (#818). An omitted ``completed_units`` is idempotent
    on (user, goal, day) and retains the original full-target behavior. An
    explicit signed value adjusts that day's canonical row, floors it at zero,
    and deliberately recomputes the streak: correcting a day below the additive
    completion threshold can reduce the returned streak. ``goal_id`` records
    tier provenance; ``day_units`` sums every tier row for the habit/day.

    The caller is responsible for ownership; ``ctx.goal`` and ``ctx.habit``
    must already be loaded.
    """
    # An already-owned, persisted goal always carries a PK.
    goal_id = cast("int", ctx.goal.id)
    target_day = _resolve_target_day(command.completed_on, ctx.user_timezone)
    subtractive = await _subtractive_context_for_goal(session, ctx.habit)
    habit_id = cast("int", ctx.habit.id)
    response_scope = _ResponseScope(
        goal_id,
        habit_id,
        ctx.user_id,
        ctx.user_timezone,
        target_day,
        subtractive,
    )
    # Every tier shares one parent lock. It serializes day-total arithmetic and
    # also closes the empty-row insert window that row locks cannot cover.
    await _lock_habit_for_check_in(session, habit_id)
    existing_response = await _legacy_existing_response(
        session,
        response_scope,
        command.completed_units,
    )
    if existing_response is not None:
        return existing_response

    # Unscheduled miss holds the current streak without inserting — only the
    # pre-insert streak is needed, so compute it once here.
    held = await _held_if_unscheduled(
        session,
        ctx,
        did_complete=command.did_complete,
        target_day=target_day,
        scope=response_scope,
    )
    if held is not None:
        return held

    # Persist path: derive pre- and post-insert streak from ONE history read.
    requested_units = _requested_units(
        ctx.goal.target,
        did_complete=command.did_complete,
        explicit=command.completed_units,
    )
    job = _CheckInJob(
        goal_id=goal_id,
        habit_id=habit_id,
        completed_units=requested_units,
        explicit_units=command.completed_units is not None,
        user_id=ctx.user_id,
        user_timezone=ctx.user_timezone,
        did_complete=command.did_complete,
        old_streak=0,
        new_streak=0,
        target_day=target_day,
        timestamp=_completion_timestamp(command.completed_on, ctx.user_timezone),
        subtractive=subtractive,
    )
    if command.completed_units is not None:
        return await _record_explicit_completion(session, job, command.idempotency_key)

    old_streak, new_streak = await compute_streak_before_and_after(
        session,
        StreakScope(goal_id, ctx.user_id, ctx.user_timezone, subtractive),
        PendingCompletion(
            target_day,
            _pending_units(
                requested_units,
                explicit_units=command.completed_units is not None,
            ),
        ),
    )
    job = replace(job, old_streak=old_streak, new_streak=new_streak)
    return await _try_persist_or_idempotent(session, job)
