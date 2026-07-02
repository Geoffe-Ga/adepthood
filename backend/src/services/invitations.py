"""Generate persisted invitation signals from a user's readiness aggregates.

This is the DB-aware companion to :mod:`domain.invitations`. It gathers a
user's cross-feature engagement with a bounded, constant number of batched
queries (never one-per-habit or one-per-practice), hands the snapshot to the
pure candidate function, then persists only the candidates that do not already
exist as an ``InvitationSignal`` row.

Deduplication spans *all* prior rows — live and dismissed alike — so a declined
invitation is never silently regenerated. A dismissed row is a present row and
therefore blocks re-creation, honouring "you choose your depth" at the write
boundary. A ``begin_nested`` SAVEPOINT plus an ``IntegrityError`` re-read makes
the insert safe against a concurrent generation pass racing over the
partial-unique indexes, mirroring ``ensure_user_progress`` and
``ensure_depth_preferences``.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.dates import now_in_tz, to_user_date_bucket
from domain.invitations import (
    ENGAGEMENT_WINDOW_DAYS,
    SUSTAINED_PRACTICE_WEEKS,
    HabitSignal,
    InvitationCandidate,
    PracticeSignal,
    ReadinessAggregates,
    compute_invitation_candidates,
)
from domain.practice_insights import build_insights
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.invitation_signal import InvitationSignal
from models.journal_entry import JournalEntry
from models.practice_session import PracticeSession
from models.user_practice import UserPractice

# Sentinel standing in for a ``None`` target_id in the dedup key, so the
# outward (null-target) embodied-community candidate dedups against its prior
# row even though SQL/Python treat two ``None`` targets as distinct.
_NULL_TARGET = -1

# Dedup / persisted-row identity: ``(target_type, target_id-or-sentinel, kind)``.
_SignalKey = tuple[str, int, str]

# Lower bound, in weeks, for the practice-session fetch. A streak needs only
# the most recent SUSTAINED_PRACTICE_WEEKS calendar weeks of sessions, but
# "N weeks ago" measured from *now* can land partway through the oldest of
# those weeks -- the earliest instant a streak can still need is that week's
# local Monday 00:00, which is strictly less than N*7 days before now. The
# extra week is a calendar-alignment buffer, not slack for the streak logic
# itself: it exists purely so a fetch anchored to the wall-clock "now" always
# reaches back to the start of the oldest required week.
_PRACTICE_SESSION_WINDOW_WEEKS = SUSTAINED_PRACTICE_WEEKS + 1


def _signal_key(target_type: str, target_id: int | None, kind: str) -> _SignalKey:
    """Build the dedup key, folding a null target onto the shared sentinel."""
    return (target_type, target_id if target_id is not None else _NULL_TARGET, kind)


async def _gather_habit_signals(session: AsyncSession, user_id: int) -> list[HabitSignal]:
    """Read every habit's denormalized streak counter in one grouped query."""
    result = await session.execute(
        select(Habit.id, Habit.streak).where(col(Habit.user_id) == user_id)
    )
    return [HabitSignal(habit_id=habit_id, streak_days=streak) for habit_id, streak in result.all()]


async def _gather_practice_signals(
    session: AsyncSession, user_id: int, user_timezone: str
) -> list[PracticeSignal]:
    """Compute sustained weeks per practice from one session fetch (no per-practice query).

    A single query pulls the user's sessions with the resolved ``practice_id``
    (via ``PracticeSession.user_practice_id -> UserPractice.practice_id``); the
    rows are grouped in memory and each group's consecutive-week count is
    derived by reusing :func:`domain.practice_insights.build_insights`. The
    fetch itself is bounded to the trailing ``_PRACTICE_SESSION_WINDOW_WEEKS``
    (UTC-normalized as in ``_gather_active_days``), so history far older than
    the mastery threshold is never pulled in. Clamping the window is
    semantically safe: the resulting ``sustained_weeks`` is only ever compared
    against ``SUSTAINED_PRACTICE_WEEKS``, never persisted, and the required
    weeks all sit fully inside the window, so the threshold comparison stays
    exact even for streaks longer than the window.
    """
    window_start = (
        now_in_tz(user_timezone) - timedelta(weeks=_PRACTICE_SESSION_WINDOW_WEEKS)
    ).astimezone(UTC)
    result = await session.execute(
        select(UserPractice.practice_id, PracticeSession)
        .join(UserPractice, col(PracticeSession.user_practice_id) == col(UserPractice.id))
        .where(
            col(PracticeSession.user_id) == user_id,
            col(PracticeSession.timestamp) >= window_start,
        )
    )
    sessions_by_practice: defaultdict[int, list[PracticeSession]] = defaultdict(list)
    for practice_id, practice_session in result.all():
        sessions_by_practice[practice_id].append(practice_session)
    return [
        PracticeSignal(
            practice_id=practice_id,
            sustained_weeks=build_insights(sessions, tz=user_timezone).streak_weeks,
        )
        for practice_id, sessions in sessions_by_practice.items()
    ]


