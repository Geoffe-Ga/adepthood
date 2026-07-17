"""Tests for the Return arc habit release/recommit endpoints (/metta-return/arc).

These tests FAIL on import/collection until the implementation-specialist adds
``models/metta_return_habit_release.py``, the ``ReleaseHabitsRequest`` /
``ReleasedHabitResponse`` / ``MAX_RELEASE_BATCH`` additions to
``schemas/metta_return.py``, and the ``/arc/release`` + ``/arc/recommit``
handlers to ``routers/metta_return.py``. That is the correct RED state for
Gate 1.

Releasing a habit is a soft pause (``Habit.revealed`` flips to False) that
never deletes a goal or a logged completion; re-committing flips it back and
stamps when. Every action is scoped to the caller's own active Return arc, and
an id that is unowned, unknown, or already locked is silently skipped rather
than raising, so the response for an unowned id and a nonexistent id must be
indistinguishable.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.metta_return_habit_release import MettaReturnHabitRelease
from models.stage_progress import StageProgress
from schemas.metta_return import MAX_RELEASE_BATCH
from tests.routers.test_metta_return import _get_user, _seed_active_arc, _seed_progress, _signup

_BASE_URL = "/metta-return"
_RELEASE_URL = f"{_BASE_URL}/arc/release"
_RECOMMIT_URL = f"{_BASE_URL}/arc/recommit"
_LEAVE_URL = f"{_BASE_URL}/arc/leave"
_FORBIDDEN_KEY = "user_id"
_ELIGIBLE_STAGE = 5


# ---------------------------------------------------------------------------
# Seeding helpers
# ---------------------------------------------------------------------------


async def _seed_habit(
    session: AsyncSession,
    user_id: int,
    *,
    name: str = "Meditate",
    icon: str = "seedling",
    revealed: bool = True,
) -> Habit:
    """Insert a Habit row owned by user_id, revealed by default."""
    habit = Habit(
        name=name,
        icon=icon,
        start_date=date(2025, 1, 1),
        energy_cost=10,
        energy_return=20,
        user_id=user_id,
        revealed=revealed,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    return habit


async def _seed_habit_with_history(
    session: AsyncSession,
    user_id: int,
    *,
    name: str = "Meditate",
    completions: int = 3,
) -> tuple[Habit, Goal, list[GoalCompletion]]:
    """Insert a revealed Habit with one Goal and several logged GoalCompletion rows."""
    habit = await _seed_habit(session, user_id, name=name)
    assert habit.id is not None
    goal = Goal(
        habit_id=habit.id,
        title="Daily sit",
        tier="clear",
        target=10.0,
        target_unit="minutes",
        frequency=1.0,
        frequency_unit="per_day",
        is_additive=True,
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    assert goal.id is not None

    rows: list[GoalCompletion] = []
    for offset in range(completions):
        row = GoalCompletion(
            goal_id=goal.id,
            user_id=user_id,
            completed_units=10.0,
            local_day=date(2025, 1, 1) + timedelta(days=offset),
        )
        session.add(row)
        rows.append(row)
    await session.commit()
    for row in rows:
        await session.refresh(row)
    return habit, goal, rows


async def _release_rows_for_arc(
    session: AsyncSession,
    arc_id: int,
) -> list[MettaReturnHabitRelease]:
    """Return every MettaReturnHabitRelease row for an arc, freshly read from the DB."""
    session.expire_all()
    result = await session.execute(
        select(MettaReturnHabitRelease).where(col(MettaReturnHabitRelease.arc_id) == arc_id),
    )
    return list(result.scalars().all())


# ---------------------------------------------------------------------------
# Release: happy path + history preservation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_release_pauses_owned_revealed_habits_and_creates_release_rows(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Releasing an owned, revealed habit flips it to locked and inserts one release row."""
    headers = await _signup(async_client, "mrh_release1")
    user = await _get_user(db_session, "mrh_release1@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    arc = await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))
    habit = await _seed_habit(db_session, user.id, name="Meditate")
    assert habit.id is not None
    assert arc.id is not None

    resp = await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": [habit.id]})

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert len(body) == 1
    assert body[0]["habit_id"] == habit.id
    assert body[0]["name"] == "Meditate"
    assert body[0]["recommitted"] is False

    habit_id = habit.id
    arc_id = arc.id
    user_id = user.id
    db_session.expire_all()
    refreshed = await db_session.get(Habit, habit_id)
    assert refreshed is not None
    assert refreshed.revealed is False

    rows = await _release_rows_for_arc(db_session, arc_id)
    assert len(rows) == 1
    assert rows[0].habit_id == habit_id
    assert rows[0].user_id == user_id
    assert rows[0].recommitted_at is None


@pytest.mark.asyncio
async def test_release_preserves_completion_and_goal_history(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Releasing a habit with logged history keeps every goal and completion row."""
    headers = await _signup(async_client, "mrh_history2")
    user = await _get_user(db_session, "mrh_history2@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))
    habit, goal, completions = await _seed_habit_with_history(db_session, user.id, completions=4)
    assert habit.id is not None
    assert goal.id is not None

    resp = await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": [habit.id]})
    assert resp.status_code == HTTPStatus.OK

    habit_id = habit.id
    goal_id = goal.id
    db_session.expire_all()
    goal_count = await db_session.execute(
        select(func.count()).select_from(Goal).where(col(Goal.habit_id) == habit_id),
    )
    assert goal_count.scalar_one() == 1
    completion_count = await db_session.execute(
        select(func.count())
        .select_from(GoalCompletion)
        .where(col(GoalCompletion.goal_id) == goal_id),
    )
    assert completion_count.scalar_one() == len(completions)


# ---------------------------------------------------------------------------
# Release: silent skips and no-enumeration-oracle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_release_silently_skips_unowned_nonexistent_and_locked_habits(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Release only ever acts on caller-owned, currently-unlocked habits."""
    alice_headers = await _signup(async_client, "mrh_alice3")
    await _signup(async_client, "mrh_bob3")
    alice = await _get_user(db_session, "mrh_alice3@example.com")
    bob = await _get_user(db_session, "mrh_bob3@example.com")
    assert alice.id is not None
    assert bob.id is not None
    await _seed_progress(db_session, alice.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, alice.id, started_at=datetime.now(UTC))
    owned_habit = await _seed_habit(db_session, alice.id, name="Owned")
    locked_habit = await _seed_habit(db_session, alice.id, name="AlreadyLocked", revealed=False)
    bob_habit = await _seed_habit(db_session, bob.id, name="BobsHabit")
    assert owned_habit.id is not None
    assert locked_habit.id is not None
    assert bob_habit.id is not None
    nonexistent_id = 987654321

    resp = await async_client.post(
        _RELEASE_URL,
        headers=alice_headers,
        json={"habit_ids": [owned_habit.id, locked_habit.id, bob_habit.id, nonexistent_id]},
    )

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert [item["habit_id"] for item in body] == [owned_habit.id]

    bob_habit_id = bob_habit.id
    locked_habit_id = locked_habit.id
    db_session.expire_all()
    bob_refreshed = await db_session.get(Habit, bob_habit_id)
    assert bob_refreshed is not None
    assert bob_refreshed.revealed is True
    locked_refreshed = await db_session.get(Habit, locked_habit_id)
    assert locked_refreshed is not None
    assert locked_refreshed.revealed is False


@pytest.mark.asyncio
async def test_release_response_for_unowned_id_matches_nonexistent_id(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The release response is identical whether a skipped id is unowned or nonexistent."""
    alice_headers = await _signup(async_client, "mrh_alice4")
    await _signup(async_client, "mrh_bob4")
    alice = await _get_user(db_session, "mrh_alice4@example.com")
    bob = await _get_user(db_session, "mrh_bob4@example.com")
    assert alice.id is not None
    assert bob.id is not None
    await _seed_progress(db_session, alice.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, alice.id, started_at=datetime.now(UTC))
    bob_habit = await _seed_habit(db_session, bob.id, name="BobsHabit")
    assert bob_habit.id is not None
    nonexistent_id = 123456789

    unowned_resp = await async_client.post(
        _RELEASE_URL,
        headers=alice_headers,
        json={"habit_ids": [bob_habit.id]},
    )
    nonexistent_resp = await async_client.post(
        _RELEASE_URL,
        headers=alice_headers,
        json={"habit_ids": [nonexistent_id]},
    )

    assert unowned_resp.status_code == HTTPStatus.OK
    assert nonexistent_resp.status_code == HTTPStatus.OK
    assert unowned_resp.json() == nonexistent_resp.json()


# ---------------------------------------------------------------------------
# Release: 404, idempotency, batch-size validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_release_without_active_arc_returns_404(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Releasing with no active arc returns 404 regardless of habit ownership."""
    headers = await _signup(async_client, "mrh_noarc5")
    user = await _get_user(db_session, "mrh_noarc5@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    habit = await _seed_habit(db_session, user.id)
    assert habit.id is not None

    resp = await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": [habit.id]})

    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_release_is_idempotent_no_duplicate_rows(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Releasing the same habit twice yields one release row and a stable response."""
    headers = await _signup(async_client, "mrh_idem6")
    user = await _get_user(db_session, "mrh_idem6@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    arc = await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))
    habit = await _seed_habit(db_session, user.id)
    assert habit.id is not None
    assert arc.id is not None

    first = await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": [habit.id]})
    second = await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": [habit.id]})

    assert first.status_code == HTTPStatus.OK
    assert second.status_code == HTTPStatus.OK
    assert first.json() == second.json()

    rows = await _release_rows_for_arc(db_session, arc.id)
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_release_empty_habit_ids_returns_422(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An empty habit_ids list fails request validation before any DB work."""
    headers = await _signup(async_client, "mrh_empty7")
    user = await _get_user(db_session, "mrh_empty7@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))

    resp = await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": []})

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_release_over_max_batch_returns_422(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A habit_ids list longer than MAX_RELEASE_BATCH fails request validation."""
    headers = await _signup(async_client, "mrh_overbatch8")
    user = await _get_user(db_session, "mrh_overbatch8@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))
    too_many_ids = list(range(1, MAX_RELEASE_BATCH + 2))

    resp = await async_client.post(
        _RELEASE_URL,
        headers=headers,
        json={"habit_ids": too_many_ids},
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ---------------------------------------------------------------------------
# Recommit: happy path, ignored ids, idempotency, 404, time-complete window
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recommit_restores_revealed_and_stamps_recommitted_at(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Recommitting a released habit unlocks it and stamps recommitted_at."""
    headers = await _signup(async_client, "mrh_recommit10")
    user = await _get_user(db_session, "mrh_recommit10@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))
    habit = await _seed_habit(db_session, user.id)
    assert habit.id is not None

    release_resp = await async_client.post(
        _RELEASE_URL,
        headers=headers,
        json={"habit_ids": [habit.id]},
    )
    assert release_resp.status_code == HTTPStatus.OK

    recommit_resp = await async_client.post(
        _RECOMMIT_URL,
        headers=headers,
        json={"habit_ids": [habit.id]},
    )

    assert recommit_resp.status_code == HTTPStatus.OK
    body = recommit_resp.json()
    assert len(body) == 1
    assert body[0]["habit_id"] == habit.id
    assert body[0]["recommitted"] is True

    habit_id = habit.id
    db_session.expire_all()
    refreshed = await db_session.get(Habit, habit_id)
    assert refreshed is not None
    assert refreshed.revealed is True

    result = await db_session.execute(
        select(MettaReturnHabitRelease).where(col(MettaReturnHabitRelease.habit_id) == habit_id),
    )
    row = result.scalars().one()
    assert row.recommitted_at is not None


@pytest.mark.asyncio
async def test_recommit_ignores_habit_ids_never_released_in_this_arc(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A habit never released in this arc is ignored, and stays exactly as it was."""
    headers = await _signup(async_client, "mrh_neverreleased11")
    user = await _get_user(db_session, "mrh_neverreleased11@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))
    never_released = await _seed_habit(db_session, user.id, revealed=False)
    assert never_released.id is not None

    resp = await async_client.post(
        _RECOMMIT_URL,
        headers=headers,
        json={"habit_ids": [never_released.id]},
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == []

    never_released_id = never_released.id
    db_session.expire_all()
    refreshed = await db_session.get(Habit, never_released_id)
    assert refreshed is not None
    assert refreshed.revealed is False


@pytest.mark.asyncio
async def test_re_release_after_recommit_re_arms_the_release_row(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Releasing a habit again after re-committing it pauses it and clears recommitted."""
    headers = await _signup(async_client, "mrh_rearm9")
    user = await _get_user(db_session, "mrh_rearm9@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    arc = await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))
    habit = await _seed_habit(db_session, user.id)
    assert habit.id is not None
    assert arc.id is not None
    habit_id = habit.id
    arc_id = arc.id

    await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": [habit_id]})
    await async_client.post(_RECOMMIT_URL, headers=headers, json={"habit_ids": [habit_id]})
    second_release = await async_client.post(
        _RELEASE_URL,
        headers=headers,
        json={"habit_ids": [habit_id]},
    )

    assert second_release.status_code == HTTPStatus.OK
    body = second_release.json()
    assert len(body) == 1
    assert body[0]["habit_id"] == habit_id
    assert body[0]["recommitted"] is False

    db_session.expire_all()
    refreshed = await db_session.get(Habit, habit_id)
    assert refreshed is not None
    assert refreshed.revealed is False

    rows = await _release_rows_for_arc(db_session, arc_id)
    assert len(rows) == 1
    assert rows[0].recommitted_at is None


@pytest.mark.asyncio
async def test_recommit_is_idempotent(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Recommitting the same habit twice leaves one release row and a stable response."""
    headers = await _signup(async_client, "mrh_recommitidem12")
    user = await _get_user(db_session, "mrh_recommitidem12@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    arc = await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))
    habit = await _seed_habit(db_session, user.id)
    assert habit.id is not None
    assert arc.id is not None
    await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": [habit.id]})

    first = await async_client.post(
        _RECOMMIT_URL,
        headers=headers,
        json={"habit_ids": [habit.id]},
    )
    second = await async_client.post(
        _RECOMMIT_URL,
        headers=headers,
        json={"habit_ids": [habit.id]},
    )

    assert first.status_code == HTTPStatus.OK
    assert second.status_code == HTTPStatus.OK
    assert first.json() == second.json()

    rows = await _release_rows_for_arc(db_session, arc.id)
    assert len(rows) == 1
    assert rows[0].recommitted_at is not None


@pytest.mark.asyncio
async def test_recommit_without_active_arc_returns_404(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Recommitting with no active arc returns 404."""
    headers = await _signup(async_client, "mrh_noarc13")
    user = await _get_user(db_session, "mrh_noarc13@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    habit = await _seed_habit(db_session, user.id)
    assert habit.id is not None

    resp = await async_client.post(
        _RECOMMIT_URL,
        headers=headers,
        json={"habit_ids": [habit.id]},
    )

    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_recommit_works_when_arc_time_complete_but_not_left(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Recommit still works once the arc's five weeks are complete but not yet left."""
    headers = await _signup(async_client, "mrh_complete14")
    user = await _get_user(db_session, "mrh_complete14@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    started_at = datetime.now(UTC) - timedelta(days=40)
    await _seed_active_arc(db_session, user.id, started_at=started_at)
    habit = await _seed_habit(db_session, user.id)
    assert habit.id is not None
    await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": [habit.id]})

    get_resp = await async_client.get(_BASE_URL, headers=headers)
    assert get_resp.status_code == HTTPStatus.OK
    assert get_resp.json()["arc"] is not None
    assert get_resp.json()["arc"]["complete"] is True

    recommit_resp = await async_client.post(
        _RECOMMIT_URL,
        headers=headers,
        json={"habit_ids": [habit.id]},
    )

    assert recommit_resp.status_code == HTTPStatus.OK
    assert recommit_resp.json()[0]["recommitted"] is True


# ---------------------------------------------------------------------------
# GET state: released_habits projection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_state_includes_released_habits_for_active_arc(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """GET reports the active arc's released habits with name, icon, and recommitted."""
    headers = await _signup(async_client, "mrh_getstate15")
    user = await _get_user(db_session, "mrh_getstate15@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))
    habit = await _seed_habit(db_session, user.id, name="Meditate", icon="seedling")
    assert habit.id is not None
    await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": [habit.id]})

    resp = await async_client.get(_BASE_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    released = resp.json()["released_habits"]
    assert len(released) == 1
    assert released[0]["habit_id"] == habit.id
    assert released[0]["name"] == "Meditate"
    assert released[0]["icon"] == "seedling"
    assert released[0]["recommitted"] is False


@pytest.mark.asyncio
async def test_get_state_released_habits_empty_when_no_active_arc(
    async_client: AsyncClient,
) -> None:
    """GET reports an empty released_habits list when the caller has no active arc."""
    headers = await _signup(async_client, "mrh_getempty16")

    resp = await async_client.get(_BASE_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["released_habits"] == []


# ---------------------------------------------------------------------------
# No owner-key / row-id leakage
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_release_response_never_leaks_user_id_or_row_id(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """No item in the release response leaks user_id or a surrogate row id."""
    headers = await _signup(async_client, "mrh_noleak17")
    user = await _get_user(db_session, "mrh_noleak17@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))
    habit = await _seed_habit(db_session, user.id)
    assert habit.id is not None

    resp = await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": [habit.id]})

    assert resp.status_code == HTTPStatus.OK
    for item in resp.json():
        assert _FORBIDDEN_KEY not in item
        assert "id" not in item


@pytest.mark.asyncio
async def test_recommit_response_never_leaks_user_id_or_row_id(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """No item in the recommit response leaks user_id or a surrogate row id."""
    headers = await _signup(async_client, "mrh_noleak18")
    user = await _get_user(db_session, "mrh_noleak18@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))
    habit = await _seed_habit(db_session, user.id)
    assert habit.id is not None
    await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": [habit.id]})

    resp = await async_client.post(
        _RECOMMIT_URL,
        headers=headers,
        json={"habit_ids": [habit.id]},
    )

    assert resp.status_code == HTTPStatus.OK
    for item in resp.json():
        assert _FORBIDDEN_KEY not in item
        assert "id" not in item


@pytest.mark.asyncio
async def test_get_state_released_habits_never_leak_user_id_or_row_id(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """No released_habits item on GET leaks user_id or a surrogate row id."""
    headers = await _signup(async_client, "mrh_noleak19")
    user = await _get_user(db_session, "mrh_noleak19@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))
    habit = await _seed_habit(db_session, user.id)
    assert habit.id is not None
    await async_client.post(_RELEASE_URL, headers=headers, json={"habit_ids": [habit.id]})

    resp = await async_client.get(_BASE_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    for item in resp.json()["released_habits"]:
        assert _FORBIDDEN_KEY not in item
        assert "id" not in item


# ---------------------------------------------------------------------------
# StageProgress invariant + leave-without-recommit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_release_then_recommit_round_trip_preserves_stage_progress(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A full release-then-recommit round trip never mutates StageProgress."""
    headers = await _signup(async_client, "mrh_stageinvariant20")
    user = await _get_user(db_session, "mrh_stageinvariant20@example.com")
    assert user.id is not None
    user_id = user.id
    progress = await _seed_progress(
        db_session,
        user_id,
        current_stage=_ELIGIBLE_STAGE,
        completed_stages=[1, 2, 3, 4],
    )
    before_stage = progress.current_stage
    before_completed = list(progress.completed_stages)
    before_highest = progress.highest_stage_reached
    before_cycle = progress.cycle_number
    await _seed_active_arc(db_session, user_id, started_at=datetime.now(UTC))
    habit = await _seed_habit(db_session, user_id)
    assert habit.id is not None

    release_resp = await async_client.post(
        _RELEASE_URL,
        headers=headers,
        json={"habit_ids": [habit.id]},
    )
    assert release_resp.status_code == HTTPStatus.OK
    recommit_resp = await async_client.post(
        _RECOMMIT_URL,
        headers=headers,
        json={"habit_ids": [habit.id]},
    )
    assert recommit_resp.status_code == HTTPStatus.OK

    db_session.expire_all()
    result = await db_session.execute(
        select(StageProgress).where(col(StageProgress.user_id) == user_id),
    )
    refreshed = result.scalars().one()
    assert refreshed.current_stage == before_stage
    assert list(refreshed.completed_stages) == before_completed
    assert refreshed.highest_stage_reached == before_highest
    assert refreshed.cycle_number == before_cycle


@pytest.mark.asyncio
async def test_leave_without_recommit_keeps_habits_paused_and_release_rows(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Leaving without recommitting leaves released habits locked and their rows intact."""
    headers = await _signup(async_client, "mrh_leave21")
    user = await _get_user(db_session, "mrh_leave21@example.com")
    assert user.id is not None
    arc = await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    habit = await _seed_habit(db_session, user.id)
    assert habit.id is not None
    assert arc.id is not None

    release_resp = await async_client.post(
        _RELEASE_URL,
        headers=headers,
        json={"habit_ids": [habit.id]},
    )
    assert release_resp.status_code == HTTPStatus.OK

    leave_resp = await async_client.post(_LEAVE_URL, headers=headers)
    assert leave_resp.status_code == HTTPStatus.OK

    habit_id = habit.id
    arc_id = arc.id
    db_session.expire_all()
    refreshed_habit = await db_session.get(Habit, habit_id)
    assert refreshed_habit is not None
    assert refreshed_habit.revealed is False

    rows = await _release_rows_for_arc(db_session, arc_id)
    assert len(rows) == 1
    assert rows[0].recommitted_at is None
