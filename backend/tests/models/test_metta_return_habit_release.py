"""Data-layer tests for the MettaReturnHabitRelease model.

FAILS on import/collection until the implementation-specialist creates
``backend/src/models/metta_return_habit_release.py`` with the
``UniqueConstraint("arc_id", "habit_id")``. That is the correct RED state
for Gate 1.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from models.habit import Habit
from models.metta_return_arc import MettaReturnArc
from models.metta_return_habit_release import MettaReturnHabitRelease
from models.user import User


async def _user(session: AsyncSession, email: str = "mrhr@example.com") -> int:
    """Insert a bare User and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    return user.id


async def _arc(session: AsyncSession, user_id: int) -> int:
    """Insert an active MettaReturnArc and return its id."""
    arc = MettaReturnArc(user_id=user_id, started_at=datetime.now(UTC))
    session.add(arc)
    await session.flush()
    assert arc.id is not None
    return arc.id


async def _habit(session: AsyncSession, user_id: int) -> int:
    """Insert a revealed Habit owned by user_id and return its id."""
    habit = Habit(
        name="Meditate",
        icon="seedling",
        start_date=date(2025, 1, 1),
        energy_cost=10,
        energy_return=20,
        user_id=user_id,
        revealed=True,
    )
    session.add(habit)
    await session.flush()
    assert habit.id is not None
    return habit.id


@pytest.mark.asyncio
async def test_unique_constraint_rejects_duplicate_arc_habit_pair(
    db_session: AsyncSession,
) -> None:
    """A second release row for the same (arc_id, habit_id) violates the unique constraint."""
    user_id = await _user(db_session)
    arc_id = await _arc(db_session, user_id)
    habit_id = await _habit(db_session, user_id)
    db_session.add(
        MettaReturnHabitRelease(
            user_id=user_id,
            arc_id=arc_id,
            habit_id=habit_id,
            released_at=datetime.now(UTC),
        ),
    )
    await db_session.commit()

    db_session.add(
        MettaReturnHabitRelease(
            user_id=user_id,
            arc_id=arc_id,
            habit_id=habit_id,
            released_at=datetime.now(UTC),
        ),
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_same_habit_can_be_released_across_different_arcs(
    db_session: AsyncSession,
) -> None:
    """The same habit released in two different arcs does not violate the constraint."""
    user_id = await _user(db_session)
    first_arc_id = await _arc(db_session, user_id)
    habit_id = await _habit(db_session, user_id)
    db_session.add(
        MettaReturnHabitRelease(
            user_id=user_id,
            arc_id=first_arc_id,
            habit_id=habit_id,
            released_at=datetime.now(UTC),
        ),
    )
    await db_session.commit()

    second_arc = MettaReturnArc(
        user_id=user_id,
        started_at=datetime.now(UTC),
        left_at=datetime.now(UTC),
    )
    db_session.add(second_arc)
    await db_session.flush()
    assert second_arc.id is not None
    db_session.add(
        MettaReturnHabitRelease(
            user_id=user_id,
            arc_id=second_arc.id,
            habit_id=habit_id,
            released_at=datetime.now(UTC),
        ),
    )
    # Should not raise: (arc_id, habit_id) differs from the first row.
    await db_session.commit()
