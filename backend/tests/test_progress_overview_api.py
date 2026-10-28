"""Private overview reads, canonical boundaries and cross-owner isolation."""

import secrets
from dataclasses import dataclass
from datetime import UTC, date, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.practice import Practice
from models.practice_session import PracticeSession
from models.stage_progress import StageProgress
from models.user_depth_preferences import UserDepthPreferences
from models.user_practice import UserPractice
from seed_practices import STAGE_TO_PRESET_NAME


async def _signup(client: AsyncClient, name: str) -> tuple[dict[str, str], int]:
    """Use a generated disposable credential, not a detector allowlist."""
    response = await client.post(
        "/auth/signup", json={"email": f"{name}@example.com", "password": secrets.token_urlsafe(24)}
    )
    assert response.status_code == HTTPStatus.OK
    body = response.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


async def _habit(session: AsyncSession, owner: int) -> tuple[Habit, Goal]:
    """Persist one owner-scoped daily Low target without invoking a read writer."""
    habit = Habit(
        user_id=owner,
        name=f"Owner {owner}",
        icon="pen",
        start_date=date(2026, 1, 5),
        stage="Blue",
        energy_cost=1,
        energy_return=4,
    )
    session.add(habit)
    await session.flush()
    goal = Goal(
        habit_id=habit.id,
        title="Low",
        tier="low",
        target=2,
        target_unit="pages",
        frequency=1,
        frequency_unit="per_day",
    )
    session.add(goal)
    await session.commit()
    await session.refresh(habit)
    await session.refresh(goal)
    return habit, goal


