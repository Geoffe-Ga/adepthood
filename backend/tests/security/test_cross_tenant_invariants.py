"""Cross-tenant reference invariant — asserted against persisted state, not status codes.

Two body-parameter authorisation holes once let a caller file their own row
against another tenant's object: ``PUT /goals/{id}`` accepted a
``goal_group_id`` no dependency had authorised, and ``POST /journal/``
accepted an unauthorised ``user_practice_id`` / ``practice_session_id``.
Both write paths are guarded now, and ``test_idor.py`` pins the guards by
response code.

This module pins the *other half* of the contract, which a status-code test
cannot reach: after real write traffic, no row in the database references an
object owned by a different user.  It therefore fails if an endpoint returns
403/404 and writes anyway, and it fails if some future endpoint learns to
plant a cross-tenant reference through a path nobody thought to probe.

The invariant covers three (table, column) pairs:

- ``goal.goal_group_id`` -> ``goalgroup`` (the goal's owner is
  ``habit.user_id``, reached through ``goal.habit_id``);
- ``journalentry.user_practice_id`` -> ``userpractice``;
- ``journalentry.practice_session_id`` -> ``practicesession``.

A non-NULL value must reference a row owned by the same user who owns the
referencing row.  A violation is classified as ``dangling`` (the target does
not exist), ``shared_template`` (the target exists but is ownerless --
reachable only for ``goalgroup``), or ``foreign_owner``.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import NamedTuple

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import TextClause

from models.goal import Goal
from models.journal_entry import JournalEntry
from models.practice import Practice
from models.stage_progress import StageProgress

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

# Two tenants, each carrying one grouped goal plus one journal entry that
# links both a user-practice and a practice session: six live references for
# the detector to inspect, so an empty violation list cannot be an artefact
# of an empty database.
_EXPECTED_LIVE_REFERENCE_COUNT = 6

# Ownership for a goal rides ``goal.habit_id -> habit.user_id`` because
# ``goal`` carries no ``user_id`` of its own.  The LEFT JOIN plus CASE keeps
# the predicate portable across SQLite and Postgres, and ownerlessness is
# read as ``user_id IS NULL`` rather than as a boolean literal.
_GOAL_GROUP_VIOLATIONS = text(
    "SELECT g.id,"
    " CASE WHEN gg.id IS NULL THEN 'dangling'"
    " WHEN gg.user_id IS NULL THEN 'shared_template'"
    " ELSE 'foreign_owner' END"
    " FROM goal g"
    " JOIN habit h ON h.id = g.habit_id"
    " LEFT JOIN goalgroup gg ON gg.id = g.goal_group_id"
    " WHERE g.goal_group_id IS NOT NULL"
    " AND (gg.id IS NULL OR gg.user_id IS NULL OR gg.user_id <> h.user_id)"
)

_JOURNAL_USER_PRACTICE_VIOLATIONS = text(
    "SELECT j.id,"
    " CASE WHEN r.id IS NULL THEN 'dangling' ELSE 'foreign_owner' END"
    " FROM journalentry j"
    " LEFT JOIN userpractice r ON r.id = j.user_practice_id"
    " WHERE j.user_practice_id IS NOT NULL"
    " AND (r.id IS NULL OR r.user_id <> j.user_id)"
)

# ``practicesession`` holds its owner directly, so the check reads
# ``practicesession.user_id`` rather than routing back through userpractice.
_JOURNAL_PRACTICE_SESSION_VIOLATIONS = text(
    "SELECT j.id,"
    " CASE WHEN r.id IS NULL THEN 'dangling' ELSE 'foreign_owner' END"
    " FROM journalentry j"
    " LEFT JOIN practicesession r ON r.id = j.practice_session_id"
    " WHERE j.practice_session_id IS NOT NULL"
    " AND (r.id IS NULL OR r.user_id <> j.user_id)"
)

_DETECTION_QUERIES: tuple[tuple[str, TextClause], ...] = (
    ("goal", _GOAL_GROUP_VIOLATIONS),
    ("journalentry", _JOURNAL_USER_PRACTICE_VIOLATIONS),
    ("journalentry", _JOURNAL_PRACTICE_SESSION_VIOLATIONS),
)

_LIVE_REFERENCE_COUNT = text(
    "SELECT (SELECT COUNT(*) FROM goal WHERE goal_group_id IS NOT NULL)"
    " + (SELECT COUNT(*) FROM journalentry WHERE user_practice_id IS NOT NULL)"
    " + (SELECT COUNT(*) FROM journalentry WHERE practice_session_id IS NOT NULL)"
)


async def _cross_tenant_violations(session: AsyncSession) -> list[tuple[str, int, str]]:
    """Return every cross-tenant reference in the database, as (table, row id, reason).

    Runs the same family of predicate the remediation migration uses, so a
    regression here and a row the migration would have quarantined are the
    same finding.
    """
    session.expire_all()
    violations: list[tuple[str, int, str]] = []
    for source_table, statement in _DETECTION_QUERIES:
        result = await session.execute(statement)
        violations.extend((source_table, int(row[0]), str(row[1])) for row in result.all())
    return sorted(violations)


async def _live_reference_count(session: AsyncSession) -> int:
    """Return how many non-NULL references across the three guarded columns exist."""
    session.expire_all()
    result = await session.execute(_LIVE_REFERENCE_COUNT)
    return int(result.scalar_one())


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


def _journal_payload(**foreign_keys: int) -> dict[str, object]:
    """Build an otherwise-valid ``POST /journal/`` body carrying the given body FKs."""
    return {"message": _JOURNAL_PROBE_MESSAGE, **foreign_keys}


def _session_window_payload(user_practice_id: int) -> dict[str, object]:
    """Build a 5-minute ``started_at``/``ended_at`` window for a session log."""
    ended = datetime.now(UTC)
    started = ended - timedelta(minutes=5)
    return {
        "user_practice_id": user_practice_id,
        "started_at": started.isoformat(),
        "ended_at": ended.isoformat(),
    }


async def _create_user_practice(
    client: AsyncClient,
    db_session: AsyncSession,
    headers: dict[str, str],
    user_id: int,
    practice_name: str,
) -> int:
    """Seed a catalog practice, unlock stage 1, and select it for the user.

    ``practice_name`` is always explicit: the preset catalog is uniquely
    indexed on (stage_number, normalized name) and every test here seeds two.
    """
    practice = Practice(**{**_PRACTICE_DEFAULTS, "name": practice_name})
    db_session.add(practice)
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
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


async def _create_practice_session(
    client: AsyncClient, headers: dict[str, str], user_practice_id: int
) -> int:
    """Log a practice session against the given user-practice."""
    resp = await client.post(
        "/practice-sessions/",
        json=_session_window_payload(user_practice_id),
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


class _Tenant(NamedTuple):
    """One provisioned user plus the ids of the objects that user owns."""

    headers: dict[str, str]
    user_id: int
    goal_id: int
    goal_payload: dict[str, object]
    goal_group_id: int
    user_practice_id: int
    practice_session_id: int


async def _provision_tenant(
    client: AsyncClient,
    db_session: AsyncSession,
    username: str,
    practice_name: str,
) -> _Tenant:
    """Drive the real write paths that produce every reference the invariant covers."""
    headers, user_id = await _signup(client, username)

    habit = await client.post("/habits/", json=_HABIT_PAYLOAD, headers=headers)
    assert habit.status_code == HTTPStatus.OK
    goal = habit.json()["goals"][0]
    goal_id = int(goal["id"])
    goal_payload = _goal_put_payload(goal)

    group = await client.post("/goal-groups/", json={"name": f"{username} group"}, headers=headers)
    assert group.status_code == HTTPStatus.CREATED
    goal_group_id = int(group.json()["id"])

    assigned = await client.put(
        f"/goals/{goal_id}",
        json={**goal_payload, "goal_group_id": goal_group_id},
        headers=headers,
    )
    assert assigned.status_code == HTTPStatus.OK
    assert assigned.json()["goal_group_id"] == goal_group_id

    user_practice_id = await _create_user_practice(
        client, db_session, headers, user_id, practice_name
    )
    practice_session_id = await _create_practice_session(client, headers, user_practice_id)

    entry = await client.post(
        "/journal/",
        json=_journal_payload(
            user_practice_id=user_practice_id, practice_session_id=practice_session_id
        ),
        headers=headers,
    )
    assert entry.status_code == HTTPStatus.CREATED
    assert entry.json()["user_practice_id"] == user_practice_id
    assert entry.json()["practice_session_id"] == practice_session_id

    return _Tenant(
        headers=headers,
        user_id=user_id,
        goal_id=goal_id,
        goal_payload=goal_payload,
        goal_group_id=goal_group_id,
        user_practice_id=user_practice_id,
        practice_session_id=practice_session_id,
    )


@pytest.mark.asyncio
async def test_detector_finds_a_planted_cross_tenant_reference(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Self-test: the detector reports a violation planted beneath the API.

    Without this, an empty violation list proves nothing -- a detector whose
    predicate never matches would look identical to a clean database.  The
    API can no longer forge a cross-tenant reference, so both shapes are
    planted through the ORM instead.
    """
    alice_headers, _alice_id = await _signup(async_client, "alice_detector")
    bob_headers, bob_id = await _signup(async_client, "bob_detector")

    habit = await async_client.post("/habits/", json=_HABIT_PAYLOAD, headers=alice_headers)
    assert habit.status_code == HTTPStatus.OK
    goal_id = int(habit.json()["goals"][0]["id"])

    group = await async_client.post(
        "/goal-groups/", json={"name": "Bob Private"}, headers=bob_headers
    )
    assert group.status_code == HTTPStatus.CREATED
    bob_group_id = int(group.json()["id"])

    entry = await async_client.post("/journal/", json=_journal_payload(), headers=alice_headers)
    assert entry.status_code == HTTPStatus.CREATED
    entry_id = int(entry.json()["id"])

    bob_practice_id = await _create_user_practice(
        async_client, db_session, bob_headers, bob_id, "Bob Sit"
    )

    assert await _cross_tenant_violations(db_session) == [], "fixture setup already violates"

    planted_goal = await db_session.get(Goal, goal_id)
    assert planted_goal is not None
    planted_goal.goal_group_id = bob_group_id
    planted_entry = await db_session.get(JournalEntry, entry_id)
    assert planted_entry is not None
    planted_entry.user_practice_id = bob_practice_id
    await db_session.flush()

    assert await _cross_tenant_violations(db_session) == [
        ("goal", goal_id, "foreign_owner"),
        ("journalentry", entry_id, "foreign_owner"),
    ]


