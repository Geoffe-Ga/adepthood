"""Energy Scaffolding opens a pass on the chosen day, including a future one (issue #3725).

``POST /stages/passes`` closes the live pass the day before ``start_day`` and
opens the next with ``origin = rescaffold``, in any cycle. A ``start_day`` that
has not come yet is held as the pending pass on ``StageProgress``: the pass
before it keeps running -- and keeps driving stage, habit reveal and Course
pacing -- until that day, when the first read closes it with the stage and week
it actually reached. A second future save replaces the pending pass.

``PUT /stages/program-calendar`` stays the first-cycle correction of the
CURRENT pass; with the widened window it can place that pass in the future,
which is the "not yet begun" state: nothing on the ladder auto-unlocks and the
Course withholds stage 1's first chapter until the day arrives.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.constants import (
    PROGRAM_START_BACKDATE_WINDOW_DAYS,
    PROGRAM_START_FORWARD_WINDOW_DAYS,
    TOTAL_PROGRAM_DAYS,
    TOTAL_STAGES,
)
from domain.dates import day_bounds_in_tz, ensure_aware, to_user_date, today_in_tz
from domain.program_calendar import days_until_start, effective_anchor
from domain.program_start import ProgramStartBounds, pass_start_verdict, program_start_bounds
from domain.stage_progress import ensure_user_progress
from models.course_stage import CourseStage
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.program_pass import PassOrigin, ProgramPass
from models.stage_content import StageContent
from models.stage_progress import StageProgress
from routers.reflections import _entry_ref_from

_TZ = "America/Los_Angeles"
_PASSES = "/stages/passes"
_CALENDAR = "/stages/program-calendar"
# 60 days into a pass is stage 3 (stages 1 and 2 run 21 days each).
_SIXTY_DAYS = 60
_THIRD_STAGE = 3
# The issue's example: a save sixteen days ahead.
_SIXTEEN_DAYS = 16
_THIRTY_DAYS = 30
_ONE_DAY = timedelta(days=1)
_LADDER = (("Beige ring", "Beige", 1), ("Purple ring", "Purple", 2), ("Red ring", "Red", 3))
_LOCKED_RING = ("Blue ring", "Blue", 4)
# Stage 1 is seeded with this many chapters, released on these days.
_CHAPTER_DAYS = (0, 7, 14)


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create a user in ``_TZ`` and return ``(auth headers, user_id)``."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
            "timezone": _TZ,
        },
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user_id"]


def _today() -> date:
    return today_in_tz(_TZ)


async def _passes(session: AsyncSession, user_id: int) -> list[ProgramPass]:
    """Every pass ``user_id`` has, oldest first, read fresh."""
    session.expire_all()
    result = await session.execute(
        select(ProgramPass)
        .where(col(ProgramPass.user_id) == user_id)
        .order_by(col(ProgramPass.pass_number))
    )
    return list(result.scalars().all())


async def _progress(session: AsyncSession, user_id: int) -> StageProgress:
    session.expire_all()
    return (
        await session.execute(select(StageProgress).where(col(StageProgress.user_id) == user_id))
    ).scalar_one()


async def _open(client: AsyncClient, headers: dict[str, str], start_day: date) -> dict[str, object]:
    resp = await client.post(_PASSES, json={"start_day": start_day.isoformat()}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    body: dict[str, object] = resp.json()
    return body


async def _pick(client: AsyncClient, headers: dict[str, str], chosen: date) -> dict[str, object]:
    resp = await client.put(
        _CALENDAR, json={"program_start_date": chosen.isoformat()}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body: dict[str, object] = resp.json()
    return body


async def _add_ring(
    client: AsyncClient, headers: dict[str, str], name: str, stage: str, slot: int
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
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text


async def _revealed(
    client: AsyncClient, headers: dict[str, str], session: AsyncSession
) -> set[str]:
    """Read the habit list (which reconciles reveals), then the names now revealed."""
    assert (await client.get("/habits/", headers=headers)).status_code == HTTPStatus.OK
    session.expire_all()
    habits = (await session.execute(select(Habit))).scalars().all()
    return {habit.name for habit in habits if habit.revealed}


async def _seed_stage_one_chapters(session: AsyncSession) -> None:
    """Stage 1 with three chapters, so the drip has something to withhold."""
    stage = CourseStage(
        title="Stage 1",
        subtitle="Subtitle 1",
        stage_number=1,
        overview_url="https://example.com/stage-1",
        category="test",
        aspect="test-aspect",
        spiral_dynamics_color="beige",
        growing_up_stage="archaic",
        divine_gender_polarity="masculine",
        relationship_to_free_will="active",
        free_will_description="Active Yes-And-Ness",
    )
    session.add(stage)
    await session.flush()
    assert stage.id is not None
    for day in _CHAPTER_DAYS:
        session.add(
            StageContent(
                course_stage_id=stage.id,
                title=f"Chapter on day {day}",
                content_type="essay",
                release_day=day,
                url=f"https://cms.example.com/s1-{day}",
            )
        )
    await session.commit()


async def _open_chapters(client: AsyncClient, headers: dict[str, str]) -> int:
    resp = await client.get("/course/stages/1/content", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    return sum(1 for item in resp.json() if not item["is_locked"])


async def _shift_back(session: AsyncSession, user_id: int, days: int) -> None:
    """Move every recorded day ``days`` into the past: what the calendar sees after ``days``.

    The live anchor, the record's entry moment, every pass and the pending day
    all move together, so the account reads exactly as it would ``days`` later.
    """
    delta = timedelta(days=days)
    progress = await _progress(session, user_id)
    passes = (
        (await session.execute(select(ProgramPass).where(col(ProgramPass.user_id) == user_id)))
        .scalars()
        .all()
    )
    assert progress.program_started_at is not None
    progress.program_started_at = ensure_aware(progress.program_started_at) - delta
    progress.stage_started_at = ensure_aware(progress.stage_started_at) - delta
    if progress.pending_pass_starts_on is not None:
        progress.pending_pass_starts_on -= delta
    for pass_ in passes:
        pass_.started_on -= delta
        session.add(pass_)
    session.add(progress)
    await session.commit()


# -- The pure rules --------------------------------------------------------


def test_the_forward_window_is_one_full_program() -> None:
    """Decision 5: as far ahead as the back-date window reaches behind."""
    assert PROGRAM_START_FORWARD_WINDOW_DAYS == TOTAL_PROGRAM_DAYS


def test_the_pickable_range_reaches_one_program_ahead() -> None:
    today = date(2026, 11, 15)
    bounds = program_start_bounds(today=today, account_created=today)
    assert bounds == ProgramStartBounds(
        earliest=today - timedelta(days=PROGRAM_START_BACKDATE_WINDOW_DAYS),
        latest=today + timedelta(days=PROGRAM_START_FORWARD_WINDOW_DAYS),
    )


@pytest.mark.parametrize(
    ("chosen_offset", "expected"),
    [
        (PROGRAM_START_FORWARD_WINDOW_DAYS + 1, "future"),
        (PROGRAM_START_FORWARD_WINDOW_DAYS, "ok"),
        (1, "ok"),
        (0, "ok"),
        (-10, "ok"),
        (-11, "before_current_start"),
        (-PROGRAM_START_BACKDATE_WINDOW_DAYS - 1, "too_early"),
    ],
)
def test_a_pass_start_is_classified_against_both_edges_and_the_live_pass(
    chosen_offset: int, expected: str
) -> None:
    """The live pass's own start is a floor: a new pass never begins before it."""
    today = date(2026, 11, 15)
    bounds = program_start_bounds(today=today, account_created=today)
    chosen = today + timedelta(days=chosen_offset)
    current = today - timedelta(days=10)
    assert pass_start_verdict(chosen, bounds, current_pass_start=current) == expected


