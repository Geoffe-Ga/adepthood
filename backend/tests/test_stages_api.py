"""Tests for the stages API — DB-backed with authentication."""

from __future__ import annotations

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
async def test_update_progress_creates_new(
    async_client: AsyncClient,
) -> None:
    headers, user_id = await _signup(async_client)
    target_stage = 2
    resp = await async_client.put(
        "/stages/progress",
        json={"current_stage": target_stage},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["current_stage"] == target_stage
    assert data["user_id"] == user_id


@pytest.mark.asyncio
async def test_update_progress_updates_existing(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    headers, user_id = await _signup(async_client)
    # Create initial progress
    progress = StageProgress(user_id=user_id, current_stage=1, completed_stages=[])
    db_session.add(progress)
    await db_session.commit()

    target_stage = 3
    resp = await async_client.put(
        "/stages/progress",
        json={"current_stage": target_stage},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["current_stage"] == target_stage
    # All stages before target should be marked completed
    assert 1 in data["completed_stages"]
    assert target_stage - 1 in data["completed_stages"]


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


# ── Edge cases ──────────────────────────────────────────────────────────


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


# ── User isolation ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stages_progress_isolated_per_user(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    alice_headers, alice_id = await _signup(async_client, "alice")
    bob_headers, bob_id = await _signup(async_client, "bob")
    await _seed_stages(db_session, count=3)

    # Alice advances to stage 2
    await async_client.put(
        "/stages/progress",
        json={"current_stage": 2},
        headers=alice_headers,
    )

    # Bob's stages should not show Alice's progress
    resp = await async_client.get("/stages", headers=bob_headers)
    data = resp.json()
    # Stage 2 should be locked for Bob (no progress record)
    assert data[1]["is_unlocked"] is False