@pytest.mark.asyncio
async def test_cross_tenant_invariant_holds_after_live_write_traffic(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Real write traffic from two tenants leaves zero cross-tenant references persisted.

    Both users exercise every write path that can set one of the guarded
    columns, then each attempts the two writes that are now refused.  The
    detector must come back empty -- a 403 that still persisted its row would
    surface here even though the status-code assertions above passed.
    """
    alice = await _provision_tenant(async_client, db_session, "alice_invariant", "Alice Sit")
    bob = await _provision_tenant(async_client, db_session, "bob_invariant", "Bob Sit")

    attack_goal = await async_client.put(
        f"/goals/{alice.goal_id}",
        json={**alice.goal_payload, "goal_group_id": bob.goal_group_id},
        headers=alice.headers,
    )
    assert attack_goal.status_code == HTTPStatus.FORBIDDEN

    attack_journal = await async_client.post(
        "/journal/",
        json=_journal_payload(user_practice_id=bob.user_practice_id),
        headers=alice.headers,
    )
    assert attack_journal.status_code == HTTPStatus.FORBIDDEN

    attack_session_link = await async_client.post(
        "/journal/",
        json=_journal_payload(practice_session_id=alice.practice_session_id),
        headers=bob.headers,
    )
    assert attack_session_link.status_code == HTTPStatus.FORBIDDEN

    assert await _live_reference_count(db_session) == _EXPECTED_LIVE_REFERENCE_COUNT, (
        "the invariant must be checked against real references, not an empty database"
    )
    assert await _cross_tenant_violations(db_session) == []
