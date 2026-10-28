"""The person picks their program start date (issue #3097).

The calendar anchor used to be stamped by the server the first time a depth
needed one. The owner decided on 2026-10-07 that the person picks it instead:
``PUT /stages/program-calendar`` sets ``program_started_at`` to the local
midnight of a chosen calendar date, within a bounded range, and moves the
record with it so the two answers never diverge. Every consumer -- habit
reveal, course drip, prompts -- reads that one anchor, so these tests drive
the endpoint and then read the consumers back.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.constants import PROGRAM_START_BACKDATE_WINDOW_DAYS, TOTAL_PROGRAM_DAYS
from domain.dates import ensure_aware
from domain.program_start import program_start_verdict
from models.habit import Habit
from models.stage_progress import StageProgress
from models.user import User
from tests.helpers.feedback_triage import Account, make_account

_PATH = "/stages/program-calendar"
# 60 days back: stages 1 and 2 (21 days each) have closed, so stage 3 is open.
_SIXTY_DAYS = 60
_THIRD_STAGE = 3
_LADDER = (("Beige ring", "Beige", 1), ("Purple ring", "Purple", 2), ("Red ring", "Red", 3))
_LOCKED_RING = ("Blue ring", "Blue", 4)
# A zone far from UTC, so "local midnight" is visibly not "UTC midnight".
_ZONE = "America/Los_Angeles"


def _today() -> date:
    return datetime.now(ZoneInfo(_ZONE)).date()


async def _account(db_session: AsyncSession, email: str, *, created_days_ago: int = 0) -> Account:
    """An account in ``_ZONE`` created ``created_days_ago`` days back."""
    account = await make_account(db_session, email)
    user = await db_session.get(User, account.user_id)
    assert user is not None
    user.timezone = _ZONE
    user.created_at = datetime.now(UTC) - timedelta(days=created_days_ago)
    db_session.add(user)
    await db_session.commit()
    return account


async def _pick(client: AsyncClient, account: Account, chosen: date) -> dict[str, object]:
    resp = await client.put(
        _PATH, json={"program_start_date": chosen.isoformat()}, headers=account.headers
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body: dict[str, object] = resp.json()
    return body


async def _add_ring(
    client: AsyncClient, account: Account, name: str, stage: str, slot: int
) -> None:
    resp = await client.post(
        "/habits/",
        json={
            "name": name,
            "icon": "*",
            "start_date": _today().isoformat(),
            "energy_cost": 1,
            "energy_return": 1,
            "stage": stage,
            "sort_order": slot,
            "revealed": False,
        },
        headers=account.headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text


async def _progress(db_session: AsyncSession, user_id: int) -> StageProgress:
    db_session.expire_all()
    return (
        await db_session.execute(select(StageProgress).where(StageProgress.user_id == user_id))
    ).scalar_one()


async def _reveal_stamps(db_session: AsyncSession, user_id: int) -> dict[str, datetime | None]:
    db_session.expire_all()
    habits = (
        (await db_session.execute(select(Habit).where(col(Habit.user_id) == user_id)))
        .scalars()
        .all()
    )
    return {habit.name: habit.auto_revealed_at for habit in habits}


# -- The pure range rule -------------------------------------------------


def test_the_backdate_window_is_one_full_program() -> None:
    """Any earlier and the whole 36-week program would already be over on day one."""
    assert PROGRAM_START_BACKDATE_WINDOW_DAYS == TOTAL_PROGRAM_DAYS


@pytest.mark.parametrize(
    ("offset_days", "expected"),
    [
        (1, "future"),
        (0, "ok"),
        (-PROGRAM_START_BACKDATE_WINDOW_DAYS, "ok"),
        (-PROGRAM_START_BACKDATE_WINDOW_DAYS - 1, "too_early"),
    ],
)
def test_program_start_verdict_bounds_are_inclusive(offset_days: int, expected: str) -> None:
    today = date(2026, 10, 14)
    chosen = today + timedelta(days=offset_days)
    assert program_start_verdict(chosen, today=today, account_created=today) == expected


def test_the_past_limit_counts_back_from_account_creation_not_today() -> None:
    """An account a year old may still start one program before it was created."""
    today = date(2026, 10, 14)
    created = today - timedelta(days=365)
    earliest = created - timedelta(days=PROGRAM_START_BACKDATE_WINDOW_DAYS)
    assert program_start_verdict(earliest, today=today, account_created=created) == "ok"
    before = earliest - timedelta(days=1)
    assert program_start_verdict(before, today=today, account_created=created) == "too_early"


# -- Picking a date ------------------------------------------------------


@pytest.mark.asyncio
async def test_a_habits_only_person_picks_a_start_date_before_any_anchor_exists(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """No progress row yet: picking provisions it at the chosen local midnight."""
    account = await _account(db_session, "picker@example.com")
    chosen = _today() - timedelta(days=_SIXTY_DAYS)

    body = await _pick(async_client, account, chosen)

    assert body["calendar_stage"] == _THIRD_STAGE
    assert body["current_stage"] == _THIRD_STAGE
    progress = await _progress(db_session, account.user_id)
    anchor = ensure_aware(progress.program_started_at or progress.stage_started_at)
    assert anchor.astimezone(ZoneInfo(_ZONE)) == datetime.combine(
        chosen, datetime.min.time(), tzinfo=ZoneInfo(_ZONE)
    )
    assert progress.completed_stages == [1, 2]


@pytest.mark.asyncio
async def test_the_calendar_read_reports_the_picked_anchor(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """GET returns the same anchor the PUT wrote -- one anchor, every reader."""
    account = await _account(db_session, "reader@example.com")
    put_body = await _pick(async_client, account, _today() - timedelta(days=_SIXTY_DAYS))

    resp = await async_client.get(_PATH, headers=account.headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == put_body


@pytest.mark.asyncio
async def test_a_past_date_reveals_the_rings_due_by_it_exactly_once(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The habit reveal reads the picked anchor; a second read stamps nothing."""
    account = await _account(db_session, "rings@example.com")
    for name, stage, slot in (*_LADDER, _LOCKED_RING):
        await _add_ring(async_client, account, name, stage, slot)
    await _pick(async_client, account, _today() - timedelta(days=_SIXTY_DAYS))

    first = await async_client.get("/habits/", headers=account.headers)
    assert first.status_code == HTTPStatus.OK
    stamps = await _reveal_stamps(db_session, account.user_id)
    second = await async_client.get("/habits/", headers=account.headers)
    assert second.status_code == HTTPStatus.OK

    assert {name for name, at in stamps.items() if at is not None} == {
        name for name, _, _ in _LADDER
    }
    assert await _reveal_stamps(db_session, account.user_id) == stamps


