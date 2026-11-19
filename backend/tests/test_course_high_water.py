"""Course access holds at the highest stage reached (issue #3744).

The owner's decision on epic #3722: "The course work should stay at the highest
unlocked point that the user has reached until they begin to pass their high
water mark again, never go back down to beige in a reset, metta or otherwise."

Every stage below ``highest_stage_reached`` stays fully open, and the mark's own
stage stays open as far as it had dripped (``highest_drip_day``), after
begin-again, a rescaffold (today or back-dated) and an arriving pending pass. A
Metta Return never touches either. Once the new pass's own position passes the
mark, the calendar paces again and the mark moves up with it. Stage standing for
the Map and the ribbon -- ``current_stage`` and ``calendar_stage`` -- is not
part of this rule and resets exactly as before.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.constants import STAGE_DURATIONS_DAYS, TOTAL_STAGES
from domain.course import (
    NOT_BEGUN_DAY,
    course_open_through,
    drip_day_in_stage,
    held_drip_day,
    stage_duration_days,
    unlocked_chapter_count,
)
from domain.dates import ensure_aware, today_in_tz
from domain.stage_progress import is_stage_unlocked
from models.course_stage import CourseStage
from models.program_pass import ProgramPass
from models.stage_content import StageContent
from models.stage_progress import StageProgress
from services.reading_recommendations import available_readings

_TZ = "America/Los_Angeles"
_CALENDAR = "/stages/program-calendar"
_PASSES = "/stages/passes"
_BEGIN_AGAIN = "/stages/begin-again"
_METTA_START = "/metta-return/arc"
_METTA_LEAVE = "/metta-return/arc/leave"
_CHAPTERS_PER_STAGE = 6
# Day 130 of a pass is stage 7, day 5: stages 1-6 run 21 days each (126 days).
_DAYS_INTO_STAGE_SEVEN = 130
_STAGE_SEVEN = 7
_STAGE_SEVEN_DAY = 5
# Day 126 is stage 7's first day; a pending pass a week later arrives on its day 8.
_FIRST_DAY_OF_STAGE_SEVEN = 126
_ONE_WEEK = 7
# Day 220 of a pass is stage 10, day 11: stages 1-8 run 21 days, stage 9 runs 42 (210).
_DAYS_INTO_STAGE_TEN = 220
_STAGE_TEN_DAY = 11
# A back-dated pass thirty days ago stands on stage 2, day 10.
_THIRTY_DAYS = 30
_SECOND_STAGE = 2
# 150 days into the new pass is stage 8, day 4: past a stage-7 mark.
_PAST_STAGE_SEVEN = 150
_STAGE_EIGHT = 8
_STAGE_EIGHT_DAY = 4


# -- Helpers -------------------------------------------------------------------


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


async def _seed_course(session: AsyncSession) -> None:
    """Every stage with the same number of chapters, so each drip is countable."""
    for number in range(1, TOTAL_STAGES + 1):
        stage = CourseStage(
            title=f"Stage {number}",
            subtitle=f"Subtitle {number}",
            stage_number=number,
            overview_url=f"https://example.com/stage-{number}",
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
        for position in range(_CHAPTERS_PER_STAGE):
            session.add(
                StageContent(
                    course_stage_id=stage.id,
                    title=f"Stage {number} chapter {position}",
                    content_type="essay",
                    release_day=position,
                    url=f"https://cms.example.com/s{number}-{position}",
                )
            )
    await session.commit()


async def _progress(session: AsyncSession, user_id: int) -> StageProgress:
    session.expire_all()
    return (
        await session.execute(select(StageProgress).where(col(StageProgress.user_id) == user_id))
    ).scalar_one()


async def _pick(client: AsyncClient, headers: dict[str, str], chosen: date) -> None:
    resp = await client.put(
        _CALENDAR, json={"program_start_date": chosen.isoformat()}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK, resp.text


async def _open_pass(client: AsyncClient, headers: dict[str, str], start_day: date) -> None:
    resp = await client.post(_PASSES, json={"start_day": start_day.isoformat()}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED, resp.text


async def _open_chapters(client: AsyncClient, headers: dict[str, str], stage: int) -> int:
    """How many of ``stage``'s chapters the Course listing opens to the caller."""
    resp = await client.get(f"/course/stages/{stage}/content", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    return sum(1 for item in resp.json() if not item["is_locked"])


async def _course_map(client: AsyncClient, headers: dict[str, str]) -> list[int]:
    """Open chapters for every stage, in stage order."""
    return [await _open_chapters(client, headers, n) for n in range(1, TOTAL_STAGES + 1)]


def _dripped(stage: int, day: int) -> int:
    return unlocked_chapter_count(
        total=_CHAPTERS_PER_STAGE, duration_days=STAGE_DURATIONS_DAYS[stage - 1], day_in_stage=day
    )


def _held_map(mark: int, mark_chapters: int) -> list[int]:
    """Stages below ``mark`` fully open, ``mark`` at ``mark_chapters``, the rest shut."""
    return [
        _CHAPTERS_PER_STAGE if n < mark else mark_chapters if n == mark else 0
        for n in range(1, TOTAL_STAGES + 1)
    ]


async def _shift_back(session: AsyncSession, user_id: int, days: int) -> None:
    """Read the account as it will be ``days`` from now: every recorded day moves back."""
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


async def _standing(client: AsyncClient, headers: dict[str, str]) -> tuple[int, int]:
    body = (await client.get(_CALENDAR, headers=headers)).json()
    return body["current_stage"], body["calendar_stage"]


async def _at_stage_seven(client: AsyncClient, headers: dict[str, str]) -> None:
    """Put a first-cycle account on stage 7, day 5, by its own chosen start date."""
    await _pick(client, headers, _today() - timedelta(days=_DAYS_INTO_STAGE_SEVEN))


# -- The pure rule ---------------------------------------------------------------


def _row(*, current: int, mark: int, held: int, started_days_ago: int = 0) -> StageProgress:
    now = datetime.now(UTC)
    return StageProgress(
        user_id=1,
        current_stage=current,
        completed_stages=list(range(1, current)),
        highest_stage_reached=mark,
        highest_drip_day=held,
        stage_started_at=now,
        program_started_at=now - timedelta(days=started_days_ago),
    )


def test_the_mark_holds_every_stage_below_it_and_its_own_drip() -> None:
    row = _row(current=1, mark=_STAGE_SEVEN, held=_STAGE_SEVEN_DAY)
    duration = stage_duration_days(_STAGE_SEVEN - 1)

    assert held_drip_day(row, _STAGE_SEVEN - 1, duration_days=duration) == duration
    assert held_drip_day(row, _STAGE_SEVEN, duration_days=duration) == _STAGE_SEVEN_DAY
    assert held_drip_day(row, _STAGE_EIGHT, duration_days=duration) == NOT_BEGUN_DAY


def test_the_course_opens_through_the_mark_while_the_calendar_stays_on_stage_one() -> None:
    row = _row(current=1, mark=_STAGE_SEVEN, held=_STAGE_SEVEN_DAY)

    assert course_open_through(row, tz=_TZ) == _STAGE_SEVEN
    assert is_stage_unlocked(_STAGE_SEVEN, row, tz=_TZ)
    assert not is_stage_unlocked(_STAGE_EIGHT, row, tz=_TZ)
    assert course_open_through(None, tz=_TZ) == 1


def test_the_drip_runs_on_whichever_is_further_the_live_day_or_the_held_one() -> None:
    """Back on the mark's stage, the new pass's own day wins once it passes the held day."""
    duration = stage_duration_days(_STAGE_SEVEN)
    behind = _row(current=_STAGE_SEVEN, mark=_STAGE_SEVEN, held=_STAGE_SEVEN_DAY)
    ahead = _row(
        current=_STAGE_SEVEN,
        mark=_STAGE_SEVEN,
        held=_STAGE_SEVEN_DAY,
        started_days_ago=_FIRST_DAY_OF_STAGE_SEVEN + _ONE_WEEK,
    )

    assert drip_day_in_stage(behind, _STAGE_SEVEN, duration_days=duration, tz=_TZ) == (
        _STAGE_SEVEN_DAY
    )
    assert drip_day_in_stage(ahead, _STAGE_SEVEN, duration_days=duration, tz=_TZ) == (_ONE_WEEK + 1)


def test_stage_lengths_clamp_to_the_curriculum() -> None:
    assert stage_duration_days(0) == STAGE_DURATIONS_DAYS[0]
    assert stage_duration_days(TOTAL_STAGES + 1) == STAGE_DURATIONS_DAYS[-1]


# -- Begin-again -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_begin_again_after_stage_ten_keeps_the_whole_course_open(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "hw_begin_again")
    await _seed_course(db_session)
    await _pick(async_client, headers, _today() - timedelta(days=_DAYS_INTO_STAGE_TEN))
    before = await _course_map(async_client, headers)

    resp = await async_client.post(_BEGIN_AGAIN, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    expected = _held_map(TOTAL_STAGES, _dripped(TOTAL_STAGES, _STAGE_TEN_DAY))
    assert before == expected
    assert await _course_map(async_client, headers) == expected
    progress = await _progress(db_session, user_id)
    assert (progress.highest_stage_reached, progress.highest_drip_day) == (
        TOTAL_STAGES,
        _STAGE_TEN_DAY,
    )
    # The Map and the ribbon are back on stage 1: the rule is the Course's only.
    assert await _standing(async_client, headers) == (1, 1)


@pytest.mark.asyncio
async def test_the_stage_list_and_a_chapter_stay_open_after_begin_again(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _ = await _signup(async_client, "hw_begin_again_list")
    await _seed_course(db_session)
    await _pick(async_client, headers, _today() - timedelta(days=_DAYS_INTO_STAGE_TEN))
    assert (await async_client.post(_BEGIN_AGAIN, headers=headers)).status_code == HTTPStatus.OK

    stages = (await async_client.get("/stages", headers=headers)).json()
    chapter = (
        (
            await db_session.execute(
                select(StageContent)
                .join(CourseStage, col(CourseStage.id) == col(StageContent.course_stage_id))
                .where(col(CourseStage.stage_number) == TOTAL_STAGES - 1)
            )
        )
        .scalars()
        .first()
    )

    assert all(stage["is_unlocked"] for stage in stages)
    assert chapter is not None
    detail = await async_client.get(f"/course/content/{chapter.id}", headers=headers)
    assert detail.status_code == HTTPStatus.OK
    assert detail.json()["is_locked"] is False


# -- Rescaffold --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_rescaffold_today_after_stage_seven_keeps_the_course_through_seven(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "hw_rescaffold_today")
    await _seed_course(db_session)
    await _at_stage_seven(async_client, headers)
    before = await _course_map(async_client, headers)

    await _open_pass(async_client, headers, _today())

    expected = _held_map(_STAGE_SEVEN, _dripped(_STAGE_SEVEN, _STAGE_SEVEN_DAY))
    assert before == expected
    assert await _course_map(async_client, headers) == expected
    assert await _standing(async_client, headers) == (1, 1)
    # Reading invitations draw on the same rule as the listing.
    sixth = await available_readings(db_session, user_id, _STAGE_SEVEN - 1, _TZ)
    seventh = await available_readings(db_session, user_id, _STAGE_SEVEN, _TZ)
    eighth = await available_readings(db_session, user_id, _STAGE_EIGHT, _TZ)
    assert len(sixth) == _CHAPTERS_PER_STAGE
    assert len(seventh) == _dripped(_STAGE_SEVEN, _STAGE_SEVEN_DAY)
    assert eighth == []


@pytest.mark.asyncio
async def test_a_back_dated_rescaffold_below_the_mark_keeps_the_mark(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "hw_rescaffold_back")
    await _seed_course(db_session)
    await _at_stage_seven(async_client, headers)

    await _open_pass(async_client, headers, _today() - timedelta(days=_THIRTY_DAYS))

    assert await _standing(async_client, headers) == (_SECOND_STAGE, _SECOND_STAGE)
    assert await _course_map(async_client, headers) == _held_map(
        _STAGE_SEVEN, _dripped(_STAGE_SEVEN, _STAGE_SEVEN_DAY)
    )
    assert (await _progress(db_session, user_id)).highest_stage_reached == _STAGE_SEVEN


@pytest.mark.asyncio
async def test_an_arriving_pending_pass_keeps_what_the_running_pass_had_dripped(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Held as of the day before the pending day: what the outgoing pass last showed."""
    headers, user_id = await _signup(async_client, "hw_pending")
    await _seed_course(db_session)
    await _pick(async_client, headers, _today() - timedelta(days=_FIRST_DAY_OF_STAGE_SEVEN))
    await _open_pass(async_client, headers, _today() + timedelta(days=_ONE_WEEK))
    await _shift_back(db_session, user_id, _ONE_WEEK)

    assert await _standing(async_client, headers) == (1, 1)

    progress = await _progress(db_session, user_id)
    assert progress.cycle_number == _SECOND_STAGE
    assert progress.highest_drip_day == _ONE_WEEK
    assert await _course_map(async_client, headers) == _held_map(
        _STAGE_SEVEN, _dripped(_STAGE_SEVEN, _ONE_WEEK)
    )


@pytest.mark.asyncio
async def test_the_new_pass_overtaking_the_mark_resumes_calendar_pacing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "hw_overtake")
    await _seed_course(db_session)
    await _at_stage_seven(async_client, headers)
    await _open_pass(async_client, headers, _today())
    await _shift_back(db_session, user_id, _PAST_STAGE_SEVEN)

    course = await _course_map(async_client, headers)

    assert course == _held_map(_STAGE_EIGHT, _dripped(_STAGE_EIGHT, _STAGE_EIGHT_DAY))
    progress = await _progress(db_session, user_id)
    assert (progress.current_stage, progress.highest_stage_reached) == (_STAGE_EIGHT,) * 2
    assert progress.highest_drip_day == NOT_BEGUN_DAY


# -- The first-cycle re-pick -------------------------------------------------------


@pytest.mark.asyncio
async def test_a_later_re_pick_below_the_mark_keeps_the_mark_open(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A correction that moves the record back keeps what the Course had opened."""
    headers, _ = await _signup(async_client, "hw_re_pick")
    await _seed_course(db_session)
    await _at_stage_seven(async_client, headers)

    await _pick(async_client, headers, _today() - timedelta(days=_THIRTY_DAYS))

    assert await _standing(async_client, headers) == (_SECOND_STAGE, _SECOND_STAGE)
    assert await _course_map(async_client, headers) == _held_map(
        _STAGE_SEVEN, _dripped(_STAGE_SEVEN, _STAGE_SEVEN_DAY)
    )


# -- Metta Return ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_metta_return_start_and_leave_leave_course_access_unchanged(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "hw_metta")
    await _seed_course(db_session)
    await _at_stage_seven(async_client, headers)
    before = await _course_map(async_client, headers)
    row = await _progress(db_session, user_id)
    snapshot = (
        row.current_stage,
        row.highest_stage_reached,
        row.highest_drip_day,
        row.cycle_number,
        row.program_started_at,
    )

    started = await async_client.post(_METTA_START, headers=headers)
    assert started.status_code == HTTPStatus.CREATED, started.text
    during = await _course_map(async_client, headers)
    left = await async_client.post(_METTA_LEAVE, headers=headers)
    assert left.status_code == HTTPStatus.OK, left.text

    assert during == before
    assert await _course_map(async_client, headers) == before
    row = await _progress(db_session, user_id)
    assert (
        row.current_stage,
        row.highest_stage_reached,
        row.highest_drip_day,
        row.cycle_number,
        row.program_started_at,
    ) == snapshot


# -- Tenancy -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_one_accounts_mark_opens_nothing_for_another(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    holder, _ = await _signup(async_client, "hw_holder")
    stranger, stranger_id = await _signup(async_client, "hw_stranger")
    await _seed_course(db_session)
    await _pick(async_client, holder, _today() - timedelta(days=_DAYS_INTO_STAGE_TEN))
    assert (await async_client.post(_BEGIN_AGAIN, headers=holder)).status_code == HTTPStatus.OK

    assert await _course_map(async_client, stranger) == _held_map(1, _dripped(1, 1))
    assert await available_readings(db_session, stranger_id, _SECOND_STAGE, _TZ) == []
    progress = await _progress(db_session, stranger_id)
    assert (progress.highest_stage_reached, progress.highest_drip_day) == (1, NOT_BEGUN_DAY)
