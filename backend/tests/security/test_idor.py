"""IDOR matrix — every owned-resource endpoint returns 403, not 404, for cross-user access.

Each parametrised case exercises one HTTP method on one resource type:
Alice creates the row, Bob calls the endpoint with Alice's id.  The
endpoint MUST return 403 ``forbidden`` so the auth-failure path is
distinguishable in audit logs and so a future change cannot silently
collapse the cross-user branch back into 404.

Per the BUG-T7 remediation (prompt ``07-normalize-idor-ordering``):

- Genuinely missing rows still 404 (sibling tests in each
  ``test_<resource>_api.py``).
- Rows that exist but belong to another user 403, never 404 — EXCEPT the
  enumeration-safe resources (goals, marginalia, and journal entries) which
  deliberately collapse the cross-user branch to 404 on every method.
- Course content is a shared catalog rather than a per-user resource;
  its enumeration oracle (BUG-COURSE-004) is closed by masking the
  locked branch as 404 instead.  That mask is asserted in
  ``test_course_api.py`` and revisited here so a regression on either
  side surfaces in the security suite.

Also asserts that no owned-resource response DTO echoes ``user_id``.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import ColumnElement
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select, update

from models.course_stage import CourseStage
from models.goal import Goal
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.practice import Practice
from models.practice_session import PracticeSession
from models.stage_content import StageContent
from models.stage_progress import StageProgress
from models.user import User

# Severity: probe attempts use a sentinel id well above any seeded row so
# the missing-row branch is the same code path as a malicious enumeration.
_DEFINITELY_MISSING_ID = 999_999

_JOURNAL_PROBE_MESSAGE = "A perfectly ordinary entry."

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


async def _promote(session: AsyncSession, username: str) -> None:
    """Flip ``is_admin`` so the caller may publish a shared template."""
    await session.execute(
        update(User).where(col(User.email) == f"{username}@example.com").values(is_admin=True)
    )
    await session.commit()


def _goal_put_payload(goal: dict[str, object]) -> dict[str, object]:
    """Rebuild the full-replace ``PUT /goals/{id}`` body from an API-returned goal."""
    return {
        field: goal[field]
        for field in (
            "title",
            "tier",
            "target",
            "target_unit",
            "frequency",
            "frequency_unit",
            "is_additive",
        )
    }


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
    *,
    practice_name: str | None = None,
) -> int:
    """Seed a practice the user owns (via UserPractice) and return its id.

    ``practice_name`` must be supplied when one test seeds two of these: the
    preset catalog is uniquely indexed on (stage_number, normalized name).
    """
    overrides: dict[str, object] = {} if practice_name is None else {"name": practice_name}
    practice = await _seed_practice(db_session, **overrides)
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


def _session_window_payload(user_practice_id: int) -> dict[str, object]:
    """Build a fresh ``started_at``/``ended_at`` payload for a 5-minute session.

    Mirrors :mod:`schemas.practice.PracticeSessionCreate` after the
    BUG-PRACTICE-006 server-derived-duration migration -- the API rejects
    legacy ``duration_minutes`` payloads with 422.
    """
    ended = datetime.now(UTC)
    started = ended - timedelta(minutes=5)
    return {
        "user_practice_id": user_practice_id,
        "started_at": started.isoformat(),
        "ended_at": ended.isoformat(),
    }


def _journal_payload(**foreign_keys: int) -> dict[str, object]:
    """Build an otherwise-valid ``POST /journal/`` body carrying the given body FKs.

    Everything except the injected id is benign, so a rejection can only be
    about the id -- never about a malformed message or a missing field.
    """
    return {"message": _JOURNAL_PROBE_MESSAGE, **foreign_keys}


def _denial_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Return the ``resource_access_denied`` audit records captured so far."""
    return [record for record in caplog.records if record.message == "resource_access_denied"]


async def _sessions_where(
    db_session: AsyncSession, condition: ColumnElement[bool]
) -> list[PracticeSession]:
    """Return every persisted practice session matching ``condition``.

    Sibling of :func:`_entries_where`, and expires the shared session for the
    same reason: the assertion has to read committed state, not the identity
    map the request left behind.
    """
    db_session.expire_all()
    result = await db_session.execute(select(PracticeSession).where(condition))
    return list(result.scalars().all())