def _row(anchor: datetime, pending: date | None) -> StageProgress:
    return StageProgress(
        user_id=1,
        current_stage=1,
        completed_stages=[],
        program_started_at=anchor,
        stage_started_at=anchor,
        pending_pass_starts_on=pending,
    )


def test_the_effective_anchor_stays_on_the_running_pass_until_the_pending_day() -> None:
    today = date(2026, 11, 15)
    running, _ = day_bounds_in_tz(_TZ, date(2026, 9, 14))
    pending = date(2026, 12, 1)
    row = _row(running, pending)

    assert effective_anchor(row, today, tz=_TZ) == running
    assert effective_anchor(row, pending - _ONE_DAY, tz=_TZ) == running
    arrived, _ = day_bounds_in_tz(_TZ, pending)
    assert effective_anchor(row, pending, tz=_TZ) == arrived
    assert days_until_start(row, today, tz=_TZ) == 0


def test_days_until_start_counts_down_to_a_future_live_anchor() -> None:
    today = date(2026, 11, 15)
    future, _ = day_bounds_in_tz(_TZ, date(2026, 12, 1))
    row = _row(future, None)

    assert effective_anchor(row, today, tz=_TZ) == future
    assert days_until_start(row, today, tz=_TZ) == _SIXTEEN_DAYS
    assert days_until_start(row, date(2026, 12, 1), tz=_TZ) == 0


