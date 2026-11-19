"""``GET /progress/overview`` serves each Metta Return arc as its own segment (issue #3745).

The arcs are read in one owner-scoped query; the pass each one sits in comes
from the owner's own passes, already read once. Nothing another account owns
-- an arc or a pass -- reaches the caller's list or moves where it is placed.
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

from conftest import test_engine
from domain.dates import today_in_tz
from domain.metta_return import RETURN_TOTAL_DAYS, RETURN_WEEK_COUNT
from models.metta_return_arc import MettaReturnArc
from models.program_pass import PassOrigin, ProgramPass
from models.user_depth_preferences import UserDepthPreferences


async def _signup(client: AsyncClient, name: str) -> tuple[dict[str, str], int]:
    """A UTC account with a generated disposable credential."""
    response = await client.post(
        "/auth/signup", json={"email": f"{name}@example.com", "password": secrets.token_urlsafe(24)}
    )
    assert response.status_code == HTTPStatus.OK
    body = response.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


def _ago(days: float) -> datetime:
    """The instant ``days`` days before now."""
    return datetime.now(UTC) - timedelta(days=days)


def _day_ago(days: int) -> date:
    """The UTC calendar day ``days`` days before today."""
    return today_in_tz("UTC") - timedelta(days=days)


def _arc(
    owner: int,
    started_days_ago: float,
    *,
    paused_days_ago: float | None = None,
    left_days_ago: float | None = None,
) -> MettaReturnArc:
    """One arc row for ``owner``."""
    return MettaReturnArc(
        user_id=owner,
        started_at=_ago(started_days_ago),
        paused_at=None if paused_days_ago is None else _ago(paused_days_ago),
        left_at=None if left_days_ago is None else _ago(left_days_ago),
    )


def _two_passes(owner: int) -> tuple[ProgramPass, ProgramPass]:
    """Pass 1 ended 101 days ago; pass 2 live since then."""
    first = ProgramPass(
        user_id=owner,
        pass_number=1,
        started_on=_day_ago(300),
        ended_on=_day_ago(101),
        origin=PassOrigin.FIRST_RUN,
        reached_stage=6,
        reached_week=29,
    )
    second = ProgramPass(
        user_id=owner, pass_number=2, started_on=_day_ago(100), origin=PassOrigin.BEGIN_AGAIN
    )
    return first, second


async def _return_arcs(client: AsyncClient, headers: dict[str, str]) -> list[dict[str, Any]]:
    """The caller's ``arc.return_arcs``."""
    response = await client.get("/progress/overview", headers=headers)
    assert response.status_code == HTTPStatus.OK
    arcs: list[dict[str, Any]] = response.json()["arc"]["return_arcs"]
    return arcs


@pytest.mark.asyncio
async def test_no_arcs_serves_an_empty_list(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client, "return_arcs_none")
    assert await _return_arcs(async_client, headers) == []


@pytest.mark.asyncio
async def test_completed_left_early_and_paused_arcs_oldest_first(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A lived-through arc, a partial one left in week three, and a paused one."""
    headers, owner = await _signup(async_client, "return_arcs_three")
    db_session.add_all(_two_passes(owner))
    db_session.add_all(
        [
            _arc(owner, 60, paused_days_ago=30),  # paused on day 30: week five, not complete
            _arc(owner, 250, left_days_ago=200),  # lived all 35 days, then left
            _arc(owner, 150, left_days_ago=135),  # left on day 15: week three
        ]
    )
    await db_session.commit()

    arcs = await _return_arcs(async_client, headers)

    assert arcs == [
        {
            "started_on": _day_ago(250).isoformat(),
            "ended_on": _day_ago(200).isoformat(),
            "state": "left",
            "weeks_total": RETURN_WEEK_COUNT,
            "reached_week": RETURN_WEEK_COUNT,
            "completed": True,
            "pass_number": 1,
        },
        {
            "started_on": _day_ago(150).isoformat(),
            "ended_on": _day_ago(135).isoformat(),
            "state": "left",
            "weeks_total": RETURN_WEEK_COUNT,
            "reached_week": 3,
            "completed": False,
            "pass_number": 1,
        },
        {
            "started_on": _day_ago(60).isoformat(),
            "ended_on": None,
            "state": "paused",
            "weeks_total": RETURN_WEEK_COUNT,
            "reached_week": RETURN_WEEK_COUNT,
            "completed": False,
            "pass_number": 2,
        },
    ]


@pytest.mark.asyncio
async def test_a_lived_through_arc_not_yet_left_is_complete(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, owner = await _signup(async_client, "return_arcs_complete")
    db_session.add(_arc(owner, RETURN_TOTAL_DAYS + 2))
    await db_session.commit()

    (arc,) = await _return_arcs(async_client, headers)

    assert (arc["state"], arc["reached_week"], arc["completed"], arc["ended_on"]) == (
        "complete",
        RETURN_WEEK_COUNT,
        True,
        None,
    )
    assert arc["pass_number"] is None  # this account has recorded no pass


@pytest.mark.asyncio
async def test_pause_and_resume_through_the_api_do_not_count_the_pause(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Paused on day 3 for three weeks, then resumed: week one, not week four."""
    headers, owner = await _signup(async_client, "return_arcs_resume")
    db_session.add(_arc(owner, 24, paused_days_ago=21))
    await db_session.commit()
    resumed = await async_client.post("/metta-return/arc/resume", headers=headers)
    assert resumed.status_code == HTTPStatus.OK

    (arc,) = await _return_arcs(async_client, headers)

    assert (arc["state"], arc["reached_week"], arc["completed"]) == ("active", 1, False)


@pytest.mark.asyncio
async def test_habits_off_serves_no_return_arcs(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The segments ride the pass ribbons, which a declined habits ring hides."""
    headers, owner = await _signup(async_client, "return_arcs_habits_off")
    db_session.add(_arc(owner, 10))
    db_session.add(UserDepthPreferences(user_id=owner, enable_habits=False))
    await db_session.commit()

    assert await _return_arcs(async_client, headers) == []


@pytest.mark.asyncio
async def test_another_accounts_arcs_and_passes_never_reach_the_caller(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Isolation at both reads: the stranger's arcs are absent, their passes place nothing."""
    headers, owner = await _signup(async_client, "return_arcs_owner")
    _, stranger = await _signup(async_client, "return_arcs_stranger")
    db_session.add_all(_two_passes(stranger))
    db_session.add_all([_arc(stranger, 150, left_days_ago=140), _arc(stranger, 5)])
    db_session.add(_arc(owner, 50, left_days_ago=45))
    await db_session.commit()

    arcs = await _return_arcs(async_client, headers)

    assert [(arc["started_on"], arc["pass_number"]) for arc in arcs] == [
        (_day_ago(50).isoformat(), None)
    ]


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
async def test_arcs_are_read_once_however_many_there_are(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One arc query and one pass query, with five arcs across two passes."""
    headers, owner = await _signup(async_client, "return_arcs_query_count")
    db_session.add_all(_two_passes(owner))
    db_session.add_all([_arc(owner, 40 * n + 10, left_days_ago=40 * n) for n in range(1, 5)])
    db_session.add(_arc(owner, 3))
    await db_session.commit()

    with (
        _selects_starting("SELECT mettareturnarc.") as arc_reads,
        _selects_starting("SELECT programpass.") as pass_reads,
    ):
        arcs = await _return_arcs(async_client, headers)

    assert len(arcs) == 5
    assert len(arc_reads) == 1
    assert "mettareturnarc.user_id = " in arc_reads[0]
    assert len(pass_reads) == 1
