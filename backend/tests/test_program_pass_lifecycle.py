"""Each pass through the stages is kept as its own ``programpass`` row (issue #3723).

First provisioning opens pass 1; begin-again closes the live pass (the day
before the new one starts, measured from the pass's own start) and opens the
next, in the same commit and under the same ``FOR UPDATE`` lock as the cycle
loop. ``past_cycle_anchors`` keeps being written alongside.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.constants import TOTAL_STAGES
from domain.dates import ensure_aware, to_user_date, today_in_tz
from domain.stage_progress import ensure_user_progress
from models.program_pass import PassOrigin, ProgramPass
from models.stage_progress import StageProgress

# UTC+14: the local day differs from the UTC day for ten hours of every day,
# so a pass dated from the UTC calendar instead of the account's is caught.
_FAR_EAST_TZ = "Pacific/Kiritimati"
# 300 days is past the 252-day program: the outgoing pass ran to the end.
_FINISHED_PASS_DAYS = 300
# 100 days in is mid-stage 5 (day 99: stage 5 opens on day 84, week 15).
_PARTIAL_PASS_DAYS = 100
_PARTIAL_STAGE = 5
_PARTIAL_WEEK = 15


async def _signup(
    client: AsyncClient, username: str, timezone: str = _FAR_EAST_TZ
) -> tuple[dict[str, str], int]:
    """Create a user in ``timezone`` and return ``(auth headers, user_id)``."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
            "timezone": timezone,
        },
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user_id"]


async def _passes(session: AsyncSession, user_id: int) -> list[ProgramPass]:
    """Every pass ``user_id`` has, oldest first, read fresh from the database."""
    session.expire_all()
    result = await session.execute(
        select(ProgramPass)
        .where(col(ProgramPass.user_id) == user_id)
        .order_by(col(ProgramPass.pass_number))
    )
    return list(result.scalars().all())


async def _provision_finished_pass(
    session: AsyncSession, user_id: int, *, days_ago: int
) -> StageProgress:
    """Provision pass 1, then move it ``days_ago`` into the past and complete the cycle."""
    await ensure_user_progress(session, user_id)
    (live,) = await _passes(session, user_id)
    progress = (
        await session.execute(select(StageProgress).where(col(StageProgress.user_id) == user_id))
    ).scalar_one()
    anchor = datetime.now(UTC) - timedelta(days=days_ago)
    progress.program_started_at = anchor
    progress.stage_started_at = anchor
    progress.current_stage = TOTAL_STAGES
    progress.completed_stages = list(range(1, TOTAL_STAGES))
    live.started_on = to_user_date(_FAR_EAST_TZ, anchor)
    session.add_all([progress, live])
    await session.commit()
    await session.refresh(progress)
    return progress


async def _complete_cycle(session: AsyncSession, progress: StageProgress) -> None:
    """Put the row back at stage 10 so begin-again is permitted again."""
    progress.current_stage = TOTAL_STAGES
    progress.completed_stages = list(range(1, TOTAL_STAGES))
    session.add(progress)
    await session.commit()


