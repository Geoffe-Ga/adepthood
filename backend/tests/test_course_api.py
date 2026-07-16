"""Tests for the course content API covering drip-feed gating, read-tracking, and progress."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import select

from domain.course import compute_days_elapsed
from domain.stage_progress import ensure_user_progress
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


_LOCKED_LISTING_KEYS = {
    "id",
    "title",
    "content_type",
    "release_day",
    "url",
    "is_locked",
    "is_read",
}


@pytest.mark.asyncio
async def test_list_content_locked_stage_returns_titles_only(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A locked stage's listing is titles-only, not a 403.

    The course drawer's table of contents needs to show every stage's
    chapter titles up front so a user can preview what is ahead; only the
    body and url stay gated behind unlock. This is a deliberate product
    contract, not a leak: every item comes back locked and url-less.
    """
    headers, _ = await _signup(async_client, "locked")
    # Seed content for stage 2 without giving the user any progress.
    _, items = await _seed_stage_with_content(db_session, stage_number=2)

    resp = await async_client.get("/course/stages/2/content", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert len(data) == len(items)

    expected_order = sorted(items, key=lambda item: (item.release_day, item.id))
    assert [d["id"] for d in data] == [item.id for item in expected_order]

    for entry in data:
        assert set(entry.keys()) == _LOCKED_LISTING_KEYS
        assert entry["is_locked"] is True
        assert entry["url"] is None
        assert entry["is_read"] is False


@pytest.mark.asyncio
async def test_list_content_locked_stage_paginated(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The paginated envelope also returns titles-only rows for a locked stage."""
    headers, _ = await _signup(async_client, "locked_paginated")
    content_items = [
        {
            "title": f"Chapter {day}",
            "content_type": "essay",
            "release_day": day,
            "url": f"https://cms.example.com/s2-{day}",
        }
        for day in range(5)
    ]
    expected_count = len(content_items)
    await _seed_stage_with_content(db_session, stage_number=2, content_items=content_items)

    resp = await async_client.get(
        "/course/stages/2/content", params={"paginate": "true"}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    envelope = resp.json()
    assert envelope["total"] == expected_count
    assert len(envelope["items"]) == expected_count
    for entry in envelope["items"]:
        assert set(entry.keys()) == _LOCKED_LISTING_KEYS
        assert entry["is_locked"] is True
        assert entry["url"] is None


@pytest.mark.asyncio
async def test_list_content_locked_stage_does_not_provision_progress(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Reading a locked stage's titles-only listing never provisions StageProgress."""
    headers, user_id = await _signup(async_client, "locked_no_provision")

    before = await db_session.execute(select(StageProgress).where(StageProgress.user_id == user_id))
    assert before.scalars().first() is None

    await _seed_stage_with_content(db_session, stage_number=2)

    resp = await async_client.get("/course/stages/2/content", headers=headers)
    assert resp.status_code == HTTPStatus.OK

    after = await db_session.execute(select(StageProgress).where(StageProgress.user_id == user_id))
    assert after.scalars().first() is None


@pytest.mark.asyncio
async def test_list_content_fresh_user_unlocks_day_zero(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """First content access provisions a stage-1 StageProgress row.

    A user who never explicitly advanced a stage had no StageProgress
    row, so drip-feed gating fell back to a ``-1`` day count and locked
    every chapter — even ``release_day=0`` ones — leaving the in-app
    reader permanently empty.  Listing stage content now provisions a
    ``current_stage=1`` row, starting the drip clock at day 0 so the
    day-0 chapter unlocks immediately while later ones stay gated.
    """
    headers, _ = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)

    resp = await async_client.get("/course/stages/1/content", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    expected_count = 3
    assert len(data) == expected_count

    by_title = {item["title"]: item for item in data}
    assert by_title["Day 1 Essay"]["is_locked"] is False
    assert by_title["Day 1 Essay"]["url"] == "https://cms.example.com/s1-essay"
    assert by_title["Day 3 Video"]["is_locked"] is True
    assert by_title["Day 3 Video"]["url"] is None
    assert by_title["Day 7 Prompt"]["is_locked"] is True
    assert by_title["Day 7 Prompt"]["url"] is None


@pytest.mark.asyncio
async def test_first_course_access_provisions_stage_progress(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Reading stage content creates the user's StageProgress row if absent."""
    headers, user_id = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)

    before = await db_session.execute(select(StageProgress).where(StageProgress.user_id == user_id))
    assert before.scalars().first() is None

    resp = await async_client.get("/course/stages/1/content", headers=headers)
    assert resp.status_code == HTTPStatus.OK

    after = await db_session.execute(select(StageProgress).where(StageProgress.user_id == user_id))
    progress = after.scalars().first()
    assert progress is not None
    assert progress.current_stage == 1
    assert progress.completed_stages == []


# A user id with no User row — FK is not enforced on the test SQLite DB, so
# ensure_user_progress can be exercised directly without a full signup.
_PROVISIONING_TEST_USER_ID = 4242


@pytest.mark.asyncio
async def test_ensure_user_progress_is_idempotent(db_session: AsyncSession) -> None:
    """ensure_user_progress creates one row and returns it on repeat calls."""
    first = await ensure_user_progress(db_session, _PROVISIONING_TEST_USER_ID)
    assert first.current_stage == 1
    assert first.completed_stages == []

    second = await ensure_user_progress(db_session, _PROVISIONING_TEST_USER_ID)
    assert second.id == first.id

    result = await db_session.execute(
        select(StageProgress).where(StageProgress.user_id == _PROVISIONING_TEST_USER_ID)
    )
    assert len(list(result.scalars().all())) == 1


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
async def test_list_content_drip_feed_partway(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Proportional drip: partway through the stage, the first ordinals open.

    3 chapters over a 21-day stage: by day 8 (day-in-stage 8) the drip has
    opened ceil(3 * 8 / 21) = 2 of them, leaving the last chapter locked —
    regardless of that chapter's release_day value.
    """
    headers, user_id = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)
    seven_days_ago = datetime.now(UTC) - timedelta(days=7)
    await _set_user_stage(db_session, user_id, stage_number=1, started_at=seven_days_ago)

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
    """By the end of the stage window, every chapter is unlocked."""
    headers, user_id = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)
    # Stage 1 runs 21 days; sit at/after its close so the whole stage drips.
    full_stage_ago = datetime.now(UTC) - timedelta(days=21)
    await _set_user_stage(db_session, user_id, stage_number=1, started_at=full_stage_ago)

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
    # BUG-T7: ContentCompletionResponse no longer echoes user_id.
    assert "user_id" not in data
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
    # Past the 21-day stage window so the whole stage has dripped open.
    full_stage_ago = datetime.now(UTC) - timedelta(days=21)
    await _set_user_stage(db_session, user_id, stage_number=1, started_at=full_stage_ago)

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
    # Every chapter has dripped by the end of the stage window, so there is
    # no further unlock day.
    assert data["next_unlock_day"] is None


@pytest.mark.asyncio
async def test_course_progress_next_unlock_day(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """next_unlock_day reports the day-in-stage the next chapter drips."""
    headers, user_id = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)
    # Day 1 of a 21-day stage with 3 chapters: one has dripped, the second
    # opens on day 8 (the first day ceil(3 * D / 21) reaches 2).
    await _set_user_stage(db_session, user_id, stage_number=1)

    resp = await async_client.get("/course/stages/1/progress", headers=headers)
    data = resp.json()
    expected_next = 8
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
    """BUG-COURSE-007 / BUG-COURSE-004: locked-stage content reads as 404.

    The locked branch is masked as ``content_not_found`` rather than
    ``stage_locked`` (403) so an attacker enumerating ``content_id``
    cannot distinguish "row exists but locked" from "row does not
    exist".  Course content is shared catalog -- the prompt-07
    canonical "403 for cross-user" rule does not apply here because
    there is no per-user ownership; the leak surface is content-row
    count, which the 404 mask removes.
    """
    headers, _user_id = await _signup(async_client)
    # Create stage 2 content but user has NO progress record (only stage 1 unlocked)
    _, items = await _seed_stage_with_content(db_session, stage_number=2)

    resp = await async_client.get(f"/course/content/{items[0].id}", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "content_not_found"


# ── BUG-COURSE-005: mark_content_read checks stage unlock ─────────────


@pytest.mark.asyncio
async def test_mark_read_rejects_locked_stage(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-COURSE-005 / BUG-COURSE-004: locked content marks read as 404.

    See ``test_get_content_item_rejects_locked_stage`` for the rationale
    behind the 404 mask.
    """
    headers, _user_id = await _signup(async_client)
    _, items = await _seed_stage_with_content(db_session, stage_number=2)

    resp = await async_client.post(f"/course/content/{items[0].id}/mark-read", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "content_not_found"


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


# ── Regression: a calendar-unlocked-ahead stage is not fully locked ────


@pytest.mark.asyncio
async def test_calendar_unlocked_ahead_stage_partially_unlocks(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A stage the calendar opened ahead of advancement drips, not blank.

    The old ``_days_for_user_stage`` returned ``-1`` for any stage past
    ``current_stage`` even when the program calendar had already opened it,
    so every chapter of a calendar-unlocked-ahead stage read as locked.
    Here the user is still ``current_stage=1`` but their program anchor is
    25 days old, putting the calendar 5 days into stage 2 — the listing
    must come back non-empty and partially unlocked (ceil(10 * 5 / 21) = 3
    of 10), never all-locked.
    """
    headers, user_id = await _signup(async_client)
    content_items = [
        {
            "title": f"Chapter {day}",
            "content_type": "essay",
            "release_day": day,
            "url": f"https://cms.example.com/s2-{day}",
        }
        for day in range(10)
    ]
    await _seed_stage_with_content(db_session, stage_number=2, content_items=content_items)
    anchor = datetime.now(UTC) - timedelta(days=25)
    db_session.add(
        StageProgress(
            user_id=user_id,
            current_stage=1,
            completed_stages=[],
            stage_started_at=anchor,
            program_started_at=anchor,
        )
    )
    await db_session.commit()

    resp = await async_client.get("/course/stages/2/content", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert len(data) == len(content_items)
    unlocked = [d for d in data if not d["is_locked"]]
    expected_unlocked = 3
    assert len(unlocked) == expected_unlocked
    # The unlocked ones are the earliest ordinals and carry a usable URL.
    assert [d["title"] for d in unlocked] == ["Chapter 0", "Chapter 1", "Chapter 2"]
    assert all(d["url"] is not None for d in unlocked)


# ── BUG-COURSE-004: next_unlock_day with negative days ─────────────────


@pytest.mark.asyncio
async def test_course_progress_fresh_user_reports_next_unlock(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-COURSE-004: a fresh user's progress reports a real next unlock, not -1.

    First course access provisions a ``current_stage=1`` row (day-in-stage
    1), so the stage-1 progress endpoint reports the proportional next
    unlock (day 8 for the second of three chapters) instead of feeding a
    negative day count into the drip math.
    """
    headers, _user_id = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1)

    resp = await async_client.get("/course/stages/1/progress", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    expected_next = 8
    assert data["next_unlock_day"] == expected_next


# ── Concurrency: BUG-COURSE-002 mark-read TOCTOU ──────────────────────


_CONCURRENT_MARK_READ_FANOUT = 5


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_mark_read_collapses_to_one_row(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Five simultaneous ``mark-read`` calls persist exactly one ``ContentCompletion``.

    Closes BUG-COURSE-002: the SELECT-then-INSERT pre-check let two
    concurrent calls both pass the existence check before either
    committed; the new ``uq_contentcompletion_user_content`` constraint
    plus the ``IntegrityError`` rollback collapses the race.  Every
    response must carry the same ``id`` (the winner's row) so callers
    can rely on the response shape regardless of which request actually
    inserted.

    Stage 1 is intentionally seeded without a ``StageProgress`` row for
    the user: ``is_stage_unlocked`` treats stage 1 as universally
    accessible (always-unlocked root, see ``domain.stage_progress``),
    so ``_resolve_unlocked_content`` clears the BUG-COURSE-004 mask and
    the race is actually exercised.  If that root invariant ever
    changes this test will start returning 404s instead of 200s and the
    assertion will surface the regression immediately.
    """
    signup_resp = await concurrent_async_client.post(
        "/auth/signup",
        json={
            "email": "raceread@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    headers = {"Authorization": f"Bearer {signup_resp.json()['token']}"}

    async with concurrent_session_factory() as session:
        stage = CourseStage(**_stage_data(stage_number=1))
        session.add(stage)
        await session.flush()
        item = StageContent(
            course_stage_id=stage.id,
            title="Day 1",
            content_type="essay",
            release_day=0,
            url="https://cms.example.com/s1-day1",
        )
        session.add(item)
        await session.commit()
        await session.refresh(item)
        content_id = item.id

    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(
                f"/course/content/{content_id}/mark-read",
                headers=headers,
            )
            for _ in range(_CONCURRENT_MARK_READ_FANOUT)
        ]
    )

    assert all(r.status_code == HTTPStatus.OK for r in responses)
    completion_ids = {r.json()["id"] for r in responses}
    assert len(completion_ids) == 1, f"every response must surface the same row: {completion_ids}"

    async with concurrent_session_factory() as session:
        result = await session.execute(
            select(ContentCompletion).where(ContentCompletion.content_id == content_id)
        )
        rows = list(result.scalars().all())
    assert len(rows) == 1


_CONCURRENT_COURSE_ACCESS_FANOUT = 5


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_first_course_access_yields_one_progress_row(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Concurrent first reads provision exactly one StageProgress row.

    First-access provisioning does a SELECT-then-INSERT; without the
    SAVEPOINT + IntegrityError re-fetch, two simultaneous content reads
    could both observe "no row" and both insert, tripping the
    ``user_id`` unique constraint.  Every request must still succeed and
    the user must end with exactly one ``current_stage=1`` row.
    """
    signup_resp = await concurrent_async_client.post(
        "/auth/signup",
        json={
            "email": "racecourse@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    headers = {"Authorization": f"Bearer {signup_resp.json()['token']}"}
    user_id = signup_resp.json()["user_id"]

    async with concurrent_session_factory() as session:
        stage = CourseStage(**_stage_data(stage_number=1))
        session.add(stage)
        await session.flush()
        session.add(
            StageContent(
                course_stage_id=stage.id,
                title="Day 1",
                content_type="essay",
                release_day=0,
                url="https://cms.example.com/s1-day1",
            )
        )
        await session.commit()

    responses = await asyncio.gather(
        *[
            concurrent_async_client.get("/course/stages/1/content", headers=headers)
            for _ in range(_CONCURRENT_COURSE_ACCESS_FANOUT)
        ]
    )

    assert all(r.status_code == HTTPStatus.OK for r in responses)
    async with concurrent_session_factory() as session:
        result = await session.execute(
            select(StageProgress).where(StageProgress.user_id == user_id)
        )
        rows = list(result.scalars().all())
    assert len(rows) == 1
    assert rows[0].current_stage == 1


@pytest.mark.asyncio
async def test_progress_endpoint_rejects_locked_stage(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """``/course/stages/{n}/progress`` must 403 on a locked stage."""
    headers, _ = await _signup(async_client, "locked_progress")
    await _seed_stage_with_content(db_session, stage_number=2)
    resp = await async_client.get("/course/stages/2/progress", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "stage_locked"


def test_compute_days_elapsed_logs_on_future_timestamp(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A future ``stage_started_at`` clamps to 0 and emits a WARNING."""
    future = datetime.now(UTC) + timedelta(hours=2)
    with caplog.at_level(logging.WARNING, logger="domain.course"):
        days = compute_days_elapsed(future)
    assert days == 0
    smell_logs = [r for r in caplog.records if r.message == "stage_started_at_in_future"]
    assert smell_logs, "expected a stage_started_at_in_future warning"