def test_a_journal_entry_before_a_future_anchor_reads_as_week_one() -> None:
    """Prompt weeks floor at the program's first week before it begins."""
    anchor = datetime.now(UTC) + timedelta(days=10)
    row = JournalEntry(id=7, user_id=1, message="x", timestamp=datetime.now(UTC))

    assert _entry_ref_from(anchor, row, _TZ).week == 1


# -- Opening a pass now or in the past -------------------------------------


@pytest.mark.asyncio
async def test_opening_a_pass_today_in_cycle_one_closes_the_live_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "rescaffold_today")
    await _pick(async_client, headers, _today() - timedelta(days=_SIXTY_DAYS))

    body = await _open(async_client, headers, _today())

    assert body["cycle_number"] == 2
    assert body["calendar_stage"] == 1
    assert body["current_stage"] == 1
    assert body["days_until_start"] == 0
    assert body["pending_pass_starts_on"] is None
    first, second = await _passes(db_session, user_id)
    assert first.ended_on == _today() - _ONE_DAY
    # Day 59 of the first pass: stage 3, week 9, a partial completion.
    assert (first.reached_stage, first.reached_week, first.completed) == (3, 9, False)
    assert second.pass_number == 2
    assert second.origin == PassOrigin.RESCAFFOLD
    assert second.started_on == _today()
    assert second.ended_on is None
    progress = await _progress(db_session, user_id)
    assert progress.past_cycle_anchors is not None
    assert len(progress.past_cycle_anchors) == 1
    assert progress.highest_stage_reached == _THIRD_STAGE


@pytest.mark.asyncio
async def test_a_back_dated_pass_puts_the_record_where_its_calendar_is(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "rescaffold_backdated")
    await _pick(async_client, headers, _today() - timedelta(days=_SIXTY_DAYS + 10))

    body = await _open(async_client, headers, _today() - timedelta(days=_SIXTY_DAYS))

    assert body["calendar_stage"] == _THIRD_STAGE
    assert body["current_stage"] == _THIRD_STAGE
    first, second = await _passes(db_session, user_id)
    assert first.ended_on == second.started_on - _ONE_DAY
    assert second.started_on == _today() - timedelta(days=_SIXTY_DAYS)


