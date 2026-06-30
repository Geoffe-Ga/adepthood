"""Data-layer tests for the CompletionSuggestion model (habit-resonance-01)."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from models.completion_suggestion import (
    CompletionSuggestion,
    CompletionTargetType,
    SuggestionStatus,
)
from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.practice import Practice
from models.user import User
from models.user_practice import UserPractice


async def _user(session: AsyncSession, email: str = "cs@example.com") -> int:
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    return user.id


async def _entry(session: AsyncSession, user_id: int) -> int:
    entry = JournalEntry(sender="user", user_id=user_id, message="I went for a run today")
    session.add(entry)
    await session.flush()
    assert entry.id is not None
    return entry.id


async def _goal(session: AsyncSession, user_id: int) -> int:
    habit = Habit(
        name="Run",
        icon="🏃",
        start_date=date(2025, 1, 1),
        energy_cost=10,
        energy_return=20,
        user_id=user_id,
    )
    session.add(habit)
    await session.flush()
    goal = Goal(
        habit_id=habit.id,
        title="Daily run",
        tier="clear",
        target=1.0,
        target_unit="run",
        frequency=1.0,
        frequency_unit="per_day",
        is_additive=True,
    )
    session.add(goal)
    await session.flush()
    assert goal.id is not None
    return goal.id


async def _user_practice(session: AsyncSession, user_id: int) -> int:
    practice = Practice(
        stage_number=1,
        name="Meditation",
        description="Sit quietly",
        instructions="Close your eyes and breathe",
        default_duration_minutes=10,
        approved=True,
    )
    session.add(practice)
    await session.flush()
    up = UserPractice(
        user_id=user_id,
        practice_id=practice.id,
        stage_number=1,
        start_date=date(2025, 1, 1),
    )
    session.add(up)
    await session.flush()
    assert up.id is not None
    return up.id


def _habit_suggestion(
    entry_id: int, user_id: int, goal_id: int | None, **over: object
) -> CompletionSuggestion:
    base: dict[str, object] = {
        "journal_entry_id": entry_id,
        "user_id": user_id,
        "target_type": CompletionTargetType.HABIT,
        "goal_id": goal_id,
        "label": "Run",
        "anchor_start": 0,
        "anchor_end": 22,
        "anchor_text": "I went for a run today",
    }
    base.update(over)
    return CompletionSuggestion(**base)


@pytest.mark.asyncio
async def test_insert_habit_suggestion_and_read(db_session: AsyncSession) -> None:
    """A habit suggestion persists and reads back with its defaults."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    goal_id = await _goal(db_session, user_id)
    db_session.add(_habit_suggestion(entry_id, user_id, goal_id))
    await db_session.commit()

    row = (await db_session.execute(select(CompletionSuggestion))).scalar_one()
    assert row.journal_entry_id == entry_id
    assert row.target_type == CompletionTargetType.HABIT
    assert row.goal_id == goal_id
    assert row.user_practice_id is None
    # status defaults to pending; accepted_at is unset until accepted.
    assert row.status == SuggestionStatus.PENDING
    assert row.accepted_at is None
    assert row.created_at is not None


