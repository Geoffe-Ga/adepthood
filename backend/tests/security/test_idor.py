"""IDOR matrix — every owned-resource endpoint returns 403, not 404, for cross-user access.

Each parametrised case exercises one HTTP method on one resource type:
Alice creates the row, Bob calls the endpoint with Alice's id.  The
endpoint MUST return 403 ``forbidden`` so the auth-failure path is
distinguishable in audit logs and so a future change cannot silently
collapse the cross-user branch back into 404.

Per the BUG-T7 remediation (prompt ``07-normalize-idor-ordering``):

- Genuinely missing rows still 404 (sibling tests in each
  ``test_<resource>_api.py``).
- Rows that exist but belong to another user 403, never 404.
- Course content is a shared catalog rather than a per-user resource;
  its enumeration oracle (BUG-COURSE-004) is closed by masking the
  locked branch as 404 instead.  That mask is asserted in
  ``test_course_api.py`` and revisited here so a regression on either
  side surfaces in the security suite.

Also asserts that no owned-resource response DTO echoes ``user_id``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.course_stage import CourseStage
from models.practice import Practice
from models.stage_content import StageContent
from models.stage_progress import StageProgress

# Severity: probe attempts use a sentinel id well above any seeded row so
# the missing-row branch is the same code path as a malicious enumeration.
_DEFINITELY_MISSING_ID = 999_999

_HABIT_PAYLOAD: dict[str, object] = {
    "name": "Drink Water",
    "icon": "💧",
    "start_date": "2024-01-01",
    "energy_cost": 1,
    "energy_return": 2,
}

_PRACTICE_DEFAULTS: dict[str, object] = {
    "stage_number": 1,
    "name": "Meditation",
    "description": "Sit quietly",
    "instructions": "Close your eyes and breathe",
    "default_duration_minutes": 10,
    "approved": True,
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


async def _seed_practice(db_session: AsyncSession, **overrides: object) -> Practice:
    """Insert a practice row directly through the ORM."""
    fields = {**_PRACTICE_DEFAULTS, **overrides}
    practice = Practice(**fields)
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    return practice


async def _create_user_practice(
    client: AsyncClient,
    db_session: AsyncSession,
    headers: dict[str, str],
    user_id: int,
) -> int:
    """Seed a practice the user owns (via UserPractice) and return its id."""
    practice = await _seed_practice(db_session)
    # Make sure the user is unlocked for stage 1 -- a fresh signup is.
    db_session.add(
        StageProgress(
            user_id=user_id,
            current_stage=1,
            completed_stages=[],
            stage_started_at=datetime.now(UTC),
        )
    )
    await db_session.commit()
    resp = await client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


async def _create_practice_session(
    client: AsyncClient,
    headers: dict[str, str],
    user_practice_id: int,
) -> int:
    """Log a practice session against the given user-practice."""
    resp = await client.post(
        "/practice-sessions/",
        json={"user_practice_id": user_practice_id, "duration_minutes": 5.0},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    return int(resp.json()["id"])


# ── Cross-user matrix: every endpoint must return 403 ─────────────────────


@pytest.mark.asyncio
async def test_idor_habit_get_returns_403(async_client: AsyncClient) -> None:
    alice_headers, _ = await _signup(async_client, "alice_h_get")
    bob_headers, _ = await _signup(async_client, "bob_h_get")

    create = await async_client.post("/habits/", json=_HABIT_PAYLOAD, headers=alice_headers)
    habit_id = create.json()["id"]

    resp = await async_client.get(f"/habits/{habit_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN, (
        "404→403 ordering regression: cross-user GET /habits/{id} must 403, not 404"
    )


@pytest.mark.asyncio
async def test_idor_habit_put_returns_403(async_client: AsyncClient) -> None:
    alice_headers, _ = await _signup(async_client, "alice_h_put")
    bob_headers, _ = await _signup(async_client, "bob_h_put")

    create = await async_client.post("/habits/", json=_HABIT_PAYLOAD, headers=alice_headers)
    habit_id = create.json()["id"]

    resp = await async_client.put(
        f"/habits/{habit_id}",
        json={**_HABIT_PAYLOAD, "name": "Hijacked"},
        headers=bob_headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_idor_habit_delete_returns_403(async_client: AsyncClient) -> None:
    alice_headers, _ = await _signup(async_client, "alice_h_del")
    bob_headers, _ = await _signup(async_client, "bob_h_del")

    create = await async_client.post("/habits/", json=_HABIT_PAYLOAD, headers=alice_headers)
    habit_id = create.json()["id"]

    resp = await async_client.delete(f"/habits/{habit_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_idor_habit_stats_returns_403(async_client: AsyncClient) -> None:
    alice_headers, _ = await _signup(async_client, "alice_stats")
    bob_headers, _ = await _signup(async_client, "bob_stats")

    create = await async_client.post("/habits/", json=_HABIT_PAYLOAD, headers=alice_headers)
    habit_id = create.json()["id"]

    resp = await async_client.get(f"/habits/{habit_id}/stats", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_idor_journal_entry_get_returns_403(async_client: AsyncClient) -> None:
    alice_headers, _ = await _signup(async_client, "alice_j_get")
    bob_headers, _ = await _signup(async_client, "bob_j_get")

    create = await async_client.post(
        "/journal/", json={"message": "private"}, headers=alice_headers
    )
    entry_id = create.json()["id"]

    resp = await async_client.get(f"/journal/{entry_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_idor_journal_entry_delete_returns_403(async_client: AsyncClient) -> None:
    alice_headers, _ = await _signup(async_client, "alice_j_del")
    bob_headers, _ = await _signup(async_client, "bob_j_del")

    create = await async_client.post(
        "/journal/", json={"message": "private"}, headers=alice_headers
    )
    entry_id = create.json()["id"]

    resp = await async_client.delete(f"/journal/{entry_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_idor_goal_group_get_returns_403(async_client: AsyncClient) -> None:
    alice_headers, _ = await _signup(async_client, "alice_gg_get")
    bob_headers, _ = await _signup(async_client, "bob_gg_get")

    create = await async_client.post(
        "/goal-groups/", json={"name": "Alice Private"}, headers=alice_headers
    )
    group_id = create.json()["id"]

    resp = await async_client.get(f"/goal-groups/{group_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_idor_goal_group_put_returns_403(async_client: AsyncClient) -> None:
    alice_headers, _ = await _signup(async_client, "alice_gg_put")
    bob_headers, _ = await _signup(async_client, "bob_gg_put")

    create = await async_client.post(
        "/goal-groups/", json={"name": "Alice Private"}, headers=alice_headers
    )
    group_id = create.json()["id"]

    resp = await async_client.put(
        f"/goal-groups/{group_id}",
        json={"name": "Hijacked"},
        headers=bob_headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_idor_goal_group_delete_returns_403(async_client: AsyncClient) -> None:
    alice_headers, _ = await _signup(async_client, "alice_gg_del")
    bob_headers, _ = await _signup(async_client, "bob_gg_del")

    create = await async_client.post(
        "/goal-groups/", json={"name": "Alice Private"}, headers=alice_headers
    )
    group_id = create.json()["id"]

    resp = await async_client.delete(f"/goal-groups/{group_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_idor_shared_template_mutation_returns_403(async_client: AsyncClient) -> None:
    """BUG-GOAL-006: shared templates have no owner -- mutation always 403.

    Alice creates a shared template (``user_id IS NULL``).  Even the
    creator cannot mutate it through the standard PUT/DELETE surface
    because ``require_owned_goal_group`` checks ``group.user_id ==
    current_user`` and ``None`` never equals an int.  An admin-only
    moderation surface will land in a separate prompt; until then,
    shared templates are read-only by design.
    """
    alice_headers, _ = await _signup(async_client, "alice_shared")

    create = await async_client.post(
        "/goal-groups/",
        json={"name": "Community", "shared_template": True, "source": "community"},
        headers=alice_headers,
    )
    assert create.status_code == HTTPStatus.CREATED
    group_id = create.json()["id"]

    put = await async_client.put(
        f"/goal-groups/{group_id}",
        json={"name": "Hijacked"},
        headers=alice_headers,
    )
    assert put.status_code == HTTPStatus.FORBIDDEN

    delete = await async_client.delete(f"/goal-groups/{group_id}", headers=alice_headers)
    assert delete.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_idor_shared_template_get_is_visible(async_client: AsyncClient) -> None:
    """Shared templates are readable by every authenticated user."""
    alice_headers, _ = await _signup(async_client, "alice_shared_get")
    bob_headers, _ = await _signup(async_client, "bob_shared_get")

    create = await async_client.post(
        "/goal-groups/",
        json={"name": "Community Yoga", "shared_template": True, "source": "community"},
        headers=alice_headers,
    )
    group_id = create.json()["id"]

    resp = await async_client.get(f"/goal-groups/{group_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["name"] == "Community Yoga"


@pytest.mark.asyncio
async def test_idor_user_practice_get_returns_403(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    alice_headers, alice_id = await _signup(async_client, "alice_up_get")
    bob_headers, _ = await _signup(async_client, "bob_up_get")

    user_practice_id = await _create_user_practice(
        async_client, db_session, alice_headers, alice_id
    )

    resp = await async_client.get(f"/user-practices/{user_practice_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_idor_practice_session_create_returns_403(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Cross-user POST /practice-sessions/ — body's user_practice_id is Alice's."""
    alice_headers, alice_id = await _signup(async_client, "alice_ps_post")
    bob_headers, _ = await _signup(async_client, "bob_ps_post")

    user_practice_id = await _create_user_practice(
        async_client, db_session, alice_headers, alice_id
    )

    resp = await async_client.post(
        "/practice-sessions/",
        json={"user_practice_id": user_practice_id, "duration_minutes": 5.0},
        headers=bob_headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_idor_practice_session_list_returns_403(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Cross-user GET /practice-sessions/?user_practice_id=... must 403."""
    alice_headers, alice_id = await _signup(async_client, "alice_ps_list")
    bob_headers, _ = await _signup(async_client, "bob_ps_list")

    user_practice_id = await _create_user_practice(
        async_client, db_session, alice_headers, alice_id
    )
    await _create_practice_session(async_client, alice_headers, user_practice_id)

    resp = await async_client.get(
        "/practice-sessions/",
        params={"user_practice_id": user_practice_id},
        headers=bob_headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_idor_practice_unapproved_returns_403(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """BUG-PRACTICE-001: Bob cannot read Alice's pending practice submission."""
    alice_headers, alice_id = await _signup(async_client, "alice_p_pending")
    bob_headers, _ = await _signup(async_client, "bob_p_pending")

    practice = await _seed_practice(
        db_session,
        name="Alice Draft",
        approved=False,
        submitted_by_user_id=alice_id,
    )

    bob_resp = await async_client.get(f"/practices/{practice.id}", headers=bob_headers)
    assert bob_resp.status_code == HTTPStatus.FORBIDDEN

    # Alice (the submitter) can still read her own draft.
    alice_resp = await async_client.get(f"/practices/{practice.id}", headers=alice_headers)
    assert alice_resp.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_idor_practice_approved_visible_to_all(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Approved catalog practices stay readable to every authenticated user."""
    _, _ = await _signup(async_client, "submitter_p_approved")
    bob_headers, _ = await _signup(async_client, "reader_p_approved")

    practice = await _seed_practice(db_session, name="Public", approved=True)

    resp = await async_client.get(f"/practices/{practice.id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.OK


# ── Genuinely-missing rows still 404 ──────────────────────────────────────


@pytest.mark.parametrize(
    ("method", "url"),
    [
        ("GET", f"/habits/{_DEFINITELY_MISSING_ID}"),
        ("PUT", f"/habits/{_DEFINITELY_MISSING_ID}"),
        ("DELETE", f"/habits/{_DEFINITELY_MISSING_ID}"),
        ("GET", f"/habits/{_DEFINITELY_MISSING_ID}/stats"),
        ("GET", f"/journal/{_DEFINITELY_MISSING_ID}"),
        ("DELETE", f"/journal/{_DEFINITELY_MISSING_ID}"),
        ("GET", f"/goal-groups/{_DEFINITELY_MISSING_ID}"),
        ("PUT", f"/goal-groups/{_DEFINITELY_MISSING_ID}"),
        ("DELETE", f"/goal-groups/{_DEFINITELY_MISSING_ID}"),
        ("GET", f"/user-practices/{_DEFINITELY_MISSING_ID}"),
        ("GET", f"/practices/{_DEFINITELY_MISSING_ID}"),
    ],
)
@pytest.mark.asyncio
async def test_missing_row_returns_404(async_client: AsyncClient, method: str, url: str) -> None:
    """Missing rows must still 404; the IDOR fix does not collapse them into 403."""
    headers, _ = await _signup(async_client, f"missing_{method}_{abs(hash(url))}")
    if method == "PUT":
        resp = await async_client.put(
            url,
            json={**_HABIT_PAYLOAD, "name": "anything"},
            headers=headers,
        )
    elif method == "DELETE":
        resp = await async_client.delete(url, headers=headers)
    else:
        resp = await async_client.get(url, headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND, (
        f"missing-row regression: {method} {url} must 404, got {resp.status_code}"
    )


# ── BUG-COURSE-004: locked course content masks as 404 ──────────────────


@pytest.mark.asyncio
async def test_locked_content_indistinguishable_from_missing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """BUG-COURSE-004: a stage-locked content row reads as 404, not 403.

    Course content is shared catalog (no per-user ownership), so the
    canonical 403-for-cross-user rule does not apply.  The leak surface
    is content-row count — masking the locked branch as 404 closes the
    enumeration oracle by making locked-but-existing indistinguishable
    from never-existed.
    """
    headers, _ = await _signup(async_client, "locked_content_probe")

    # Seed stage-2 content; the user has no progress so stage 2 is locked.
    stage = CourseStage(
        title="S2",
        subtitle="x",
        stage_number=2,
        overview_url="https://example.com/s2",
        category="x",
        aspect="x",
        spiral_dynamics_color="x",
        growing_up_stage="x",
        divine_gender_polarity="x",
        relationship_to_free_will="active",
        free_will_description="x",
    )
    db_session.add(stage)
    await db_session.flush()
    item = StageContent(
        course_stage_id=stage.id,
        title="locked",
        content_type="essay",
        release_day=0,
        url="https://cms.example.com/locked",
    )
    db_session.add(item)
    await db_session.commit()
    await db_session.refresh(item)

    locked_resp = await async_client.get(f"/course/content/{item.id}", headers=headers)
    missing_resp = await async_client.get(
        f"/course/content/{_DEFINITELY_MISSING_ID}", headers=headers
    )

    assert locked_resp.status_code == HTTPStatus.NOT_FOUND
    assert missing_resp.status_code == HTTPStatus.NOT_FOUND
    assert locked_resp.json()["detail"] == missing_resp.json()["detail"] == "content_not_found"

    mark_locked = await async_client.post(f"/course/content/{item.id}/mark-read", headers=headers)
    assert mark_locked.status_code == HTTPStatus.NOT_FOUND


# ── No response DTO leaks user_id ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_user_id_in_owned_resource_responses(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """No owned-resource response body emits ``user_id`` (BUG-T7).

    The auth response (``POST /auth/signup``) legitimately tells the
    caller their own id, so it is excluded from this scan.
    """
    alice_headers, alice_id = await _signup(async_client, "user_id_scrub")

    create_habit = await async_client.post("/habits/", json=_HABIT_PAYLOAD, headers=alice_headers)
    habit_id = create_habit.json()["id"]

    create_journal = await async_client.post(
        "/journal/", json={"message": "scrub"}, headers=alice_headers
    )
    entry_id = create_journal.json()["id"]

    create_group = await async_client.post(
        "/goal-groups/", json={"name": "Scrub"}, headers=alice_headers
    )
    group_id = create_group.json()["id"]

    user_practice_id = await _create_user_practice(
        async_client, db_session, alice_headers, alice_id
    )
    session_id = await _create_practice_session(async_client, alice_headers, user_practice_id)

    practice = await _seed_practice(db_session, name="Catalog Scrub")

    probes: list[tuple[str, dict[str, object]]] = [
        ("create_habit", create_habit.json()),
        ("create_journal", create_journal.json()),
        ("create_group", create_group.json()),
        (
            "get_habit",
            (await async_client.get(f"/habits/{habit_id}", headers=alice_headers)).json(),
        ),
        (
            "get_journal",
            (await async_client.get(f"/journal/{entry_id}", headers=alice_headers)).json(),
        ),
        (
            "get_group",
            (await async_client.get(f"/goal-groups/{group_id}", headers=alice_headers)).json(),
        ),
        (
            "get_user_practice",
            (
                await async_client.get(f"/user-practices/{user_practice_id}", headers=alice_headers)
            ).json(),
        ),
        (
            "get_practice",
            (await async_client.get(f"/practices/{practice.id}", headers=alice_headers)).json(),
        ),
    ]

    for label, body in probes:
        assert "user_id" not in body, f"{label} response leaked user_id"
        assert "submitted_by_user_id" not in body, f"{label} response leaked submitted_by_user_id"

    # ``session_id`` is consumed by referencing the session POST response;
    # the create-session response was already exercised in the existing
    # ``test_practice_sessions.py`` suite, so we just keep the variable
    # bound to satisfy the seeding flow.
    _ = session_id
