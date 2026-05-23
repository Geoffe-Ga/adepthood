"""Tests for the practices API — listing, fetching, and user submission."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice import Practice

_APPROVED_STAGE_1_COUNT = 2


async def _signup(
    client: AsyncClient, username: str = "practitioner"
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


def _timer_cfg(duration_minutes: float) -> dict[str, object]:
    """Build a minimal meditation-timer config payload for fixtures."""
    return {
        "mode": "meditation_timer",
        "duration_minutes": duration_minutes,
        "start_bell": True,
        "halfway_bell": False,
        "end_bell": True,
    }


async def _seed_practices(db_session: AsyncSession) -> list[Practice]:
    """Insert a set of approved and unapproved practices."""
    practices = [
        Practice(
            stage_number=1,
            name="Meditation",
            description="Sit quietly",
            instructions="Close your eyes and breathe",
            default_duration_minutes=10,
            approved=True,
            mode="meditation_timer",
            mode_config=_timer_cfg(10),
        ),
        Practice(
            stage_number=1,
            name="Journaling",
            description="Write reflections",
            instructions="Write for 10 minutes",
            default_duration_minutes=10,
            approved=True,
            mode="meditation_timer",
            mode_config=_timer_cfg(10),
        ),
        Practice(
            stage_number=2,
            name="Yoga",
            description="Move mindfully",
            instructions="Follow a yoga sequence",
            default_duration_minutes=20,
            approved=True,
            mode="meditation_timer",
            mode_config=_timer_cfg(20),
        ),
        Practice(
            stage_number=1,
            name="Pending Practice",
            description="Awaiting approval",
            instructions="TBD",
            default_duration_minutes=5,
            submitted_by_user_id=1,
            approved=False,
            mode="meditation_timer",
            mode_config=_timer_cfg(5),
        ),
    ]
    for p in practices:
        db_session.add(p)
    await db_session.commit()
    for p in practices:
        await db_session.refresh(p)
    return practices


# -- Auth required ----------------------------------------------------------


@pytest.mark.asyncio
async def test_list_practices_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/practices/", params={"stage_number": 1})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_get_practice_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/practices/1")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# -- List practices ---------------------------------------------------------


@pytest.mark.asyncio
async def test_list_practices_by_stage(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers, _ = await _signup(async_client)
    await _seed_practices(db_session)

    resp = await async_client.get("/practices/", params={"stage_number": 1}, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    # Should return only approved stage-1 practices (Meditation, Journaling)
    assert len(data) == _APPROVED_STAGE_1_COUNT
    names = {p["name"] for p in data}
    assert names == {"Meditation", "Journaling"}


@pytest.mark.asyncio
async def test_list_practices_excludes_unapproved(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _ = await _signup(async_client)
    await _seed_practices(db_session)

    resp = await async_client.get("/practices/", params={"stage_number": 1}, headers=headers)
    names = {p["name"] for p in resp.json()}
    assert "Pending Practice" not in names


@pytest.mark.asyncio
async def test_list_practices_include_mine_returns_own_drafts(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """custom-practices-07: ``?include_mine=true`` adds the caller's drafts."""
    # Sign up two distinct users; only the caller's drafts should appear.
    _other_headers, other_user_id = await _signup(async_client, username="other")
    headers, user_id = await _signup(async_client, username="me")
    assert user_id != other_user_id
    own_draft = Practice(
        stage_number=1,
        name="My private draft",
        description="",
        instructions="",
        default_duration_minutes=5,
        submitted_by_user_id=user_id,
        approved=False,
        mode="meditation_timer",
        mode_config=_timer_cfg(5),
    )
    other_draft = Practice(
        stage_number=1,
        name="Other user's draft",
        description="",
        instructions="",
        default_duration_minutes=5,
        submitted_by_user_id=other_user_id,
        approved=False,
        mode="meditation_timer",
        mode_config=_timer_cfg(5),
    )
    db_session.add(own_draft)
    db_session.add(other_draft)
    await db_session.commit()

    resp = await async_client.get(
        "/practices/",
        params={"stage_number": 1, "include_mine": "true"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    names = {p["name"] for p in resp.json()}
    assert "My private draft" in names
    assert "Other user's draft" not in names


@pytest.mark.asyncio
async def test_list_practices_default_still_excludes_own_drafts(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Without ``include_mine`` the legacy approved-only behaviour holds."""
    headers, user_id = await _signup(async_client)
    db_session.add(
        Practice(
            stage_number=1,
            name="My private draft",
            description="",
            instructions="",
            default_duration_minutes=5,
            submitted_by_user_id=user_id,
            approved=False,
            mode="meditation_timer",
            mode_config=_timer_cfg(5),
        ),
    )
    await db_session.commit()

    resp = await async_client.get("/practices/", params={"stage_number": 1}, headers=headers)
    names = {p["name"] for p in resp.json()}
    assert "My private draft" not in names


@pytest.mark.asyncio
async def test_list_practices_empty_stage(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _ = await _signup(async_client)
    await _seed_practices(db_session)

    resp = await async_client.get("/practices/", params={"stage_number": 99}, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == []


# -- Get single practice ----------------------------------------------------


@pytest.mark.asyncio
async def test_get_practice(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers, _ = await _signup(async_client)
    practices = await _seed_practices(db_session)
    target = practices[0]

    resp = await async_client.get(f"/practices/{target.id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["name"] == "Meditation"
    assert data["instructions"] == "Close your eyes and breathe"


@pytest.mark.asyncio
async def test_get_practice_not_found(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.get("/practices/999", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# -- Submit practice --------------------------------------------------------


@pytest.mark.asyncio
async def test_submit_practice(async_client: AsyncClient) -> None:
    headers, _user_id = await _signup(async_client)
    payload = {
        "stage_number": 1,
        "name": "My Custom Practice",
        "description": "Something personal",
        "instructions": "Do this then that",
        "default_duration_minutes": 15,
    }
    resp = await async_client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert data["name"] == "My Custom Practice"
    # BUG-PRACTICE-001 / BUG-SCHEMA-010: catalog responses must not leak the
    # submitter's user id.  Server-side ownership lives on the row.
    assert "submitted_by_user_id" not in data
    assert data["approved"] is False
    # ritual-01: omitting mode + mode_config defaults to a meditation timer
    # derived from default_duration_minutes.
    assert data["mode"] == "meditation_timer"
    assert data["mode_config"]["duration_minutes"] == 15
    assert data["mode_config"]["mode"] == "meditation_timer"


@pytest.mark.asyncio
async def test_submit_practice_with_metronome_mode(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """ritual-01: clients can ship a non-default mode with a matching config."""
    headers, _ = await _signup(async_client)
    payload = {
        "stage_number": 6,
        "name": "Shadow drum",
        "description": "Metronome-led shadow practice",
        "instructions": "Sit with what arises in time with the click",
        "default_duration_minutes": 30,
        "mode": "metronome",
        "mode_config": {
            "mode": "metronome",
            "bpm": 60,
            "timer": {
                "mode": "meditation_timer",
                "duration_minutes": 30,
                "halfway_bell": True,
            },
        },
    }
    resp = await async_client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert data["mode"] == "metronome"
    assert data["mode_config"]["bpm"] == 60
    assert data["mode_config"]["timer"]["duration_minutes"] == 30

    # The ORM round-trip keeps the JSON intact.
    persisted = await db_session.get(Practice, data["id"])
    assert persisted is not None
    assert persisted.mode == "metronome"
    assert persisted.mode_config["bpm"] == 60


@pytest.mark.asyncio
async def test_submit_practice_rejects_mode_without_config(async_client: AsyncClient) -> None:
    """Non-default modes must include a mode_config; 422 otherwise."""
    headers, _ = await _signup(async_client)
    payload = {
        "stage_number": 2,
        "name": "Tarot",
        "description": "Card meditation",
        "instructions": "Sit with the card",
        "default_duration_minutes": 5,
        "mode": "tarot",
    }
    resp = await async_client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_submit_practice_rejects_unknown_mode_with_clear_error(
    async_client: AsyncClient,
) -> None:
    """Unknown ``mode`` surfaces an enum error, not the wrong branch.

    Regression for the misleading "mode_config is required" path: typing
    ``mode`` as ``PracticeMode`` makes Pydantic reject ``"telepathy"`` at
    field validation time, before the mode-config check runs.
    """
    headers, _ = await _signup(async_client)
    payload = {
        "stage_number": 1,
        "name": "Telepathy",
        "description": "x",
        "instructions": "x",
        "default_duration_minutes": 10,
        "mode": "telepathy",
    }
    resp = await async_client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    body = resp.json()
    # Pydantic emits an enum-validation error whose ``input`` is the bad
    # value; the misleading "mode_config is required" message must not
    # appear.
    raw = repr(body)
    assert "telepathy" in raw
    assert "mode_config is required" not in raw


@pytest.mark.asyncio
async def test_submit_practice_rejects_mode_mismatch(async_client: AsyncClient) -> None:
    """The mode_config discriminator must match the parent mode field."""
    headers, _ = await _signup(async_client)
    payload = {
        "stage_number": 1,
        "name": "Mismatched",
        "description": "x",
        "instructions": "x",
        "default_duration_minutes": 10,
        "mode": "meditation_timer",
        "mode_config": {"mode": "count_up"},
    }
    resp = await async_client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_submit_practice_rejects_invalid_mode_config(async_client: AsyncClient) -> None:
    """Mode-specific range checks (e.g. BPM bounds) surface as 422."""
    headers, _ = await _signup(async_client)
    payload = {
        "stage_number": 6,
        "name": "Bad metronome",
        "description": "x",
        "instructions": "x",
        "default_duration_minutes": 30,
        "mode": "metronome",
        "mode_config": {
            "mode": "metronome",
            "bpm": 9001,  # out of [20, 240]
            "timer": {"mode": "meditation_timer", "duration_minutes": 30},
        },
    }
    resp = await async_client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_submitted_practice_not_in_listings(
    async_client: AsyncClient,
) -> None:
    headers, _ = await _signup(async_client)
    payload = {
        "stage_number": 1,
        "name": "My Custom Practice",
        "description": "Something personal",
        "instructions": "Do this then that",
        "default_duration_minutes": 15,
    }
    await async_client.post("/practices/", json=payload, headers=headers)

    resp = await async_client.get("/practices/", params={"stage_number": 1}, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert len(resp.json()) == 0


@pytest.mark.asyncio
async def test_submit_practice_ignores_smuggled_server_fields(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-PRACTICE-002: extra fields on the body never set ORM columns.

    A future addition to ``PracticeCreate`` overlapping a server-controlled
    column (``approved``, ``submitted_by_user_id``) would otherwise flow
    through ``model_dump()`` and let a client mint pre-approved rows.  The
    explicit-kwargs construction in the router pins the whitelist.  Pydantic
    silently drops unknown keys today, so the canonical regression is to
    confirm the persisted row reflects server defaults regardless of body
    keys.
    """
    headers, user_id = await _signup(async_client, username="smuggler")
    payload = {
        "stage_number": 1,
        "name": "Smuggled Practice",
        "description": "Trying to mint approval",
        "instructions": "Should not bypass moderation",
        "default_duration_minutes": 15,
        # Extra keys a future schema might honour — must be ignored today.
        "approved": True,
        "submitted_by_user_id": 999,
    }
    resp = await async_client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    practice_id = resp.json()["id"]

    persisted = await db_session.get(Practice, practice_id)
    assert persisted is not None
    assert persisted.approved is False
    assert persisted.submitted_by_user_id == user_id


# -- Rate-limit key (BUG-PRACTICE-003) -------------------------------------


@pytest.mark.asyncio
async def test_rate_limit_key_survives_token_refresh(async_client: AsyncClient) -> None:
    """The rate-limit bucket must follow the user, not the JWT.

    Hashing the bearer token reset the rate-limit budget on every
    re-authentication; keying on the JWT ``sub`` (the stable user id)
    so a logout / login cycle inside the limiter window does not give
    the user a fresh budget.

    We log in twice as the same user, drive both tokens to the
    ``5/minute`` cap, and assert the second token sees a 429 without
    needing to wait for the limiter window to roll over.  Re-using
    ``submit_practice`` (the rate-limited endpoint) confirms the
    end-to-end wiring rather than poking the helper in isolation.

    The autouse ``_reset_rate_limiter`` fixture in ``conftest.py`` already
    forces ``limiter.enabled = True`` and clears storage on entry/exit,
    so we do not need to manage limiter state manually here.
    """
    email = "rl_refresh@example.com"
    password = "securepassword123"  # pragma: allowlist secret
    signup = await async_client.post("/auth/signup", json={"email": email, "password": password})
    assert signup.status_code == HTTPStatus.OK
    first_token = signup.json()["token"]

    # Re-login mints a fresh token with a different ``jti`` for the same user.
    login = await async_client.post("/auth/login", json={"email": email, "password": password})
    assert login.status_code == HTTPStatus.OK
    second_token = login.json()["token"]
    assert first_token != second_token, "test premise: re-login mints distinct tokens"

    payload = {
        "stage_number": 1,
        "name": "RL probe",
        "description": "rate limit probe",
        "instructions": "n/a",
        "default_duration_minutes": 1,
    }

    # Drive the first token to the 5/minute cap.
    rate_cap = 5
    for i in range(rate_cap):
        resp = await async_client.post(
            "/practices/",
            json={**payload, "name": f"RL probe {i}"},
            headers={"Authorization": f"Bearer {first_token}"},
        )
        assert resp.status_code == HTTPStatus.CREATED

    # Token-hash keying would give the second token its own bucket and
    # the next request would succeed; user-id keying refuses it.
    resp = await async_client.post(
        "/practices/",
        json={**payload, "name": "RL probe overflow"},
        headers={"Authorization": f"Bearer {second_token}"},
    )
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