@pytest.mark.asyncio
async def test_a_pass_opens_in_cycle_two_where_the_plain_put_is_refused(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "rescaffold_cycle_two")
    await _pick(async_client, headers, _today() - timedelta(days=_SIXTY_DAYS))
    await _open(async_client, headers, _today() - timedelta(days=_THIRTY_DAYS))

    put = await async_client.put(
        _CALENDAR, json={"program_start_date": _today().isoformat()}, headers=headers
    )
    assert put.status_code == HTTPStatus.CONFLICT
    assert put.json()["detail"] == "program_start_fixed_after_first_cycle"

    body = await _open(async_client, headers, _today())

    assert body["cycle_number"] == _THIRD_STAGE
    numbers = [(p.pass_number, p.origin) for p in await _passes(db_session, user_id)]
    assert numbers == [
        (1, PassOrigin.FIRST_RUN),
        (2, PassOrigin.RESCAFFOLD),
        (3, PassOrigin.RESCAFFOLD),
    ]


@pytest.mark.asyncio
async def test_a_person_with_no_progress_row_opens_their_first_pass_on_the_day(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """With nothing to close, the save starts pass 1 on the chosen day."""
    headers, user_id = await _signup(async_client, "rescaffold_first")
    chosen = _today() - timedelta(days=_SIXTY_DAYS)

    body = await _open(async_client, headers, chosen)

    assert body["cycle_number"] == 1
    assert body["calendar_stage"] == _THIRD_STAGE
    (only,) = await _passes(db_session, user_id)
    assert (only.pass_number, only.origin, only.started_on) == (1, PassOrigin.FIRST_RUN, chosen)


# -- What is refused ---------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("offset", "detail"),
    [
        (PROGRAM_START_FORWARD_WINDOW_DAYS + 1, "program_start_in_future"),
        (-_SIXTY_DAYS - 1, "pass_start_before_current_pass"),
        (-PROGRAM_START_BACKDATE_WINDOW_DAYS - 1, "program_start_too_early"),
    ],
)
async def test_a_day_outside_the_pass_window_is_refused_and_nothing_moves(
    async_client: AsyncClient, db_session: AsyncSession, offset: int, detail: str
) -> None:
    headers, user_id = await _signup(async_client, f"rescaffold_refused_{abs(offset)}")
    await _pick(async_client, headers, _today() - timedelta(days=_SIXTY_DAYS))

    resp = await async_client.post(
        _PASSES,
        json={"start_day": (_today() + timedelta(days=offset)).isoformat()},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == detail
    (only,) = await _passes(db_session, user_id)
    assert only.ended_on is None
    progress = await _progress(db_session, user_id)
    assert progress.cycle_number == 1
    assert progress.pending_pass_starts_on is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [{}, {"start_day": "not-a-date"}, {"start_day": "2026-12-01", "pass_id": 3}],
)
async def test_the_body_is_a_day_and_nothing_else(
    async_client: AsyncClient, payload: dict[str, object]
) -> None:
    headers, _ = await _signup(async_client, "rescaffold_malformed")

    resp = await async_client.post(_PASSES, json=payload, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_opening_a_pass_requires_authentication(async_client: AsyncClient) -> None:
    resp = await async_client.post(_PASSES, json={"start_day": "2026-12-01"})

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# -- A future pass -----------------------------------------------------------


@pytest.mark.asyncio
async def test_a_future_pass_leaves_stage_reveal_and_course_on_the_running_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "rescaffold_future")
    await _seed_stage_one_chapters(db_session)
    for name, stage, slot in (*_LADDER, _LOCKED_RING):
        await _add_ring(async_client, headers, name, stage, slot)
    await _pick(async_client, headers, _today() - timedelta(days=_SIXTY_DAYS))
    start_day = _today() + timedelta(days=_SIXTEEN_DAYS)

    body = await _open(async_client, headers, start_day)

    assert body["calendar_stage"] == _THIRD_STAGE
    assert body["current_stage"] == _THIRD_STAGE
    assert body["cycle_number"] == 1
    assert body["days_until_start"] == 0
    assert body["pending_pass_starts_on"] == start_day.isoformat()
    read = (await async_client.get(_CALENDAR, headers=headers)).json()
    assert read == body
    assert await _revealed(async_client, headers, db_session) == {n for n, _, _ in _LADDER}
    # Stage 1 is behind the running pass, so every chapter of it stays open.
    assert await _open_chapters(async_client, headers) == len(_CHAPTER_DAYS)
    (only,) = await _passes(db_session, user_id)
    assert only.ended_on is None


