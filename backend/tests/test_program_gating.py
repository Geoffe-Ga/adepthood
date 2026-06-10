"""Gating reconciliation tests for the program-start anchor (issue #386).

The calendar can OPEN weeks and stages the user hasn't manually advanced
to, but never beyond the schedule — and advancement-derived access is
never revoked.  ``max(advancement, calendar)`` on both gates.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from domain.stage_progress import is_stage_unlocked
from models.stage_progress import StageProgress
from models.user import User


async def _signup(client: AsyncClient, username: str = "anchored") -> dict[str, str]:
    """Create a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _plant_progress(
    session: AsyncSession, *, days_into_program: int, current_stage: int = 1
) -> StageProgress:
    """Create a StageProgress row anchored ``days_into_program`` days ago."""
    user = (await session.execute(select(User))).scalars().first()
    assert user is not None
    assert user.id is not None
    anchor = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=days_into_program)
    progress = StageProgress(
        user_id=user.id,
        current_stage=current_stage,
        completed_stages=[],
        stage_started_at=anchor,
        program_started_at=anchor,
    )
    session.add(progress)
    await session.commit()
    await session.refresh(progress)
    return progress


# ── Week gate (prompts) ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_calendar_opens_weeks_without_prompt_completions(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Eight days in with zero responses, week 2 is readable (was 403)."""
    headers = await _signup(async_client)
    await _plant_progress(db_session, days_into_program=8)

    week2 = await async_client.get("/prompts/2", headers=headers)
    assert week2.status_code == HTTPStatus.OK

    # The calendar says week 2 — week 3 stays locked: no skip-ahead.
    week3 = await async_client.get("/prompts/3", headers=headers)
    assert week3.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_completion_derived_week_still_governs_without_anchor_lead(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Day 0 of the program: only week 1 is open — the old contract holds."""
    headers = await _signup(async_client)
    await _plant_progress(db_session, days_into_program=0)

    week1 = await async_client.get("/prompts/1", headers=headers)
    assert week1.status_code == HTTPStatus.OK
    week2 = await async_client.get("/prompts/2", headers=headers)
    assert week2.status_code == HTTPStatus.FORBIDDEN


# ── Stage gate (domain) ─────────────────────────────────────────────────


def _progress_at(days: int, current_stage: int = 1) -> StageProgress:
    anchor = datetime.now(UTC) - timedelta(days=days)
    return StageProgress(
        user_id=1,
        current_stage=current_stage,
        completed_stages=[],
        stage_started_at=anchor,
        program_started_at=anchor,
    )


def test_calendar_unlocks_stage_without_advancement() -> None:
    """22 days in, stage 2 opens by time alone; stage 3 stays locked."""
    progress = _progress_at(22, current_stage=1)
    assert is_stage_unlocked(2, progress) is True
    assert is_stage_unlocked(3, progress) is False


def test_advancement_unlock_is_never_revoked_by_the_calendar() -> None:
    """A user who advanced to stage 4 on day 1 keeps every unlocked stage."""
    progress = _progress_at(1, current_stage=4)
    for stage in (1, 2, 3, 4):
        assert is_stage_unlocked(stage, progress) is True
    assert is_stage_unlocked(5, progress) is False


def test_missing_progress_still_locks_everything_past_stage_one() -> None:
    assert is_stage_unlocked(1, None) is True
    assert is_stage_unlocked(2, None) is False


# ── Anchor exposure ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_program_calendar_endpoint_exposes_anchor_and_derivations(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await _signup(async_client, "calendarreader")
    await _plant_progress(db_session, days_into_program=22, current_stage=1)

    resp = await async_client.get("/stages/program-calendar", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["program_started_at"] is not None
    assert body["calendar_stage"] == 2
    assert body["calendar_week"] == 4
    assert body["current_stage"] == 1


@pytest.mark.asyncio
async def test_program_calendar_endpoint_day_zero_shape_without_progress(
    async_client: AsyncClient,
) -> None:
    headers = await _signup(async_client, "freshcalendar")

    resp = await async_client.get("/stages/program-calendar", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["program_started_at"] is None
    assert body["calendar_stage"] == 1
    assert body["calendar_week"] == 1
    assert body["current_stage"] == 1


def test_is_stage_unlocked_accepts_an_explicit_now() -> None:
    """PR #432 review: deterministic clock injection, matching the calendar API."""
    progress = _progress_at(0, current_stage=1)
    later = datetime.now(UTC) + timedelta(days=22)
    assert is_stage_unlocked(2, progress, now=later) is True
    assert is_stage_unlocked(3, progress, now=later) is False
