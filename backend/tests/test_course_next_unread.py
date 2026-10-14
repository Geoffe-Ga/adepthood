"""Tests for ``GET /course/next-unread`` — the "Read next" target (issue #3147).

The endpoint answers one question for the caller: which chapter, across every
stage the drip has opened, is the earliest one they have not read yet? Ordering
is stage first, then ``release_day``, then ``id`` — the same release order the
per-stage listing uses — and a locked stage never contributes a chapter.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.stage_content import StageContent
from models.stage_progress import StageProgress
from tests.test_course_api import _seed_stage_with_content, _set_user_stage, _signup

_ENDPOINT = "/course/next-unread"
_PURPLE = 2


def _chapters(stage: str, release_days: list[int]) -> list[dict[str, object]]:
    """Content rows for a stage, one per ``release_days`` entry, in that insert order."""
    return [
        {
            "title": f"{stage} chapter day {day}",
            "content_type": "essay",
            "release_day": day,
            "url": f"content://{stage}-{day}",
        }
        for day in release_days
    ]


def _expected(item: StageContent, stage_number: int) -> dict[str, object]:
    """The wire shape the endpoint returns for ``item``."""
    return {"content_id": item.id, "stage_number": stage_number, "title": item.title}


async def _mark_read(client: AsyncClient, headers: dict[str, str], item: StageContent) -> None:
    """Mark ``item`` read through the real endpoint."""
    response = await client.post(f"/course/content/{item.id}/mark-read", headers=headers)
    assert response.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_next_unread_requires_auth(async_client: AsyncClient) -> None:
    """No token, no reading position."""
    response = await async_client.get(_ENDPOINT)
    assert response.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_fresh_user_gets_first_beige_chapter(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A brand-new reader is pointed at Beige's first chapter."""
    headers, _ = await _signup(async_client)
    _, beige = await _seed_stage_with_content(db_session, stage_number=1)
    await _seed_stage_with_content(db_session, stage_number=_PURPLE)

    response = await async_client.get(_ENDPOINT, headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json() == _expected(beige[0], 1)


@pytest.mark.asyncio
async def test_all_of_beige_read_points_at_first_unlocked_purple_chapter(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """With every Beige chapter read, the target moves to Purple's first open chapter."""
    headers, user_id = await _signup(async_client)
    _, beige = await _seed_stage_with_content(db_session, stage_number=1)
    _, purple = await _seed_stage_with_content(db_session, stage_number=_PURPLE)
    await _set_user_stage(db_session, user_id, stage_number=_PURPLE)
    for item in beige:
        await _mark_read(async_client, headers, item)

    response = await async_client.get(_ENDPOINT, headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json() == _expected(purple[0], _PURPLE)


@pytest.mark.asyncio
async def test_orders_by_release_day_not_insert_order(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Release order decides which chapter is next, never the row's insert order."""
    headers, user_id = await _signup(async_client)
    _, beige = await _seed_stage_with_content(
        db_session, stage_number=1, content_items=_chapters("beige", [5, 2, 0])
    )
    await _set_user_stage(db_session, user_id, stage_number=_PURPLE)
    day_zero, day_two, day_five = beige[2], beige[1], beige[0]

    await _mark_read(async_client, headers, day_zero)
    response = await async_client.get(_ENDPOINT, headers=headers)
    assert response.json() == _expected(day_two, 1)

    await _mark_read(async_client, headers, day_two)
    response = await async_client.get(_ENDPOINT, headers=headers)
    assert response.json() == _expected(day_five, 1)


@pytest.mark.asyncio
async def test_everything_unlocked_read_returns_null(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Drip-locked chapters and a locked stage are not "unread" — the reader is caught up."""
    headers, _ = await _signup(async_client)
    _, beige = await _seed_stage_with_content(db_session, stage_number=1)
    await _seed_stage_with_content(db_session, stage_number=_PURPLE)
    await _mark_read(async_client, headers, beige[0])

    response = await async_client.get(_ENDPOINT, headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json() is None


@pytest.mark.asyncio
async def test_locked_stage_chapters_are_never_returned(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An empty open stage does not make the endpoint reach into a locked one."""
    headers, _ = await _signup(async_client)
    await _seed_stage_with_content(db_session, stage_number=1, content_items=[])
    await _seed_stage_with_content(db_session, stage_number=_PURPLE)

    response = await async_client.get(_ENDPOINT, headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json() is None


@pytest.mark.asyncio
async def test_calendar_opened_stage_counts_without_advancing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A stage the program calendar opened is eligible even before the record advances."""
    headers, user_id = await _signup(async_client)
    calendar_days_into_purple = 25
    anchor = datetime.now(UTC) - timedelta(days=calendar_days_into_purple)
    _, purple = await _seed_stage_with_content(db_session, stage_number=_PURPLE)
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

    response = await async_client.get(_ENDPOINT, headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json() == _expected(purple[0], _PURPLE)


@pytest.mark.asyncio
async def test_next_unread_is_isolated_per_user(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One reader's completions never move another reader's target."""
    alice, alice_id = await _signup(async_client, "alice")
    bob, _ = await _signup(async_client, "bob")
    _, beige = await _seed_stage_with_content(db_session, stage_number=1)
    await _set_user_stage(db_session, alice_id, stage_number=_PURPLE)

    await _mark_read(async_client, alice, beige[0])

    alice_response = await async_client.get(_ENDPOINT, headers=alice)
    bob_response = await async_client.get(_ENDPOINT, headers=bob)
    assert alice_response.json() == _expected(beige[1], 1)
    assert bob_response.json() == _expected(beige[0], 1)