async def _entries_where(
    db_session: AsyncSession, condition: ColumnElement[bool]
) -> list[JournalEntry]:
    """Return every persisted journal entry matching ``condition``.

    Expires the shared test session first so the assertion reads committed
    state rather than the identity map the request left behind.
    """
    db_session.expire_all()
    result = await db_session.execute(select(JournalEntry).where(condition))
    return list(result.scalars().all())


async def _create_practice_session(
    client: AsyncClient,
    headers: dict[str, str],
    user_practice_id: int,
) -> int:
    """Log a practice session against the given user-practice."""
    resp = await client.post(
        "/practice-sessions/",
        json=_session_window_payload(user_practice_id),
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


async def _seed_expanded_marginalia(
    db_session: AsyncSession,
    *,
    owner_id: int,
    column_user_id: int | None = None,
) -> int:
    """Persist an entry owned by ``owner_id`` carrying one expanded margin note.

    ``column_user_id`` overrides the denormalized ``Marginalia.user_id`` column
    so a drifted row — one naming a user who does not own the parent entry —
    can be probed.
    """
    entry = JournalEntry(sender="user", user_id=owner_id, message=_JOURNAL_PROBE_MESSAGE)
    db_session.add(entry)
    await db_session.flush()
    note = Marginalia(
        journal_entry_id=entry.id,
        user_id=column_user_id if column_user_id is not None else owner_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=1,
        anchor_text="A",
        note="A margin note.",
        essay="An expanded letter.",
        essay_generated_at=datetime.now(UTC),
    )
    db_session.add(note)
    await db_session.commit()
    await db_session.refresh(note)
    assert note.id is not None
    return int(note.id)


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


# Journal entries are the deliberate exception to the 403-everywhere rule: GET,
# DELETE, and PATCH all collapse a cross-user probe to 404 (enumeration-safe),
# matching the goal/marginalia contract.
@pytest.mark.asyncio
async def test_idor_journal_entry_get_returns_404(async_client: AsyncClient) -> None:
    alice_headers, _ = await _signup(async_client, "alice_j_get")
    bob_headers, _ = await _signup(async_client, "bob_j_get")

    create = await async_client.post(
        "/journal/", json={"message": "private"}, headers=alice_headers
    )
    entry_id = create.json()["id"]

    resp = await async_client.get(f"/journal/{entry_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_idor_journal_entry_delete_returns_404(async_client: AsyncClient) -> None:
    alice_headers, _ = await _signup(async_client, "alice_j_del")
    bob_headers, _ = await _signup(async_client, "bob_j_del")

    create = await async_client.post(
        "/journal/", json={"message": "private"}, headers=alice_headers
    )
    entry_id = create.json()["id"]

    resp = await async_client.delete(f"/journal/{entry_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


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
async def test_idor_shared_template_mutation_returns_403(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """BUG-GOAL-006: an ordinary user cannot mutate a shared template.

    A template is ownerless (``user_id IS NULL``), so it can never match the
    caller's id.  The admin moderation surface this docstring once anticipated
    now exists -- ``require_manageable_goal_group`` routes templates to admin --
    but a *non-admin* is still refused, which is what this pins.  Bob, an
    ordinary user, is the one probing here.
    """
    alice_headers, _ = await _signup(async_client, "alice_shared")
    await _promote(db_session, "alice_shared")
    bob_headers, _ = await _signup(async_client, "bob_shared_probe")

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
        headers=bob_headers,
    )
    assert put.status_code == HTTPStatus.FORBIDDEN

    delete = await async_client.delete(f"/goal-groups/{group_id}", headers=bob_headers)
    assert delete.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_idor_shared_template_get_is_visible(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Shared templates are readable by every authenticated user."""
    alice_headers, _ = await _signup(async_client, "alice_shared_get")
    bob_headers, _ = await _signup(async_client, "bob_shared_get")
    await _promote(db_session, "alice_shared_get")

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
async def test_idor_goal_update_cannot_write_into_another_users_group(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Alice cannot smuggle her goal into Bob's private group via ``PUT /goals/{id}``.

    ``require_owned_goal`` authorises the goal but not the ``goal_group_id``
    in the body, so an unguarded full-replace write would publish Alice's
    goal (title, target, units, parent habit) into Bob's group, which Bob
    then reads through ``GET /goal-groups/{id}``.
    """
    alice_headers, alice_id = await _signup(async_client, "alice_goal_xgroup")
    bob_headers, _bob_id = await _signup(async_client, "bob_goal_xgroup")

    habit = await async_client.post("/habits/", json=_HABIT_PAYLOAD, headers=alice_headers)
    assert habit.status_code == HTTPStatus.OK
    alice_goals = habit.json()["goals"]
    assert alice_goals, "habit creation must embed its default tier goals"
    goal_id = alice_goals[0]["id"]
    payload = _goal_put_payload(alice_goals[0])

    create_group = await async_client.post(
        "/goal-groups/", json={"name": "Bob Private"}, headers=bob_headers
    )
    assert create_group.status_code == HTTPStatus.CREATED
    bob_group_id = create_group.json()["id"]

    # The victim group really exists and its owner can read it, so a 403 below
    # cannot be an artefact of a missing target row.
    owner_read = await async_client.get(f"/goal-groups/{bob_group_id}", headers=bob_headers)
    assert owner_read.status_code == HTTPStatus.OK
    assert owner_read.json()["name"] == "Bob Private"

    # The identical payload with a benign group is accepted, so a 403 below
    # cannot be an artefact of an unrelated validation failure.
    baseline = await async_client.put(
        f"/goals/{goal_id}",
        json={**payload, "goal_group_id": None},
        headers=alice_headers,
    )
    assert baseline.status_code == HTTPStatus.OK
    assert baseline.json()["goal_group_id"] is None

    with caplog.at_level(logging.WARNING):
        attack = await async_client.put(
            f"/goals/{goal_id}",
            json={**payload, "goal_group_id": bob_group_id},
            headers=alice_headers,
        )

    assert attack.status_code == HTTPStatus.FORBIDDEN
    assert attack.json()["detail"] == "forbidden"

    db_session.expire_all()
    stored = (await db_session.execute(select(Goal).where(Goal.id == goal_id))).scalars().one()
    assert stored.goal_group_id is None, (
        "cross-user goal-group write persisted; the goal moved into the victim's group"
    )

    victim_view = await async_client.get(f"/goal-groups/{bob_group_id}", headers=bob_headers)
    assert victim_view.status_code == HTTPStatus.OK
    assert victim_view.json()["goals"] == [], "attacker's goal surfaced inside the victim's group"

    denials = [r for r in caplog.records if r.message == "resource_access_denied"]
    assert denials, "expected a resource_access_denied audit log entry"
    assert getattr(denials[0], "resource", None) == "goal_group"
    assert getattr(denials[0], "resource_id", None) == bob_group_id
    assert getattr(denials[0], "user_id", None) == alice_id


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
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Bob cannot log a practice session against Alice's user-practice.

    ``POST /practice-sessions/`` takes ``user_practice_id`` from the request
    body, so the path-parameter ownership dependencies never see it.  An
    unguarded write would graft sessions onto a victim's practice history --
    rows that then surface in her session list and her analytics rollups.

    Asserted three ways rather than on the status alone.  The 403 was already
    correct before this test grew; what was missing is that a *denial nobody
    records* is a cross-tenant probe nobody can see, and that a status code
    says nothing about whether a row was written anyway.
    """
    alice_headers, alice_id = await _signup(async_client, "alice_ps_post")
    bob_headers, bob_id = await _signup(async_client, "bob_ps_post")

    alice_practice_id = await _create_user_practice(
        async_client, db_session, alice_headers, alice_id, practice_name="Alice PS Post"
    )
    bob_practice_id = await _create_user_practice(
        async_client, db_session, bob_headers, bob_id, practice_name="Bob PS Post"
    )

    with caplog.at_level(logging.WARNING):
        attack = await async_client.post(
            "/practice-sessions/",
            json=_session_window_payload(alice_practice_id),
            headers=bob_headers,
        )

    assert attack.status_code == HTTPStatus.FORBIDDEN
    assert attack.json()["detail"] == "forbidden"

    # The identical payload against Bob's own practice is accepted, so the 403
    # above can only be about ownership -- not a malformed body or a stage gate.
    baseline = await async_client.post(
        "/practice-sessions/",
        json=_session_window_payload(bob_practice_id),
        headers=bob_headers,
    )
    assert baseline.status_code == HTTPStatus.CREATED
    assert baseline.json()["user_practice_id"] == bob_practice_id

    smuggled = await _sessions_where(
        db_session, col(PracticeSession.user_practice_id) == alice_practice_id
    )
    assert smuggled == [], "cross-user practice session persisted against the victim's practice"

    denials = _denial_records(caplog)
    assert len(denials) == 1, "expected exactly one resource_access_denied audit log entry"
    assert getattr(denials[0], "resource", None) == "user_practice"
    assert getattr(denials[0], "resource_id", None) == alice_practice_id
    assert getattr(denials[0], "user_id", None) == bob_id


async def _probe_missing_user_practice(
    async_client: AsyncClient, spelling: str, headers: dict[str, str]
) -> Response:
    """Name a nonexistent user practice in the request position ``spelling`` asks for."""
    if spelling == "body":
        return await async_client.post(
            "/practice-sessions/",
            json=_session_window_payload(_DEFINITELY_MISSING_ID),
            headers=headers,
        )
    return await async_client.get(
        "/practice-sessions/",
        params={"user_practice_id": _DEFINITELY_MISSING_ID},
        headers=headers,
    )


@pytest.mark.parametrize("spelling", ["body", "query"])
@pytest.mark.asyncio
async def test_practice_session_missing_user_practice_is_404_and_unaudited(
    async_client: AsyncClient,
    caplog: pytest.LogCaptureFixture,
    spelling: str,
) -> None:
    """A ``user_practice_id`` that exists for nobody 404s, and audits nothing.

    A missing row must never reach the ownership comparison -- inverting that
    order makes the endpoint an existence oracle.  A denial record for a row
    that never existed would likewise poison the audit signal that genuine
    cross-tenant probes are meant to raise.  The sibling case is pinned for
    ``POST /journal/`` but was unpinned for this endpoint.

    The create body and the list query string reach the rule through two
    separate dependencies, so both spellings are pinned rather than only the
    one that happened to be written first.
    """
    headers, _ = await _signup(async_client, f"ps_missing_up_{spelling}")

    with caplog.at_level(logging.WARNING):
        resp = await _probe_missing_user_practice(async_client, spelling, headers)

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "user_practice_not_found"
    assert _denial_records(caplog) == []


@pytest.mark.asyncio
async def test_idor_journal_create_user_practice_returns_403(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Bob cannot bind a new journal entry to Alice's user-practice.

    ``POST /journal/`` takes ``user_practice_id`` from the request body, so the
    path-parameter ownership dependencies never see it.  An unguarded write
    would let an attacker graft rows onto a victim's practice history -- rows
    that then surface in the victim's practice-scoped views and aggregates.
    """
    alice_headers, alice_id = await _signup(async_client, "alice_j_up_post")
    bob_headers, bob_id = await _signup(async_client, "bob_j_up_post")

    alice_practice_id = await _create_user_practice(
        async_client, db_session, alice_headers, alice_id, practice_name="Alice Sit"
    )
    bob_practice_id = await _create_user_practice(
        async_client, db_session, bob_headers, bob_id, practice_name="Bob Sit"
    )

    with caplog.at_level(logging.WARNING):
        attack = await async_client.post(
            "/journal/",
            json=_journal_payload(user_practice_id=alice_practice_id),
            headers=bob_headers,
        )

    assert attack.status_code == HTTPStatus.FORBIDDEN
    assert attack.json()["detail"] == "forbidden"

    # The identical payload against Bob's own practice is accepted, so the 403
    # above can only be about ownership -- not a missing row or a bad body.
    baseline = await async_client.post(
        "/journal/",
        json=_journal_payload(user_practice_id=bob_practice_id),
        headers=bob_headers,
    )
    assert baseline.status_code == HTTPStatus.CREATED
    assert baseline.json()["user_practice_id"] == bob_practice_id

    smuggled = await _entries_where(
        db_session, col(JournalEntry.user_practice_id) == alice_practice_id
    )
    assert smuggled == [], "cross-user journal entry persisted against the victim's user-practice"

    denials = _denial_records(caplog)
    assert denials, "expected a resource_access_denied audit log entry"
    assert getattr(denials[0], "resource", None) == "user_practice"
    assert getattr(denials[0], "resource_id", None) == alice_practice_id
    assert getattr(denials[0], "user_id", None) == bob_id


@pytest.mark.asyncio
async def test_idor_journal_create_practice_session_returns_403(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Bob cannot bind a new journal entry to Alice's practice session.

    ``practice_session_id`` is the second unguarded body FK on ``POST
    /journal/``; ``GET /journal/?practice_session_id=`` filters on it, so a
    forged link is an attacker-controlled write into the victim's session view.
    """
    alice_headers, alice_id = await _signup(async_client, "alice_j_ps_post")
    bob_headers, bob_id = await _signup(async_client, "bob_j_ps_post")

    alice_practice_id = await _create_user_practice(
        async_client, db_session, alice_headers, alice_id, practice_name="Alice Sit"
    )
    bob_practice_id = await _create_user_practice(
        async_client, db_session, bob_headers, bob_id, practice_name="Bob Sit"
    )
    alice_session_id = await _create_practice_session(
        async_client, alice_headers, alice_practice_id
    )
    bob_session_id = await _create_practice_session(async_client, bob_headers, bob_practice_id)

    with caplog.at_level(logging.WARNING):
        attack = await async_client.post(
            "/journal/",
            json=_journal_payload(practice_session_id=alice_session_id),
            headers=bob_headers,
        )

    assert attack.status_code == HTTPStatus.FORBIDDEN
    assert attack.json()["detail"] == "forbidden"

    baseline = await async_client.post(
        "/journal/",
        json=_journal_payload(practice_session_id=bob_session_id),
        headers=bob_headers,
    )
    assert baseline.status_code == HTTPStatus.CREATED
    assert baseline.json()["practice_session_id"] == bob_session_id

    smuggled = await _entries_where(
        db_session, col(JournalEntry.practice_session_id) == alice_session_id
    )
    assert smuggled == [], "cross-user journal entry persisted against the victim's session"

    denials = _denial_records(caplog)
    assert denials, "expected a resource_access_denied audit log entry"
    assert getattr(denials[0], "resource", None) == "practice_session"
    assert getattr(denials[0], "resource_id", None) == alice_session_id
    assert getattr(denials[0], "user_id", None) == bob_id


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


@pytest.mark.parametrize(
    ("field", "detail"),
    [
        ("user_practice_id", "user_practice_not_found"),
        ("practice_session_id", "practice_session_not_found"),
    ],
)
@pytest.mark.asyncio
async def test_journal_create_missing_body_fk_returns_404(
    async_client: AsyncClient, field: str, detail: str
) -> None:
    """A ``POST /journal/`` body FK that exists for nobody 404s, never 403.

    Pins the canonical ordering the IDOR matrix relies on: existence is
    checked before ownership, so a nonexistent id cannot be mistaken for
    someone else's.
    """
    headers, _ = await _signup(async_client, f"journal_missing_{field}")

    resp = await async_client.post(
        "/journal/",
        json=_journal_payload(**{field: _DEFINITELY_MISSING_ID}),
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == detail


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
    create_session = await async_client.post(
        "/practice-sessions/",
        json=_session_window_payload(user_practice_id),
        headers=alice_headers,
    )
    assert create_session.status_code == HTTPStatus.CREATED

    practice = await _seed_practice(db_session, name="Catalog Scrub")

    probes: list[tuple[str, dict[str, object]]] = [
        ("create_habit", create_habit.json()),
        ("create_journal", create_journal.json()),
        ("create_group", create_group.json()),
        ("create_practice_session", create_session.json()),
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


# ── Token-scoped listings leak no other tenant's rows ─────────────────────


@pytest.mark.asyncio
async def test_idor_voice_drafts_listing_is_scoped_to_the_caller(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Bob's Voice Drafts shelf holds none of Alice's essays, and no count of them.

    The shelf takes no resource id — it is keyed entirely on the bearer token —
    so there is no cross-user branch to spell 403 or 404, and marginalia is one
    of the enumeration-safe resources that deliberately collapses that branch
    anyway.  The invariant to pin is therefore isolation of the *projection*:
    neither the rows nor ``total`` may carry another tenant's writing, and the
    parent entry's owner is authoritative over the denormalized
    ``Marginalia.user_id`` column.
    """
    alice_headers, alice_id = await _signup(async_client, "alice_drafts")
    bob_headers, bob_id = await _signup(async_client, "bob_drafts")

    alices_note = await _seed_expanded_marginalia(db_session, owner_id=alice_id)
    # Drifted denormalized column: it names Bob, but the parent entry is Alice's.
    await _seed_expanded_marginalia(db_session, owner_id=alice_id, column_user_id=bob_id)

    alice_body = (await async_client.get("/journal/voice-drafts", headers=alice_headers)).json()
    bob_body = (await async_client.get("/journal/voice-drafts", headers=bob_headers)).json()

    assert [item["marginalia_id"] for item in alice_body["items"]] == [alices_note]
    assert alice_body["total"] == 1
    assert bob_body["items"] == []
    assert bob_body["total"] == 0
