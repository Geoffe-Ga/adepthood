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
from typing import NamedTuple
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import async_session_factory
from domain.stage_progress import get_user_progress
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.metta_return_arc import MettaReturnArc
from models.metta_return_habit_release import MettaReturnHabitRelease
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


# --- The cadence sweep (AC3-AC10, AC24) ------------------------------------
#
# Every expected value below is a literal, never derived from
# ``STAGE_DURATIONS_DAYS`` or ``calendar_stage``: an oracle computed by the code
# under test would move with it. The ladder is eight 21-day windows then two
# 42-day windows, so the rings open on local days 0, 21, 42, 63, 84, 105, 126,
# 147, 168 and 210. Each boundary appears with the day before it.
_LADDER = (
    "Beige",
    "Purple",
    "Red",
    "Blue",
    "Orange",
    "Green",
    "Yellow",
    "Teal",
    "Ultraviolet",
    "Clear Light",
)
_OPEN_STAGE_ON_DAY = {
    0: 1,
    20: 1,
    21: 2,
    41: 2,
    42: 3,
    62: 3,
    63: 4,
    83: 4,
    84: 5,
    104: 5,
    105: 6,
    125: 6,
    126: 7,
    146: 7,
    147: 8,
    167: 8,
    168: 9,
    209: 9,
    210: 10,
    251: 10,
}
_LOS_ANGELES = "America/Los_Angeles"
# 2026-02-20 + 16 days is the 2026-03-08 spring-forward; 2026-07-01 + 123 days
# is the 2026-11-01 fall-back, and its sweep reaches the 2027-03-14 spring-forward.
_ANCHOR_DATES = (date(2026, 2, 20), date(2026, 7, 1))
_ANCHOR_HOUR = 9
_NOON = 12
# After 17:00 in Los Angeles the UTC date is already tomorrow's, so a reveal
# keyed to the UTC date instead of the local one opens a ring a day early.
_LATE_HOUR, _LATE_MINUTE = 17, 30
_RELOCKED_STAGE = 3
_GAP_DAYS = 60
_STAGE_OPEN_AFTER_GAP = 3


def _local(tz: str, day: date, hour: int, minute: int = 0) -> datetime:
    """``day`` at ``hour:minute`` wall-clock time in ``tz``, as an aware UTC datetime."""
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=ZoneInfo(tz)).astimezone(UTC)


async def _seed_ladder(session: AsyncSession, user_id: int, anchor_day: date) -> list[Habit]:
    """Lay one locked habit on each of the ten rings, start-dated to the anchor."""
    return [
        await _add_habit(session, user_id, _Seed(f"{colour} ring", colour, anchor_day, slot))
        for slot, colour in enumerate(_LADDER, start=1)
    ]


async def _anchor_at(session: AsyncSession, user_id: int, anchor: datetime) -> StageProgress:
    """Give ``user_id`` a stage-1 record whose calendar starts at ``anchor``."""
    progress = StageProgress(
        user_id=user_id,
        current_stage=1,
        completed_stages=[],
        highest_stage_reached=1,
        program_started_at=anchor,
        stage_started_at=anchor,
    )
    session.add(progress)
    await session.commit()
    return progress


async def _revealed(session: AsyncSession, user_id: int) -> dict[str, bool]:
    """Read every habit's persisted ``revealed`` flag, keyed by name."""
    result = await session.execute(select(Habit).where(Habit.user_id == user_id))
    return {habit.name: habit.revealed for habit in result.scalars().all()}


async def _markers(session: AsyncSession, user_id: int) -> dict[str, datetime | None]:
    """Read every habit's persisted ``auto_revealed_at`` marker, keyed by name."""
    result = await session.execute(
        select(Habit).where(Habit.user_id == user_id).execution_options(populate_existing=True)
    )
    return {habit.name: habit.auto_revealed_at for habit in result.scalars().all()}


def _rings_through(stage: int) -> dict[str, bool]:
    """The expected ``revealed`` map when the ladder is open through ``stage``."""
    return {f"{colour} ring": index < stage for index, colour in enumerate(_LADDER)}


