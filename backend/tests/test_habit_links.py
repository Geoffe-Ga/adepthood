"""Timer-linked habits: create-with-goals, ``via_timer`` and the linked-unit guard (#3150).

A habit the journal (or, later, a practice) logs to is fed by a timer, so its
goals may only count ``minutes`` or ``sessions`` and its cadence only
``per_day`` or ``per_week``. These tests pin the three backend seams that make
that true: a habit created with its tiers in one request, a timer-driven
completion recorded as such, and the unit guard on every write that could put
a linked habit on any other unit.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.habit_links import (
    LINKED_HABIT_FREQUENCY_UNITS,
    LINKED_HABIT_UNITS,
    assert_linked_frequency_unit_allowed,
    assert_linked_unit_allowed,
    linked_habit_ids,
)
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit

_FLAGS_URL = "/ui-flags"
_LINK_KEY = "writing_session_habit_id"

_JOURNAL_GOALS: dict[str, object] = {
    "target_unit": "minutes",
    "frequency": 1,
    "frequency_unit": "per_day",
    "low": 10,
    "clear": 20,
    "stretch": 45,
}

_REPS_UNITS: dict[str, object] = {
    "target_unit": "reps",
    "frequency": 1,
    "frequency_unit": "per_day",
}


def _habit_payload(name: str = "Journaling", **overrides: object) -> dict[str, object]:
    """A valid ``POST /habits/`` body, optionally carrying a goals block."""
    payload: dict[str, object] = {
        "name": name,
        "icon": "📓",
        "start_date": "2024-01-01",
        "energy_cost": 1,
        "energy_return": 2,
    }
    payload.update(overrides)
    return payload


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create a user and return (auth headers, user_id)."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


async def _create(client: AsyncClient, headers: dict[str, str], **overrides: object) -> int:
    """Create a habit and return its id, failing loudly on refusal."""
    payload = {**_habit_payload(), **overrides}
    resp = await client.post("/habits/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    return int(resp.json()["id"])


async def _stored_goals(db_session: AsyncSession, habit_id: int) -> list[Goal]:
    """Read a habit's goals from storage, bypassing the identity map."""
    result = await db_session.execute(
        select(Goal)
        .where(col(Goal.habit_id) == habit_id)
        .order_by(col(Goal.id))
        .execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


# ---------------------------------------------------------------------------
# The helper itself
# ---------------------------------------------------------------------------


def test_linked_units_are_exactly_minutes_and_sessions() -> None:
    """The allow-lists are the epic's decision, spelled once."""
    assert frozenset({"minutes", "sessions"}) == LINKED_HABIT_UNITS
    assert frozenset({"per_day", "per_week"}) == LINKED_HABIT_FREQUENCY_UNITS


@pytest.mark.parametrize("unit", ["minutes", "sessions"])
def test_assert_linked_unit_allowed_accepts_timer_units(unit: str) -> None:
    """Minutes and sessions pass without raising."""
    assert_linked_unit_allowed(unit)


@pytest.mark.parametrize("unit", ["reps", "units", "Minutes", ""])
def test_assert_linked_unit_allowed_rejects_other_units(unit: str) -> None:
    """Anything a timer cannot measure is the repo's 422."""
    with pytest.raises(HTTPException) as excinfo:
        assert_linked_unit_allowed(unit)
    assert excinfo.value.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert excinfo.value.detail == "linked_habit_unit_not_allowed"


@pytest.mark.parametrize("unit", ["per_day", "per_week"])
def test_assert_linked_frequency_unit_allowed_accepts_day_and_week(unit: str) -> None:
    """Daily and weekly cadences pass without raising."""
    assert_linked_frequency_unit_allowed(unit)


def test_assert_linked_frequency_unit_allowed_rejects_monthly() -> None:
    """A monthly cadence is refused for a linked habit."""
    with pytest.raises(HTTPException) as excinfo:
        assert_linked_frequency_unit_allowed("per_month")
    assert excinfo.value.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert excinfo.value.detail == "linked_habit_frequency_unit_not_allowed"


@pytest.mark.asyncio
async def test_linked_habit_ids_reads_the_writing_link(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """No flags row means no links; a set writing link is reported, per user."""
    headers, user_id = await _signup(async_client, "links_reader")
    other_headers, other_id = await _signup(async_client, "links_other")
    assert await linked_habit_ids(db_session, user_id) == set()

    habit_id = await _create(async_client, headers, goals=_JOURNAL_GOALS)
    await _create(async_client, other_headers, goals=_JOURNAL_GOALS)
    linked = await async_client.patch(_FLAGS_URL, json={_LINK_KEY: habit_id}, headers=headers)
    assert linked.status_code == HTTPStatus.OK, linked.text

    assert await linked_habit_ids(db_session, user_id) == {habit_id}
    await async_client.get(_FLAGS_URL, headers=other_headers)
    assert await linked_habit_ids(db_session, other_id) == set()


# ---------------------------------------------------------------------------
# POST /habits/ with a goals block
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_with_goals_round_trips_tiers_unit_and_revealed(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The three tiers carry the block's unit, cadence and targets; revealed sticks."""
    headers, _user_id = await _signup(async_client, "create_goals")

    resp = await async_client.post(
        "/habits/", json=_habit_payload(revealed=True, goals=_JOURNAL_GOALS), headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["revealed"] is True
    tiers = {goal["tier"]: goal for goal in body["goals"]}
    assert {tier: goal["target"] for tier, goal in tiers.items()} == {
        "low": 10.0,
        "clear": 20.0,
        "stretch": 45.0,
    }
    for goal in body["goals"]:
        assert goal["target_unit"] == "minutes"
        assert goal["frequency"] == 1.0
        assert goal["frequency_unit"] == "per_day"
        assert goal["is_additive"] is True
    assert tiers["clear"]["title"] == "Clear goal for Journaling"
    stored = await db_session.get(Habit, body["id"], populate_existing=True)
    assert stored is not None
    # Created unlocked on purpose: the one-shot invitation is consumed, so a
    # later manual re-lock is a real choice rather than reopening on read.
    assert stored.auto_revealed_at is not None


@pytest.mark.asyncio
async def test_create_with_session_goals_per_week(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The practice default -- 1 session, 4 times a week -- is accepted as given."""
    headers, _user_id = await _signup(async_client, "create_sessions")
    goals = {
        "target_unit": "sessions",
        "frequency": 4,
        "frequency_unit": "per_week",
        "low": 1,
        "clear": 1,
        "stretch": 2,
    }

    resp = await async_client.post(
        "/habits/", json=_habit_payload("Sit", goals=goals), headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["revealed"] is False
    assert {(g["target_unit"], g["frequency"], g["frequency_unit"]) for g in body["goals"]} == {
        ("sessions", 4.0, "per_week")
    }
    stored = await db_session.get(Habit, body["id"], populate_existing=True)
    assert stored is not None
    # Created locked: the program's invitation is still the user's to receive.
    assert stored.auto_revealed_at is None


@pytest.mark.asyncio
async def test_create_without_goals_keeps_default_tiers(async_client: AsyncClient) -> None:
    """A plain Add-habit still gets 1/2/3 ``units`` per day, locked."""
    headers, _user_id = await _signup(async_client, "create_plain")

    resp = await async_client.post("/habits/", json=_habit_payload("Water"), headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["revealed"] is False
    assert sorted((g["target"], g["target_unit"]) for g in body["goals"]) == [
        (1.0, "units"),
        (2.0, "units"),
        (3.0, "units"),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("low", "clear", "stretch"),
    [(20, 10, 45), (10, 45, 20), (46, 45, 45)],
)
async def test_create_with_out_of_order_tiers_is_422_and_persists_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    low: float,
    clear: float,
    stretch: float,
) -> None:
    """Low <= clear <= stretch, or nothing is written."""
    headers, user_id = await _signup(async_client, f"tier_order_{low}_{clear}_{stretch}")
    goals = {**_JOURNAL_GOALS, "low": low, "clear": clear, "stretch": stretch}

    resp = await async_client.post("/habits/", json=_habit_payload(goals=goals), headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    rows = await db_session.execute(select(Habit).where(col(Habit.user_id) == user_id))
    assert rows.scalars().all() == []


@pytest.mark.asyncio
async def test_create_with_equal_tiers_is_accepted(async_client: AsyncClient) -> None:
    """Equal neighbours are in order: ``1 / 1 / 1`` sessions is a valid goal."""
    headers, _user_id = await _signup(async_client, "tier_equal")
    goals = {**_JOURNAL_GOALS, "target_unit": "sessions", "low": 1, "clear": 1, "stretch": 1}

    resp = await async_client.post("/habits/", json=_habit_payload(goals=goals), headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("override", "detail"),
    [
        ({"target_unit": "reps"}, "linked_habit_unit_not_allowed"),
        ({"frequency_unit": "per_month"}, "linked_habit_frequency_unit_not_allowed"),
    ],
)
async def test_create_with_non_timer_units_is_422(
    async_client: AsyncClient,
    db_session: AsyncSession,
    override: dict[str, object],
    detail: str,
) -> None:
    """The goals block is the link flow's: it only speaks minutes or sessions."""
    headers, user_id = await _signup(async_client, f"create_bad_{detail}")
    goals = {**_JOURNAL_GOALS, **override}

    resp = await async_client.post("/habits/", json=_habit_payload(goals=goals), headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == detail
    rows = await db_session.execute(select(Habit).where(col(Habit.user_id) == user_id))
    assert rows.scalars().all() == []


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", [{"low": 0}, {"frequency": 0}, {"low": -1}])
async def test_create_with_non_positive_goal_numbers_is_422(
    async_client: AsyncClient, bad: dict[str, object]
) -> None:
    """A zero-minute tier or a zero cadence is meaningless for a timer."""
    headers, _user_id = await _signup(async_client, "create_zero")

    resp = await async_client.post(
        "/habits/", json=_habit_payload(goals={**_JOURNAL_GOALS, **bad}), headers=headers
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_put_habit_with_goals_block_is_422(async_client: AsyncClient) -> None:
    """Goals ride the create only; tiers are edited through the goals endpoints."""
    headers, _user_id = await _signup(async_client, "put_goals")
    habit_id = await _create(async_client, headers)

    resp = await async_client.put(
        f"/habits/{habit_id}", json=_habit_payload(goals=_JOURNAL_GOALS), headers=headers
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "habit_goals_create_only"


# ---------------------------------------------------------------------------
# POST /goal_completions/ via_timer
# ---------------------------------------------------------------------------


async def _low_goal_id(client: AsyncClient, headers: dict[str, str], habit_id: int) -> int:
    """Return the id of the habit's low tier."""
    resp = await client.get(f"/habits/{habit_id}", headers=headers)
    return int(next(g["id"] for g in resp.json()["goals"] if g["tier"] == "low"))


async def _completion_rows(db_session: AsyncSession, goal_id: int) -> list[GoalCompletion]:
    """Every stored completion row for ``goal_id``."""
    result = await db_session.execute(
        select(GoalCompletion)
        .where(col(GoalCompletion.goal_id) == goal_id)
        .execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_via_timer_is_persisted_on_an_explicit_amount(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A timer-driven log of 10 minutes stores ``via_timer`` on the day's row."""
    headers, _user_id = await _signup(async_client, "timer_explicit")
    habit_id = await _create(async_client, headers, revealed=True, goals=_JOURNAL_GOALS)
    goal_id = await _low_goal_id(async_client, headers, habit_id)

    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal_id, "completed_units": 10, "via_timer": True},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    rows = await _completion_rows(db_session, goal_id)
    assert [(row.completed_units, row.via_timer) for row in rows] == [(10.0, True)]


@pytest.mark.asyncio
async def test_via_timer_defaults_false_and_first_write_wins(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The day's row keeps the flag of the write that created it."""
    headers, _user_id = await _signup(async_client, "timer_first_wins")
    habit_id = await _create(async_client, headers, revealed=True, goals=_JOURNAL_GOALS)
    goal_id = await _low_goal_id(async_client, headers, habit_id)

    manual = await async_client.post(
        "/goal_completions/", json={"goal_id": goal_id, "completed_units": 5}, headers=headers
    )
    timed = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal_id, "completed_units": 10, "via_timer": True},
        headers=headers,
    )

    assert manual.status_code == HTTPStatus.OK
    assert timed.status_code == HTTPStatus.OK
    rows = await _completion_rows(db_session, goal_id)
    assert [(row.completed_units, row.via_timer) for row in rows] == [(15.0, False)]


@pytest.mark.asyncio
async def test_via_timer_is_persisted_on_an_amountless_check_in(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The legacy full-target path records the flag too."""
    headers, _user_id = await _signup(async_client, "timer_legacy")
    habit_id = await _create(async_client, headers, revealed=True, goals=_JOURNAL_GOALS)
    goal_id = await _low_goal_id(async_client, headers, habit_id)

    resp = await async_client.post(
        "/goal_completions/", json={"goal_id": goal_id, "via_timer": True}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    rows = await _completion_rows(db_session, goal_id)
    assert [row.via_timer for row in rows] == [True]


# ---------------------------------------------------------------------------
# The guard on linked habits
# ---------------------------------------------------------------------------


async def _link(client: AsyncClient, headers: dict[str, str], habit_id: int) -> None:
    """Point the caller's writing timer at ``habit_id``, failing loudly on refusal."""
    resp = await client.patch(_FLAGS_URL, json={_LINK_KEY: habit_id}, headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text


@pytest.mark.asyncio
async def test_units_put_on_a_linked_habit_refuses_reps(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A journal-linked habit cannot be moved onto ``reps``; nothing is written."""
    headers, _user_id = await _signup(async_client, "units_linked")
    habit_id = await _create(async_client, headers, goals=_JOURNAL_GOALS)
    await _link(async_client, headers, habit_id)

    resp = await async_client.put(
        f"/habits/{habit_id}/goals/units", json=_REPS_UNITS, headers=headers
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "linked_habit_unit_not_allowed"
    assert {goal.target_unit for goal in await _stored_goals(db_session, habit_id)} == {"minutes"}


@pytest.mark.asyncio
async def test_units_put_on_a_linked_habit_refuses_monthly_cadence(
    async_client: AsyncClient,
) -> None:
    """A linked habit's cadence stays per day or per week."""
    headers, _user_id = await _signup(async_client, "units_monthly")
    habit_id = await _create(async_client, headers, goals=_JOURNAL_GOALS)
    await _link(async_client, headers, habit_id)

    resp = await async_client.put(
        f"/habits/{habit_id}/goals/units",
        json={"target_unit": "sessions", "frequency": 1, "frequency_unit": "per_month"},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "linked_habit_frequency_unit_not_allowed"


@pytest.mark.asyncio
async def test_units_put_on_a_linked_habit_accepts_sessions(async_client: AsyncClient) -> None:
    """Switching a linked habit between the two timer units is allowed."""
    headers, _user_id = await _signup(async_client, "units_sessions")
    habit_id = await _create(async_client, headers, goals=_JOURNAL_GOALS)
    await _link(async_client, headers, habit_id)

    resp = await async_client.put(
        f"/habits/{habit_id}/goals/units",
        json={"target_unit": "sessions", "frequency": 4, "frequency_unit": "per_week"},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert {goal["target_unit"] for goal in resp.json()} == {"sessions"}


@pytest.mark.asyncio
async def test_units_put_on_an_unlinked_habit_is_unaffected(async_client: AsyncClient) -> None:
    """Any unit stays available to a habit no timer feeds."""
    headers, _user_id = await _signup(async_client, "units_unlinked")
    habit_id = await _create(async_client, headers, goals=_JOURNAL_GOALS)

    resp = await async_client.put(
        f"/habits/{habit_id}/goals/units", json=_REPS_UNITS, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert {goal["target_unit"] for goal in resp.json()} == {"reps"}


@pytest.mark.asyncio
async def test_goal_put_on_a_linked_habit_refuses_reps(async_client: AsyncClient) -> None:
    """The per-tier editor cannot move a linked habit off minutes either."""
    headers, _user_id = await _signup(async_client, "goal_put_linked")
    habit_id = await _create(async_client, headers, goals=_JOURNAL_GOALS)
    await _link(async_client, headers, habit_id)
    goal_id = await _low_goal_id(async_client, headers, habit_id)
    body = {
        "title": "Low",
        "tier": "low",
        "target": 10,
        "target_unit": "reps",
        "frequency": 1,
        "frequency_unit": "per_day",
    }

    refused = await async_client.put(f"/goals/{goal_id}", json=body, headers=headers)
    allowed = await async_client.put(
        f"/goals/{goal_id}", json={**body, "target": 15, "target_unit": "minutes"}, headers=headers
    )

    assert refused.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert refused.json()["detail"] == "linked_habit_unit_not_allowed"
    assert allowed.status_code == HTTPStatus.OK, allowed.text


@pytest.mark.asyncio
async def test_goal_put_on_an_unlinked_habit_is_unaffected(async_client: AsyncClient) -> None:
    """An unlinked habit's tier may still use any unit."""
    headers, _user_id = await _signup(async_client, "goal_put_unlinked")
    habit_id = await _create(async_client, headers)
    goal_id = await _low_goal_id(async_client, headers, habit_id)
    body = {
        "title": "Low",
        "tier": "low",
        "target": 10,
        "target_unit": "reps",
        "frequency": 1,
        "frequency_unit": "per_month",
    }

    resp = await async_client.put(f"/goals/{goal_id}", json=body, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text


@pytest.mark.asyncio
async def test_link_patch_refuses_a_habit_on_reps_and_writes_nothing(
    async_client: AsyncClient,
) -> None:
    """Linking the journal to a ``reps`` habit is 422; the prior state survives."""
    headers, _user_id = await _signup(async_client, "link_reps")
    habit_id = await _create(async_client, headers, goals=_JOURNAL_GOALS)
    await async_client.put(f"/habits/{habit_id}/goals/units", json=_REPS_UNITS, headers=headers)

    resp = await async_client.patch(
        _FLAGS_URL, json={_LINK_KEY: habit_id, "has_seen_welcome": True}, headers=headers
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "linked_habit_unit_not_allowed"
    flags = (await async_client.get(_FLAGS_URL, headers=headers)).json()
    assert flags[_LINK_KEY] is None
    assert flags["has_seen_welcome"] is False


@pytest.mark.asyncio
async def test_link_patch_refuses_a_monthly_habit(async_client: AsyncClient) -> None:
    """A minutes habit scored per month is not a timer link either."""
    headers, _user_id = await _signup(async_client, "link_monthly")
    habit_id = await _create(async_client, headers, goals=_JOURNAL_GOALS)
    await async_client.put(
        f"/habits/{habit_id}/goals/units",
        json={"target_unit": "minutes", "frequency": 1, "frequency_unit": "per_month"},
        headers=headers,
    )

    resp = await async_client.patch(_FLAGS_URL, json={_LINK_KEY: habit_id}, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "linked_habit_frequency_unit_not_allowed"


@pytest.mark.asyncio
async def test_link_patch_refuses_a_default_units_habit(async_client: AsyncClient) -> None:
    """A plain Add-habit (``units``) must be given timer units before it can link."""
    headers, _user_id = await _signup(async_client, "link_default")
    habit_id = await _create(async_client, headers)

    resp = await async_client.patch(_FLAGS_URL, json={_LINK_KEY: habit_id}, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "linked_habit_unit_not_allowed"


@pytest.mark.asyncio
async def test_link_patch_accepts_a_minutes_habit_and_clearing(async_client: AsyncClient) -> None:
    """A timer-unit habit links; clearing the link needs no unit check."""
    headers, _user_id = await _signup(async_client, "link_minutes")
    habit_id = await _create(async_client, headers, goals=_JOURNAL_GOALS)

    linked = await async_client.patch(_FLAGS_URL, json={_LINK_KEY: habit_id}, headers=headers)
    cleared = await async_client.patch(_FLAGS_URL, json={_LINK_KEY: None}, headers=headers)

    assert linked.status_code == HTTPStatus.OK, linked.text
    assert linked.json()[_LINK_KEY] == habit_id
    assert cleared.status_code == HTTPStatus.OK
    assert cleared.json()[_LINK_KEY] is None
