"""Data-layer tests for the UserDepthPreferences model (depth-prefs-01)."""

from __future__ import annotations

import pytest
from sqlalchemy import JSON, func, select, text
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, col

from models.user import User
from models.user_depth_preferences import UserDepthPreferences


def _swap_pg_arrays_to_json() -> None:
    """Replace PostgreSQL ARRAY columns with JSON for SQLite compatibility."""
    for table in SQLModel.metadata.tables.values():
        for column in table.columns:
            if isinstance(column.type, PG_ARRAY):
                column.type = JSON()


async def _user(session: AsyncSession, email: str = "prefs@example.com") -> int:
    """Insert a bare User and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    return user.id


@pytest.mark.asyncio
async def test_defaults_all_true_on_create(db_session: AsyncSession) -> None:
    """All four booleans default to True when no value is supplied."""
    user_id = await _user(db_session)
    prefs = UserDepthPreferences(user_id=user_id)
    db_session.add(prefs)
    await db_session.commit()

    row = (await db_session.execute(select(UserDepthPreferences))).scalar_one()
    assert row.enable_habits is True
    assert row.enable_practices is True
    assert row.enable_course is True
    assert row.enable_sangha is True


@pytest.mark.asyncio
async def test_explicit_false_round_trips(db_session: AsyncSession) -> None:
    """An explicit False on one flag persists; the others remain True."""
    user_id = await _user(db_session)
    prefs = UserDepthPreferences(user_id=user_id, enable_sangha=False)
    db_session.add(prefs)
    await db_session.commit()

    row = (await db_session.execute(select(UserDepthPreferences))).scalar_one()
    assert row.enable_habits is True
    assert row.enable_practices is True
    assert row.enable_course is True
    assert row.enable_sangha is False


@pytest.mark.asyncio
async def test_per_user_isolation(db_session: AsyncSession) -> None:
    """Two users each have their own prefs row; mutating one does not touch the other."""
    user_a = await _user(db_session, "a@example.com")
    user_b = await _user(db_session, "b@example.com")
    db_session.add(UserDepthPreferences(user_id=user_a))
    db_session.add(UserDepthPreferences(user_id=user_b, enable_habits=False))
    await db_session.commit()

    row_a = (
        await db_session.execute(
            select(UserDepthPreferences).where(col(UserDepthPreferences.user_id) == user_a)
        )
    ).scalar_one()
    row_b = (
        await db_session.execute(
            select(UserDepthPreferences).where(col(UserDepthPreferences.user_id) == user_b)
        )
    ).scalar_one()

    assert row_a.enable_habits is True
    assert row_b.enable_habits is False
    # Mutate user_a's row and confirm user_b is unchanged.
    row_a.enable_course = False
    await db_session.commit()
    await db_session.refresh(row_b)
    assert row_b.enable_course is True


@pytest.mark.asyncio
async def test_unique_constraint_prevents_duplicate_for_same_user(
    db_session: AsyncSession,
) -> None:
    """A second prefs row for the same user_id violates the unique constraint."""
    user_id = await _user(db_session)
    db_session.add(UserDepthPreferences(user_id=user_id))
    await db_session.commit()

    db_session.add(UserDepthPreferences(user_id=user_id))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_cascade_delete_on_user_delete() -> None:
    """Deleting the parent user removes the prefs row via DB-level CASCADE.

    Uses a dedicated in-memory engine so PRAGMA foreign_keys = ON is scoped
    entirely to this test and never leaks to the shared test_engine used by
    the rest of the suite.
    """
    _swap_pg_arrays_to_json()
    isolated_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    factory = async_sessionmaker(isolated_engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with isolated_engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
            await conn.execute(text("PRAGMA foreign_keys = ON"))

        async with factory() as session:
            user = User(email="cascade@example.com", password_hash="x")  # pragma: allowlist secret
            session.add(user)
            await session.flush()
            assert user.id is not None
            session.add(UserDepthPreferences(user_id=user.id))
            await session.commit()

            await session.execute(text("PRAGMA foreign_keys = ON"))
            loaded = await session.get(User, user.id)
            assert loaded is not None
            await session.delete(loaded)
            await session.commit()

            remaining = (
                await session.execute(select(func.count()).select_from(UserDepthPreferences))
            ).scalar_one()
            assert remaining == 0
    finally:
        await isolated_engine.dispose()


@pytest.mark.asyncio
async def test_relationship_wiring(db_session: AsyncSession) -> None:
    """user.depth_preferences loads the row; prefs.user back-references the user."""
    user_id = await _user(db_session)
    prefs = UserDepthPreferences(user_id=user_id)
    db_session.add(prefs)
    await db_session.commit()

    loaded_user = await db_session.get(User, user_id)
    assert loaded_user is not None
    # Expire the cached attribute so the relationship is re-loaded from the DB.
    await db_session.refresh(loaded_user, ["depth_preferences"])
    assert loaded_user.depth_preferences is not None
    assert loaded_user.depth_preferences.user_id == user_id

    loaded_prefs = await db_session.get(UserDepthPreferences, prefs.id)
    assert loaded_prefs is not None
    await db_session.refresh(loaded_prefs, ["user"])
    assert loaded_prefs.user is not None
    assert loaded_prefs.user.id == user_id
