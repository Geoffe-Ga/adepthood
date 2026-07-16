"""Tests for the ownership-aware practice-selection gate on POST /user-practices/.

Covers three scenarios around the fix that adds an ownership carve-out to
the unapproved-practice rejection:

1. An author CAN select their own unapproved draft (RED — returns 400 today).
2. A non-owner CANNOT select another user's unapproved draft (regression-guard).
3. Any user CAN select an approved catalog practice (regression-guard for
   the approved-normal path; see also test_select_practice in
   test_user_practices_api.py which covers this with full assertions — we
   keep this one for co-location and do not duplicate the heavy assertions).

The read-path IDOR test (test_idor_practice_unapproved_returns_403 in
tests/security/test_idor.py) guards GET /practices/{id} and is intentionally
NOT modified here — it exercises a separate code path (require_visible_practice
in dependencies/ownership.py) that this fix does not touch.
"""

from __future__ import annotations

from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.practice import Practice
from models.stage_progress import StageProgress
from models.user_practice import UserPractice

_PRACTICE_MODE_CONFIG: dict[str, object] = {
    "mode": "meditation_timer",
    "duration_minutes": 10,
    "start_bell": True,
    "halfway_bell": False,
    "end_bell": True,
}

_PRACTICE_BASE: dict[str, object] = {
    "stage_number": 1,
    "name": "Quiet Breath",
    "description": "Sit quietly",
    "instructions": "Close your eyes and breathe",
    "default_duration_minutes": 10,
    "mode": "meditation_timer",
    "mode_config": _PRACTICE_MODE_CONFIG,
}


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a user and return (auth headers, user_id)."""
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


async def _unlock_stage(db_session: AsyncSession, user_id: int, stage: int = 1) -> None:
    """Ensure the user has a StageProgress row that unlocks the given stage.

    Stage 1 is always unlocked for a user who has any StageProgress row
    with current_stage >= 1.  For stage N > 1 the completed_stages list
    must contain all prior stages.  Mirrors the unlock seeding used in
    tests/security/test_idor.py::_create_user_practice.
    """
    completed = list(range(1, stage))
    db_session.add(
        StageProgress(
            user_id=user_id,
            current_stage=stage,
            completed_stages=completed,
            stage_started_at=datetime.now(UTC),
        )
    )
    await db_session.commit()


async def _seed_unapproved_draft(
    db_session: AsyncSession,
    submitted_by_user_id: int,
    stage_number: int = 1,
) -> Practice:
    """Insert an unapproved practice owned by submitted_by_user_id."""
    practice = Practice(
        **{
            **_PRACTICE_BASE,
            "stage_number": stage_number,
            "name": f"Draft by {submitted_by_user_id}",
            "approved": False,
            "submitted_by_user_id": submitted_by_user_id,
        }
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    return practice


async def _seed_approved_practice(
    db_session: AsyncSession,
    stage_number: int = 1,
) -> Practice:
    """Insert an approved catalog practice (no owner)."""
    practice = Practice(
        **{
            **_PRACTICE_BASE,
            "stage_number": stage_number,
            "name": "Approved Catalog Sit",
            "approved": True,
            "submitted_by_user_id": None,
        }
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    return practice


# ---------------------------------------------------------------------------
# Test 1 — RED: owner can select their own unapproved draft
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_owner_can_select_own_unapproved_practice(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Author selecting their own unapproved draft must return 201.

    Today this returns 400 practice_not_approved because the selection path
    rejects any unapproved row without an ownership check.  After the fix a
    new resolver (_resolve_selectable_practice) allows the row when
    practice.submitted_by_user_id == current_user.

    RED: fails with 400 until the implementation is updated.
    """
    alice_headers, alice_id = await _signup(async_client, "alice_owner_select")
    draft = await _seed_unapproved_draft(db_session, submitted_by_user_id=alice_id, stage_number=1)
    await _unlock_stage(db_session, alice_id, stage=1)

    resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": draft.id, "stage_number": 1},
        headers=alice_headers,
    )

    # Must succeed — the author is allowed to activate their own draft.
    assert resp.status_code == HTTPStatus.CREATED, (
        f"Expected 201 for owner selecting own draft, got {resp.status_code}: {resp.text}"
    )
    body = resp.json()
    assert body["practice_id"] == draft.id
    assert body["stage_number"] == 1
    assert body["end_date"] is None

    # Confirm the UserPractice row exists in the DB for alice + this draft.
    result = await db_session.execute(
        select(UserPractice).where(
            UserPractice.user_id == alice_id,
            UserPractice.practice_id == draft.id,
            col(UserPractice.end_date).is_(None),
        )
    )
    row = result.scalars().first()
    assert row is not None, "Expected an open UserPractice row for Alice's own draft"


# ---------------------------------------------------------------------------
# Test 2 — regression-guard: non-owner cannot select another user's draft
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_non_owner_cannot_select_others_unapproved_practice(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A user who does not own the draft still receives 400 practice_not_approved.

    This is the existing rejection behaviour for non-owners and must stay
    green after the ownership carve-out is introduced.

    regression-guard: must remain green before and after the fix.
    """
    _alice_headers, alice_id = await _signup(async_client, "alice_draft_owner")
    bob_headers, bob_id = await _signup(async_client, "bob_non_owner")

    draft = await _seed_unapproved_draft(db_session, submitted_by_user_id=alice_id, stage_number=1)
    # Bob needs stage 1 unlocked so the stage-lock gate does not fire first.
    await _unlock_stage(db_session, bob_id, stage=1)

    resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": draft.id, "stage_number": 1},
        headers=bob_headers,
    )

    assert resp.status_code == HTTPStatus.BAD_REQUEST, (
        f"Expected 400 for non-owner selecting someone else's draft, "
        f"got {resp.status_code}: {resp.text}"
    )
    assert resp.json()["detail"] == "practice_not_approved"


# ---------------------------------------------------------------------------
# Test 3 — regression-guard: approved catalog practice still returns 201
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_owner_can_select_approved_catalog_practice(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Selecting an approved practice must return 201 after the ownership fix.

    The ownership carve-out must not break the existing approved-practice path.
    A similar happy-path test exists in test_user_practices_api.py::test_select_practice;
    this copy lives here for co-location with the ownership-boundary tests.

    regression-guard: must remain green before and after the fix.
    """
    headers, user_id = await _signup(async_client, "carol_approved_select")
    practice = await _seed_approved_practice(db_session, stage_number=1)
    await _unlock_stage(db_session, user_id, stage=1)

    resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.CREATED, (
        f"Expected 201 for selecting approved practice, got {resp.status_code}: {resp.text}"
    )
    assert resp.json()["practice_id"] == practice.id


# ---------------------------------------------------------------------------
# Sentinel: test_idor_practice_unapproved_returns_403 in
# tests/security/test_idor.py is NOT modified by this fix.  It guards
# GET /practices/{id} via require_visible_practice (read path) which is
# unchanged — Bob cannot read Alice's draft regardless of this fix.
# ---------------------------------------------------------------------------
