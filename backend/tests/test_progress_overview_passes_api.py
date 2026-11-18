"""``GET /progress/overview`` serves one ribbon per recorded pass (issue #3726).

The rows come from the ``programpass`` table and the unlock log, read in one
query each and scoped to the caller at every join. A pending pass whose day has
come is opened before the read, exactly as the Map, Course and habit list do.
"""

from __future__ import annotations

import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import event as sa_event
from sqlalchemy.engine import Connection, ExecutionContext
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from conftest import test_engine
from domain.dates import today_in_tz
from models.habit import Habit
from models.habit_unlock_event import HabitUnlockEvent, UnlockKind, UnlockSource
from models.program_pass import PassOrigin, ProgramPass
from models.stage_progress import StageProgress
from models.user_depth_preferences import UserDepthPreferences

_DAYS_PER_WEEK = 7


async def _signup(client: AsyncClient, name: str) -> tuple[dict[str, str], int]:
    """A UTC account with a generated disposable credential."""
    response = await client.post(
        "/auth/signup", json={"email": f"{name}@example.com", "password": secrets.token_urlsafe(24)}
    )
    assert response.status_code == HTTPStatus.OK
    body = response.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


def _midnight(day: date) -> datetime:
    """UTC midnight of ``day``, the anchor a UTC account's pass starts at."""
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


async def _habit(session: AsyncSession, owner: int, name: str, sort_order: int) -> Habit:
    """One unlocked owner habit."""
    habit = Habit(
        user_id=owner,
        name=name,
        icon=f"icon-{name}",
        start_date=today_in_tz("UTC") - timedelta(days=400),
        stage="Beige",
        energy_cost=1,
        energy_return=2,
        sort_order=sort_order,
        revealed=True,
    )
    session.add(habit)
    await session.flush()
    return habit


def _unlock(
    owner: int,
    habit: Habit,
    pass_: ProgramPass | None,
    day: date,
    number: int,
) -> HabitUnlockEvent:
    """One unlock written on ``day``."""
    assert habit.id is not None
    return HabitUnlockEvent(
        user_id=owner,
        habit_id=habit.id,
        pass_id=None if pass_ is None else pass_.id,
        kind=UnlockKind.UNLOCKED,
        occurred_at=_midnight(day) + timedelta(hours=9),
        local_day=day,
        program_number=number,
        source=UnlockSource.MANUAL,
    )


def _relock(owner: int, habit: Habit, pass_: ProgramPass, day: date) -> HabitUnlockEvent:
    """One re-lock written on ``day``."""
    event = _unlock(owner, habit, pass_, day, 1)
    event.kind = UnlockKind.RELOCKED
    return event


async def _three_passes(
    session: AsyncSession, owner: int
) -> tuple[ProgramPass, ProgramPass, ProgramPass]:
    """Pass 1 ended partial, pass 2 ended complete, pass 3 live since 50 days ago."""
    today = today_in_tz("UTC")
    third_start = today - timedelta(days=50)
    second_start = third_start - timedelta(days=260)
    first_start = second_start - timedelta(days=100)
    rows = (
        ProgramPass(
            user_id=owner,
            pass_number=1,
            started_on=first_start,
            ended_on=second_start - timedelta(days=1),
            origin=PassOrigin.BACKFILL,
            reached_stage=5,
            reached_week=15,
            completed=False,
        ),
        ProgramPass(
            user_id=owner,
            pass_number=2,
            started_on=second_start,
            ended_on=third_start - timedelta(days=1),
            origin=PassOrigin.RESCAFFOLD,
            reached_stage=10,
            reached_week=36,
            completed=True,
        ),
        ProgramPass(
            user_id=owner, pass_number=3, started_on=third_start, origin=PassOrigin.BEGIN_AGAIN
        ),
    )
    session.add_all(rows)
    session.add(
        StageProgress(
            user_id=owner,
            current_stage=3,
            cycle_number=3,
            program_started_at=_midnight(third_start),
            stage_started_at=_midnight(third_start),
            past_cycle_anchors=[
                _midnight(first_start).isoformat(),
                _midnight(second_start).isoformat(),
            ],
        )
    )
    await session.flush()
    return rows


async def _overview(client: AsyncClient, headers: dict[str, str]) -> dict[str, Any]:
    """The caller's overview body."""
    response = await client.get("/progress/overview", headers=headers)
    assert response.status_code == HTTPStatus.OK
    body: dict[str, Any] = response.json()
    return body


def _week_of(day: date, start: date) -> int:
    """The 1-based week ``day`` falls in for a pass begun ``start``."""
    return (day - start).days // _DAYS_PER_WEEK + 1


