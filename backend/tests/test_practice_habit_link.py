"""Linking a practice to a habit: ``PATCH /user-practices/{id}/habit`` (#3151).

Each ``UserPractice`` may name one habit its sessions count toward. The link is
per practice -- a journaling practice and a metta practice can feed two habits
at once -- and it obeys the journal link's rules: the habit must be the
caller's own (404 missing, 403 another user's), it must count in a unit a timer
can measure (422 otherwise), and deleting the habit clears the link.

Cross-tenant refusals live in ``tests/security/test_idor.py``; this module pins
the owner's own round trip and the guards the link joins.
"""

from __future__ import annotations

from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.habit_links import linked_habit_ids
from models.practice import Practice
from models.stage_progress import StageProgress
from models.user_practice import UserPractice

_LINK_KEY = "habit_id"
_MISSING_ID = 999_999

_HABIT_FIELDS: dict[str, object] = {
    "icon": "🧘",
    "start_date": "2024-01-01",
    "energy_cost": 1,
    "energy_return": 2,
}

# The practice default the epic settles on: one session, four times a week.
_SESSION_GOALS: dict[str, object] = {
    "target_unit": "sessions",
    "frequency": 4,
    "frequency_unit": "per_week",
    "low": 1,
    "clear": 1,
    "stretch": 1,
}

_PRACTICE_FIELDS: dict[str, object] = {
    "stage_number": 1,
    "description": "Sit quietly",
    "instructions": "Close your eyes and breathe",
    "default_duration_minutes": 10,
    "approved": True,
    "mode": "meditation_timer",
    "mode_config": {
        "mode": "meditation_timer",
        "duration_minutes": 10,
        "start_bell": True,
        "halfway_bell": False,
        "end_bell": True,
    },
}


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create a user and return (auth headers, user_id)."""
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


async def _habit(
    client: AsyncClient, headers: dict[str, str], name: str, *, timer_goals: bool = True
) -> int:
    """Create a habit -- on session goals unless told otherwise -- and return its id."""
    payload: dict[str, object] = {"name": name, **_HABIT_FIELDS}
    if timer_goals:
        payload["goals"] = _SESSION_GOALS
    resp = await client.post("/habits/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    return int(resp.json()["id"])


async def _user_practice(
    client: AsyncClient,
    db_session: AsyncSession,
    headers: dict[str, str],
    user_id: int,
    *,
    stage_number: int = 1,
) -> int:
    """Seed a catalog practice for ``stage_number``, select it, and return the selection id."""
    practice = Practice(
        **{**_PRACTICE_FIELDS, "stage_number": stage_number},
        name=f"Sit {user_id}-{stage_number}",
    )
    db_session.add(practice)
    progress = await db_session.execute(
        select(StageProgress).where(col(StageProgress.user_id) == user_id)
    )
    if progress.scalars().first() is None:
        db_session.add(
            StageProgress(
                user_id=user_id,
                current_stage=1,
                completed_stages=[],
                stage_started_at=datetime.now(UTC),
            )
        )
    await db_session.commit()
    await db_session.refresh(practice)
    resp = await client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": stage_number},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    return int(resp.json()["id"])


def _link_url(user_practice_id: int) -> str:
    return f"/user-practices/{user_practice_id}/habit"


async def _stored_link(db_session: AsyncSession, user_practice_id: int) -> int | None:
    """Read a selection's habit link from storage, bypassing the identity map."""
    row = await db_session.get(UserPractice, user_practice_id, populate_existing=True)
    assert row is not None
    return row.habit_id


