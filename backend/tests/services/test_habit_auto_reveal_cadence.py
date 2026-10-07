"""Habit reveal follows the program cadence, with or without the Course (issue #3071).

These tests drive :func:`services.habit_auto_reveal.reconcile_habit_auto_reveals`
directly, so the clock is an argument rather than a mock: every case passes the
``now`` it wants and reads the result back from the database.

The session factory behind ``db_session`` is built with ``expire_on_commit=False``
(``conftest.py``), exactly as production's is (``database.py``). Reconcile relies
on that: provisioning the calendar anchor commits after the candidate habits have
been loaded, and the first eligibility pass then reads ``stage`` and
``start_date`` from those same objects. If the flag flips, that read raises
``MissingGreenlet`` and these tests fail loudly rather than pass by luck.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import async_session_factory
from domain.stage_progress import get_user_progress
from models.habit import Habit
from models.stage_progress import StageProgress
from models.user import User
from services.habit_auto_reveal import reconcile_habit_auto_reveals

# How far apart "now" and a freshly provisioned ``program_started_at`` may be:
# the model stamps the column with ``datetime.now(UTC)`` at row creation, so a
# generous minute separates "stamped by this call" from "stamped some other day".
_PROVISION_TOLERANCE = timedelta(seconds=60)
_UTC = "UTC"


async def _make_user(session: AsyncSession, email: str) -> int:
    """Insert a User row and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user.id


@dataclass(frozen=True)
class _Seed:
    """One habit row to insert, naming each column a case pins."""

    name: str
    stage: str
    start_date: date
    sort_order: int
    is_carryover: bool = False
    auto_revealed_at: datetime | None = None


async def _add_habit(session: AsyncSession, user_id: int, seed: _Seed) -> Habit:
    """Insert one habit, locked unless ``seed`` says its invitation was consumed."""
    habit = Habit(
        name=seed.name,
        icon="*",
        start_date=seed.start_date,
        energy_cost=1,
        energy_return=1,
        user_id=user_id,
        stage=seed.stage,
        sort_order=seed.sort_order,
        revealed=seed.auto_revealed_at is not None,
        auto_revealed_at=seed.auto_revealed_at,
        is_carryover=seed.is_carryover,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    return habit


@pytest.mark.asyncio
async def test_reconcile_provisions_anchor_when_no_progress_row(db_session: AsyncSession) -> None:
    """A laddered habit awaiting its ring gives a habits-only account a calendar anchor."""
    user_id = await _make_user(db_session, "provision@example.com")
    today = datetime.now(UTC).date()
    await _add_habit(db_session, user_id, _Seed("Beige ring", "Beige", today, 1))
    await _add_habit(db_session, user_id, _Seed("Purple ring", "Purple", today, 2))
    before = datetime.now(UTC)

    opened = await reconcile_habit_auto_reveals(db_session, user_id, _UTC)

    assert opened == 1
    progress = await get_user_progress(db_session, user_id)
    assert progress is not None
    assert progress.program_started_at is not None
    stamped = progress.program_started_at.replace(tzinfo=UTC)
    assert abs(stamped - before) < _PROVISION_TOLERANCE
    assert progress.current_stage == 1


@pytest.mark.parametrize(
    ("stage", "is_carryover", "already_consumed"),
    [
        pytest.param("", False, False, id="unladdered-empty"),
        pytest.param("aptitude", False, False, id="unladdered-unknown"),
        pytest.param("Beige", False, True, id="laddered-already-consumed"),
        pytest.param("Purple", True, False, id="laddered-carryover"),
    ],
)
@pytest.mark.asyncio
async def test_reconcile_provisions_nothing_without_laddered_unconsumed_habit(
    db_session: AsyncSession, stage: str, *, is_carryover: bool, already_consumed: bool
) -> None:
    """Only a pending laddered invitation earns an anchor (AC2)."""
    user_id = await _make_user(db_session, f"no-anchor-{stage or 'empty'}@example.com")
    seed = _Seed(
        name="Only habit",
        stage=stage,
        start_date=datetime.now(UTC).date() + timedelta(days=30),
        sort_order=1,
        is_carryover=is_carryover,
        auto_revealed_at=datetime.now(UTC) if already_consumed else None,
    )
    await _add_habit(db_session, user_id, seed)

    await reconcile_habit_auto_reveals(db_session, user_id, _UTC)

    assert await get_user_progress(db_session, user_id) is None
    rows = await db_session.execute(
        select(StageProgress).where(col(StageProgress.user_id) == user_id)
    )
    assert rows.scalars().all() == []


def test_production_session_factory_keeps_objects_loaded_across_commit() -> None:
    """Pin the ``expire_on_commit=False`` that reconcile's provisioning commit relies on."""
    assert async_session_factory.kw["expire_on_commit"] is False
