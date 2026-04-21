"""Tests for the admin ``/stage-progress`` inspect + repair endpoints.

Covers:

- the auth gate (anonymous / non-admin / admin) to prove the helper inherits
  the same per-user admin boundary as the rest of the admin surface;
- the listing endpoint's gap detector (empty, contiguous, missing-middle,
  over-credited, and both-at-once);
- the explicit repair endpoint rewriting ``completed_stages`` to the canonical
  ``{1..current_stage-1}`` set;
- the repair endpoint's 404 on unknown users so the caller cannot blindly
  loop over every integer id hoping to create a row.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.stage_progress import StageProgress
from models.user import User


async def _signup(
    client: AsyncClient, email: str = "user@example.com", password: str = "secret12345"
) -> tuple[int, dict[str, str]]:
    """Create a user and return ``(user_id, auth headers)``."""
    resp = await client.post("/auth/signup", json={"email": email, "password": password})
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return int(body["user_id"]), {"Authorization": f"Bearer {body['token']}"}


async def _promote(db_session: AsyncSession, email: str) -> None:
    """Flip ``is_admin`` for a user by email."""
    await db_session.execute(update(User).where(col(User.email) == email).values(is_admin=True))
    await db_session.commit()


async def _signup_admin(
    client: AsyncClient, db_session: AsyncSession, email: str = "admin@example.com"
) -> tuple[int, dict[str, str]]:
    """Sign up + promote a user; return ``(user_id, auth headers)``."""
    user_id, headers = await _signup(client, email=email)
    await _promote(db_session, email)
    return user_id, headers


async def _seed_progress(
    db_session: AsyncSession,
    *,
    user_id: int,
    current_stage: int,
    completed_stages: list[int],
) -> None:
    """Insert a :class:`StageProgress` row with a specific completed set."""
    db_session.add(
        StageProgress(
            user_id=user_id,
            current_stage=current_stage,
            completed_stages=completed_stages,
        )
    )
    await db_session.commit()


# ── Auth gate ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gaps_rejects_anonymous(async_client: AsyncClient) -> None:
    resp = await async_client.get("/admin/stage-progress/gaps")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_gaps_rejects_non_admin(async_client: AsyncClient) -> None:
    _uid, headers = await _signup(async_client, email="plain@example.com")
    resp = await async_client.get("/admin/stage-progress/gaps", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "admin_required"


@pytest.mark.asyncio
async def test_repair_rejects_non_admin(async_client: AsyncClient) -> None:
    target_id, _ = await _signup(async_client, email="victim@example.com")
    _uid, headers = await _signup(async_client, email="plain@example.com")
    resp = await async_client.post(f"/admin/stage-progress/{target_id}/repair", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "admin_required"


# ── Listing ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gaps_empty_when_no_progress_rows(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    _admin_id, headers = await _signup_admin(async_client, db_session)
    resp = await async_client.get("/admin/stage-progress/gaps", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body == {"rows": [], "total": 0}


@pytest.mark.asyncio
async def test_gaps_ignores_contiguous_rows(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``completed_stages == {1..current_stage-1}`` must not be flagged."""
    _admin_id, headers = await _signup_admin(async_client, db_session)
    user_id, _ = await _signup(async_client, email="good@example.com")
    await _seed_progress(db_session, user_id=user_id, current_stage=3, completed_stages=[1, 2])

    resp = await async_client.get("/admin/stage-progress/gaps", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"rows": [], "total": 0}


@pytest.mark.asyncio
async def test_gaps_flags_missing_middle(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Stage-2 missing from ``[1, 3]`` at ``current_stage=4`` must be flagged."""
    _admin_id, headers = await _signup_admin(async_client, db_session)
    user_id, _ = await _signup(async_client, email="gappy@example.com")
    await _seed_progress(db_session, user_id=user_id, current_stage=4, completed_stages=[1, 3])

    resp = await async_client.get("/admin/stage-progress/gaps", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["total"] == 1
    assert body["rows"][0] == {
        "user_id": user_id,
        "current_stage": 4,
        "completed_stages": [1, 3],
        "missing_stages": [2],
        "extra_stages": [],
    }


@pytest.mark.asyncio
async def test_gaps_flags_over_credited_future_stages(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``completed_stages=[1, 2, 5]`` at ``current_stage=3`` has 5 as an 'extra'."""
    _admin_id, headers = await _signup_admin(async_client, db_session)
    user_id, _ = await _signup(async_client, email="over@example.com")
    await _seed_progress(db_session, user_id=user_id, current_stage=3, completed_stages=[1, 2, 5])

    resp = await async_client.get("/admin/stage-progress/gaps", headers=headers)
    body = resp.json()
    assert body["total"] == 1
    assert body["rows"][0]["missing_stages"] == []
    assert body["rows"][0]["extra_stages"] == [5]


# ── Repair ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_repair_rewrites_completed_stages_to_canonical_set(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    _admin_id, headers = await _signup_admin(async_client, db_session)
    user_id, _ = await _signup(async_client, email="fix@example.com")
    await _seed_progress(db_session, user_id=user_id, current_stage=4, completed_stages=[1, 3])

    resp = await async_client.post(f"/admin/stage-progress/{user_id}/repair", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["completed_stages"] == [1, 2, 3]
    assert body["stages_added"] == [2]
    assert body["stages_removed"] == []

    # Verify the row was actually written.
    await db_session.commit()  # release any snapshot
    row = await _refetch(db_session, user_id)
    assert sorted(row.completed_stages) == [1, 2, 3]


@pytest.mark.asyncio
async def test_repair_returns_404_for_unknown_user(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    _admin_id, headers = await _signup_admin(async_client, db_session)
    resp = await async_client.post("/admin/stage-progress/99999/repair", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "stage_progress_not_found"


async def _refetch(session: AsyncSession, user_id: int) -> StageProgress:
    """Load the user's :class:`StageProgress` row fresh from the DB."""
    result = await session.execute(select(StageProgress).where(StageProgress.user_id == user_id))
    row = result.scalars().first()
    assert row is not None
    return row