@pytest.mark.asyncio
async def test_first_provisioning_opens_pass_one_in_the_account_zone(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The first StageProgress row opens pass 1, live, dated in the account's zone."""
    _, user_id = await _signup(async_client, "pass_first_run")

    progress = await ensure_user_progress(db_session, user_id)
    anchor = progress.program_started_at

    (first,) = await _passes(db_session, user_id)
    assert anchor is not None
    assert first.pass_number == 1
    assert first.origin == PassOrigin.FIRST_RUN
    assert first.started_on == to_user_date(_FAR_EAST_TZ, ensure_aware(anchor))
    assert first.ended_on is None
    assert first.reached_stage is None
    assert first.reached_week is None
    assert first.completed is False


@pytest.mark.asyncio
async def test_provisioning_twice_keeps_one_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-reading an existing row opens nothing new."""
    _, user_id = await _signup(async_client, "pass_idempotent")

    await ensure_user_progress(db_session, user_id)
    await ensure_user_progress(db_session, user_id)

    assert len(await _passes(db_session, user_id)) == 1


@pytest.mark.asyncio
async def test_picking_the_start_date_in_the_first_cycle_moves_the_live_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The live pass starts on the day the program does, so a re-pick carries it along."""
    headers, user_id = await _signup(async_client, "pass_repick")
    chosen = today_in_tz(_FAR_EAST_TZ) - timedelta(days=30)

    resp = await async_client.put(
        "/stages/program-calendar",
        headers=headers,
        json={"program_start_date": chosen.isoformat()},
    )

    assert resp.status_code == HTTPStatus.OK
    (first,) = await _passes(db_session, user_id)
    assert first.started_on == chosen
    assert first.origin == PassOrigin.FIRST_RUN
    assert first.ended_on is None


@pytest.mark.asyncio
async def test_begin_again_closes_the_live_pass_and_opens_the_next(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Pass 1 ends the day before pass 2 starts; pass 2 is live and starts today."""
    headers, user_id = await _signup(async_client, "pass_begin_again")
    await _provision_finished_pass(db_session, user_id, days_ago=_FINISHED_PASS_DAYS)

    resp = await async_client.post("/stages/begin-again", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    progress = (
        await db_session.execute(select(StageProgress).where(col(StageProgress.user_id) == user_id))
    ).scalar_one()
    assert progress.program_started_at is not None
    new_start = to_user_date(_FAR_EAST_TZ, ensure_aware(progress.program_started_at))
    # The anchor list is still written alongside the pass rows.
    assert progress.past_cycle_anchors is not None
    assert len(progress.past_cycle_anchors) == 1
    first, second = await _passes(db_session, user_id)
    assert first.ended_on == new_start - timedelta(days=1)
    assert (first.reached_stage, first.reached_week, first.completed) == (TOTAL_STAGES, 36, True)
    assert second.pass_number == 2
    assert second.origin == PassOrigin.BEGIN_AGAIN
    assert second.started_on == new_start
    assert second.ended_on is None
    assert (second.reached_stage, second.reached_week, second.completed) == (None, None, False)


@pytest.mark.asyncio
async def test_begin_again_records_a_partial_pass_by_its_own_start(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A pass left on day 99 reached stage 5, week 15, and is a partial completion."""
    headers, user_id = await _signup(async_client, "pass_partial")
    await _provision_finished_pass(db_session, user_id, days_ago=_PARTIAL_PASS_DAYS)

    assert (await async_client.post("/stages/begin-again", headers=headers)).status_code == (
        HTTPStatus.OK
    )

    first, _ = await _passes(db_session, user_id)
    assert first.reached_stage == _PARTIAL_STAGE
    assert first.reached_week == _PARTIAL_WEEK
    assert first.completed is False


@pytest.mark.asyncio
async def test_a_second_begin_again_closes_pass_two_and_opens_pass_three(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Each loop closes exactly the live pass; earlier passes are not rewritten."""
    headers, user_id = await _signup(async_client, "pass_two_loops")
    progress = await _provision_finished_pass(db_session, user_id, days_ago=_FINISHED_PASS_DAYS)
    assert (await async_client.post("/stages/begin-again", headers=headers)).status_code == (
        HTTPStatus.OK
    )
    first_before, _ = await _passes(db_session, user_id)
    first_snapshot = (first_before.ended_on, first_before.reached_stage, first_before.completed)

    await db_session.refresh(progress)
    await _complete_cycle(db_session, progress)
    assert (await async_client.post("/stages/begin-again", headers=headers)).status_code == (
        HTTPStatus.OK
    )

    first, second, third = await _passes(db_session, user_id)
    assert (first.ended_on, first.reached_stage, first.completed) == first_snapshot
    # Pass 2 began and ended today: it ran no days at all.
    assert second.ended_on == third.started_on - timedelta(days=1)
    assert (second.reached_stage, second.reached_week, second.completed) == (1, 1, False)
    assert third.pass_number == 3
    assert third.origin == PassOrigin.BEGIN_AGAIN
    assert third.ended_on is None


@pytest.mark.asyncio
async def test_begin_again_without_a_recorded_pass_records_the_outgoing_one(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A row the backfill never saw still leaves its outgoing pass behind.

    A StageProgress row written by a build that predates the table has no live
    pass. Begin-again records the outgoing pass from the live anchor (as a
    backfill, numbered by its cycle) before closing it, so the loop never
    silently drops the pass it is ending.
    """
    headers, user_id = await _signup(async_client, "pass_unrecorded")
    anchor = datetime.now(UTC) - timedelta(days=_FINISHED_PASS_DAYS)
    db_session.add(
        StageProgress(
            user_id=user_id,
            current_stage=TOTAL_STAGES,
            completed_stages=list(range(1, TOTAL_STAGES)),
            cycle_number=2,
            program_started_at=anchor,
            stage_started_at=anchor,
        )
    )
    await db_session.commit()

    assert (await async_client.post("/stages/begin-again", headers=headers)).status_code == (
        HTTPStatus.OK
    )

    outgoing, incoming = await _passes(db_session, user_id)
    assert outgoing.pass_number == 2
    assert outgoing.origin == PassOrigin.BACKFILL
    assert outgoing.started_on == to_user_date(_FAR_EAST_TZ, anchor)
    assert outgoing.ended_on == incoming.started_on - timedelta(days=1)
    assert outgoing.completed is True
    assert incoming.pass_number == 3
    assert incoming.origin == PassOrigin.BEGIN_AGAIN


@pytest.mark.asyncio
async def test_a_refused_begin_again_leaves_the_live_pass_alone(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Mid-cycle begin-again is a 409, and the pass record does not move."""
    headers, user_id = await _signup(async_client, "pass_refused")
    await ensure_user_progress(db_session, user_id)

    resp = await async_client.post("/stages/begin-again", headers=headers)

    assert resp.status_code == HTTPStatus.CONFLICT
    (only,) = await _passes(db_session, user_id)
    assert only.ended_on is None


@pytest.mark.asyncio
async def test_begin_again_touches_only_the_callers_passes(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Bob's loop neither closes Alice's live pass nor numbers his own after hers."""
    _, alice_id = await _signup(async_client, "pass_alice")
    bob_headers, bob_id = await _signup(async_client, "pass_bob")
    await ensure_user_progress(db_session, alice_id)
    await _provision_finished_pass(db_session, bob_id, days_ago=_FINISHED_PASS_DAYS)

    assert (await async_client.post("/stages/begin-again", headers=bob_headers)).status_code == (
        HTTPStatus.OK
    )

    (alice_pass,) = await _passes(db_session, alice_id)
    assert alice_pass.ended_on is None
    assert [p.pass_number for p in await _passes(db_session, bob_id)] == [1, 2]


@pytest.mark.asyncio
async def test_re_picking_the_start_without_a_recorded_pass_opens_none(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A row that predates the table is re-anchored without inventing a pass.

    Begin-again records the outgoing pass from the live anchor when it closes,
    so the re-pick needs no row of its own.
    """
    headers, user_id = await _signup(async_client, "pass_repick_unrecorded")
    db_session.add(StageProgress(user_id=user_id, current_stage=1, completed_stages=[]))
    await db_session.commit()
    chosen = today_in_tz(_FAR_EAST_TZ) - timedelta(days=10)

    resp = await async_client.put(
        "/stages/program-calendar",
        headers=headers,
        json={"program_start_date": chosen.isoformat()},
    )

    assert resp.status_code == HTTPStatus.OK
    assert await _passes(db_session, user_id) == []