class _SweepCase(NamedTuple):
    """One moment the sweep visits: an anchor, a zone, a local day and a wall-clock time."""

    anchor_day: date
    tz: str
    day: int
    hour: int
    minute: int

    def label(self) -> str:
        """A readable pytest id for this case."""
        return f"{self.anchor_day}-{self.tz}-day{self.day}-{self.hour:02d}{self.minute:02d}"


def _sweep_cases() -> list[_SweepCase]:
    """Every boundary at noon in both zones, plus 17:30 Pacific on each eve."""
    cases = [
        _SweepCase(anchor, tz, day, _NOON, 0)
        for anchor in _ANCHOR_DATES
        for tz in (_UTC, _LOS_ANGELES)
        for day in _OPEN_STAGE_ON_DAY
    ]
    cases += [
        _SweepCase(anchor, _LOS_ANGELES, day, _LATE_HOUR, _LATE_MINUTE)
        for anchor in _ANCHOR_DATES
        for day in _OPEN_STAGE_ON_DAY
        if day + 1 in _OPEN_STAGE_ON_DAY and _OPEN_STAGE_ON_DAY[day + 1] > _OPEN_STAGE_ON_DAY[day]
    ]
    return cases


@pytest.mark.parametrize("case", _sweep_cases(), ids=_SweepCase.label)
@pytest.mark.asyncio
async def test_reveal_count_tracks_calendar_stage_at_every_boundary(
    db_session: AsyncSession, case: _SweepCase
) -> None:
    """On local day ``d`` exactly the rings the calendar has reached are revealed (AC3, AC4)."""
    user_id = await _make_user(db_session, "sweep@example.com")
    await _seed_ladder(db_session, user_id, case.anchor_day)
    await _anchor_at(db_session, user_id, _local(case.tz, case.anchor_day, _ANCHOR_HOUR))
    now = _local(case.tz, case.anchor_day + timedelta(days=case.day), case.hour, case.minute)

    opened = await reconcile_habit_auto_reveals(db_session, user_id, case.tz, now=now)

    expected_stage = _OPEN_STAGE_ON_DAY[case.day]
    assert opened == expected_stage
    assert await _revealed(db_session, user_id) == _rings_through(expected_stage)


async def _row_counts(session: AsyncSession) -> tuple[int, int, int]:
    """Count every habit, goal and goal-completion row in the database."""
    counts = []
    for model in (Habit, Goal, GoalCompletion):
        result = await session.execute(select(func.count()).select_from(model))
        counts.append(int(result.scalar_one()))
    return counts[0], counts[1], counts[2]


@pytest.mark.asyncio
async def test_reveal_after_a_long_gap_creates_no_rows(db_session: AsyncSession) -> None:
    """Time away opens rings and nothing else: no habit, goal or completion appears (AC5)."""
    user_id = await _make_user(db_session, "gap@example.com")
    anchor_day = _ANCHOR_DATES[0]
    habits = await _seed_ladder(db_session, user_id, anchor_day)
    goal = Goal(
        habit_id=habits[0].id,
        title="Sit",
        tier="clear",
        target=1,
        target_unit="sit",
        frequency=1,
        frequency_unit="per_day",
    )
    db_session.add(goal)
    await db_session.flush()
    assert goal.id is not None
    db_session.add(
        GoalCompletion(
            goal_id=goal.id,
            user_id=user_id,
            timestamp=_local(_UTC, anchor_day, _NOON),
            completed_units=1,
        )
    )
    await db_session.commit()
    await _anchor_at(db_session, user_id, _local(_UTC, anchor_day, _ANCHOR_HOUR))
    before = await _row_counts(db_session)

    opened = await reconcile_habit_auto_reveals(
        db_session,
        user_id,
        _UTC,
        now=_local(_UTC, anchor_day + timedelta(days=_GAP_DAYS), _NOON),
    )

    assert opened == _STAGE_OPEN_AFTER_GAP
    assert await _row_counts(db_session) == before
    assert before == (len(_LADDER), 1, 1)


