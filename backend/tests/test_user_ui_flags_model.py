"""Model-level guarantees for :class:`models.user_ui_flags.UserUiFlags`.

``delete_habit`` unlinks a writing timer and a practice screen explicitly, so
the API tests for that rule pass whether or not the database enforces the
columns' own ``ON DELETE SET NULL``. This file proves the backstop on its own: with SQLite's
foreign keys switched on, deleting the habit row directly -- no router, no ORM
cascade -- leaves the flags row in place with the link nulled.
"""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, col, select

from models.habit import Habit
from models.user import User
from models.user_ui_flags import UserUiFlags


async def _linked_flags(session: AsyncSession) -> tuple[int, int]:
    """Insert a user, a habit and a flags row linking them; return (user id, habit id)."""
    user = User(email="linked@example.com", password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    habit = Habit(
        user_id=user.id,
        name="Morning pages",
        icon="✍️",
        start_date=date(2024, 1, 1),
        energy_cost=1,
        energy_return=2,
    )
    session.add(habit)
    await session.flush()
    assert habit.id is not None
    session.add(
        UserUiFlags(
            user_id=user.id, writing_session_habit_id=habit.id, practice_session_habit_id=habit.id
        )
    )
    await session.commit()
    return user.id, habit.id


# ``db_session`` is requested only for its side effect: its setup swaps the
# Postgres ARRAY columns for JSON so ``create_all`` can render on SQLite.
@pytest.mark.usefixtures("db_session")
@pytest.mark.asyncio
async def test_deleting_the_habit_row_nulls_the_link_at_the_database() -> None:
    """``ON DELETE SET NULL`` on both habit links holds without the router.

    A dedicated in-memory engine keeps ``PRAGMA foreign_keys = ON`` scoped to
    this test, never leaking to the shared test engine.
    """
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)

        async with factory() as session:
            await session.execute(text("PRAGMA foreign_keys = ON"))
            user_id, habit_id = await _linked_flags(session)

            await session.execute(text("PRAGMA foreign_keys = ON"))
            await session.execute(text("DELETE FROM habit WHERE id = :h"), {"h": habit_id})
            await session.commit()

            flags = (
                (
                    await session.execute(
                        select(UserUiFlags)
                        .where(col(UserUiFlags.user_id) == user_id)
                        .execution_options(populate_existing=True)
                    )
                )
                .scalars()
                .one()
            )
            assert flags.writing_session_habit_id is None
            assert flags.practice_session_habit_id is None
    finally:
        await engine.dispose()
