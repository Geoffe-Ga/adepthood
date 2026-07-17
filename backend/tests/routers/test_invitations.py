"""Tests for GET /invitations and POST /invitations/{id}/dismiss."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.constants import TOTAL_STAGES
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    HandshakeResult,
    VaultClassification,
    VaultIngestRequest,
    VaultIngestResult,
    VaultTierCeiling,
    VaultWheelAspect,
    VaultWheelBalance,
)
from main import app
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.invitation_signal import InvitationSignal
from models.user import User
from services.creek_vault_write import get_creek_vault_client

_LIST_URL = "/invitations"
_SUSTAINED_STREAK = 21  # mirrors SUSTAINED_HABIT_STREAK_DAYS in the domain

# Response keys the endpoint must include / must not include.
_REQUIRED_KEYS = ("id", "target_type", "target_id", "kind", "created_at")
_FORBIDDEN_KEY = "user_id"


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Create an account and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Seeding helpers (mirrored from test_invitations_service.py)
# ---------------------------------------------------------------------------


async def _make_habit_with_streak(
    session: AsyncSession,
    user_id: int,
    streak_days: int,
    *,
    name: str = "Meditate",
) -> int:
    """Seed Habit + Goal + GoalCompletion rows sufficient for a streak signal."""
    habit = Habit(
        name=name,
        icon="flame",
        start_date=datetime.now(UTC).date() - timedelta(days=streak_days),
        stage="1",
        streak=streak_days,
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    assert habit.id is not None

    goal = Goal(
        habit_id=habit.id,
        title="Daily sit",
        tier="clear",
        target=1.0,
        target_unit="minutes",
        frequency=1.0,
        frequency_unit="per_day",
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    assert goal.id is not None

    now = datetime.now(UTC)
    for days_ago in range(streak_days):
        session.add(
            GoalCompletion(
                goal_id=goal.id,
                user_id=user_id,
                completed_units=goal.target,
                timestamp=now - timedelta(days=days_ago),
            )
        )
    await session.commit()
    return habit.id


async def _seed_pending_signal(
    session: AsyncSession,
    user_id: int,
    target_type: str = "habit",
    target_id: int | None = 1,
    kind: str = "consistency",
) -> int:
    """Insert a pending InvitationSignal row and return its id."""
    row = InvitationSignal(
        user_id=user_id,
        target_type=target_type,
        target_id=target_id,
        kind=kind,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    assert row.id is not None
    return row.id


async def _seed_dismissed_signal(
    session: AsyncSession,
    user_id: int,
    target_type: str = "habit",
    target_id: int | None = 2,
    kind: str = "consistency",
) -> int:
    """Insert an already-dismissed InvitationSignal row and return its id."""
    row = InvitationSignal(
        user_id=user_id,
        target_type=target_type,
        target_id=target_id,
        kind=kind,
        dismissed_at=datetime.now(UTC) - timedelta(hours=1),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    assert row.id is not None
    return row.id


# ---------------------------------------------------------------------------
# 1. GET returns only the caller's PENDING rows
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_returns_only_callers_pending_rows(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """GET /invitations returns the caller's pending rows; excluded: dismissed + other user's."""
    alice_headers = await _signup(async_client, "inv_alice1")
    bob_headers = await _signup(async_client, "inv_bob1")

    # Resolve DB user ids by looking up the user rows for alice and bob.
    alice_result = await db_session.execute(
        select(User).where(col(User.email) == "inv_alice1@example.com")
    )
    alice = alice_result.scalars().one()
    bob_result = await db_session.execute(
        select(User).where(col(User.email) == "inv_bob1@example.com")
    )
    bob = bob_result.scalars().one()

    assert alice.id is not None
    assert bob.id is not None

    # Alice: two pending rows + one dismissed row.
    pending_a = await _seed_pending_signal(
        db_session, alice.id, target_type="habit", target_id=10, kind="consistency"
    )
    pending_b = await _seed_pending_signal(
        db_session, alice.id, target_type="practice", target_id=20, kind="readiness"
    )
    await _seed_dismissed_signal(
        db_session, alice.id, target_type="habit", target_id=30, kind="mastery"
    )

    # Bob: one pending row that must not appear in Alice's response.
    await _seed_pending_signal(
        db_session, bob.id, target_type="sangha", target_id=99, kind="readiness"
    )

    # Bob's GET must only show his own row (not Alice's).
    bob_resp = await async_client.get(_LIST_URL, headers=bob_headers)
    assert bob_resp.status_code == HTTPStatus.OK
    bob_ids = {item["id"] for item in bob_resp.json()}
    assert pending_a not in bob_ids
    assert pending_b not in bob_ids

    resp = await async_client.get(_LIST_URL, headers=alice_headers)

    assert resp.status_code == HTTPStatus.OK
    items = resp.json()
    returned_ids = {item["id"] for item in items}

    # Both pending rows must appear.
    assert pending_a in returned_ids
    assert pending_b in returned_ids

    # Dismissed row must be absent.
    for item in items:
        assert item.get("dismissed_at") is None or "dismissed_at" not in item

    # Bob's row must not appear.
    assert len(returned_ids) == 2


# ---------------------------------------------------------------------------
# 2. GET generate-on-list seeds a candidate and is idempotent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_generates_invitation_and_is_idempotent(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """GET /invitations calls generate first; a second GET inserts nothing extra."""
    headers = await _signup(async_client, "inv_gen2")

    user_result = await db_session.execute(
        select(User).where(col(User.email) == "inv_gen2@example.com")
    )
    user = user_result.scalars().one()
    assert user.id is not None

    # Seed a habit streak at the threshold so generate yields a candidate.
    habit_id = await _make_habit_with_streak(db_session, user.id, streak_days=_SUSTAINED_STREAK)

    first_resp = await async_client.get(_LIST_URL, headers=headers)
    assert first_resp.status_code == HTTPStatus.OK
    first_items = first_resp.json()

    # At least one invitation for the seeded habit must appear.
    habit_ids = [item["target_id"] for item in first_items if item["target_type"] == "habit"]
    assert habit_id in habit_ids

    second_resp = await async_client.get(_LIST_URL, headers=headers)
    assert second_resp.status_code == HTTPStatus.OK
    second_items = second_resp.json()

    # Same count — no duplicate was inserted.
    assert len(second_items) == len(first_items)

    # The DB row count must also be stable.
    db_rows_result = await db_session.execute(
        select(InvitationSignal).where(col(InvitationSignal.user_id) == user.id)
    )
    db_rows = list(db_rows_result.scalars().all())
    assert len(db_rows) == len(first_items)


# ---------------------------------------------------------------------------
# 3. DISMISS sets dismissed_at and removes the row from subsequent GET
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dismiss_sets_dismissed_at_and_excludes_from_list(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """POST /invitations/{id}/dismiss marks dismissed_at; row absent from GET."""
    headers = await _signup(async_client, "inv_dis3")

    user_result = await db_session.execute(
        select(User).where(col(User.email) == "inv_dis3@example.com")
    )
    user = user_result.scalars().one()
    assert user.id is not None

    inv_id = await _seed_pending_signal(
        db_session, user.id, target_type="practice", target_id=55, kind="readiness"
    )

    dismiss_resp = await async_client.post(f"{_LIST_URL}/{inv_id}/dismiss", headers=headers)
    assert dismiss_resp.status_code == HTTPStatus.OK

    # DB row must have dismissed_at set (queried via col()).
    db_session.expire_all()
    row_result = await db_session.execute(
        select(InvitationSignal).where(col(InvitationSignal.id) == inv_id)
    )
    row = row_result.scalars().one()
    assert row.dismissed_at is not None

    # Subsequent GET must not include the dismissed row.
    list_resp = await async_client.get(_LIST_URL, headers=headers)
    assert list_resp.status_code == HTTPStatus.OK
    returned_ids = {item["id"] for item in list_resp.json()}
    assert inv_id not in returned_ids


# ---------------------------------------------------------------------------
# 4. DISMISS blocks regeneration of the same coordinate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dismissed_invitation_is_not_regenerated(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A dismissed invitation is never recreated even when conditions still hold."""
    headers = await _signup(async_client, "inv_regen4")

    user_result = await db_session.execute(
        select(User).where(col(User.email) == "inv_regen4@example.com")
    )
    user = user_result.scalars().one()
    assert user.id is not None

    # First GET generates the invitation.
    habit_id = await _make_habit_with_streak(db_session, user.id, streak_days=_SUSTAINED_STREAK)
    first_resp = await async_client.get(_LIST_URL, headers=headers)
    assert first_resp.status_code == HTTPStatus.OK
    first_items = first_resp.json()
    matching = [i for i in first_items if i["target_id"] == habit_id]
    assert len(matching) == 1
    inv_id = matching[0]["id"]

    # Dismiss the generated invitation.
    dismiss_resp = await async_client.post(f"{_LIST_URL}/{inv_id}/dismiss", headers=headers)
    assert dismiss_resp.status_code == HTTPStatus.OK

    # Conditions still hold (habit streak unchanged); GET again.
    second_resp = await async_client.get(_LIST_URL, headers=headers)
    assert second_resp.status_code == HTTPStatus.OK

    # The dismissed coordinate must not reappear.
    second_items = second_resp.json()
    regenerated = [i for i in second_items if i["id"] == inv_id]
    assert regenerated == []

    # Also confirm only one DB row for this coordinate (the dismissed one).
    uid = user.id
    db_session.expire_all()
    db_result = await db_session.execute(
        select(InvitationSignal).where(
            col(InvitationSignal.user_id) == uid,
            col(InvitationSignal.target_id) == habit_id,
            col(InvitationSignal.kind) == "consistency",
        )
    )
    db_rows = list(db_result.scalars().all())
    assert len(db_rows) == 1
    assert db_rows[0].dismissed_at is not None