@pytest.mark.asyncio
async def test_a_second_future_save_replaces_the_pending_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "rescaffold_replace")
    await _open(async_client, headers, _today() + timedelta(days=_SIXTEEN_DAYS))

    body = await _open(async_client, headers, _today() + timedelta(days=_THIRTY_DAYS))

    assert body["pending_pass_starts_on"] == (_today() + timedelta(days=_THIRTY_DAYS)).isoformat()
    assert len(await _passes(db_session, user_id)) == 1
    progress = await _progress(db_session, user_id)
    assert progress.pending_pass_starts_on == _today() + timedelta(days=_THIRTY_DAYS)


@pytest.mark.asyncio
async def test_a_save_for_today_replaces_a_pending_pass_and_opens_now(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "rescaffold_replace_now")
    await _pick(async_client, headers, _today() - timedelta(days=_THIRTY_DAYS))
    await _open(async_client, headers, _today() + timedelta(days=_SIXTEEN_DAYS))

    body = await _open(async_client, headers, _today())

    assert body["pending_pass_starts_on"] is None
    assert [p.started_on for p in await _passes(db_session, user_id)] == [
        _today() - timedelta(days=_THIRTY_DAYS),
        _today(),
    ]


@pytest.mark.asyncio
async def test_the_day_arriving_closes_the_running_pass_with_what_it_reached(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "rescaffold_arrival")
    await _pick(async_client, headers, _today() - timedelta(days=_SIXTY_DAYS))
    await _open(async_client, headers, _today() + timedelta(days=_SIXTEEN_DAYS))
    await _shift_back(db_session, user_id, _SIXTEEN_DAYS)

    body = (await async_client.get(_CALENDAR, headers=headers)).json()

    assert body["cycle_number"] == 2
    assert body["calendar_stage"] == 1
    assert body["current_stage"] == 1
    assert body["pending_pass_starts_on"] is None
    first, second = await _passes(db_session, user_id)
    assert first.ended_on == _today() - _ONE_DAY
    # The pass ran 76 days (60 before the save, 16 after): day 75 is stage 4, week 11.
    assert (first.reached_stage, first.reached_week, first.completed) == (4, 11, False)
    assert (second.origin, second.started_on, second.ended_on) == (
        PassOrigin.RESCAFFOLD,
        _today(),
        None,
    )
    progress = await _progress(db_session, user_id)
    assert progress.pending_pass_starts_on is None
    assert progress.program_started_at is not None
    assert to_user_date(_TZ, ensure_aware(progress.program_started_at)) == _today()


@pytest.mark.asyncio
async def test_the_habit_list_also_settles_an_arrived_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A person who opens their habits first still lands in the new pass."""
    headers, user_id = await _signup(async_client, "rescaffold_arrival_habits")
    await _add_ring(async_client, headers, *_LADDER[0])
    await _pick(async_client, headers, _today() - timedelta(days=_SIXTY_DAYS))
    await _open(async_client, headers, _today() + timedelta(days=_SIXTEEN_DAYS))
    await _shift_back(db_session, user_id, _SIXTEEN_DAYS)

    assert (await async_client.get("/habits/", headers=headers)).status_code == HTTPStatus.OK

    assert [p.ended_on is None for p in await _passes(db_session, user_id)] == [False, True]


@pytest.mark.asyncio
async def test_begin_again_drops_a_pending_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "rescaffold_begin_again")
    await ensure_user_progress(db_session, user_id)
    await _open(async_client, headers, _today() + timedelta(days=_SIXTEEN_DAYS))
    progress = await _progress(db_session, user_id)
    progress.current_stage = TOTAL_STAGES
    progress.completed_stages = list(range(1, TOTAL_STAGES))
    db_session.add(progress)
    await db_session.commit()

    assert (await async_client.post("/stages/begin-again", headers=headers)).status_code == (
        HTTPStatus.OK
    )

    assert (await _progress(db_session, user_id)).pending_pass_starts_on is None
    origins = [p.origin for p in await _passes(db_session, user_id)]
    assert origins == [PassOrigin.FIRST_RUN, PassOrigin.BEGIN_AGAIN]


@pytest.mark.asyncio
async def test_begin_again_after_the_pending_day_finds_the_new_pass_instead(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The pending pass arrived first, so the person is at stage 1 and may not loop."""
    headers, user_id = await _signup(async_client, "rescaffold_begin_again_late")
    await ensure_user_progress(db_session, user_id)
    await _open(async_client, headers, _today() + timedelta(days=_SIXTEEN_DAYS))
    progress = await _progress(db_session, user_id)
    progress.current_stage = TOTAL_STAGES
    progress.completed_stages = list(range(1, TOTAL_STAGES))
    db_session.add(progress)
    await db_session.commit()
    await _shift_back(db_session, user_id, _SIXTEEN_DAYS)

    resp = await async_client.post("/stages/begin-again", headers=headers)

    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "cycle_not_complete"