@pytest.mark.asyncio
async def test_overview_requires_authentication(async_client: AsyncClient) -> None:
    """The user's whole-person timeline is never anonymously readable."""
    assert (await async_client.get("/progress/overview")).status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_empty_overview_is_uncacheable_and_does_not_provision_programme(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A GET preserves an unstarted account and unknown dates."""
    headers, owner = await _signup(async_client, "overview_empty")
    assert (
        await db_session.execute(select(StageProgress).where(StageProgress.user_id == owner))
    ).scalar_one_or_none() is None
    response = await async_client.get("/progress/overview", headers=headers)
    assert response.status_code == HTTPStatus.OK
    assert response.headers["cache-control"] == "private, no-store"
    assert "Authorization" in response.headers["vary"]
    body = response.json()
    assert body["arc"]["program_started_at"] is None
    assert body["rhythm"]["days"] == []
    assert len(body["arc"]["stages"]) == 10
    assert (
        await db_session.execute(select(StageProgress).where(StageProgress.user_id == owner))
    ).scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_overview_rejects_other_owners_history_at_every_join(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An inconsistent completion/session owner cannot bridge another owner's row."""
    headers, owner = await _signup(async_client, "overview_owner")
    _, stranger = await _signup(async_client, "overview_stranger")
    own_habit, own_goal = await _habit(db_session, owner)
    _, foreign_goal = await _habit(db_session, stranger)
    for user_id, goal, units in [
        (owner, own_goal, 2),
        (stranger, own_goal, 999),
        (owner, foreign_goal, 999),
    ]:
        db_session.add(
            GoalCompletion(
                user_id=user_id, goal_id=goal.id, local_day=date(2026, 1, 5), completed_units=units
            )
        )
    db_session.add(
        StageProgress(
            user_id=owner, current_stage=1, program_started_at=datetime(2026, 1, 5, tzinfo=UTC)
        )
    )
    practice = Practice(
        stage_number=1,
        name="Overview sit",
        description="",
        instructions="",
        default_duration_minutes=5,
    )
    db_session.add(practice)
    await db_session.flush()
    selected = UserPractice(
        user_id=stranger, practice_id=practice.id, stage_number=1, start_date=date(2026, 1, 5)
    )
    db_session.add(selected)
    await db_session.flush()
    db_session.add(
        PracticeSession(user_id=owner, user_practice_id=selected.id, duration_minutes=500)
    )
    await db_session.commit()
    body = (await async_client.get("/progress/overview", headers=headers)).json()
    assert [birth["habit_id"] for birth in body["arc"]["habit_births"]] == [own_habit.id]
    assert sum(week["net"] for week in body["energy"]["weeks"]) == 0
    assert body["rhythm"]["days"][0]["daily_met"] == 1


@pytest.mark.asyncio
async def test_preferences_remove_both_opportunities_and_observations(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A declined ring cannot inflate the engagement denominator."""
    headers, owner = await _signup(async_client, "overview_rings")
    await _habit(db_session, owner)
    db_session.add(UserDepthPreferences(user_id=owner, enable_habits=False, enable_practices=False))
    db_session.add(
        StageProgress(
            user_id=owner, current_stage=1, program_started_at=datetime(2026, 1, 5, tzinfo=UTC)
        )
    )
    await db_session.commit()
    body = (await async_client.get("/progress/overview", headers=headers)).json()
    assert body["arc"]["habit_births"] == []
    assert all(day["daily_scheduled"] == day["daily_met"] == 0 for day in body["rhythm"]["days"])


@pytest.mark.asyncio
async def test_only_approved_public_canonical_catalog_asks_are_read(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An unrelated private preset sharing a stage never supplies its ask."""
    headers, owner = await _signup(async_client, "overview_asks")
    for name, submitted_by, approved, minutes in [
        (STAGE_TO_PRESET_NAME[1], None, True, 3),
        ("Alternative", None, True, 999),
        (STAGE_TO_PRESET_NAME[2], owner, True, 999),
        (STAGE_TO_PRESET_NAME[3], None, False, 999),
    ]:
        db_session.add(
            Practice(
                stage_number=1
                if name == "Alternative"
                else next(
                    (
                        stage
                        for stage, canonical in STAGE_TO_PRESET_NAME.items()
                        if canonical == name
                    ),
                    1,
                ),
                name=name,
                description="",
                instructions="",
                default_duration_minutes=minutes,
                submitted_by_user_id=submitted_by,
                approved=approved,
            )
        )
    await db_session.commit()
    stages = (await async_client.get("/progress/overview", headers=headers)).json()["arc"]["stages"]
    assert stages[0]["practice_ask_minutes"] == 3
    assert stages[1]["practice_ask_minutes"] is None
    assert stages[2]["practice_ask_minutes"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("frequency_unit", ["per_day", "per_week", "per_month"])
async def test_canonical_context_survives_public_mixed_polarity_goal_edits(
    async_client: AsyncClient, db_session: AsyncSession, frequency_unit: str
) -> None:
    """An editable Clear tier owns cadence and makes the whole habit subtractive."""
    headers, owner = await _signup(async_client, f"overview_edit_{frequency_unit}")
    habit, low = await _habit(db_session, owner)
    clear = Goal(
        habit_id=habit.id,
        title="Clear",
        tier="clear",
        target=5,
        target_unit="pages",
        frequency=1,
        frequency_unit="per_day",
    )
    db_session.add(clear)
    db_session.add(
        StageProgress(
            user_id=owner, current_stage=1, program_started_at=datetime(2026, 1, 5, tzinfo=UTC)
        )
    )
    db_session.add(UserDepthPreferences(user_id=owner, enable_practices=False))
    await db_session.commit()
    await db_session.refresh(clear)
    response = await async_client.put(
        f"/goals/{clear.id}",
        headers=headers,
        json={
            "title": "Clear",
            "tier": "clear",
            "target": 5,
            "target_unit": "pages",
            "is_additive": False,
            "frequency_unit": frequency_unit,
            "frequency": 3,
        },
    )
    assert response.status_code == HTTPStatus.OK, response.text
    db_session.add(
        GoalCompletion(
            user_id=owner, goal_id=low.id, local_day=date(2026, 1, 5), completed_units=50
        )
    )
    await db_session.commit()
    days = (await async_client.get("/progress/overview", headers=headers)).json()["rhythm"]["days"]
    # Exceeding every tier's ceiling stays unmet across the canonical period.
    assert [day["daily_met"] for day in days[:2]] == (
        [0, 1] if frequency_unit == "per_day" else [0, 0]
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("units", "low_frequency", "expected"),
    [
        (("per_week", "per_week"), 1, 1),
        (("per_month", "per_month"), 1, 1),
        (("per_day", "per_week"), 3, 1),
        (("per_day", "per_month"), 3, 1),
        (("per_week", "per_day"), 3, 0),
        (("per_month", "per_day"), 3, 0),
    ],
)
async def test_low_uses_its_own_edited_frequency_and_unit(
    async_client: AsyncClient,
    db_session: AsyncSession,
    units: tuple[str, str],
    low_frequency: int,
    expected: int,
) -> None:
    """Clear owns the native bucket; it cannot lend its frequency to Low's target."""
    low_unit, clear_unit = units
    headers, owner = await _signup(async_client, f"overview_own_frequency_{low_unit}_{clear_unit}")
    habit, low = await _habit(db_session, owner)
    low.frequency_unit, low.frequency = low_unit, 3
    db_session.add(low)
    db_session.add(
        Goal(
            habit_id=habit.id,
            title="Clear",
            tier="clear",
            target=10,
            target_unit="pages",
            frequency=3,
            frequency_unit=clear_unit,
        )
    )
    db_session.add(
        StageProgress(
            user_id=owner, current_stage=1, program_started_at=datetime(2026, 1, 5, tzinfo=UTC)
        )
    )
    db_session.add(UserDepthPreferences(user_id=owner, enable_practices=False))
    await db_session.commit()
    response = await async_client.put(
        f"/goals/{low.id}",
        headers=headers,
        json={
            "title": "Low",
            "tier": "low",
            "target": 2,
            "target_unit": "pages",
            "frequency": low_frequency,
            "frequency_unit": low_unit,
        },
    )
    assert response.status_code == HTTPStatus.OK, response.text
    db_session.add(
        GoalCompletion(user_id=owner, goal_id=low.id, local_day=date(2026, 1, 5), completed_units=4)
    )
    await db_session.commit()
    response = await async_client.get("/progress/overview", headers=headers)
    assert response.status_code == HTTPStatus.OK, response.text
    days = response.json()["rhythm"]["days"]
    assert days[0]["daily_met"] == expected
    if clear_unit != "per_day":
        assert days[1]["daily_met"] == expected


@dataclass(frozen=True)
class _TierFrequencyCase:
    """A raw ordered ladder whose per-tier frequencies invert effective difficulty."""

    goals: tuple[tuple[str, int, int], ...]
    clear_frequency: int
    additive: bool


@pytest.mark.asyncio
@pytest.mark.parametrize("unit", ["per_week", "per_month"])
@pytest.mark.parametrize(
    "case",
    [
        pytest.param(
            _TierFrequencyCase((("low", 2, 3), ("clear", 3, 3), ("stretch", 5, 1)), 1, True),
            id="additive-higher-clear",
        ),
        pytest.param(
            _TierFrequencyCase((("low", 3, 1), ("clear", 2, 1), ("stretch", 1, 1)), 3, False),
            id="subtractive-higher-clear",
        ),
        pytest.param(
            _TierFrequencyCase((("clear", 3, 1), ("stretch", 4, 1)), 3, True),
            id="additive-missing-low",
        ),
        pytest.param(
            _TierFrequencyCase((("clear", 3, 3), ("stretch", 2, 3)), 1, False),
            id="subtractive-missing-low",
        ),
    ],
)
async def test_any_qualifying_named_tier_counts_after_a_public_frequency_edit(
    async_client: AsyncClient, db_session: AsyncSession, unit: str, case: _TierFrequencyCase
) -> None:
    """Low or above means any named qualifying tier, including valid missing-Low data."""
    has_low = any(tier == "low" for tier, _, _ in case.goals)
    headers, owner = await _signup(
        async_client, f"overview_inverted_{unit}_{case.additive}_{has_low}"
    )
    habit = Habit(
        user_id=owner,
        name="Tier edits",
        icon="pen",
        start_date=date(2026, 1, 5),
        stage="Blue",
        energy_cost=1,
        energy_return=2,
    )
    db_session.add(habit)
    await db_session.flush()
    goals = [
        Goal(
            habit_id=habit.id,
            title=tier.title(),
            tier=tier,
            target=target,
            target_unit="pages",
            frequency=frequency,
            frequency_unit=unit,
            is_additive=case.additive,
        )
        for tier, target, frequency in case.goals
    ]
    db_session.add_all(goals)
    db_session.add(
        StageProgress(
            user_id=owner, current_stage=1, program_started_at=datetime(2026, 1, 5, tzinfo=UTC)
        )
    )
    db_session.add(UserDepthPreferences(user_id=owner, enable_practices=False))
    await db_session.commit()
    clear = next(goal for goal in goals if goal.tier == "clear")
    response = await async_client.put(
        f"/goals/{clear.id}",
        headers=headers,
        json={
            "title": clear.title,
            "tier": "clear",
            "target": clear.target,
            "target_unit": "pages",
            "frequency": case.clear_frequency,
            "frequency_unit": unit,
            "is_additive": case.additive,
        },
    )
    assert response.status_code == HTTPStatus.OK, response.text
    db_session.add(
        GoalCompletion(
            user_id=owner, goal_id=clear.id, local_day=date(2026, 1, 5), completed_units=4
        )
    )
    await db_session.commit()
    response = await async_client.get("/progress/overview", headers=headers)
    assert response.status_code == HTTPStatus.OK, response.text
    days = response.json()["rhythm"]["days"]
    assert [(day["daily_met"], day["daily_scheduled"]) for day in days[:2]] == [(1, 1), (1, 1)]


@pytest.mark.asyncio
@pytest.mark.parametrize("unit", ["per_week", "per_month"])
@pytest.mark.parametrize("same_period", [True, False])
async def test_moving_start_preserves_recorded_native_period_units(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    unit: str,
    same_period: bool,
) -> None:
    """A public birth edit moves opportunities, never the actual recorded facts."""
    headers, owner = await _signup(async_client, f"overview_start_edit_{unit}_{same_period}")
    habit, goal = await _habit(db_session, owner)
    habit.start_date = date(2025, 12, 1)
    goal.frequency_unit = unit
    db_session.add_all([habit, goal])
    db_session.add(
        StageProgress(
            user_id=owner, current_stage=1, program_started_at=datetime(2026, 1, 5, tzinfo=UTC)
        )
    )
    db_session.add(UserDepthPreferences(user_id=owner, enable_practices=False))
    await db_session.commit()
    monkeypatch.setattr("services.checkin.today_in_tz", lambda _timezone: date(2026, 1, 8))
    recorded = (
        date(2026, 1, 5)
        if same_period
        else date(2026, 1, 4)
        if unit == "per_week"
        else date(2025, 12, 31)
    )
    response = await async_client.post(
        "/goal_completions/",
        headers=headers,
        json={"goal_id": goal.id, "completed_on": recorded.isoformat(), "completed_units": 2},
    )
    assert response.status_code == HTTPStatus.OK, response.text
    response = await async_client.put(
        f"/habits/{habit.id}",
        headers=headers,
        json={
            "name": habit.name,
            "icon": habit.icon,
            "start_date": "2026-01-06",
            "stage": "Blue",
            "energy_cost": 1,
            "energy_return": 4,
        },
    )
    assert response.status_code == HTTPStatus.OK, response.text
    response = await async_client.get("/progress/overview", headers=headers)
    assert response.status_code == HTTPStatus.OK, response.text
    days = response.json()["rhythm"]["days"]
    assert (days[0]["daily_met"], days[0]["daily_scheduled"]) == (0, 0)
    assert (days[1]["daily_met"], days[1]["daily_scheduled"]) == (int(same_period), 1)