# ---------------------------------------------------------------------------
# 5. Idempotent dismiss: re-dismissing returns 200 no-op
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dismiss_is_idempotent(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Dismissing an already-dismissed row returns 200 without error."""
    headers = await _signup(async_client, "inv_idem5")

    user_result = await db_session.execute(
        select(User).where(col(User.email) == "inv_idem5@example.com")
    )
    user = user_result.scalars().one()
    assert user.id is not None

    # Seed an already-dismissed row.
    inv_id = await _seed_dismissed_signal(
        db_session, user.id, target_type="habit", target_id=77, kind="mastery"
    )

    first_dismiss = await async_client.post(f"{_LIST_URL}/{inv_id}/dismiss", headers=headers)
    assert first_dismiss.status_code == HTTPStatus.OK

    second_dismiss = await async_client.post(f"{_LIST_URL}/{inv_id}/dismiss", headers=headers)
    assert second_dismiss.status_code == HTTPStatus.OK

    # Row must still be dismissed (not reset).
    db_session.expire_all()
    row_result = await db_session.execute(
        select(InvitationSignal).where(col(InvitationSignal.id) == inv_id)
    )
    row = row_result.scalars().one()
    assert row.dismissed_at is not None


# ---------------------------------------------------------------------------
# 6. Cross-user dismiss → 404 no-leak; GET isolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cross_user_dismiss_returns_404_no_leak(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """User A dismissing user B's invitation → 404; same detail as a missing id."""
    alice_headers = await _signup(async_client, "inv_alice6")
    bob_headers = await _signup(async_client, "inv_bob6")

    bob_result = await db_session.execute(
        select(User).where(col(User.email) == "inv_bob6@example.com")
    )
    bob = bob_result.scalars().one()
    assert bob.id is not None

    # Bob has a pending row.
    bob_inv_id = await _seed_pending_signal(
        db_session, bob.id, target_type="habit", target_id=44, kind="consistency"
    )

    # Alice tries to dismiss Bob's invitation.
    cross_resp = await async_client.post(f"{_LIST_URL}/{bob_inv_id}/dismiss", headers=alice_headers)
    assert cross_resp.status_code == HTTPStatus.NOT_FOUND
    assert cross_resp.json()["detail"] == "invitation_not_found"

    # A truly-missing id must produce the same detail (no existence leak).
    missing_resp = await async_client.post(f"{_LIST_URL}/999999/dismiss", headers=alice_headers)
    assert missing_resp.status_code == HTTPStatus.NOT_FOUND
    assert missing_resp.json()["detail"] == "invitation_not_found"

    # Alice's GET must never show Bob's rows.
    alice_resp = await async_client.get(_LIST_URL, headers=alice_headers)
    assert alice_resp.status_code == HTTPStatus.OK
    returned_ids = {item["id"] for item in alice_resp.json()}
    assert bob_inv_id not in returned_ids

    # Bob's own GET must still include his pending row (unaffected by Alice).
    bob_resp = await async_client.get(_LIST_URL, headers=bob_headers)
    assert bob_resp.status_code == HTTPStatus.OK
    bob_returned_ids = {item["id"] for item in bob_resp.json()}
    assert bob_inv_id in bob_returned_ids

    # Bob's row remains pending (not mutated by Alice's attempt).
    db_session.expire_all()
    row_result = await db_session.execute(
        select(InvitationSignal).where(col(InvitationSignal.id) == bob_inv_id)
    )
    row = row_result.scalars().one()
    assert row.dismissed_at is None


# ---------------------------------------------------------------------------
# 7. Auth 401 — both endpoints require a valid token
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_invitations_requires_auth(async_client: AsyncClient) -> None:
    """GET /invitations without a token returns 401."""
    resp = await async_client.get(_LIST_URL)

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_get_invitations_invalid_token_returns_401(async_client: AsyncClient) -> None:
    """GET /invitations with a malformed token returns 401."""
    resp = await async_client.get(
        _LIST_URL,
        headers={"Authorization": "Bearer not.a.real.token"},
    )

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_dismiss_requires_auth(async_client: AsyncClient) -> None:
    """POST /invitations/{id}/dismiss without a token returns 401."""
    resp = await async_client.post(f"{_LIST_URL}/1/dismiss")

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_dismiss_invalid_token_returns_401(async_client: AsyncClient) -> None:
    """POST /invitations/{id}/dismiss with a bad token returns 401."""
    resp = await async_client.post(
        f"{_LIST_URL}/1/dismiss",
        headers={"Authorization": "Bearer not.a.real.token"},
    )

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ---------------------------------------------------------------------------
# 8. Response shape: required keys present, user_id absent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_response_shape_has_required_keys_and_excludes_user_id(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Each item in GET /invitations has the required keys and omits user_id."""
    headers = await _signup(async_client, "inv_shape8")

    user_result = await db_session.execute(
        select(User).where(col(User.email) == "inv_shape8@example.com")
    )
    user = user_result.scalars().one()
    assert user.id is not None

    await _seed_pending_signal(
        db_session, user.id, target_type="course", target_id=5, kind="readiness"
    )

    resp = await async_client.get(_LIST_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    items = resp.json()
    assert len(items) >= 1

    for item in items:
        for key in _REQUIRED_KEYS:
            assert key in item, f"response item missing required key '{key}'"
        assert _FORBIDDEN_KEY not in item, f"response item must not expose '{_FORBIDDEN_KEY}'"
        assert isinstance(item["id"], int)
        assert isinstance(item["target_type"], str)
        assert isinstance(item["kind"], str)
        assert isinstance(item["created_at"], str)


# ---------------------------------------------------------------------------
# 9. GET /invitations surfaces a Creek Vault corpus-theme candidate
# ---------------------------------------------------------------------------


class _ThemeVaultClient:
    """A minimal fake CreekVaultClient exposing only the wheel path."""

    def __init__(
        self,
        *,
        available: bool = True,
        capabilities: frozenset[CreekCapability] = frozenset({CreekCapability.WHEEL}),
        wheel_result: VaultWheelBalance | None = None,
    ) -> None:
        """Store the scripted handshake outcome and wheel result."""
        self._available = available
        self._capabilities = capabilities
        self._wheel_result = wheel_result

    async def handshake(self) -> HandshakeResult:
        """Return the scripted availability/capabilities."""
        return HandshakeResult(
            available=self._available,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=self._capabilities,
            attestation=None,
        )

    def is_available(self) -> bool:
        """Return the scripted availability."""
        return self._available

    def supports(self, capability: CreekCapability, /) -> bool:
        """Return whether ``capability`` is in the scripted capability set."""
        return capability in self._capabilities

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Unused on the wheel path; raises if a test calls it by mistake."""
        raise NotImplementedError(request)

    async def classify(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Unused on the wheel path; raises if a test calls it by mistake."""
        raise NotImplementedError((body, tier_ceiling))

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> str:
        """Unused on the wheel path; raises if a test calls it by mistake."""
        raise NotImplementedError((body, tier_ceiling))

    async def wheel(self) -> VaultWheelBalance:
        """Return the scripted balance."""
        assert self._wheel_result is not None
        return self._wheel_result


@pytest.mark.asyncio
async def test_get_invitations_includes_vault_theme_candidate(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A valid vault wheel with an above-threshold theme surfaces alongside behavioral ones."""
    theme_stage = 6
    aspects = tuple(
        VaultWheelAspect(
            stage_number=n,
            aspect=f"Aspect-{n}",
            fullness=0.9 if n == theme_stage else 0.1,
        )
        for n in range(1, TOTAL_STAGES + 1)
    )
    fake_vault = _ThemeVaultClient(wheel_result=VaultWheelBalance(aspects=aspects))
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    headers = await _signup(async_client, "inv_vault_theme9")

    user_result = await db_session.execute(
        select(User).where(col(User.email) == "inv_vault_theme9@example.com")
    )
    user = user_result.scalars().one()
    assert user.id is not None
    habit_id = await _make_habit_with_streak(db_session, user.id, streak_days=_SUSTAINED_STREAK)

    resp = await async_client.get(_LIST_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    items = resp.json()
    course_items = [i for i in items if i["target_type"] == "course"]
    habit_items = [i for i in items if i["target_type"] == "habit"]
    assert len(course_items) == 1
    assert course_items[0]["target_id"] == theme_stage
    assert course_items[0]["kind"] == "readiness"
    assert habit_id in [i["target_id"] for i in habit_items]