def _begin_again(progress: StageProgress, new_anchor: datetime) -> None:
    """Mirror ``_loop_to_next_cycle`` with a chosen anchor instead of the wall clock."""
    progress.cycle_number += 1
    progress.current_stage = 1
    progress.completed_stages = []
    progress.stage_started_at = new_anchor
    progress.program_started_at = new_anchor


@pytest.mark.asyncio
async def test_relocked_ring_stays_locked_across_later_boundaries_and_begin_again(
    db_session: AsyncSession,
) -> None:
    """A ring the user closed again is never re-offered by the calendar (AC6)."""
    user_id = await _make_user(db_session, "relock@example.com")
    anchor_day = _ANCHOR_DATES[1]
    habits = await _seed_ladder(db_session, user_id, anchor_day)
    progress = await _anchor_at(db_session, user_id, _local(_UTC, anchor_day, _ANCHOR_HOUR))
    red_day = 42
    await reconcile_habit_auto_reveals(
        db_session, user_id, _UTC, now=_local(_UTC, anchor_day + timedelta(days=red_day), _NOON)
    )
    red = habits[_RELOCKED_STAGE - 1]
    assert red.revealed is True
    red.revealed = False  # the manual re-lock keeps the consumed marker
    db_session.add(red)
    await db_session.commit()

    for day in (63, 84, 105, 126, 147, 168, 210, 251):
        now = _local(_UTC, anchor_day + timedelta(days=day), _NOON)
        await reconcile_habit_auto_reveals(db_session, user_id, _UTC, now=now)
        assert (await _revealed(db_session, user_id))["Red ring"] is False, day

    cycle_two = anchor_day + timedelta(days=300)
    _begin_again(progress, _local(_UTC, cycle_two, _ANCHOR_HOUR))
    db_session.add(progress)
    await db_session.commit()
    for day in (0, 42, 210):
        now = _local(_UTC, cycle_two + timedelta(days=day), _NOON)
        await reconcile_habit_auto_reveals(db_session, user_id, _UTC, now=now)
        assert (await _revealed(db_session, user_id))["Red ring"] is False, day


@pytest.mark.asyncio
async def test_metta_return_release_pauses_reveal_across_a_boundary(
    db_session: AsyncSession,
) -> None:
    """A rest taken across a ring's opening holds it shut until the user recommits (AC7)."""
    user_id = await _make_user(db_session, "rest@example.com")
    anchor_day = _ANCHOR_DATES[0]
    habits = await _seed_ladder(db_session, user_id, anchor_day)
    await _anchor_at(db_session, user_id, _local(_UTC, anchor_day, _ANCHOR_HOUR))
    day_zero = _local(_UTC, anchor_day, _NOON)
    assert await reconcile_habit_auto_reveals(db_session, user_id, _UTC, now=day_zero) == 1
    purple = habits[1]
    rest_began = _local(_UTC, anchor_day + timedelta(days=20), _NOON)
    arc = MettaReturnArc(user_id=user_id, started_at=rest_began)
    db_session.add(arc)
    await db_session.flush()
    assert arc.id is not None
    assert purple.id is not None
    release = MettaReturnHabitRelease(
        user_id=user_id, arc_id=arc.id, habit_id=purple.id, released_at=rest_began
    )
    db_session.add(release)
    await db_session.commit()

    for day in (21, 30):
        now = _local(_UTC, anchor_day + timedelta(days=day), _NOON)
        assert await reconcile_habit_auto_reveals(db_session, user_id, _UTC, now=now) == 0
    assert (await _revealed(db_session, user_id))["Purple ring"] is False

    release.recommitted_at = _local(_UTC, anchor_day + timedelta(days=31), _NOON)
    db_session.add(release)
    await db_session.commit()
    now = _local(_UTC, anchor_day + timedelta(days=31), _NOON)

    assert await reconcile_habit_auto_reveals(db_session, user_id, _UTC, now=now) == 1
    assert (await _revealed(db_session, user_id))["Purple ring"] is True


