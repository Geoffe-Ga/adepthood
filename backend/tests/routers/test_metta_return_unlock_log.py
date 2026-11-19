"""The Return's habit release and recommit are logged like every other lock change (#3745).

Releasing a habit within a Return arc re-locks it; re-committing unlocks it
again. Each actual flip of ``revealed`` writes one ``habitunlockevent`` row with
source ``metta_return`` in the same commit as the flip, tagged with the live
pass. A call that changes nothing -- a habit already locked, a repeat release,
a recommit of a habit already re-enabled elsewhere -- logs nothing.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus
from typing import TYPE_CHECKING

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain import habit_unlock_log
from domain.dates import day_bounds_in_tz, to_user_date, today_in_tz
from domain.program_pass import live_pass
from domain.stage_progress import ensure_user_progress
from models.habit import Habit
from models.habit_unlock_event import HabitUnlockEvent, UnlockKind, UnlockSource
from models.metta_return_arc import MettaReturnArc
from models.metta_return_habit_release import MettaReturnHabitRelease
from models.program_pass import ProgramPass
from models.stage_progress import StageProgress
from routers import metta_return as metta_router

if TYPE_CHECKING:
    from collections.abc import Sequence

    from domain.habit_unlock_log import LockChange

_RELEASE_URL = "/metta-return/arc/release"
_RECOMMIT_URL = "/metta-return/arc/recommit"
_LEAVE_URL = "/metta-return/arc/leave"
# UTC+14, so a day stamped from the UTC calendar instead of the account's is caught.
_FAR_EAST_TZ = "Pacific/Kiritimati"


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """An account in ``_FAR_EAST_TZ``: ``(auth headers, user_id)``."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
            "timezone": _FAR_EAST_TZ,
        },
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


async def _live_pass_id(session: AsyncSession, user_id: int) -> int:
    """Provision ``user_id``'s progress row and return its live pass id."""
    await ensure_user_progress(session, user_id)
    current = await live_pass(session, user_id)
    assert current is not None
    assert current.id is not None
    return current.id


async def _habit(
    session: AsyncSession,
    user_id: int,
    name: str,
    sort_order: int,
    *,
    revealed: bool = True,
) -> int:
    """One habit row for ``user_id``; returns its id."""
    habit = Habit(
        user_id=user_id,
        name=name,
        icon="*",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=1,
        sort_order=sort_order,
        revealed=revealed,
    )
    session.add(habit)
    await session.commit()
    assert habit.id is not None
    return habit.id


async def _arc(session: AsyncSession, user_id: int, *, left: bool = False) -> None:
    """An arc for ``user_id``, begun a week ago and optionally already left."""
    now = datetime.now(UTC)
    session.add(
        MettaReturnArc(
            user_id=user_id,
            started_at=now - timedelta(days=7),
            left_at=now if left else None,
        )
    )
    await session.commit()


async def _post(
    client: AsyncClient, headers: dict[str, str], url: str, habit_ids: list[int]
) -> None:
    """Release or recommit ``habit_ids``; the call succeeds."""
    resp = await client.post(url, headers=headers, json={"habit_ids": habit_ids})
    assert resp.status_code == HTTPStatus.OK


async def _events(session: AsyncSession, user_id: int) -> list[HabitUnlockEvent]:
    """Every event ``user_id`` has, in write order, read fresh."""
    session.expire_all()
    result = await session.execute(
        select(HabitUnlockEvent)
        .where(col(HabitUnlockEvent.user_id) == user_id)
        .order_by(col(HabitUnlockEvent.id))
    )
    return list(result.scalars().all())


async def _revealed(session: AsyncSession, habit_id: int) -> bool:
    """The stored lock flag of ``habit_id``, read fresh."""
    session.expire_all()
    habit = await session.get(Habit, habit_id)
    assert habit is not None
    return habit.revealed


# ── Release ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_release_logs_one_relock_per_habit_in_the_live_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Each released habit: a relock, source metta_return, at its program number, today."""
    headers, user_id = await _signup(async_client, "mr_log_release")
    pass_id = await _live_pass_id(db_session, user_id)
    walk = await _habit(db_session, user_id, "Walk", 0)
    sit = await _habit(db_session, user_id, "Sit", 1)
    await _arc(db_session, user_id)
    before = datetime.now(UTC)

    await _post(async_client, headers, _RELEASE_URL, [sit, walk])

    events = await _events(db_session, user_id)
    assert sorted((e.habit_id, e.kind, e.source, e.program_number) for e in events) == [
        (walk, UnlockKind.RELOCKED, UnlockSource.METTA_RETURN, 1),
        (sit, UnlockKind.RELOCKED, UnlockSource.METTA_RETURN, 2),
    ]
    assert {e.pass_id for e in events} == {pass_id}
    assert {e.local_day for e in events} == {to_user_date(_FAR_EAST_TZ, before)}