@pytest.mark.asyncio
async def test_the_plain_put_replaces_a_pending_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The latest save wins: a first-cycle re-pick drops the pass it would have opened."""
    headers, user_id = await _signup(async_client, "rescaffold_put_after")
    await _open(async_client, headers, _today() + timedelta(days=_SIXTEEN_DAYS))

    body = await _pick(async_client, headers, _today() - timedelta(days=_SIXTY_DAYS))

    assert body["pending_pass_starts_on"] is None
    assert (await _progress(db_session, user_id)).pending_pass_starts_on is None


# -- Not yet begun -------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_first_cycle_pass_moved_into_the_future_has_not_begun(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "rescaffold_not_begun")
    await _seed_stage_one_chapters(db_session)
    await _add_ring(async_client, headers, *_LADDER[0])
    start_day = _today() + timedelta(days=_SIXTEEN_DAYS)

    body = await _pick(async_client, headers, start_day)

    assert body["days_until_start"] == _SIXTEEN_DAYS
    assert body["calendar_stage"] == 1
    assert body["calendar_week"] == 1
    assert body["current_stage"] == 1
    assert await _revealed(async_client, headers, db_session) == set()
    assert await _open_chapters(async_client, headers) == 0
    (only,) = await _passes(db_session, user_id)
    assert (only.started_on, only.ended_on) == (start_day, None)


@pytest.mark.asyncio
async def test_the_first_day_opens_what_waited_for_it(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "rescaffold_begins")
    await _seed_stage_one_chapters(db_session)
    await _add_ring(async_client, headers, *_LADDER[0])
    await _pick(async_client, headers, _today() + timedelta(days=_SIXTEEN_DAYS))
    await _revealed(async_client, headers, db_session)
    await _shift_back(db_session, user_id, _SIXTEEN_DAYS)

    body = (await async_client.get(_CALENDAR, headers=headers)).json()

    assert body["days_until_start"] == 0
    assert await _revealed(async_client, headers, db_session) == {_LADDER[0][0]}
    assert await _open_chapters(async_client, headers) == 1


@pytest.mark.asyncio
async def test_the_calendar_offers_the_window_a_new_pass_may_open_in(
    async_client: AsyncClient,
) -> None:
    """The floor is the live pass's own start; the ceiling is one program ahead."""
    headers, _ = await _signup(async_client, "rescaffold_window")
    chosen = _today() - timedelta(days=_SIXTY_DAYS)
    await _pick(async_client, headers, chosen)

    body = (await async_client.get(_CALENDAR, headers=headers)).json()

    assert body["pass_start_window"] == {
        "earliest": chosen.isoformat(),
        "latest": (_today() + timedelta(days=PROGRAM_START_FORWARD_WINDOW_DAYS)).isoformat(),
    }
    assert body["program_start_window"]["latest"] == body["pass_start_window"]["latest"]
