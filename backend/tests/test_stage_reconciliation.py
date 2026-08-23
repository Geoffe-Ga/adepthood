"""The calendar paces what is offered; showing up is what records entry.

``StageProgress.current_stage`` could not move: the only code that advanced
it lived behind a client-driven ``PUT`` no client ever called. These tests
pin the replacement -- the server records entry into whatever window the
calendar has already opened, the moment the person shows up, with nobody
asking -- and pin the constraint that makes it safe: a record that lags the
calendar withholds nothing.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import select

from domain.constants import TOTAL_STAGES
from domain.stage_progress import is_stage_unlocked
from models.course_stage import CourseStage
from models.stage_progress import StageProgress

# 60 days after the anchor: stages 1 and 2 (21 days each) have closed and the
# calendar is 18 days into stage 3.
_SIXTY_DAYS = 60
_THIRD_STAGE = 3
# Well past the 252-day curriculum, so a stale anchor would offer stage 10.
_THREE_HUNDRED_DAYS = 300


def _stage_row(stage_number: int) -> CourseStage:
    """A minimal seeded ``CourseStage`` so stage lookups resolve."""
    return CourseStage(
        title=f"Stage {stage_number}",
        subtitle=f"Subtitle {stage_number}",
        stage_number=stage_number,
        overview_url=f"https://example.com/stage-{stage_number}",
        category="test",
        aspect="test-aspect",
        spiral_dynamics_color="beige",
        growing_up_stage="archaic",
        divine_gender_polarity="masculine",
        relationship_to_free_will="active",
        free_will_description="Active Yes-And-Ness",
    )


async def _seed_stages(db_session: AsyncSession, count: int = 3) -> None:
    """Insert ``count`` course stages so stage lookups resolve."""
    for stage_number in range(1, count + 1):
        db_session.add(_stage_row(stage_number))
    await db_session.commit()


async def _signup(client: AsyncClient, username: str = "reconciler") -> tuple[dict[str, str], int]:
    """Create a user and return ``(auth headers, user_id)``."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user_id"]


async def _anchored_progress(
    db_session: AsyncSession,
    user_id: int,
    *,
    days_ago: int,
    current_stage: int = 1,
) -> StageProgress:
    """Persist a progress row whose program anchor is ``days_ago`` in the past."""
    anchor = datetime.now(UTC) - timedelta(days=days_ago)
    progress = StageProgress(
        user_id=user_id,
        current_stage=current_stage,
        completed_stages=list(range(1, current_stage)),
        stage_started_at=anchor,
        program_started_at=anchor,
        highest_stage_reached=current_stage,
    )
    db_session.add(progress)
    await db_session.commit()
    await db_session.refresh(progress)
    return progress


# -- Entry is recorded by showing up, not by asking ----------------------