@pytest.mark.asyncio
async def test_today_is_a_valid_pick(async_client: AsyncClient, db_session: AsyncSession) -> None:
    account = await _account(db_session, "today@example.com")

    body = await _pick(async_client, account, _today())

    assert body["calendar_stage"] == 1
    assert body["calendar_week"] == 1


# -- Editing it afterwards -----------------------------------------------


@pytest.mark.asyncio
async def test_moving_the_date_later_re_paces_both_answers_together(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A deliberate re-anchor moves the record with the calendar, like begin-again.

    Leaving the record at stage 3 while the calendar says stage 1 would let a
    mistaken pick pin the person ahead of their own schedule for good.
    """
    account = await _account(db_session, "mover@example.com")
    await _pick(async_client, account, _today() - timedelta(days=_SIXTY_DAYS))

    body = await _pick(async_client, account, _today())

    assert body["calendar_stage"] == 1
    assert body["current_stage"] == 1
    progress = await _progress(db_session, account.user_id)
    assert progress.completed_stages == []
    # The lifetime high-water mark is monotone; a re-anchor does not erase it.
    assert progress.highest_stage_reached == _THIRD_STAGE


@pytest.mark.asyncio
async def test_editing_the_date_never_re_stamps_a_consumed_invitation(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Back and forth across a ring's window: each ring is stamped once, ever."""
    account = await _account(db_session, "editor@example.com")
    for name, stage, slot in _LADDER:
        await _add_ring(async_client, account, name, stage, slot)
    await _pick(async_client, account, _today() - timedelta(days=_SIXTY_DAYS))
    await async_client.get("/habits/", headers=account.headers)
    stamps = await _reveal_stamps(db_session, account.user_id)

    await _pick(async_client, account, _today())
    await async_client.get("/habits/", headers=account.headers)
    await _pick(async_client, account, _today() - timedelta(days=_SIXTY_DAYS))
    await async_client.get("/habits/", headers=account.headers)

    assert await _reveal_stamps(db_session, account.user_id) == stamps


@pytest.mark.asyncio
async def test_re_picking_the_same_stage_keeps_the_entry_moment(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A nudge inside the same window is not a new threshold crossing."""
    account = await _account(db_session, "nudger@example.com")
    await _pick(async_client, account, _today() - timedelta(days=_SIXTY_DAYS))
    entered_at = (await _progress(db_session, account.user_id)).stage_started_at

    await _pick(async_client, account, _today() - timedelta(days=_SIXTY_DAYS - 1))

    assert (await _progress(db_session, account.user_id)).stage_started_at == entered_at


# -- What is refused -----------------------------------------------------


@pytest.mark.asyncio
async def test_a_future_date_is_rejected_and_nothing_is_written(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    account = await _account(db_session, "future@example.com")

    resp = await async_client.put(
        _PATH,
        json={"program_start_date": (_today() + timedelta(days=1)).isoformat()},
        headers=account.headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "program_start_in_future"
    rows = (
        await db_session.execute(
            select(StageProgress).where(StageProgress.user_id == account.user_id)
        )
    ).all()
    assert rows == []


@pytest.mark.asyncio
async def test_a_date_before_the_window_is_rejected(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    account = await _account(db_session, "ancient@example.com", created_days_ago=10)
    too_early = _today() - timedelta(days=10 + PROGRAM_START_BACKDATE_WINDOW_DAYS + 2)

    resp = await async_client.put(
        _PATH, json={"program_start_date": too_early.isoformat()}, headers=account.headers
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "program_start_too_early"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"program_start_date": "not-a-date"},
        {"program_start_date": "2026-02-30"},
        {"program_start_date": "2026-01-01", "current_stage": 9},
    ],
)
async def test_malformed_bodies_are_rejected(
    async_client: AsyncClient, db_session: AsyncSession, payload: dict[str, object]
) -> None:
    """A date and only a date: no client may assert the record alongside it."""
    account = await _account(db_session, "malformed@example.com")

    resp = await async_client.put(_PATH, json=payload, headers=account.headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_a_later_cycle_keeps_its_begin_again_anchor(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Cycle N+1's start is cycle N's end; moving it would rewrite a past cycle."""
    account = await _account(db_session, "looper@example.com")
    db_session.add(
        StageProgress(
            user_id=account.user_id,
            current_stage=1,
            completed_stages=[],
            cycle_number=2,
            past_cycle_anchors=[datetime(2025, 1, 1, tzinfo=UTC).isoformat()],
        )
    )
    await db_session.commit()

    resp = await async_client.put(
        _PATH, json={"program_start_date": _today().isoformat()}, headers=account.headers
    )

    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "program_start_fixed_after_first_cycle"


@pytest.mark.asyncio
async def test_picking_requires_authentication(async_client: AsyncClient) -> None:
    resp = await async_client.put(_PATH, json={"program_start_date": "2026-01-01"})

    assert resp.status_code == HTTPStatus.UNAUTHORIZED