@pytest.mark.asyncio
async def test_insert_practice_suggestion(db_session: AsyncSession) -> None:
    """A practice suggestion sets user_practice_id and leaves goal_id NULL."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    up_id = await _user_practice(db_session, user_id)
    db_session.add(
        CompletionSuggestion(
            journal_entry_id=entry_id,
            user_id=user_id,
            target_type=CompletionTargetType.PRACTICE,
            user_practice_id=up_id,
            label="Meditation",
            anchor_start=0,
            anchor_end=10,
            anchor_text="meditation",
            status=SuggestionStatus.ACCEPTED,
            accepted_at=datetime.now(UTC),
        ),
    )
    await db_session.commit()

    row = (await db_session.execute(select(CompletionSuggestion))).scalar_one()
    assert row.target_type == CompletionTargetType.PRACTICE
    assert row.user_practice_id == up_id
    assert row.goal_id is None
    assert row.status == SuggestionStatus.ACCEPTED
    assert row.accepted_at is not None


@pytest.mark.asyncio
async def test_parent_delete_cascades(db_session: AsyncSession) -> None:
    """Deleting the journal entry removes its suggestions (delete-orphan)."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    goal_id = await _goal(db_session, user_id)
    db_session.add(_habit_suggestion(entry_id, user_id, goal_id))
    await db_session.commit()

    loaded = await db_session.get(JournalEntry, entry_id)
    assert loaded is not None
    await db_session.delete(loaded)
    await db_session.commit()

    remaining = (
        await db_session.execute(select(func.count()).select_from(CompletionSuggestion))
    ).scalar_one()
    assert remaining == 0


@pytest.mark.asyncio
async def test_updated_at_advances_on_mutate(db_session: AsyncSession) -> None:
    """updated_at advances when the row is flushed after a mutation (onupdate)."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    goal_id = await _goal(db_session, user_id)
    row = _habit_suggestion(entry_id, user_id, goal_id)
    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)
    original = row.updated_at

    row.status = SuggestionStatus.DISMISSED
    await db_session.commit()
    await db_session.refresh(row)
    assert row.updated_at > original


@pytest.mark.asyncio
async def test_invalid_status_is_rejected(db_session: AsyncSession) -> None:
    """A status outside the enum set violates the CHECK constraint."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    goal_id = await _goal(db_session, user_id)
    db_session.add(_habit_suggestion(entry_id, user_id, goal_id, status="bogus"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_invalid_target_type_is_rejected(db_session: AsyncSession) -> None:
    """A target_type outside the enum set violates the CHECK constraint."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    goal_id = await _goal(db_session, user_id)
    db_session.add(_habit_suggestion(entry_id, user_id, goal_id, target_type="bogus"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_negative_anchor_start_is_rejected(db_session: AsyncSession) -> None:
    """anchor_start must be non-negative (CHECK constraint)."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    goal_id = await _goal(db_session, user_id)
    db_session.add(_habit_suggestion(entry_id, user_id, goal_id, anchor_start=-1, anchor_end=4))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_inverted_anchor_span_is_rejected(db_session: AsyncSession) -> None:
    """anchor_end must be greater than anchor_start (CHECK constraint)."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    goal_id = await _goal(db_session, user_id)
    db_session.add(_habit_suggestion(entry_id, user_id, goal_id, anchor_start=5, anchor_end=3))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_habit_target_without_goal_is_rejected(db_session: AsyncSession) -> None:
    """A habit suggestion must set goal_id (target_fk_matches CHECK)."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    db_session.add(_habit_suggestion(entry_id, user_id, goal_id=None))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_habit_target_with_practice_fk_is_rejected(db_session: AsyncSession) -> None:
    """A habit suggestion must not also set user_practice_id (target_fk_matches)."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    goal_id = await _goal(db_session, user_id)
    up_id = await _user_practice(db_session, user_id)
    db_session.add(_habit_suggestion(entry_id, user_id, goal_id, user_practice_id=up_id))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_practice_target_without_user_practice_is_rejected(db_session: AsyncSession) -> None:
    """A practice suggestion must set user_practice_id (target_fk_matches CHECK)."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    db_session.add(
        CompletionSuggestion(
            journal_entry_id=entry_id,
            user_id=user_id,
            target_type=CompletionTargetType.PRACTICE,
            label="Meditation",
            anchor_start=0,
            anchor_end=10,
            anchor_text="meditation",
        ),
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


def test_enum_values() -> None:
    """The enum value sets match the contract."""
    assert {t.value for t in CompletionTargetType} == {"habit", "practice"}
    assert {s.value for s in SuggestionStatus} == {"pending", "accepted", "dismissed"}