@pytest.mark.asyncio
async def test_begin_again_reopens_only_never_offered_habits_on_the_new_anchor(
    db_session: AsyncSession,
) -> None:
    """Cycle 2 leaves consumed invitations alone and paces a new habit by its own anchor (AC9)."""
    user_id = await _make_user(db_session, "cycle@example.com")
    anchor_day = _ANCHOR_DATES[0]
    await _seed_ladder(db_session, user_id, anchor_day)
    progress = await _anchor_at(db_session, user_id, _local(_UTC, anchor_day, _ANCHOR_HOUR))
    end_of_cycle_one = _local(_UTC, anchor_day + timedelta(days=251), _NOON)
    assert await reconcile_habit_auto_reveals(
        db_session, user_id, _UTC, now=end_of_cycle_one
    ) == len(_LADDER)
    cycle_one_markers = await _markers(db_session, user_id)

    cycle_two = anchor_day + timedelta(days=260)
    _begin_again(progress, _local(_UTC, cycle_two, _ANCHOR_HOUR))
    db_session.add(progress)
    await db_session.commit()
    await _add_habit(db_session, user_id, _Seed("Late Purple", "Purple", cycle_two, 11))

    day_zero = _local(_UTC, cycle_two, _NOON)
    assert await reconcile_habit_auto_reveals(db_session, user_id, _UTC, now=day_zero) == 0
    day_twenty_one = _local(_UTC, cycle_two + timedelta(days=21), _NOON)
    assert await reconcile_habit_auto_reveals(db_session, user_id, _UTC, now=day_twenty_one) == 1

    markers = await _markers(db_session, user_id)
    assert markers["Late Purple"] is not None
    assert {name: markers[name] for name in cycle_one_markers} == cycle_one_markers


@pytest.mark.parametrize("stage", ["", "aptitude"])
@pytest.mark.asyncio
async def test_unladdered_habit_opens_on_its_local_start_date_and_not_before(
    db_session: AsyncSession, stage: str
) -> None:
    """A habit with no ring keeps its own start date, read in the user's zone (AC10)."""
    user_id = await _make_user(db_session, f"unladdered-{stage or 'empty'}@example.com")
    start = date(2026, 3, 9)
    await _add_habit(db_session, user_id, _Seed("Own date", stage, start, 1))
    late_evening_before = _local(_LOS_ANGELES, start - timedelta(days=1), 23, 55)
    just_after_midnight = _local(_LOS_ANGELES, start, 0, 5)

    assert (
        await reconcile_habit_auto_reveals(
            db_session, user_id, _LOS_ANGELES, now=late_evening_before
        )
        == 0
    )
    assert (
        await reconcile_habit_auto_reveals(
            db_session, user_id, _LOS_ANGELES, now=just_after_midnight
        )
        == 1
    )


@pytest.mark.asyncio
async def test_sweep_leaves_a_legacy_over_revealed_row_open(db_session: AsyncSession) -> None:
    """A ring opened before the stage gate existed is neither re-locked nor re-stamped (AC24)."""
    user_id = await _make_user(db_session, "legacy@example.com")
    anchor_day = _ANCHOR_DATES[0]
    legacy_marker = _local(_UTC, anchor_day - timedelta(days=7), _NOON)
    await _add_habit(
        db_session,
        user_id,
        _Seed("Legacy Yellow", "Yellow", anchor_day, 1, auto_revealed_at=legacy_marker),
    )
    await _add_habit(db_session, user_id, _Seed("Fresh Yellow", "Yellow", anchor_day, 2))
    await _anchor_at(db_session, user_id, _local(_UTC, anchor_day, _ANCHOR_HOUR))

    for day in (0, 21, 125):
        now = _local(_UTC, anchor_day + timedelta(days=day), _NOON)
        assert await reconcile_habit_auto_reveals(db_session, user_id, _UTC, now=now) == 0

    assert await _revealed(db_session, user_id) == {"Legacy Yellow": True, "Fresh Yellow": False}
    stored = (await _markers(db_session, user_id))["Legacy Yellow"]
    assert stored is not None
    assert stored.replace(tzinfo=UTC) == legacy_marker
