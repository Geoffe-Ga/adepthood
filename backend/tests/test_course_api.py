"""Tests for the course content API covering drip-feed gating, read-tracking, and progress."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.content_completion import ContentCompletion
from models.course_stage import CourseStage
from models.stage_content import StageContent
from models.stage_progress import StageProgress


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
    username: str = "courseuser",
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


async def _seed_stage_with_content(
    db_session: AsyncSession,
    stage_number: int = 1,
    content_items: list[dict[str, object]] | None = None,
) -> tuple[CourseStage, list[StageContent]]:
    """Insert a stage and its content items. Returns (stage, items)."""
    stage = CourseStage(**_stage_data(stage_number=stage_number))
    db_session.add(stage)
    await db_session.flush()

    if content_items is None:
        content_items = [
            {
                "title": "Day 1 Essay",
                "content_type": "essay",
                "release_day": 0,
                "url": "https://cms.example.com/s1-essay",
            },
            {
                "title": "Day 3 Video",
                "content_type": "video",
                "release_day": 3,
                "url": "https://cms.example.com/s1-video",
            },
            {
                "title": "Day 7 Prompt",
                "content_type": "prompt",
                "release_day": 7,
                "url": "https://cms.example.com/s1-prompt",
            },
        ]

    items = []
    for item_data in content_items:
        item = StageContent(course_stage_id=stage.id, **item_data)
        db_session.add(item)
        items.append(item)
    await db_session.commit()
    for obj in [stage, *items]:
        await db_session.refresh(obj)
    return stage, items


async def _set_user_stage(
    db_session: AsyncSession,
    user_id: int,
    stage_number: int,
    started_at: datetime | None = None,
) -> StageProgress:
    """Create a StageProgress record with a specific stage_started_at."""
    progress = StageProgress(
        user_id=user_id,
        current_stage=stage_number,
        completed_stages=list(range(1, stage_number)),
        stage_started_at=started_at or datetime.now(UTC),
    )
    db_session.add(progress)
    await db_session.commit()
    await db_session.refresh(progress)
    return progress


# ── Unauthenticated access ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_content_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/course/stages/1/content")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_get_content_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/course/content/1")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_mark_read_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.post("/course/content/1/mark-read")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_get_progress_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/course/stages/1/progress")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── GET /course/stages/{stage_number}/content ────────────────────────────


@pytest.mark.asyncio
async def test_list_content_stage_not_found(
    async_client: AsyncClient,
) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.get("/course/stages/99/content", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_list_content_rejects_locked_stage(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-COURSE-001: listing content for a locked stage must 403.

    The sibling single-item endpoints gate on ``_check_stage_unlocked``;
    until this fix ``list_stage_content`` leaked every item's title and
    release_day (only the URL was nulled) so a never-enrolled user could
    enumerate the full 36-stage drip schedule.
    """
    headers, _ = await _signup(async_client, "locked")
    # Seed content for stage 2 without giving the user any progress.
    await _seed_stage_with_content(db_session, stage_number=2)

    resp = await async_client.get("/course/stages/2/content", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "stage_locked"


@pytest.mark.asyncio
async def test_list_content_no_progress_record(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Without a StageProgress record, all items are locked."""
    headers, _ = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)

    resp = await async_client.get("/course/stages/1/content", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    expected_count = 3
    assert len(data) == expected_count
    # All items should be locked (no progress record means day 0 not started)
    for item in data:
        assert item["is_locked"] is True
        assert item["url"] is None


@pytest.mark.asyncio
async def test_list_content_drip_feed_day_zero(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """On day 0, only release_day=0 items are unlocked."""
    headers, user_id = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)
    await _set_user_stage(db_session, user_id, stage_number=1)

    resp = await async_client.get("/course/stages/1/content", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    expected_count = 3
    assert len(data) == expected_count

    unlocked = [d for d in data if not d["is_locked"]]
    locked = [d for d in data if d["is_locked"]]
    expected_locked = 2
    assert len(unlocked) == 1
    assert unlocked[0]["title"] == "Day 1 Essay"
    assert unlocked[0]["url"] == "https://cms.example.com/s1-essay"
    assert len(locked) == expected_locked
    for item in locked:
        assert item["url"] is None


@pytest.mark.asyncio
async def test_list_content_drip_feed_day_three(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """After 3 days, release_day 0 and 3 items are unlocked."""
    headers, user_id = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)
    three_days_ago = datetime.now(UTC) - timedelta(days=3)
    await _set_user_stage(db_session, user_id, stage_number=1, started_at=three_days_ago)

    resp = await async_client.get("/course/stages/1/content", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()

    unlocked = [d for d in data if not d["is_locked"]]
    locked = [d for d in data if d["is_locked"]]
    expected_unlocked = 2
    assert len(unlocked) == expected_unlocked
    assert len(locked) == 1
    assert locked[0]["title"] == "Day 7 Prompt"


@pytest.mark.asyncio
async def test_list_content_drip_feed_all_unlocked(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """After 7+ days, all items are unlocked."""
    headers, user_id = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)
    ten_days_ago = datetime.now(UTC) - timedelta(days=10)
    await _set_user_stage(db_session, user_id, stage_number=1, started_at=ten_days_ago)

    resp = await async_client.get("/course/stages/1/content", headers=headers)
    data = resp.json()
    assert all(not item["is_locked"] for item in data)
    assert all(item["url"] is not None for item in data)


@pytest.mark.asyncio
async def test_list_content_includes_is_read(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Items marked as read show is_read: true."""
    headers, user_id = await _signup(async_client)
    _, items = await _seed_stage_with_content(db_session, stage_number=1)
    ten_days_ago = datetime.now(UTC) - timedelta(days=10)
    await _set_user_stage(db_session, user_id, stage_number=1, started_at=ten_days_ago)

    # Mark the first item as read
    completion = ContentCompletion(user_id=user_id, content_id=items[0].id)
    db_session.add(completion)
    await db_session.commit()

    resp = await async_client.get("/course/stages/1/content", headers=headers)
    data = resp.json()
    read_items = [d for d in data if d["is_read"]]
    assert len(read_items) == 1
    assert read_items[0]["title"] == "Day 1 Essay"


# ── GET /course/content/{content_id} ────────────────────────────────────


@pytest.mark.asyncio
async def test_get_single_content_item(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    headers, user_id = await _signup(async_client)
    _, items = await _seed_stage_with_content(db_session, stage_number=1)
    ten_days_ago = datetime.now(UTC) - timedelta(days=10)
    await _set_user_stage(db_session, user_id, stage_number=1, started_at=ten_days_ago)

    resp = await async_client.get(f"/course/content/{items[0].id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["title"] == "Day 1 Essay"
    assert data["url"] == "https://cms.example.com/s1-essay"
    assert data["is_locked"] is False


@pytest.mark.asyncio
async def test_get_single_content_locked(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Locked content returns no URL."""
    headers, user_id = await _signup(async_client)
    _, items = await _seed_stage_with_content(db_session, stage_number=1)
    await _set_user_stage(db_session, user_id, stage_number=1)

    # Day 7 prompt should be locked on day 0
    day7_item = items[2]
    resp = await async_client.get(f"/course/content/{day7_item.id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["is_locked"] is True
    assert data["url"] is None


@pytest.mark.asyncio
async def test_get_content_not_found(
    async_client: AsyncClient,
) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.get("/course/content/999", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── POST /course/content/{content_id}/mark-read ─────────────────────────


@pytest.mark.asyncio
async def test_mark_content_read(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    headers, user_id = await _signup(async_client)
    _, items = await _seed_stage_with_content(db_session, stage_number=1)
    ten_days_ago = datetime.now(UTC) - timedelta(days=10)
    await _set_user_stage(db_session, user_id, stage_number=1, started_at=ten_days_ago)

    resp = await async_client.post(f"/course/content/{items[0].id}/mark-read", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["content_id"] == items[0].id
    assert data["user_id"] == user_id
    assert "completed_at" in data


@pytest.mark.asyncio
async def test_mark_read_idempotent(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Marking the same item read twice doesn't error or duplicate."""
    headers, user_id = await _signup(async_client)
    _, items = await _seed_stage_with_content(db_session, stage_number=1)
    ten_days_ago = datetime.now(UTC) - timedelta(days=10)
    await _set_user_stage(db_session, user_id, stage_number=1, started_at=ten_days_ago)

    resp1 = await async_client.post(f"/course/content/{items[0].id}/mark-read", headers=headers)
    assert resp1.status_code == HTTPStatus.OK
    resp2 = await async_client.post(f"/course/content/{items[0].id}/mark-read", headers=headers)
    assert resp2.status_code == HTTPStatus.OK

    # Verify only one completion record exists
    result = await db_session.execute(
        select(ContentCompletion).where(
            ContentCompletion.user_id == user_id,
            ContentCompletion.content_id == items[0].id,
        )
    )
    completions = result.scalars().all()
    assert len(completions) == 1


@pytest.mark.asyncio
async def test_mark_read_content_not_found(
    async_client: AsyncClient,
) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.post("/course/content/999/mark-read", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── GET /course/stages/{stage_number}/progress ──────────────────────────


@pytest.mark.asyncio
async def test_course_progress_empty(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Progress is 0% when nothing has been read."""
    headers, user_id = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)
    await _set_user_stage(db_session, user_id, stage_number=1)

    resp = await async_client.get("/course/stages/1/progress", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    expected_total = 3
    assert data["total_items"] == expected_total
    assert data["read_items"] == 0
    assert data["progress_percent"] == 0.0
    assert data["next_unlock_day"] is not None


@pytest.mark.asyncio
async def test_course_progress_partial(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Progress reflects read/total ratio."""
    headers, user_id = await _signup(async_client)
    _, items = await _seed_stage_with_content(db_session, stage_number=1)
    ten_days_ago = datetime.now(UTC) - timedelta(days=10)
    await _set_user_stage(db_session, user_id, stage_number=1, started_at=ten_days_ago)

    # Mark 1 of 3 items as read
    completion = ContentCompletion(user_id=user_id, content_id=items[0].id)
    db_session.add(completion)
    await db_session.commit()

    resp = await async_client.get("/course/stages/1/progress", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    expected_total = 3
    assert data["total_items"] == expected_total
    assert data["read_items"] == 1
    expected_pct = 33.33
    assert data["progress_percent"] == pytest.approx(expected_pct, abs=1e-2)


@pytest.mark.asyncio
async def test_course_progress_complete(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """100% progress when all items read."""
    headers, user_id = await _signup(async_client)
    _, items = await _seed_stage_with_content(db_session, stage_number=1)
    ten_days_ago = datetime.now(UTC) - timedelta(days=10)
    await _set_user_stage(db_session, user_id, stage_number=1, started_at=ten_days_ago)

    for item in items:
        completion = ContentCompletion(user_id=user_id, content_id=item.id)
        db_session.add(completion)
    await db_session.commit()

    resp = await async_client.get("/course/stages/1/progress", headers=headers)
    data = resp.json()
    expected_total = 3
    assert data["total_items"] == expected_total
    assert data["read_items"] == expected_total
    expected_pct = 100.0
    assert data["progress_percent"] == expected_pct
    assert data["next_unlock_day"] is None


@pytest.mark.asyncio
async def test_course_progress_next_unlock_day(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """next_unlock_day reports the next locked item's release_day."""
    headers, user_id = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)
    # User started today -> day 0: release_day 3 is next unlock
    await _set_user_stage(db_session, user_id, stage_number=1)

    resp = await async_client.get("/course/stages/1/progress", headers=headers)
    data = resp.json()
    expected_next = 3
    assert data["next_unlock_day"] == expected_next


@pytest.mark.asyncio
async def test_course_progress_stage_not_found(
    async_client: AsyncClient,
) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.get("/course/stages/99/progress", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── User isolation ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_read_tracking_isolated_per_user(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """One user's read completions don't affect another user."""
    alice_headers, alice_id = await _signup(async_client, "alice")
    bob_headers, bob_id = await _signup(async_client, "bob")
    _, items = await _seed_stage_with_content(db_session, stage_number=1)

    ten_days_ago = datetime.now(UTC) - timedelta(days=10)
    # Both users on stage 1
    await _set_user_stage(db_session, alice_id, stage_number=1, started_at=ten_days_ago)
    bob_progress = StageProgress(
        user_id=bob_id,
        current_stage=1,
        completed_stages=[],
        stage_started_at=ten_days_ago,
    )
    db_session.add(bob_progress)
    await db_session.commit()

    # Alice marks item read
    await async_client.post(f"/course/content/{items[0].id}/mark-read", headers=alice_headers)

    # Bob's content should not show as read
    resp = await async_client.get("/course/stages/1/content", headers=bob_headers)
    data = resp.json()
    assert all(not item["is_read"] for item in data)


# ── BUG-COURSE-007: get_content_item checks stage unlock ──────────────


@pytest.mark.asyncio
async def test_get_content_item_rejects_locked_stage(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-COURSE-007: Content from a locked stage must be forbidden."""
    headers, _user_id = await _signup(async_client)
    # Create stage 2 content but user has NO progress record (only stage 1 unlocked)
    _, items = await _seed_stage_with_content(db_session, stage_number=2)

    resp = await async_client.get(f"/course/content/{items[0].id}", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


# ── BUG-COURSE-005: mark_content_read checks stage unlock ─────────────


@pytest.mark.asyncio
async def test_mark_read_rejects_locked_stage(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-COURSE-005: Cannot mark content from a locked stage as read."""
    headers, _user_id = await _signup(async_client)
    _, items = await _seed_stage_with_content(db_session, stage_number=2)

    resp = await async_client.post(f"/course/content/{items[0].id}/mark-read", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


# ── BUG-COURSE-002/003: past-stage content is fully unlocked ───────────


@pytest.mark.asyncio
async def test_past_stage_content_fully_unlocked(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-COURSE-002/003: User on stage 3 can see all stage-1 content.

    Content from completed stages is visible regardless of drip-feed timing.
    """
    headers, user_id = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)
    # Also seed stage 3 so user can be on it
    stage3 = CourseStage(
        title="S3",
        subtitle="S3",
        stage_number=3,
        overview_url="",
        category="t",
        aspect="t",
        spiral_dynamics_color="red",
        growing_up_stage="power",
        divine_gender_polarity="m",
        relationship_to_free_will="a",
        free_will_description="t",
    )
    db_session.add(stage3)
    await db_session.commit()
    # User is on stage 3 with stages 1,2 completed
    await _set_user_stage(db_session, user_id, stage_number=3)

    resp = await async_client.get("/course/stages/1/content", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    # Even day-7 content should be unlocked for a past stage
    assert all(not item["is_locked"] for item in data)
    assert all(item["url"] is not None for item in data)


# ── BUG-COURSE-004: next_unlock_day with negative days ─────────────────


@pytest.mark.asyncio
async def test_course_progress_no_next_unlock_when_not_on_stage(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-COURSE-004: next_unlock_day should be None when the user has not started the stage.

    The endpoint must not pass -1 to next_unlock_day.
    """
    headers, _user_id = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)
    # User has no progress record
    resp = await async_client.get("/course/stages/1/progress", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["next_unlock_day"] is None