@pytest.mark.asyncio
async def test_three_passes_with_markers_in_their_own_weeks(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Ended-partial, ended-complete and live rows, each marking its own unlocks."""
    headers, owner = await _signup(async_client, "passes_three")
    first, second, third = await _three_passes(db_session, owner)
    walk = await _habit(db_session, owner, "Walk", 0)
    read = await _habit(db_session, owner, "Read", 1)
    first_unlock = first.started_on + timedelta(days=17)
    third_unlock = third.started_on + timedelta(days=22)
    db_session.add_all(
        [
            _unlock(owner, walk, first, first.started_on, 1),
            _unlock(owner, read, first, first_unlock, 2),
            _unlock(owner, read, third, third.started_on, 1),
            _relock(owner, read, third, third.started_on + timedelta(days=8)),
            _unlock(owner, read, third, third_unlock, 4),
            _unlock(owner, walk, None, third.started_on, 1),
        ]
    )
    await db_session.commit()

    passes = (await _overview(async_client, headers))["arc"]["passes"]

    assert [(p["pass_number"], p["state"], p["origin"]) for p in passes] == [
        (1, "ended", "backfill"),
        (2, "ended", "rescaffold"),
        (3, "live", "begin_again"),
    ]
    assert passes[0]["started_on"] == first.started_on.isoformat()
    assert passes[0]["ended_on"] == (second.started_on - timedelta(days=1)).isoformat()
    assert [passes[0][k] for k in ("reached_stage", "reached_week", "completed")] == [5, 15, False]
    assert [passes[1][k] for k in ("reached_stage", "reached_week", "completed")] == [10, 36, True]
    assert passes[2]["ended_on"] is None
    assert passes[2]["reached_week"] == _week_of(today_in_tz("UTC"), third.started_on)
    assert passes[1]["markers"] == []
    assert [(m["habit_id"], m["program_number"], m["week"]) for m in passes[0]["markers"]] == [
        (walk.id, 1, 1),
        (read.id, 2, _week_of(first_unlock, first.started_on)),
    ]
    assert passes[2]["markers"] == [
        {
            "habit_id": read.id,
            "name": "Read",
            "icon": "icon-Read",
            "program_number": 4,
            "week": _week_of(third_unlock, third.started_on),
            "unlocked_on": third_unlock.isoformat(),
            "currently_locked": False,
        }
    ]


@pytest.mark.asyncio
async def test_a_relocked_habit_is_marked_currently_locked(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A habit re-locked through the API keeps its marker, now hollow."""
    headers, owner = await _signup(async_client, "passes_relock")
    *_, live = await _three_passes(db_session, owner)
    habit = await _habit(db_session, owner, "Sit", 0)
    db_session.add(_unlock(owner, habit, live, live.started_on, 1))
    habit.revealed = False
    db_session.add(habit)
    db_session.add(_relock(owner, habit, live, live.started_on + timedelta(days=2)))
    await db_session.commit()

    (marker,) = (await _overview(async_client, headers))["arc"]["passes"][2]["markers"]
    assert marker["currently_locked"] is True
    assert marker["unlocked_on"] == live.started_on.isoformat()


@pytest.mark.asyncio
async def test_a_future_pass_saved_through_the_api_is_pending(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``POST /stages/passes`` for a later day shows a pending row after the live one."""
    headers, owner = await _signup(async_client, "passes_pending")
    await _three_passes(db_session, owner)
    await db_session.commit()
    begins = today_in_tz("UTC") + timedelta(days=9)
    saved = await async_client.post(
        "/stages/passes", json={"start_day": begins.isoformat()}, headers=headers
    )
    assert saved.status_code == HTTPStatus.CREATED

    passes = (await _overview(async_client, headers))["arc"]["passes"]
    assert [p["state"] for p in passes] == ["ended", "ended", "live", "pending"]
    assert passes[-1] == {
        "pass_number": 4,
        "started_on": begins.isoformat(),
        "ended_on": None,
        "origin": "rescaffold",
        "state": "pending",
        "days_until_start": 9,
        "reached_stage": None,
        "reached_week": None,
        "completed": False,
        "markers": [],
    }


@pytest.mark.asyncio
async def test_an_arrived_pending_pass_is_opened_before_the_read(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The overview settles a due pending pass, so it is drawn live, not pending."""
    headers, owner = await _signup(async_client, "passes_settle")
    *_, live = await _three_passes(db_session, owner)
    progress = (
        await db_session.execute(select(StageProgress).where(StageProgress.user_id == owner))
    ).scalar_one()
    today = today_in_tz("UTC")
    progress.pending_pass_starts_on = today
    db_session.add(progress)
    await db_session.commit()

    body = await _overview(async_client, headers)
    passes = body["arc"]["passes"]
    assert [(p["pass_number"], p["state"]) for p in passes] == [
        (1, "ended"),
        (2, "ended"),
        (3, "ended"),
        (4, "live"),
    ]
    assert passes[2]["ended_on"] == (today - timedelta(days=1)).isoformat()
    assert passes[2]["reached_week"] == _week_of(today - timedelta(days=1), live.started_on)
    assert passes[3]["started_on"] == today.isoformat()
    assert body["arc"]["cycle_number"] == 4  # the settled cycle feeds the shipped fields too
    db_session.expire_all()
    stored = (
        await db_session.execute(select(StageProgress).where(StageProgress.user_id == owner))
    ).scalar_one()
    assert stored.pending_pass_starts_on is None


@pytest.mark.asyncio
async def test_reanchoring_the_live_pass_leaves_earlier_passes_byte_identical(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Moving the live start and anchor changes only the live row."""
    headers, owner = await _signup(async_client, "passes_reanchor")
    first, _, live = await _three_passes(db_session, owner)
    habit = await _habit(db_session, owner, "Run", 0)
    db_session.add(_unlock(owner, habit, first, first.started_on + timedelta(days=30), 1))
    db_session.add(_unlock(owner, habit, live, live.started_on + timedelta(days=20), 1))
    await db_session.commit()
    before = (await _overview(async_client, headers))["arc"]["passes"]

    moved = live.started_on + timedelta(days=14)
    live.started_on = moved
    progress = (
        await db_session.execute(select(StageProgress).where(StageProgress.user_id == owner))
    ).scalar_one()
    progress.program_started_at = _midnight(moved)
    db_session.add_all([live, progress])
    await db_session.commit()
    after = (await _overview(async_client, headers))["arc"]["passes"]

    assert after[:2] == before[:2]
    assert after[2]["started_on"] == moved.isoformat()
    assert after[2]["markers"][0]["week"] != before[2]["markers"][0]["week"]


@pytest.mark.asyncio
async def test_habits_off_serves_no_passes(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A declined habits ring hides the ribbons, matching the births."""
    headers, owner = await _signup(async_client, "passes_habits_off")
    await _three_passes(db_session, owner)
    db_session.add(UserDepthPreferences(user_id=owner, enable_habits=False))
    await db_session.commit()
    assert (await _overview(async_client, headers))["arc"]["passes"] == []


@contextmanager
def _selects_starting(prefix: str) -> Iterator[list[str]]:
    """Collect every executed SQL statement that begins with ``prefix``."""
    seen: list[str] = []

    def _before_cursor_execute(
        _conn: Connection,
        _cursor: object,
        statement: str,
        _params: object,
        _context: ExecutionContext,
        _executemany: bool,
    ) -> None:
        if statement.lstrip().startswith(prefix):
            seen.append(statement)

    sync_engine = test_engine.sync_engine
    sa_event.listen(sync_engine, "before_cursor_execute", _before_cursor_execute)
    try:
        yield seen
    finally:
        sa_event.remove(sync_engine, "before_cursor_execute", _before_cursor_execute)


@pytest.mark.asyncio
async def test_passes_and_events_are_each_read_once_however_many_habits(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One query for passes and one for events, with five habits across three passes."""
    headers, owner = await _signup(async_client, "passes_query_count")
    passes = await _three_passes(db_session, owner)
    for number in range(1, 6):
        habit = await _habit(db_session, owner, f"Habit {number}", number)
        db_session.add_all([_unlock(owner, habit, row, row.started_on, number) for row in passes])
    await db_session.commit()

    with (
        _selects_starting("SELECT programpass.") as pass_reads,
        _selects_starting("SELECT habitunlockevent.") as event_reads,
    ):
        body = await _overview(async_client, headers)

    assert [len(row["markers"]) for row in body["arc"]["passes"]] == [5, 5, 5]
    assert len(pass_reads) == 1
    assert len(event_reads) == 1


async def _pass_count(session: AsyncSession, owner: int) -> int:
    """How many pass rows ``owner`` has, read fresh."""
    session.expire_all()
    rows = await session.execute(select(ProgramPass).where(ProgramPass.user_id == owner))
    return len(rows.scalars().all())


@pytest.mark.asyncio
@pytest.mark.parametrize("pending_in_days", [None, 5])
async def test_a_read_with_nothing_due_writes_no_pass(
    async_client: AsyncClient, db_session: AsyncSession, pending_in_days: int | None
) -> None:
    """With no pending pass, or one not yet due, the overview creates no pass row."""
    headers, owner = await _signup(async_client, f"passes_no_write_{pending_in_days}")
    await _three_passes(db_session, owner)
    progress = (
        await db_session.execute(select(StageProgress).where(StageProgress.user_id == owner))
    ).scalar_one()
    if pending_in_days is not None:
        progress.pending_pass_starts_on = today_in_tz("UTC") + timedelta(days=pending_in_days)
    db_session.add(progress)
    await db_session.commit()

    await _overview(async_client, headers)
    await _overview(async_client, headers)

    assert await _pass_count(db_session, owner) == 3


@pytest.mark.asyncio
async def test_settling_writes_one_pass_and_a_second_read_writes_none(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The first read opens the arrived pass once; the next read adds nothing."""
    headers, owner = await _signup(async_client, "passes_settle_once")
    await _three_passes(db_session, owner)
    progress = (
        await db_session.execute(select(StageProgress).where(StageProgress.user_id == owner))
    ).scalar_one()
    progress.pending_pass_starts_on = today_in_tz("UTC")
    db_session.add(progress)
    await db_session.commit()

    await _overview(async_client, headers)
    assert await _pass_count(db_session, owner) == 4
    await _overview(async_client, headers)
    assert await _pass_count(db_session, owner) == 4