@pytest.mark.asyncio
async def test_reading_the_calendar_records_entry_into_the_open_window(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Two months away, then one visit: the record catches up to the calendar."""
    headers, user_id = await _signup(async_client)
    progress = await _anchored_progress(db_session, user_id, days_ago=_SIXTY_DAYS)

    resp = await async_client.get("/stages/program-calendar", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["current_stage"] == _THIRD_STAGE
    await db_session.refresh(progress)
    assert progress.current_stage == _THIRD_STAGE
    assert progress.completed_stages == [1, 2]
    assert progress.highest_stage_reached == _THIRD_STAGE


@pytest.mark.asyncio
async def test_listing_the_stages_records_entry_too(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The Map's other read is a visit as well -- no button, no payload."""
    headers, user_id = await _signup(async_client, "maplooker")
    await _seed_stages(db_session)
    progress = await _anchored_progress(db_session, user_id, days_ago=_SIXTY_DAYS)

    resp = await async_client.get("/stages", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    await db_session.refresh(progress)
    assert progress.current_stage == _THIRD_STAGE


@pytest.mark.asyncio
async def test_entry_stops_at_the_calendar_and_never_runs_past_it(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Showing up enters the window that is open, not the whole curriculum."""
    headers, user_id = await _signup(async_client, "notaskipper")
    progress = await _anchored_progress(db_session, user_id, days_ago=_SIXTY_DAYS)

    await async_client.get("/stages/program-calendar", headers=headers)

    await db_session.refresh(progress)
    assert progress.current_stage < TOTAL_STAGES


@pytest.mark.asyncio
async def test_no_entry_is_recorded_while_the_window_has_not_moved(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Five days in is still stage 1; nothing is written and nothing moves."""
    headers, user_id = await _signup(async_client, "earlydays")
    progress = await _anchored_progress(db_session, user_id, days_ago=5)
    entered_at = progress.stage_started_at

    resp = await async_client.get("/stages/program-calendar", headers=headers)

    assert resp.json()["current_stage"] == 1
    await db_session.refresh(progress)
    assert progress.current_stage == 1
    assert progress.stage_started_at == entered_at


@pytest.mark.asyncio
async def test_a_second_visit_in_the_same_window_re_records_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Entry is a threshold crossing, so the entry moment survives the next read."""
    headers, user_id = await _signup(async_client, "repeatvisitor")
    progress = await _anchored_progress(db_session, user_id, days_ago=_SIXTY_DAYS)

    await async_client.get("/stages/program-calendar", headers=headers)
    await db_session.refresh(progress)
    entered_at = progress.stage_started_at

    await async_client.get("/stages/program-calendar", headers=headers)

    await db_session.refresh(progress)
    assert progress.current_stage == _THIRD_STAGE
    assert progress.stage_started_at == entered_at


# -- The gap withholds nothing -------------------------------------------


@pytest.mark.asyncio
async def test_a_lagging_record_does_not_lock_a_stage_the_calendar_opened(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The constraint that makes a lagging record safe to keep.

    ``/stages/{n}/history`` does not reconcile, so the record is still at
    stage 1 when the gate runs. It must open stage 3 anyway.
    """
    headers, user_id = await _signup(async_client, "unlocked")
    await _seed_stages(db_session)
    progress = await _anchored_progress(db_session, user_id, days_ago=_SIXTY_DAYS)

    resp = await async_client.get(f"/stages/{_THIRD_STAGE}/history", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert progress.current_stage == 1


@pytest.mark.asyncio
async def test_every_stage_the_calendar_opened_is_unlocked_for_a_lagging_record(
    db_session: AsyncSession,
) -> None:
    """No stage inside the open window is withheld because the record lags."""
    progress = await _anchored_progress(db_session, 1, days_ago=_SIXTY_DAYS)

    assert all(is_stage_unlocked(stage, progress) for stage in range(1, _THIRD_STAGE + 1))
    assert is_stage_unlocked(_THIRD_STAGE + 1, progress) is False


# -- Begin again re-anchors both answers together ------------------------


@pytest.mark.asyncio
async def test_begin_again_re_anchors_the_calendar_so_the_next_lap_starts_over(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The reset moves the record and the anchor, or the two diverge forever.

    Without the anchor reset the very next read would re-record entry into
    stage 10 and the second lap would be over before it began.
    """
    headers, user_id = await _signup(async_client, "loopback")
    progress = await _anchored_progress(
        db_session, user_id, days_ago=_THREE_HUNDRED_DAYS, current_stage=TOTAL_STAGES
    )

    reset = await async_client.post("/stages/begin-again", headers=headers)
    assert reset.status_code == HTTPStatus.OK

    resp = await async_client.get("/stages/program-calendar", headers=headers)

    assert resp.json()["calendar_stage"] == 1
    assert resp.json()["current_stage"] == 1
    await db_session.refresh(progress)
    assert progress.current_stage == 1
    assert progress.highest_stage_reached == TOTAL_STAGES


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_two_visits_at_once_record_one_entry(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Two tabs opening the Map together must not race the record apart.

    The write is taken under ``FOR UPDATE`` and the standing recomputed
    against the locked row, so whichever request loses finds the entry
    already recorded and writes nothing.
    """
    headers, user_id = await _signup(concurrent_async_client, "twotabs")
    async with concurrent_session_factory() as seeding:
        await _anchored_progress(seeding, user_id, days_ago=_SIXTY_DAYS)

    results = await asyncio.gather(
        concurrent_async_client.get("/stages/program-calendar", headers=headers),
        concurrent_async_client.get("/stages/program-calendar", headers=headers),
    )

    assert all(resp.status_code == HTTPStatus.OK for resp in results)
    assert {resp.json()["current_stage"] for resp in results} == {_THIRD_STAGE}
    async with concurrent_session_factory() as reading:
        found = await reading.execute(select(StageProgress).where(StageProgress.user_id == user_id))
        rows = list(found.scalars().all())
    assert len(rows) == 1
    assert rows[0].current_stage == _THIRD_STAGE
    assert rows[0].completed_stages == [1, 2]


# -- The client-driven advance route is gone -----------------------------


@pytest.mark.asyncio
async def test_the_client_driven_advance_route_is_retired(async_client: AsyncClient) -> None:
    """A route no client called, asking the server to accept a client's opinion."""
    headers, _ = await _signup(async_client, "stalecaller")

    resp = await async_client.put("/stages/progress", json={"current_stage": 2}, headers=headers)

    assert resp.status_code == HTTPStatus.NOT_FOUND