# ---------------------------------------------------------------------------
# Link and unlink
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_link_sets_the_habit_and_echoes_it(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``{"habit_id": n}`` links the practice; the answer is the selection, carrying ``n``."""
    headers, user_id = await _signup(async_client, "link_sets")
    habit_id = await _habit(async_client, headers, "Sitting")
    user_practice_id = await _user_practice(async_client, db_session, headers, user_id)

    resp = await async_client.patch(
        _link_url(user_practice_id), json={_LINK_KEY: habit_id}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["id"] == user_practice_id
    assert body[_LINK_KEY] == habit_id
    assert body["effective_name"] == f"Sit {user_id}-1"
    assert "user_id" not in body
    assert await _stored_link(db_session, user_practice_id) == habit_id


@pytest.mark.asyncio
async def test_null_unlinks(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """``{"habit_id": null}`` clears the link and needs no habit to exist."""
    headers, user_id = await _signup(async_client, "link_clears")
    habit_id = await _habit(async_client, headers, "Sitting")
    user_practice_id = await _user_practice(async_client, db_session, headers, user_id)
    await async_client.patch(
        _link_url(user_practice_id), json={_LINK_KEY: habit_id}, headers=headers
    )

    resp = await async_client.patch(
        _link_url(user_practice_id), json={_LINK_KEY: None}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()[_LINK_KEY] is None
    assert await _stored_link(db_session, user_practice_id) is None


@pytest.mark.asyncio
async def test_the_body_must_name_the_link(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An empty body is a 422, not a silent unlink: the field is required, ``null`` included."""
    headers, user_id = await _signup(async_client, "link_required")
    user_practice_id = await _user_practice(async_client, db_session, headers, user_id)

    resp = await async_client.patch(_link_url(user_practice_id), json={}, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_two_practices_link_two_habits(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The link is per practice: two selections keep two different habits."""
    headers, user_id = await _signup(async_client, "link_two")
    sitting = await _habit(async_client, headers, "Sitting")
    metta = await _habit(async_client, headers, "Metta")
    first = await _user_practice(async_client, db_session, headers, user_id, stage_number=1)
    second = await _user_practice(async_client, db_session, headers, user_id, stage_number=2)

    for user_practice_id, habit_id in ((first, sitting), (second, metta)):
        resp = await async_client.patch(
            _link_url(user_practice_id), json={_LINK_KEY: habit_id}, headers=headers
        )
        assert resp.status_code == HTTPStatus.OK, resp.text

    assert await _stored_link(db_session, first) == sitting
    assert await _stored_link(db_session, second) == metta
    assert await linked_habit_ids(db_session, user_id) == {sitting, metta}


@pytest.mark.asyncio
async def test_link_is_read_back_on_get_and_list(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The read schemas carry ``habit_id``: ``null`` before linking, the id after."""
    headers, user_id = await _signup(async_client, "link_reads")
    habit_id = await _habit(async_client, headers, "Sitting")
    user_practice_id = await _user_practice(async_client, db_session, headers, user_id)

    before = await async_client.get(f"/user-practices/{user_practice_id}", headers=headers)
    assert before.json()[_LINK_KEY] is None

    await async_client.patch(
        _link_url(user_practice_id), json={_LINK_KEY: habit_id}, headers=headers
    )

    detail = await async_client.get(f"/user-practices/{user_practice_id}", headers=headers)
    listing = await async_client.get("/user-practices/", headers=headers)
    assert detail.json()[_LINK_KEY] == habit_id
    assert [row[_LINK_KEY] for row in listing.json()] == [habit_id]


# ---------------------------------------------------------------------------
# Refusals the owner can draw
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_habit_is_404_and_keeps_the_link(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A habit nobody owns is 404 ``habit`` and the existing link survives."""
    headers, user_id = await _signup(async_client, "link_missing")
    habit_id = await _habit(async_client, headers, "Sitting")
    user_practice_id = await _user_practice(async_client, db_session, headers, user_id)
    await async_client.patch(
        _link_url(user_practice_id), json={_LINK_KEY: habit_id}, headers=headers
    )

    resp = await async_client.patch(
        _link_url(user_practice_id), json={_LINK_KEY: _MISSING_ID}, headers=headers
    )

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "habit_not_found"
    assert await _stored_link(db_session, user_practice_id) == habit_id


@pytest.mark.asyncio
async def test_missing_user_practice_is_404(async_client: AsyncClient) -> None:
    """The path's own selection is resolved first: a missing one is 404."""
    headers, _user_id = await _signup(async_client, "link_no_practice")
    habit_id = await _habit(async_client, headers, "Sitting")

    resp = await async_client.patch(
        _link_url(_MISSING_ID), json={_LINK_KEY: habit_id}, headers=headers
    )

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "user_practice_not_found"


@pytest.mark.asyncio
async def test_habit_on_reps_is_422_and_writes_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A practice's timer counts minutes or sessions, so a reps habit cannot be linked."""
    headers, user_id = await _signup(async_client, "link_reps")
    habit_id = await _habit(async_client, headers, "Water", timer_goals=False)
    user_practice_id = await _user_practice(async_client, db_session, headers, user_id)

    resp = await async_client.patch(
        _link_url(user_practice_id), json={_LINK_KEY: habit_id}, headers=headers
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "linked_habit_unit_not_allowed"
    assert await _stored_link(db_session, user_practice_id) is None


# ---------------------------------------------------------------------------
# The link joins every existing guard
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_practice_linked_habit_cannot_move_off_timer_units(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``linked_habit_ids`` reports practice links, so the units editor refuses reps."""
    headers, user_id = await _signup(async_client, "link_units_guard")
    habit_id = await _habit(async_client, headers, "Sitting")
    user_practice_id = await _user_practice(async_client, db_session, headers, user_id)
    await async_client.patch(
        _link_url(user_practice_id), json={_LINK_KEY: habit_id}, headers=headers
    )

    resp = await async_client.put(
        f"/habits/{habit_id}/goals/units",
        json={"target_unit": "reps", "frequency": 1, "frequency_unit": "per_day"},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "linked_habit_unit_not_allowed"


@pytest.mark.asyncio
async def test_linked_habit_ids_is_scoped_to_the_user(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Another user's practice link is not reported as this user's."""
    headers, user_id = await _signup(async_client, "link_scope_owner")
    _other_headers, other_id = await _signup(async_client, "link_scope_other")
    habit_id = await _habit(async_client, headers, "Sitting")
    user_practice_id = await _user_practice(async_client, db_session, headers, user_id)
    await async_client.patch(
        _link_url(user_practice_id), json={_LINK_KEY: habit_id}, headers=headers
    )

    assert await linked_habit_ids(db_session, user_id) == {habit_id}
    assert await linked_habit_ids(db_session, other_id) == set()


# ---------------------------------------------------------------------------
# Deleting the habit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_deleting_the_habit_clears_the_practice_link(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``DELETE /habits/{id}`` unlinks every practice that fed it; the selection survives."""
    headers, user_id = await _signup(async_client, "link_delete")
    habit_id = await _habit(async_client, headers, "Sitting")
    kept_habit_id = await _habit(async_client, headers, "Metta")
    linked = await _user_practice(async_client, db_session, headers, user_id, stage_number=1)
    untouched = await _user_practice(async_client, db_session, headers, user_id, stage_number=2)
    await async_client.patch(_link_url(linked), json={_LINK_KEY: habit_id}, headers=headers)
    await async_client.patch(_link_url(untouched), json={_LINK_KEY: kept_habit_id}, headers=headers)

    resp = await async_client.delete(f"/habits/{habit_id}", headers=headers)

    assert resp.status_code == HTTPStatus.NO_CONTENT
    assert await _stored_link(db_session, linked) is None
    assert await _stored_link(db_session, untouched) == kept_habit_id
    detail = await async_client.get(f"/user-practices/{linked}", headers=headers)
    assert detail.status_code == HTTPStatus.OK
    assert detail.json()[_LINK_KEY] is None
