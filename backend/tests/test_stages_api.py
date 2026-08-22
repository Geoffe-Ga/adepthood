"""Tests for the stages API — DB-backed with authentication."""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from http import HTTPStatus
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from curriculum import CANONICAL_PHASE_ORDER, CurriculumDataError, stage_curriculum
from domain.constants import TOTAL_STAGES
from models.course_stage import CourseStage
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.practice import Practice
from models.practice_session import PracticeSession
from models.stage_progress import StageProgress
from models.user_practice import UserPractice
from routers import stages as stages_router


def _stage_data(stage_number: int = 1, **overrides: object) -> dict[str, object]:
    """Return valid CourseStage fields for direct DB insertion."""
    defaults: dict[str, object] = {
        "title": f"Stage {stage_number}",
        "subtitle": f"Subtitle {stage_number}",
        "stage_number": stage_number,
        "overview_url": f"https://example.com/stage-{stage_number}",
        "category": "test",
        "aspect": "test-aspect",
        "spiral_dynamics_color": "beige",
        "growing_up_stage": "archaic",
        "divine_gender_polarity": "masculine",
        "relationship_to_free_will": "active",
        "free_will_description": "Active Yes-And-Ness",
    }
    defaults.update(overrides)
    return defaults


async def _signup(
    client: AsyncClient,
    username: str = "stageuser",
) -> tuple[dict[str, str], int]:
    """Create a user and return (auth headers, user_id)."""
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


async def _signup_with_timezone(
    client: AsyncClient,
    username: str,
    timezone: str,
) -> tuple[dict[str, str], int]:
    """Create a user with an explicit IANA timezone; returns (auth headers, user_id)."""
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


_STAGE_ONE_DURATION_DAYS = 21


def _pacific_anchor_for_stage_two_day(day_in_stage: int) -> datetime:
    """UTC-naive anchor placing "now" on local day ``day_in_stage`` of stage 2 in LA time.

    Stage 1 runs ``_STAGE_ONE_DURATION_DAYS`` days; anchoring at 23:59 local
    time makes the UTC-default calendar read one calendar day behind Pacific
    time regardless of when the test runs.
    """
    la = ZoneInfo("America/Los_Angeles")
    start_date = datetime.now(la).date() - timedelta(
        days=_STAGE_ONE_DURATION_DAYS + day_in_stage - 1
    )
    anchor_local = datetime.combine(start_date, time(23, 59), tzinfo=la)
    return anchor_local.astimezone(UTC).replace(tzinfo=None)


async def _seed_stages(db_session: AsyncSession, count: int = 3) -> list[CourseStage]:
    """Insert test stages into the DB."""
    stages = []
    for i in range(1, count + 1):
        stage = CourseStage(**_stage_data(stage_number=i))
        db_session.add(stage)
        stages.append(stage)
    await db_session.commit()
    for s in stages:
        await db_session.refresh(s)
    return stages