@pytest.mark.asyncio
async def test_release_of_locked_or_repeated_habits_logs_nothing_more(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Only a real flip is logged: a locked habit and a repeat release write nothing."""
    headers, user_id = await _signup(async_client, "mr_log_release_noop")
    await _live_pass_id(db_session, user_id)
    walk = await _habit(db_session, user_id, "Walk", 0)
    locked = await _habit(db_session, user_id, "Locked", 1, revealed=False)
    await _arc(db_session, user_id)

    await _post(async_client, headers, _RELEASE_URL, [walk, locked])
    await _post(async_client, headers, _RELEASE_URL, [walk, locked])

    assert [e.habit_id for e in await _events(db_session, user_id)] == [walk]


@pytest.mark.asyncio
async def test_release_of_a_carryover_habit_logs_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A carryover is not on the ribbon, so its release is not logged, as with every writer."""
    headers, user_id = await _signup(async_client, "mr_log_release_carry")
    await _live_pass_id(db_session, user_id)
    carried = await _habit(db_session, user_id, "Carried", 0)
    habit = await db_session.get(Habit, carried)
    assert habit is not None
    habit.is_carryover = True
    db_session.add(habit)
    await db_session.commit()
    await _arc(db_session, user_id)

    await _post(async_client, headers, _RELEASE_URL, [carried])

    assert await _revealed(db_session, carried) is False
    assert await _events(db_session, user_id) == []


@pytest.mark.asyncio
async def test_a_release_that_fails_after_logging_leaves_no_flip_and_no_row(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The flip, the release row, and the event are one transaction."""
    headers, user_id = await _signup(async_client, "mr_log_release_atomic")
    await _live_pass_id(db_session, user_id)
    walk = await _habit(db_session, user_id, "Walk", 0)
    await _arc(db_session, user_id)
    _fail_after_logging(monkeypatch)

    resp = await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": [walk]})
    assert resp.status_code == HTTPStatus.INTERNAL_SERVER_ERROR
    await db_session.rollback()  # what get_session does when a handler raises

    assert await _revealed(db_session, walk) is True
    assert await _events(db_session, user_id) == []
    releases = await db_session.execute(
        select(MettaReturnHabitRelease).where(col(MettaReturnHabitRelease.user_id) == user_id)
    )
    assert releases.scalars().all() == []


def _fail_after_logging(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the router's logger write its rows, then fail before the handler commits."""
    real = habit_unlock_log.record_lock_changes

    async def _log_then_fail(
        session: AsyncSession, user_id: int, habits: Sequence[Habit], change: LockChange
    ) -> list[HabitUnlockEvent]:
        """Write the rows as the real logger does, then fail before the handler commits."""
        await real(session, user_id, habits, change)
        await session.flush()
        msg = "failed after logging"
        raise RuntimeError(msg)

    monkeypatch.setattr(metta_router, "record_lock_changes", _log_then_fail)


# ── Recommit ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recommit_logs_an_unlock_even_after_the_arc_was_left(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Release then leave then recommit: a relock then an unlock, both metta_return."""
    headers, user_id = await _signup(async_client, "mr_log_recommit")
    pass_id = await _live_pass_id(db_session, user_id)
    walk = await _habit(db_session, user_id, "Walk", 0)
    await _arc(db_session, user_id)
    await _post(async_client, headers, _RELEASE_URL, [walk])
    assert (await async_client.post(_LEAVE_URL, headers=headers)).status_code == HTTPStatus.OK

    await _post(async_client, headers, _RECOMMIT_URL, [walk])

    events = await _events(db_session, user_id)
    assert [(e.habit_id, e.kind, e.source, e.pass_id) for e in events] == [
        (walk, UnlockKind.RELOCKED, UnlockSource.METTA_RETURN, pass_id),
        (walk, UnlockKind.UNLOCKED, UnlockSource.METTA_RETURN, pass_id),
    ]
    assert await _revealed(db_session, walk) is True


@pytest.mark.asyncio
async def test_a_repeat_recommit_logs_nothing_more(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "mr_log_recommit_repeat")
    await _live_pass_id(db_session, user_id)
    walk = await _habit(db_session, user_id, "Walk", 0)
    await _arc(db_session, user_id)
    await _post(async_client, headers, _RELEASE_URL, [walk])

    await _post(async_client, headers, _RECOMMIT_URL, [walk])
    await _post(async_client, headers, _RECOMMIT_URL, [walk])

    assert [e.kind for e in await _events(db_session, user_id)] == [
        UnlockKind.RELOCKED,
        UnlockKind.UNLOCKED,
    ]


@pytest.mark.asyncio
async def test_recommitting_a_habit_already_unlocked_elsewhere_logs_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A habit re-enabled outside the Return is still stamped, but its lock did not move."""
    headers, user_id = await _signup(async_client, "mr_log_recommit_noop")
    await _live_pass_id(db_session, user_id)
    walk = await _habit(db_session, user_id, "Walk", 0)
    await _arc(db_session, user_id)
    await _post(async_client, headers, _RELEASE_URL, [walk])
    habit = await db_session.get(Habit, walk)
    assert habit is not None
    habit.revealed = True  # re-enabled directly, outside the Return
    db_session.add(habit)
    await db_session.commit()

    await _post(async_client, headers, _RECOMMIT_URL, [walk])

    assert [e.kind for e in await _events(db_session, user_id)] == [UnlockKind.RELOCKED]
    release = (
        await db_session.execute(
            select(MettaReturnHabitRelease).where(col(MettaReturnHabitRelease.habit_id) == walk)
        )
    ).scalar_one()
    assert release.recommitted_at is not None


@pytest.mark.asyncio
async def test_a_recommit_that_fails_after_logging_leaves_the_habit_locked(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The unlock, its stamp, and its event are one transaction."""
    headers, user_id = await _signup(async_client, "mr_log_recommit_atomic")
    await _live_pass_id(db_session, user_id)
    walk = await _habit(db_session, user_id, "Walk", 0)
    await _arc(db_session, user_id)
    await _post(async_client, headers, _RELEASE_URL, [walk])
    _fail_after_logging(monkeypatch)

    resp = await async_client.post(_RECOMMIT_URL, headers=headers, json={"habit_ids": [walk]})
    assert resp.status_code == HTTPStatus.INTERNAL_SERVER_ERROR
    await db_session.rollback()  # what get_session does when a handler raises

    assert await _revealed(db_session, walk) is False
    assert [e.kind for e in await _events(db_session, user_id)] == [UnlockKind.RELOCKED]
    release = (
        await db_session.execute(
            select(MettaReturnHabitRelease).where(col(MettaReturnHabitRelease.habit_id) == walk)
        )
    ).scalar_one()
    assert release.recommitted_at is None


# ── Isolation and the ribbon ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_another_accounts_habit_is_neither_flipped_nor_logged(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Naming a stranger's habit in a release or recommit writes nothing for anyone."""
    headers, user_id = await _signup(async_client, "mr_log_owner")
    _, stranger = await _signup(async_client, "mr_log_stranger")
    await _live_pass_id(db_session, user_id)
    await _live_pass_id(db_session, stranger)
    theirs = await _habit(db_session, stranger, "Theirs", 0)
    await _arc(db_session, user_id)

    await _post(async_client, headers, _RELEASE_URL, [theirs])
    await _post(async_client, headers, _RECOMMIT_URL, [theirs])

    assert await _revealed(db_session, theirs) is True
    assert await _events(db_session, user_id) == []
    assert await _events(db_session, stranger) == []


@pytest.mark.asyncio
async def test_a_released_habit_is_marked_currently_locked_on_its_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The release's relock is the pass's last word on the habit, so its marker goes hollow."""
    headers, user_id = await _signup(async_client, "mr_log_marker")
    pass_id = await _live_pass_id(db_session, user_id)
    walk = await _habit(db_session, user_id, "Walk", 0)
    unlocked_at = datetime.now(UTC) - timedelta(days=1)
    db_session.add(
        HabitUnlockEvent(
            user_id=user_id,
            habit_id=walk,
            pass_id=pass_id,
            kind=UnlockKind.UNLOCKED,
            occurred_at=unlocked_at,
            local_day=to_user_date(_FAR_EAST_TZ, unlocked_at),
            program_number=1,
            source=UnlockSource.MANUAL,
        )
    )
    await _arc(db_session, user_id)

    await _post(async_client, headers, _RELEASE_URL, [walk])
    overview = await async_client.get("/progress/overview", headers=headers)

    assert overview.status_code == HTTPStatus.OK
    (live,) = overview.json()["arc"]["passes"]
    (marker,) = live["markers"]
    assert (marker["habit_id"], marker["currently_locked"]) == (walk, True)


@pytest.mark.asyncio
async def test_a_release_on_the_pending_day_is_logged_in_the_new_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The release settles an arrived pass first, so its event is not stranded in the old one."""
    headers, user_id = await _signup(async_client, "mr_log_pending_day")
    old_id = await _live_pass_id(db_session, user_id)
    today = today_in_tz(_FAR_EAST_TZ)
    old = await db_session.get(ProgramPass, old_id)
    progress = (
        await db_session.execute(select(StageProgress).where(col(StageProgress.user_id) == user_id))
    ).scalar_one()
    assert old is not None
    anchor, _ = day_bounds_in_tz(_FAR_EAST_TZ, today - timedelta(days=30))
    old.started_on = today - timedelta(days=30)
    progress.program_started_at = anchor
    progress.stage_started_at = anchor
    progress.pending_pass_starts_on = today
    db_session.add_all([old, progress])
    await db_session.commit()
    walk = await _habit(db_session, user_id, "Walk", 0)
    await _arc(db_session, user_id)

    await _post(async_client, headers, _RELEASE_URL, [walk])

    (event,) = await _events(db_session, user_id)
    current = await live_pass(db_session, user_id)
    assert current is not None
    assert current.started_on == today
    assert event.pass_id == current.id != old_id
