"""Every change of a program habit's lock state is logged (issue #3724).

Three writers flip ``Habit.revealed`` -- a manual ``PUT /habits/{id}``, the
list read's auto-reveal, and a create that arrives unlocked -- and each appends
a ``habitunlockevent`` row in the same commit as the flip, tagged with the live
pass and the habit's program number at that moment. Carryover habits are not on
the ribbon and log nothing. ``auto_revealed_at`` keeps its one-shot meaning.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.dates import ensure_aware, to_user_date, today_in_tz
from domain.habit_unlock_log import latest_unlocks
from domain.program_pass import live_pass
from domain.stage_progress import ensure_user_progress
from models.habit import Habit
from models.habit_unlock_event import HabitUnlockEvent, UnlockKind, UnlockSource

# UTC+14: the local day differs from the UTC day for ten hours of every day,
# so a day stamped from the UTC calendar instead of the account's is caught.
_FAR_EAST_TZ = "Pacific/Kiritimati"


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create a user in ``_FAR_EAST_TZ`` and return ``(auth headers, user_id)``."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
            "timezone": _FAR_EAST_TZ,
        },
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user_id"]


def _payload(name: str, **overrides: object) -> dict[str, object]:
    """A habit payload starting far in the future, so nothing auto-reveals it."""
    payload: dict[str, object] = {
        "name": name,
        "icon": "*",
        "start_date": (today_in_tz("UTC") + timedelta(days=60)).isoformat(),
        "energy_cost": 1,
        "energy_return": 1,
        "stage": "",
        "sort_order": 0,
        "revealed": False,
        "is_carryover": False,
    }
    payload.update(overrides)
    return payload


async def _create(
    client: AsyncClient, headers: dict[str, str], name: str, **overrides: object
) -> dict[str, object]:
    """Create one habit and return the request payload with its new ``id``."""
    payload = _payload(name, **overrides)
    resp = await client.post("/habits/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    return {**payload, "id": resp.json()["id"]}


async def _put(client: AsyncClient, headers: dict[str, str], habit: dict[str, object]) -> None:
    """Replace ``habit`` with its own payload."""
    body = {key: value for key, value in habit.items() if key != "id"}
    resp = await client.put(f"/habits/{habit['id']}", json=body, headers=headers)
    assert resp.status_code == HTTPStatus.OK


async def _events(session: AsyncSession, user_id: int) -> list[HabitUnlockEvent]:
    """Every event ``user_id`` has, in write order, read fresh from the database."""
    session.expire_all()
    result = await session.execute(
        select(HabitUnlockEvent)
        .where(col(HabitUnlockEvent.user_id) == user_id)
        .order_by(col(HabitUnlockEvent.id))
    )
    return list(result.scalars().all())


async def _live_pass_id(session: AsyncSession, user_id: int) -> int:
    """Provision ``user_id``'s progress row and return its live pass id."""
    await ensure_user_progress(session, user_id)
    current = await live_pass(session, user_id)
    assert current is not None
    assert current.id is not None
    return current.id