# ── Unauthenticated access ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_stages_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/stages")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_get_stage_progress_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/stages/1/progress")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── GET /stages ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_stages_empty(
    async_client: AsyncClient,
) -> None:
    headers, _user_id = await _signup(async_client)
    resp = await async_client.get("/stages", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_stages_returns_all(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    headers, _user_id = await _signup(async_client)
    seed_count = 3
    await _seed_stages(db_session, count=seed_count)
    resp = await async_client.get("/stages", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert len(data) == seed_count
    assert data[0]["stage_number"] == 1
    assert data[-1]["stage_number"] == seed_count


@pytest.mark.asyncio
async def test_list_stages_includes_progress_overlay(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    headers, user_id = await _signup(async_client)
    await _seed_stages(db_session, count=2)
    # Set user progress to stage 2 with stage 1 completed
    progress = StageProgress(user_id=user_id, current_stage=2, completed_stages=[1])
    db_session.add(progress)
    await db_session.commit()

    resp = await async_client.get("/stages", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    # Stage 1: unlocked (always), completed
    assert data[0]["is_unlocked"] is True
    # Stage 2: unlocked (current)
    assert data[1]["is_unlocked"] is True


@pytest.mark.asyncio
async def test_list_stages_stage1_always_unlocked(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Stage 1 is always unlocked even without any StageProgress record."""
    headers, _user_id = await _signup(async_client)
    await _seed_stages(db_session, count=2)
    resp = await async_client.get("/stages", headers=headers)
    data = resp.json()
    assert data[0]["is_unlocked"] is True
    assert data[1]["is_unlocked"] is False


@pytest.mark.asyncio
async def test_list_stages_populates_progress_field(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-STAGE-006: The progress field should be populated, not always 0.0."""
    headers, user_id = await _signup(async_client)
    await _seed_stages(db_session, count=1)
    # Create practice + session so progress > 0
    practice = Practice(
        stage_number=1,
        name="Test",
        description="t",
        instructions="t",
        default_duration_minutes=5,
        approved=True,
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    user_practice = UserPractice(
        user_id=user_id,
        practice_id=practice.id,
        stage_number=1,
        start_date=datetime.now(UTC).date(),
    )
    db_session.add(user_practice)
    await db_session.commit()
    await db_session.refresh(user_practice)
    ps = PracticeSession(
        user_id=user_id,
        user_practice_id=user_practice.id,
        duration_minutes=10.0,
    )
    db_session.add(ps)
    await db_session.commit()

    resp = await async_client.get("/stages", headers=headers)
    data = resp.json()
    # Stage 1 is always unlocked, and the user has a practice session,
    # so progress should be > 0.
    assert data[0]["progress"] > 0.0


# ── GET /stages manifestations (integrated/shadow phase expressions) ────

_CANONICAL_PHASE_NAMES: tuple[str, ...] = tuple(phase.value for phase in CANONICAL_PHASE_ORDER)
_MANIFESTATION_COUNT = 6


@pytest.mark.asyncio
async def test_list_stages_includes_six_canonical_manifestations(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Every stage carries its 6 integrated/shadow phase pairs, in canonical order."""
    headers, _user_id = await _signup(async_client, "manifestations_all")
    await _seed_stages(db_session, count=TOTAL_STAGES)

    resp = await async_client.get("/stages", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert len(data) == TOTAL_STAGES

    for stage_payload in data:
        manifestations = stage_payload["manifestations"]
        assert len(manifestations) == _MANIFESTATION_COUNT
        assert [m["phase"] for m in manifestations] == list(_CANONICAL_PHASE_NAMES)
        for m in manifestations:
            assert m["integrated"]["name"].strip() != ""
            assert m["integrated"]["description"].strip() != ""
            assert m["shadow"]["name"].strip() != ""
            assert m["shadow"]["description"].strip() != ""


@pytest.mark.asyncio
async def test_list_stages_manifestations_match_curriculum_source(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A sampled stage's manifestations mirror the curriculum loader field-for-field."""
    sample_stage_number = 3
    headers, _user_id = await _signup(async_client, "manifestations_parity")
    await _seed_stages(db_session, count=TOTAL_STAGES)

    resp = await async_client.get("/stages", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    stage_payload = next(s for s in data if s["stage_number"] == sample_stage_number)

    expected = stage_curriculum(sample_stage_number)
    assert len(stage_payload["manifestations"]) == len(expected.manifestations)
    for actual_m, expected_m in zip(
        stage_payload["manifestations"],
        expected.manifestations,
        strict=True,
    ):
        assert actual_m["phase"] == expected_m.phase.value
        assert actual_m["integrated"]["name"] == expected_m.integrated.name
        assert actual_m["integrated"]["description"] == expected_m.integrated.description
        assert actual_m["shadow"]["name"] == expected_m.shadow.name
        assert actual_m["shadow"]["description"] == expected_m.shadow.description


@pytest.mark.asyncio
async def test_list_stages_manifestations_degrade_to_empty_on_curriculum_error(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A curriculum lookup failure leaves the list intact; that stage's manifestations become []."""

    def _raise_curriculum_error(stage_number: int) -> object:
        del stage_number
        raise CurriculumDataError("boom")

    monkeypatch.setattr(stages_router, "stage_curriculum", _raise_curriculum_error)

    headers, _user_id = await _signup(async_client, "manifestations_degrade")
    await _seed_stages(db_session, count=1)

    resp = await async_client.get("/stages", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data[0]["manifestations"] == []


# ── GET /stages/{stage_number}/progress ─────────────────────────────────


@pytest.mark.asyncio
async def test_get_stage_progress_empty(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Progress for a stage with no habits/sessions/content returns zeros."""
    headers, _user_id = await _signup(async_client)
    await _seed_stages(db_session, count=1)
    resp = await async_client.get("/stages/1/progress", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["habits_progress"] == 0.0
    assert data["practice_sessions_completed"] == 0
    assert data["course_items_completed"] == 0
    assert data["overall_progress"] == 0.0


@pytest.mark.asyncio
async def test_get_stage_progress_counts_practice_sessions(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    headers, user_id = await _signup(async_client)
    await _seed_stages(db_session, count=1)
    # Create a practice and user-practice selection for stage 1
    practice = Practice(
        stage_number=1,
        name="Meditation",
        description="Sit",
        instructions="Breathe",
        default_duration_minutes=10,
        approved=True,
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    user_practice = UserPractice(
        user_id=user_id,
        practice_id=practice.id,
        stage_number=1,
        start_date=datetime.now(UTC).date(),
    )
    db_session.add(user_practice)
    await db_session.commit()
    await db_session.refresh(user_practice)
    # Add practice sessions linked to the user-practice
    for _ in range(3):
        session = PracticeSession(
            user_id=user_id,
            user_practice_id=user_practice.id,
            duration_minutes=10.0,
        )
        db_session.add(session)
    await db_session.commit()

    resp = await async_client.get("/stages/1/progress", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    expected_count = 3
    assert resp.json()["practice_sessions_completed"] == expected_count


@pytest.mark.asyncio
async def test_get_stage_progress_not_found(
    async_client: AsyncClient,
) -> None:
    headers, _user_id = await _signup(async_client)
    resp = await async_client.get("/stages/99/progress", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── BUG-STAGE-003: history requires stage to be unlocked ────────────────


@pytest.mark.asyncio
async def test_history_rejects_locked_stage(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-STAGE-003: GET /stages/{n}/history must reject locked stages."""
    headers, _user_id = await _signup(async_client)
    await _seed_stages(db_session, count=3)
    # No progress record → only stage 1 is unlocked
    resp = await async_client.get("/stages/3/history", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


# ── is_stage_unlocked correctness ──────────────────────────────────────


@pytest.mark.asyncio
async def test_stage_unlocked_uses_current_stage(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Stage N is unlocked iff ``N <= current_stage``."""
    headers, user_id = await _signup(async_client)
    await _seed_stages(db_session, count=3)
    progress = StageProgress(user_id=user_id, current_stage=3, completed_stages=[1, 2])
    db_session.add(progress)
    await db_session.commit()

    resp = await async_client.get("/stages", headers=headers)
    data = resp.json()
    # current_stage=3 unlocks stages 1..3.
    assert data[0]["is_unlocked"] is True
    assert data[1]["is_unlocked"] is True
    assert data[2]["is_unlocked"] is True


@pytest.mark.asyncio
async def test_stage_unlocked_uses_current_stage_only(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """``current_stage`` is the source of truth; a drifted ``completed_stages`` is ignored."""
    headers, user_id = await _signup(async_client)
    await _seed_stages(db_session, count=3)
    progress = StageProgress(user_id=user_id, current_stage=3, completed_stages=[2])
    db_session.add(progress)
    await db_session.commit()

    resp = await async_client.get("/stages", headers=headers)
    data = resp.json()
    assert data[0]["is_unlocked"] is True
    assert data[1]["is_unlocked"] is True  # current_stage=3 unlocks 1..3
    assert data[2]["is_unlocked"] is True


# ── Timezone-aware stage-unlock gating ──────────────────────────────────


@pytest.mark.asyncio
async def test_list_stages_shows_stage_two_unlocked_on_pacific_first_local_day(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """``GET /stages`` reads the calendar unlock in the caller's timezone, not UTC.

    A Pacific user on the first local calendar day of stage 2 sees it
    unlocked; the UTC default still reads day 20 of stage 1 and reports it
    locked.
    """
    headers, user_id = await _signup_with_timezone(
        async_client, "pacificstages", "America/Los_Angeles"
    )
    await _seed_stages(db_session, count=3)
    db_session.add(
        StageProgress(
            user_id=user_id,
            current_stage=1,
            completed_stages=[],
            program_started_at=_pacific_anchor_for_stage_two_day(1),
        )
    )
    await db_session.commit()

    resp = await async_client.get("/stages", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data[1]["is_unlocked"] is True


@pytest.mark.asyncio
async def test_stage_history_open_on_pacific_first_local_day_of_stage_two(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """``GET /stages/{n}/history`` must honor the same timezone-aware calendar unlock."""
    headers, user_id = await _signup_with_timezone(
        async_client, "pacifichistory", "America/Los_Angeles"
    )
    await _seed_stages(db_session, count=3)
    db_session.add(
        StageProgress(
            user_id=user_id,
            current_stage=1,
            completed_stages=[],
            program_started_at=_pacific_anchor_for_stage_two_day(1),
        )
    )
    await db_session.commit()

    resp = await async_client.get("/stages/2/history", headers=headers)
    assert resp.status_code == HTTPStatus.OK


# ── User isolation ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stages_progress_isolated_per_user(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    alice_headers, _alice_id = await _signup(async_client, "alice")
    bob_headers, _bob_id = await _signup(async_client, "bob")
    await _seed_stages(db_session, count=3)

    # Alice starts at stage 1
    await async_client.put(
        "/stages/progress",
        json={"current_stage": 1},
        headers=alice_headers,
    )

    # Bob's stages should not show Alice's progress
    resp = await async_client.get("/stages", headers=bob_headers)
    data = resp.json()
    # Stage 2 should be locked for Bob (no progress record)
    assert data[1]["is_unlocked"] is False


# ── POST /stages/begin-again ─────────────────────────────────────────────


async def _seed_stage_10_progress(
    db_session: AsyncSession,
    user_id: int,
    *,
    cycle_number: int = 1,
    highest_stage_reached: int | None = None,
) -> StageProgress:
    """Insert a completed-cycle StageProgress row (current_stage == TOTAL_STAGES).

    ``highest_stage_reached`` defaults to ``TOTAL_STAGES`` (matching
    ``current_stage``, the ordinary case for a freshly-completed cycle); pass
    it explicitly to pin a persisted lifetime high-water mark ahead of a
    begin-again reset.
    """
    resolved_mark = TOTAL_STAGES if highest_stage_reached is None else highest_stage_reached
    progress = StageProgress(
        user_id=user_id,
        current_stage=TOTAL_STAGES,
        completed_stages=list(range(1, TOTAL_STAGES)),
        cycle_number=cycle_number,
        highest_stage_reached=resolved_mark,
    )
    db_session.add(progress)
    await db_session.commit()
    await db_session.refresh(progress)
    return progress


@pytest.mark.asyncio
async def test_begin_again_happy_path(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Stage-10 user loops back to stage 1 with cycle_number incremented."""
    headers, user_id = await _signup(async_client, "beginagain_happy")
    await _seed_stage_10_progress(db_session, user_id, cycle_number=1)

    resp = await async_client.post("/stages/begin-again", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["current_stage"] == 1
    assert data["completed_stages"] == []
    assert data["cycle_number"] == 2


@pytest.mark.asyncio
async def test_begin_again_preserves_journal_habit_and_goal_completion(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """begin-again must not touch journal, habit streak, or goal-completion rows."""
    headers, user_id = await _signup(async_client, "beginagain_preserve")
    await _seed_stage_10_progress(db_session, user_id, cycle_number=1)

    # Seed a journal entry for the same user.
    journal = JournalEntry(sender="user", user_id=user_id, message="carry me over")
    db_session.add(journal)
    await db_session.commit()
    await db_session.refresh(journal)
    journal_id = journal.id

    # Seed a habit with a nonzero streak.
    habit = Habit(
        name="Morning run",
        icon="running",
        start_date=datetime.now(UTC).date(),
        energy_cost=2,
        energy_return=3,
        user_id=user_id,
        streak=7,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)
    habit_id = habit.id
    expected_streak = 7

    # Seed a Goal and a GoalCompletion attached to that habit.
    goal = Goal(
        habit_id=habit_id,
        title="Run 30 min",
        tier="clear",
        target=30.0,
        target_unit="minutes",
        frequency=1.0,
        frequency_unit="per_day",
    )
    db_session.add(goal)
    await db_session.commit()
    await db_session.refresh(goal)
    completion = GoalCompletion(
        goal_id=goal.id,
        user_id=user_id,
        completed_units=30.0,
    )
    db_session.add(completion)
    await db_session.commit()
    await db_session.refresh(completion)
    completion_id = completion.id

    resp = await async_client.post("/stages/begin-again", headers=headers)
    assert resp.status_code == HTTPStatus.OK

    # Journal row survives.
    journal_result = await db_session.execute(
        select(JournalEntry).where(col(JournalEntry.id) == journal_id)
    )
    assert journal_result.scalar_one_or_none() is not None

    # Habit row survives AND streak is unchanged (no penalty).
    habit_result = await db_session.execute(select(Habit).where(col(Habit.id) == habit_id))
    surviving_habit = habit_result.scalar_one_or_none()
    assert surviving_habit is not None
    assert surviving_habit.streak == expected_streak

    # GoalCompletion row survives.
    gc_result = await db_session.execute(
        select(GoalCompletion).where(col(GoalCompletion.id) == completion_id)
    )
    assert gc_result.scalar_one_or_none() is not None


@pytest.mark.asyncio
async def test_begin_again_preserves_high_water_mark_across_reset(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """begin-again resets current_stage to 1 but the persisted mark survives at its high value."""
    headers, user_id = await _signup(async_client, "beginagain_highwater")
    await _seed_stage_10_progress(
        db_session, user_id, cycle_number=1, highest_stage_reached=TOTAL_STAGES
    )

    resp = await async_client.post("/stages/begin-again", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["current_stage"] == 1

    db_session.expire_all()
    row_result = await db_session.execute(
        select(StageProgress).where(col(StageProgress.user_id) == user_id)
    )
    row = row_result.scalar_one()
    assert row.highest_stage_reached == TOTAL_STAGES


@pytest.mark.asyncio
async def test_begin_again_rejects_mid_cycle(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """begin-again on a mid-cycle user returns 409 cycle_not_complete; row unchanged."""
    headers, user_id = await _signup(async_client, "beginagain_midcycle")
    progress = StageProgress(
        user_id=user_id,
        current_stage=5,
        completed_stages=[1, 2, 3, 4],
        cycle_number=1,
    )
    db_session.add(progress)
    await db_session.commit()

    resp = await async_client.post("/stages/begin-again", headers=headers)

    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "cycle_not_complete"

    # Row must be untouched.
    row_result = await db_session.execute(
        select(StageProgress).where(col(StageProgress.user_id) == user_id)
    )
    row = row_result.scalar_one()
    assert row.current_stage == 5
    assert row.cycle_number == 1


@pytest.mark.asyncio
async def test_begin_again_rejects_fresh_user_no_row(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """begin-again with no StageProgress row must be rejected (4xx, not 200)."""
    headers, user_id = await _signup(async_client, "beginagain_norow")

    resp = await async_client.post("/stages/begin-again", headers=headers)

    assert resp.status_code == HTTPStatus.NOT_FOUND

    # No StageProgress row may be created as a side-effect.
    row_result = await db_session.execute(
        select(StageProgress).where(col(StageProgress.user_id) == user_id)
    )
    assert row_result.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_begin_again_requires_auth(async_client: AsyncClient) -> None:
    """POST /stages/begin-again without a token returns 401."""
    resp = await async_client.post("/stages/begin-again")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_begin_again_second_loop_increments_to_cycle_3(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A user already on cycle 2 at stage 10 advances to cycle_number 3."""
    headers, user_id = await _signup(async_client, "beginagain_cycle2")
    await _seed_stage_10_progress(db_session, user_id, cycle_number=2)

    resp = await async_client.post("/stages/begin-again", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["cycle_number"] == 3
    assert data["current_stage"] == 1
    assert data["completed_stages"] == []
