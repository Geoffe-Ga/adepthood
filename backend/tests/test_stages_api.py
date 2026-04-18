"""Tests for the stages API — DB-backed with authentication."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.course_stage import CourseStage
from models.practice import Practice
from models.practice_session import PracticeSession
from models.stage_progress import StageProgress
from models.user_practice import UserPractice


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
async def test_get_stage_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/stages/1")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_get_stage_progress_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/stages/1/progress")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_update_progress_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.put("/stages/progress", json={"current_stage": 2})
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


# ── GET /stages/{stage_number} ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_stage_detail(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    headers, _user_id = await _signup(async_client)
    await _seed_stages(db_session, count=2)
    resp = await async_client.get("/stages/1", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["stage_number"] == 1
    assert data["title"] == "Stage 1"
    assert data["spiral_dynamics_color"] == "beige"
    assert "is_unlocked" in data


@pytest.mark.asyncio
async def test_get_stage_not_found(
    async_client: AsyncClient,
) -> None:
    headers, _user_id = await _signup(async_client)
    resp = await async_client.get("/stages/99", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


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


# ── PUT /stages/progress ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_update_progress_creates_new_at_stage_one(
    async_client: AsyncClient,
) -> None:
    """First progress record must start at stage 1 (BUG-STAGE-001)."""
    headers, user_id = await _signup(async_client)
    resp = await async_client.put(
        "/stages/progress",
        json={"current_stage": 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["current_stage"] == 1
    assert data["user_id"] == user_id
    assert data["completed_stages"] == []


@pytest.mark.asyncio
async def test_update_progress_rejects_create_at_nonzero_stage(
    async_client: AsyncClient,
) -> None:
    """BUG-STAGE-001: Cannot create progress at a stage other than 1."""
    headers, _user_id = await _signup(async_client)
    resp = await async_client.put(
        "/stages/progress",
        json={"current_stage": 5},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST


@pytest.mark.asyncio
async def test_update_progress_advances_one_step(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-STAGE-001: Must advance exactly one stage at a time."""
    headers, user_id = await _signup(async_client)
    progress = StageProgress(user_id=user_id, current_stage=1, completed_stages=[])
    db_session.add(progress)
    await db_session.commit()

    expected_stage = 2
    resp = await async_client.put(
        "/stages/progress",
        json={"current_stage": expected_stage},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["current_stage"] == expected_stage
    assert 1 in data["completed_stages"]


@pytest.mark.asyncio
async def test_update_progress_rejects_skip(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-STAGE-001: Skipping from stage 1 to 3 is rejected."""
    headers, user_id = await _signup(async_client)
    progress = StageProgress(user_id=user_id, current_stage=1, completed_stages=[])
    db_session.add(progress)
    await db_session.commit()

    resp = await async_client.put(
        "/stages/progress",
        json={"current_stage": 3},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST


@pytest.mark.asyncio
async def test_update_progress_cannot_go_backwards(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    headers, user_id = await _signup(async_client)
    progress = StageProgress(user_id=user_id, current_stage=5, completed_stages=[1, 2, 3, 4])
    db_session.add(progress)
    await db_session.commit()

    resp = await async_client.put(
        "/stages/progress",
        json={"current_stage": 2},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST


@pytest.mark.asyncio
async def test_update_progress_cannot_stay_same(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Submitting the current stage again is rejected."""
    headers, user_id = await _signup(async_client)
    progress = StageProgress(user_id=user_id, current_stage=3, completed_stages=[1, 2])
    db_session.add(progress)
    await db_session.commit()

    resp = await async_client.put(
        "/stages/progress",
        json={"current_stage": 3},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST


# ── BUG-STAGE-005: TOCTOU race on PUT /stages/progress ─────────────────


_EXPECTED_STAGE_AFTER_ADVANCE = 2


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_advance_produces_consistent_state(
    concurrent_async_client: AsyncClient,
) -> None:
    """BUG-STAGE-005: Two concurrent advances must produce a consistent.

    final state.  With PostgreSQL's ``FOR UPDATE`` lock, exactly one
    request wins and the other is rejected.  SQLite serialises at the
    database level so both may succeed — but the final state must still
    be ``current_stage=2, completed_stages=[1]``.
    """
    headers, _user_id = await _signup(concurrent_async_client, "raceuser")
    # Create initial progress at stage 1
    resp = await concurrent_async_client.put(
        "/stages/progress",
        json={"current_stage": 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK

    # Both try to advance to stage 2 concurrently
    results = await asyncio.gather(
        concurrent_async_client.put(
            "/stages/progress",
            json={"current_stage": _EXPECTED_STAGE_AFTER_ADVANCE},
            headers=headers,
        ),
        concurrent_async_client.put(
            "/stages/progress",
            json={"current_stage": _EXPECTED_STAGE_AFTER_ADVANCE},
            headers=headers,
        ),
    )

    # At least one must succeed
    assert any(r.status_code == HTTPStatus.OK for r in results)

    # Verify the final state is consistent
    successful = [r for r in results if r.status_code == HTTPStatus.OK]
    for r in successful:
        data = r.json()
        assert data["current_stage"] == _EXPECTED_STAGE_AFTER_ADVANCE
        assert data["completed_stages"] == [1]


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


# ── BUG-STAGE-002: is_stage_unlocked correctness ───────────────────────


@pytest.mark.asyncio
async def test_stage_unlocked_via_completed_stages(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Stage N+1 unlocks when N is in completed_stages."""
    headers, user_id = await _signup(async_client)
    await _seed_stages(db_session, count=3)
    # completed_stages includes 1 and 2, current is 2
    progress = StageProgress(user_id=user_id, current_stage=2, completed_stages=[1, 2])
    db_session.add(progress)
    await db_session.commit()

    resp = await async_client.get("/stages", headers=headers)
    data = resp.json()
    # Stage 3 should be unlocked because stage 2 is in completed_stages
    assert data[2]["is_unlocked"] is True


@pytest.mark.asyncio
async def test_stage_unlocked_requires_predecessor_completed(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-STAGE-002: stage N <= current but N-1 NOT in completed_stages → locked."""
    headers, user_id = await _signup(async_client)
    await _seed_stages(db_session, count=3)
    # current_stage=3 but completed_stages is missing stage 1.
    # This simulates a DB-level mutation that skipped the completion list.
    progress = StageProgress(user_id=user_id, current_stage=3, completed_stages=[2])
    db_session.add(progress)
    await db_session.commit()

    resp = await async_client.get("/stages", headers=headers)
    data = resp.json()
    # Stage 1: always unlocked
    assert data[0]["is_unlocked"] is True
    # Stage 2: current_stage=3 > 2, but predecessor (1) NOT in completed → locked
    assert data[1]["is_unlocked"] is False
    # Stage 3: current_stage=3, predecessor (2) IS in completed → unlocked
    assert data[2]["is_unlocked"] is True


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