async def _active_timestamps(
    session: AsyncSession, user_id: int, since: datetime
) -> list[datetime]:
    """Fetch cross-feature activity timestamps since ``since`` in three grouped queries.

    One query per source (goal completions, practice sessions, journal entries),
    each already narrowed to the engagement window so the day-bucketing in
    Python stays cheap regardless of history depth.
    """
    goal_rows = await session.execute(
        select(GoalCompletion.timestamp).where(
            col(GoalCompletion.user_id) == user_id,
            col(GoalCompletion.timestamp) >= since,
        )
    )
    practice_rows = await session.execute(
        select(PracticeSession.timestamp).where(
            col(PracticeSession.user_id) == user_id,
            col(PracticeSession.timestamp) >= since,
        )
    )
    journal_rows = await session.execute(
        select(JournalEntry.timestamp).where(
            col(JournalEntry.user_id) == user_id,
            col(JournalEntry.deleted_at).is_(None),
            col(JournalEntry.timestamp) >= since,
        )
    )
    return [
        *goal_rows.scalars().all(),
        *practice_rows.scalars().all(),
        *journal_rows.scalars().all(),
    ]


async def _gather_active_days(session: AsyncSession, user_id: int, user_timezone: str) -> int:
    """Count distinct user-local calendar days with any activity in the window."""
    # Normalize to UTC so the cutoff string shares the +00:00 offset of the
    # stored timestamps: SQLite compares DateTime(timezone=True) lexically and
    # is blind to the offset suffix, so a user-offset boundary would skew the
    # window edge (see day_bounds_in_tz in domain.dates).
    window_start = (now_in_tz(user_timezone) - timedelta(days=ENGAGEMENT_WINDOW_DAYS)).astimezone(
        UTC
    )
    timestamps = await _active_timestamps(session, user_id, window_start)
    return len({to_user_date_bucket(ts, user_timezone) for ts in timestamps})


async def _gather_aggregates(
    session: AsyncSession, user_id: int, user_timezone: str
) -> ReadinessAggregates:
    """Assemble the readiness snapshot from the batched per-source gathers."""
    return ReadinessAggregates(
        habits=await _gather_habit_signals(session, user_id),
        practices=await _gather_practice_signals(session, user_id, user_timezone),
        active_days_in_window=await _gather_active_days(session, user_id, user_timezone),
    )


async def _existing_signal_keys(session: AsyncSession, user_id: int) -> set[_SignalKey]:
    """Pre-query the dedup keys of every prior row (live and dismissed) for the user."""
    result = await session.execute(
        select(
            InvitationSignal.target_type,
            InvitationSignal.target_id,
            InvitationSignal.kind,
        ).where(col(InvitationSignal.user_id) == user_id)
    )
    return {
        _signal_key(target_type, target_id, kind) for target_type, target_id, kind in result.all()
    }


async def _persist_signal(session: AsyncSession, row: InvitationSignal) -> InvitationSignal | None:
    """Insert one row inside a SAVEPOINT; return ``None`` if a race already wrote it.

    The partial-unique indexes are the source of truth: an ``IntegrityError``
    means a concurrent pass beat us to this coordinate, which is a safe no-op —
    the winner's row already carries the invitation. Unlike ``ensure_*`` helpers
    this variant deliberately omits the re-read: it discards the losing candidate
    rather than returning the concurrently-written singleton.
    """
    try:
        async with session.begin_nested():
            session.add(row)
        await session.commit()
        await session.refresh(row)
    except IntegrityError:
        return None
    else:
        return row


async def _insert_new_signals(
    session: AsyncSession,
    user_id: int,
    candidates: list[InvitationCandidate],
    existing: set[_SignalKey],
) -> list[InvitationSignal]:
    """Persist each candidate whose key is not already present; return the new rows.

    ``existing`` is mutated as rows are inserted so two candidates that resolve
    to the same coordinate within one pass can't both be written.
    """
    inserted: list[InvitationSignal] = []
    for candidate in candidates:
        key = _signal_key(candidate.target_type, candidate.target_id, candidate.kind)
        if key in existing:
            continue
        existing.add(key)
        row = InvitationSignal(
            user_id=user_id,
            target_type=candidate.target_type,
            target_id=candidate.target_id,
            kind=candidate.kind,
        )
        persisted = await _persist_signal(session, row)
        if persisted is not None:
            inserted.append(persisted)
    return inserted


async def generate_invitation_signals(
    session: AsyncSession,
    user_id: int,
    user_timezone: str = "UTC",
) -> list[InvitationSignal]:
    """Detect readiness, persist the newly-warranted invitations, and return them.

    Gathers the user's engagement with a constant number of batched queries,
    computes candidates via the pure domain function, drops any candidate that
    already exists as a signal (dismissed rows included), and inserts only the
    survivors. Returns the rows created by this call — ``[]`` when nothing new
    is warranted, making repeat calls idempotent.
    """
    aggregates = await _gather_aggregates(session, user_id, user_timezone)
    candidates = compute_invitation_candidates(aggregates)
    if not candidates:
        return []
    existing = await _existing_signal_keys(session, user_id)
    return await _insert_new_signals(session, user_id, candidates, existing)
