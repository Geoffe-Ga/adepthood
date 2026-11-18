"""The ``habitunlockevent`` log refuses an impossible row (issue #3724)."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest
from sqlalchemy import DateTime, insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

from models.habit import Habit
from models.habit_unlock_event import HabitUnlockEvent, UnlockKind, UnlockSource
from models.user import User

_TABLE = "habitunlockevent"
_AT = datetime(2026, 6, 22, 9, tzinfo=UTC)


def _ondelete(column_name: str) -> set[str | None]:
    """The ``ON DELETE`` actions of every foreign key on ``column_name``."""
    table = SQLModel.metadata.tables[_TABLE]
    return {key.ondelete for key in table.c[column_name].foreign_keys}


def test_the_log_is_registered_with_owner_habit_and_pass_keys() -> None:
    """Owner and habit are indexed and cascade; the pass is nullable for backfill only."""
    table = SQLModel.metadata.tables[_TABLE]

    assert table.c.user_id.index is True
    assert table.c.habit_id.index is True
    assert table.c.pass_id.index is True
    assert _ondelete("user_id") == {"CASCADE"}
    assert _ondelete("habit_id") == {"CASCADE"}
    assert _ondelete("pass_id") == {"CASCADE"}
    assert table.c.pass_id.nullable is True
    assert table.c.occurred_at.nullable is False
    occurred_type = table.c.occurred_at.type
    assert isinstance(occurred_type, DateTime)
    assert occurred_type.timezone is True
    assert table.c.local_day.nullable is False
    assert table.c.program_number.nullable is False


def test_the_vocabularies_match_the_issue() -> None:
    """Two kinds of change, four ways one is written."""
    assert {kind.value for kind in UnlockKind} == {"unlocked", "relocked"}
    assert {source.value for source in UnlockSource} == {
        "manual",
        "auto_reveal",
        "created_unlocked",
        "backfill",
    }


async def _owner_and_habit(session: AsyncSession) -> tuple[int, int]:
    """Persist an account with one habit and return both ids."""
    user = User(email="unlocks@example.com", password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    habit = Habit(
        name="Walk",
        icon="*",
        start_date=date(2026, 6, 1),
        energy_cost=1,
        energy_return=1,
        user_id=user.id,
    )
    session.add(habit)
    await session.commit()
    assert habit.id is not None
    return user.id, habit.id


async def _insert(session: AsyncSession, **fields: object) -> None:
    """Insert one event as a raw row, so the database alone judges it."""
    user_id, habit_id = await _owner_and_habit(session)
    values: dict[str, object] = {
        "user_id": user_id,
        "habit_id": habit_id,
        "pass_id": None,
        "kind": UnlockKind.UNLOCKED.value,
        "occurred_at": _AT,
        "local_day": _AT.date(),
        "program_number": 1,
        "source": UnlockSource.MANUAL.value,
    }
    values.update(fields)
    await session.execute(insert(HabitUnlockEvent).values(**values))
    await session.commit()


@pytest.mark.asyncio
async def test_a_well_formed_event_is_accepted(db_session: AsyncSession) -> None:
    """The baseline row the rejection cases below each break in one place."""
    await _insert(db_session)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fields",
    [
        pytest.param({"kind": "opened"}, id="unknown-kind"),
        pytest.param({"source": "import"}, id="unknown-source"),
        pytest.param({"program_number": 0}, id="program-number-zero"),
    ],
)
async def test_the_database_refuses_an_impossible_event(
    db_session: AsyncSession, fields: dict[str, object]
) -> None:
    """Each CHECK constraint holds on its own."""
    with pytest.raises(IntegrityError):
        await _insert(db_session, **fields)