@pytest.mark.asyncio
async def test_unlock_relock_unlock_writes_three_rows(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Every flip is logged, not only the first; the marker is the third row."""
    headers, user_id = await _signup(async_client, "three_flips")
    pass_id = await _live_pass_id(db_session, user_id)
    habit = await _create(async_client, headers, "Walk")

    for revealed in (True, False, True):
        await _put(async_client, headers, {**habit, "revealed": revealed})

    events = await _events(db_session, user_id)
    assert [(event.kind, event.source) for event in events] == [
        (UnlockKind.UNLOCKED, UnlockSource.MANUAL),
        (UnlockKind.RELOCKED, UnlockSource.MANUAL),
        (UnlockKind.UNLOCKED, UnlockSource.MANUAL),
    ]
    assert {event.pass_id for event in events} == {pass_id}
    assert {event.habit_id for event in events} == {habit["id"]}
    assert latest_unlocks(events, pass_id) == {habit["id"]: events[2]}


@pytest.mark.asyncio
async def test_a_put_that_leaves_the_lock_alone_writes_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A rename is not a lock-state change."""
    headers, user_id = await _signup(async_client, "unchanged_put")
    habit = await _create(async_client, headers, "Walk")

    await _put(async_client, headers, {**habit, "name": "Stroll"})

    assert await _events(db_session, user_id) == []


@pytest.mark.asyncio
async def test_the_event_day_is_the_account_zone_day(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``local_day`` is the day the instant falls on where the person lives."""
    headers, user_id = await _signup(async_client, "zone_day")
    habit = await _create(async_client, headers, "Walk")

    await _put(async_client, headers, {**habit, "revealed": True})

    (event,) = await _events(db_session, user_id)
    assert event.local_day == to_user_date(_FAR_EAST_TZ, ensure_aware(event.occurred_at))


@pytest.mark.asyncio
async def test_the_program_number_is_taken_at_the_unlock(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The issue example: unlocked at 3, moved to 5 while locked, unlocked at 5.

    A carryover habit sorted ahead of every program habit does not count, and
    the earlier event keeps the number it was written with.
    """
    headers, user_id = await _signup(async_client, "program_number")
    await _create(async_client, headers, "Old", is_carryover=True, sort_order=None)
    habits = [
        await _create(async_client, headers, f"H{slot}", sort_order=slot) for slot in range(5)
    ]
    third = habits[2]

    await _put(async_client, headers, {**third, "revealed": True})
    await _put(async_client, headers, {**third, "revealed": False})
    await _put(async_client, headers, {**third, "sort_order": 5})
    await _put(async_client, headers, {**third, "sort_order": 5, "revealed": True})

    assert [(event.kind, event.program_number) for event in await _events(db_session, user_id)] == [
        (UnlockKind.UNLOCKED, 3),
        (UnlockKind.RELOCKED, 3),
        (UnlockKind.UNLOCKED, 5),
    ]


@pytest.mark.asyncio
async def test_another_accounts_habits_do_not_shift_the_number(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Position is counted among the caller's own habits only."""
    other_headers, other_id = await _signup(async_client, "other_account")
    await _create(async_client, other_headers, "Theirs")
    headers, user_id = await _signup(async_client, "own_account")
    habit = await _create(async_client, headers, "Mine")

    await _put(async_client, headers, {**habit, "revealed": True})

    (event,) = await _events(db_session, user_id)
    assert event.program_number == 1
    assert await _events(db_session, other_id) == []


@pytest.mark.asyncio
async def test_without_a_recorded_pass_the_event_carries_none(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An account that never began the program has no pass to tag the event with."""
    headers, user_id = await _signup(async_client, "no_pass")
    habit = await _create(async_client, headers, "Walk")

    await _put(async_client, headers, {**habit, "revealed": True})

    (event,) = await _events(db_session, user_id)
    assert event.pass_id is None


@pytest.mark.asyncio
async def test_a_habit_created_unlocked_logs_its_unlock(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Creation with ``revealed=true`` is the first unlock; a locked create logs nothing."""
    headers, user_id = await _signup(async_client, "created_unlocked")
    pass_id = await _live_pass_id(db_session, user_id)
    await _create(async_client, headers, "Locked")
    opened = await _create(async_client, headers, "Open", revealed=True, sort_order=1)

    (event,) = await _events(db_session, user_id)
    assert event.habit_id == opened["id"]
    assert event.kind == UnlockKind.UNLOCKED
    assert event.source == UnlockSource.CREATED_UNLOCKED
    assert event.pass_id == pass_id
    assert event.program_number == 2


@pytest.mark.asyncio
async def test_carryover_habits_log_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A carryover habit is not on the ribbon, created unlocked or flipped."""
    headers, user_id = await _signup(async_client, "carryover_silent")
    habit = await _create(async_client, headers, "Old", is_carryover=True, revealed=True)

    await _put(async_client, headers, {**habit, "revealed": False})
    await _put(async_client, headers, {**habit, "revealed": True})

    assert await _events(db_session, user_id) == []


@pytest.mark.asyncio
async def test_moving_to_carryover_keeps_earlier_events(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The log is history: moving a habit off the program does not erase it."""
    headers, user_id = await _signup(async_client, "carryover_move")
    habit = await _create(async_client, headers, "Walk")
    await _put(async_client, headers, {**habit, "revealed": True})

    await _put(async_client, headers, {**habit, "revealed": False, "is_carryover": True})

    events = await _events(db_session, user_id)
    assert [event.kind for event in events] == [UnlockKind.UNLOCKED]


@pytest.mark.asyncio
async def test_the_one_shot_stamp_keeps_its_meaning(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``auto_revealed_at`` is set once by the first manual change and never moves."""
    headers, _ = await _signup(async_client, "stamp_kept")
    habit = await _create(async_client, headers, "Walk")
    await _put(async_client, headers, {**habit, "revealed": True})
    persisted = await db_session.get(Habit, habit["id"])
    assert persisted is not None
    first_stamp = persisted.auto_revealed_at
    assert first_stamp is not None

    await _put(async_client, headers, {**habit, "revealed": False})
    await _put(async_client, headers, {**habit, "revealed": True})

    await db_session.refresh(persisted)
    assert persisted.auto_revealed_at == first_stamp


@pytest.mark.asyncio
async def test_auto_reveal_logs_an_auto_reveal_event(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The list read's reveal is logged with its own source, once."""
    headers, user_id = await _signup(async_client, "auto_reveal")
    pass_id = await _live_pass_id(db_session, user_id)
    past = (today_in_tz(_FAR_EAST_TZ) - timedelta(days=1)).isoformat()
    habit = await _create(async_client, headers, "Walk", start_date=past)

    for _ in range(2):
        listed = await async_client.get("/habits/", headers=headers)
        assert listed.status_code == HTTPStatus.OK

    (event,) = await _events(db_session, user_id)
    assert event.habit_id == habit["id"]
    assert event.kind == UnlockKind.UNLOCKED
    assert event.source == UnlockSource.AUTO_REVEAL
    assert event.pass_id == pass_id
    assert event.program_number == 1


@pytest.mark.asyncio
async def test_auto_reveal_stamping_an_already_open_habit_logs_nothing_more(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Consuming the invitation of a habit already unlocked is not a lock-state change."""
    headers, user_id = await _signup(async_client, "auto_reveal_stamp_only")
    past = (today_in_tz(_FAR_EAST_TZ) - timedelta(days=1)).isoformat()
    await _create(async_client, headers, "Walk", start_date=past, revealed=True)

    listed = await async_client.get("/habits/", headers=headers)
    assert listed.status_code == HTTPStatus.OK

    events = await _events(db_session, user_id)
    assert [event.source for event in events] == [UnlockSource.CREATED_UNLOCKED]


@asynccontextmanager
async def _foreign_keys_enforced(db_session: AsyncSession) -> AsyncIterator[None]:
    """Run the body with SQLite enforcing ``ON DELETE CASCADE`` as Postgres does.

    The pragma is per connection and ignored inside a transaction, so the
    transaction is closed first and the setting is switched back off after --
    see ``_foreign_keys_enforced`` in ``test_habits_api.py`` for the history.
    """
    await db_session.commit()
    await db_session.execute(text("PRAGMA foreign_keys=ON"))
    try:
        yield
    finally:
        await db_session.rollback()
        await db_session.execute(text("PRAGMA foreign_keys=OFF"))


@pytest.mark.asyncio
async def test_deleting_a_habit_removes_its_events(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The log cascades with the habit; a sibling habit's events stay."""
    headers, user_id = await _signup(async_client, "delete_cascade")
    doomed = await _create(async_client, headers, "Doomed")
    kept = await _create(async_client, headers, "Kept", sort_order=1)
    await _put(async_client, headers, {**doomed, "revealed": True})
    await _put(async_client, headers, {**kept, "revealed": True})

    async with _foreign_keys_enforced(db_session):
        resp = await async_client.delete(f"/habits/{doomed['id']}", headers=headers)
        assert resp.status_code == HTTPStatus.NO_CONTENT
        surviving = [event.habit_id for event in await _events(db_session, user_id)]

    assert surviving == [kept["id"]]
