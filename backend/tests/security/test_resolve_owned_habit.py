"""Unit tests for :func:`dependencies.ownership.resolve_owned_habit`.

The singular body-id habit resolver: 404 when no habit carries the id, 403 --
with a ``resource_access_denied`` audit row -- when the habit is somebody
else's, and the habit itself when the caller owns it. Unlike the batch
:func:`~dependencies.ownership.resolve_owned_habits`, it never silently drops a
foreign id: a caller naming one habit is told why it was refused.
"""

from __future__ import annotations

import logging
from datetime import date
from http import HTTPStatus

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.ownership import resolve_owned_habit
from models.habit import Habit
from models.user import User

_MISSING_ID = 999_999


async def _user(session: AsyncSession, email: str) -> int:
    """Insert a bare user and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user.id


async def _habit(session: AsyncSession, user_id: int) -> int:
    """Insert a habit owned by ``user_id`` and return its id."""
    habit = Habit(
        user_id=user_id,
        name="Morning pages",
        icon="✍️",
        start_date=date(2024, 1, 1),
        energy_cost=1,
        energy_return=2,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    assert habit.id is not None
    return habit.id


def _denials(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """The ``resource_access_denied`` records captured so far."""
    return [r for r in caplog.records if r.message == "resource_access_denied"]


@pytest.mark.asyncio
async def test_owned_habit_resolves_to_itself(db_session: AsyncSession) -> None:
    """The owner gets their own habit row back."""
    owner = await _user(db_session, "owner@example.com")
    habit_id = await _habit(db_session, owner)

    habit = await resolve_owned_habit(db_session, habit_id, owner)

    assert habit.id == habit_id
    assert habit.user_id == owner


@pytest.mark.asyncio
async def test_missing_habit_is_404_and_unaudited(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """No habit carries the id: 404 ``habit_not_found``, and no audit row."""
    owner = await _user(db_session, "nobody@example.com")

    with caplog.at_level(logging.WARNING), pytest.raises(HTTPException) as raised:
        await resolve_owned_habit(db_session, _MISSING_ID, owner)

    assert raised.value.status_code == HTTPStatus.NOT_FOUND
    assert raised.value.detail == "habit_not_found"
    assert _denials(caplog) == []


@pytest.mark.asyncio
async def test_foreign_habit_is_403_and_audited(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """Another user's habit: 403 ``forbidden`` plus one audit row naming the probe."""
    owner = await _user(db_session, "alice@example.com")
    prober = await _user(db_session, "bob@example.com")
    habit_id = await _habit(db_session, owner)

    with caplog.at_level(logging.WARNING), pytest.raises(HTTPException) as raised:
        await resolve_owned_habit(db_session, habit_id, prober)

    assert raised.value.status_code == HTTPStatus.FORBIDDEN
    assert raised.value.detail == "forbidden"
    denials = _denials(caplog)
    assert len(denials) == 1
    assert getattr(denials[0], "resource", None) == "habit"
    assert getattr(denials[0], "resource_id", None) == habit_id
    assert getattr(denials[0], "user_id", None) == prober
