"""Endpoint tests for GET /stages/wheel — Wheel of Wholeness balance."""

from __future__ import annotations

from datetime import date
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

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
from models.course_stage import CourseStage
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from services.creek_vault_write import get_creek_vault_client

_TOTAL_STAGES = 10

# Synthetic aspect label per fixture stage; local test values, not the
# canonical seed ontology from seed_stages.py.
_CANONICAL_ASPECTS = [
    "Body",
    "Body",
    "Emotion",
    "Emotion",
    "Mind",
    "Mind",
    "Spirit",
    "Spirit",
    "Nondual",
    "Nondual",
]


def _stage_data(stage_number: int) -> dict[str, object]:
    """Valid CourseStage fields for direct DB insertion."""
    return {
        "title": f"Stage {stage_number}",
        "subtitle": "sub",
        "stage_number": stage_number,
        "overview_url": "",
        "category": "test",
        "aspect": _CANONICAL_ASPECTS[stage_number - 1],
        "spiral_dynamics_color": "beige",
        "growing_up_stage": "archaic",
        "divine_gender_polarity": "masculine",
        "relationship_to_free_will": "active",
        "free_will_description": "desc",
    }


async def _signup(
    client: AsyncClient,
    username: str = "wheeluser",
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


async def _seed_all_stages(db_session: AsyncSession) -> None:
    """Insert all ten CourseStage rows."""
    for n in range(1, _TOTAL_STAGES + 1):
        db_session.add(CourseStage(**_stage_data(n)))
    await db_session.commit()


async def _seed_habit_with_completion(
    db_session: AsyncSession, user_id: int, stage_number: int
) -> None:
    """Seed one habit with one goal and one completion for the given stage."""
    habit = Habit(
        name=f"HW-{stage_number}-{user_id}",
        icon="x",
        start_date=date(2026, 1, 1),
        energy_cost=1,
        energy_return=1,
        user_id=user_id,
        stage=str(stage_number),
        streak=0,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)
    goal = Goal(
        habit_id=habit.id,
        title="g",
        tier="t",
        target=1,
        target_unit="rep",
        frequency=1,
        frequency_unit="per_day",
    )
    db_session.add(goal)
    await db_session.commit()
    await db_session.refresh(goal)
    db_session.add(GoalCompletion(goal_id=goal.id, user_id=user_id, completed_units=1))
    await db_session.commit()


# ── B. Endpoint tests ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_wheel_endpoint_requires_auth(async_client: AsyncClient) -> None:
    """Missing token → 401."""
    resp = await async_client.get("/stages/wheel")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_wheel_endpoint_invalid_token_returns_401(async_client: AsyncClient) -> None:
    """Invalid bearer token → 401."""
    resp = await async_client.get(
        "/stages/wheel", headers={"Authorization": "Bearer not-a-real-token"}
    )
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_wheel_endpoint_authed_returns_200(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Authenticated request → 200 with ten balance items."""
    await _seed_all_stages(db_session)
    headers, _uid = await _signup(async_client, "wheel_200")

    resp = await async_client.get("/stages/wheel", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert "aspects" in data, f"response missing 'aspects' key: {data}"
    assert len(data["aspects"]) == _TOTAL_STAGES


@pytest.mark.asyncio
async def test_wheel_endpoint_new_user_all_zero(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """New user → all ten fullness values are 0.0."""
    await _seed_all_stages(db_session)
    headers, _uid = await _signup(async_client, "wheel_newuser")

    resp = await async_client.get("/stages/wheel", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    aspects = resp.json()["aspects"]
    assert len(aspects) == _TOTAL_STAGES
    for item in aspects:
        assert item["fullness"] == 0.0, (
            f"stage {item['stage_number']} expected 0.0 fullness, got {item['fullness']}"
        )


@pytest.mark.asyncio
async def test_wheel_endpoint_canonical_stage_order(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Items are in stage_number 1..10 order, not sorted by fullness."""
    await _seed_all_stages(db_session)
    headers, user_id = await _signup(async_client, "wheel_order")
    # Engage stage 9 so it has fullness > 0, earlier stages do not
    await _seed_habit_with_completion(db_session, user_id, 9)

    resp = await async_client.get("/stages/wheel", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    stage_numbers = [item["stage_number"] for item in resp.json()["aspects"]]
    assert stage_numbers == list(range(1, _TOTAL_STAGES + 1))


@pytest.mark.asyncio
async def test_wheel_endpoint_response_schema_shape(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Each aspect item exposes exactly stage_number, aspect, and fullness fields."""
    await _seed_all_stages(db_session)
    headers, _uid = await _signup(async_client, "wheel_schema")

    resp = await async_client.get("/stages/wheel", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    for item in resp.json()["aspects"]:
        assert "stage_number" in item, f"missing stage_number: {item}"
        assert "aspect" in item, f"missing aspect: {item}"
        assert "fullness" in item, f"missing fullness: {item}"
        assert isinstance(item["stage_number"], int)
        assert isinstance(item["aspect"], str)
        assert isinstance(item["fullness"], float)
        assert 0.0 <= item["fullness"] <= 1.0


@pytest.mark.asyncio
async def test_wheel_endpoint_aspect_labels_match_stages(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Aspect strings in the response match the canonical stage-to-aspect mapping."""
    await _seed_all_stages(db_session)
    headers, _uid = await _signup(async_client, "wheel_aspect")

    resp = await async_client.get("/stages/wheel", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    for item in resp.json()["aspects"]:
        expected = _CANONICAL_ASPECTS[item["stage_number"] - 1]
        assert item["aspect"] == expected, (
            f"stage {item['stage_number']}: expected {expected!r}, got {item['aspect']!r}"
        )


@pytest.mark.asyncio
async def test_wheel_endpoint_reflects_engagement(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Engaged stage shows fullness > 0.0; untouched stages remain 0.0."""
    await _seed_all_stages(db_session)
    headers, user_id = await _signup(async_client, "wheel_engagement")
    engaged_stage = 6
    await _seed_habit_with_completion(db_session, user_id, engaged_stage)

    resp = await async_client.get("/stages/wheel", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    aspects = resp.json()["aspects"]
    engaged = next(a for a in aspects if a["stage_number"] == engaged_stage)
    assert engaged["fullness"] > 0.0
    for item in aspects:
        if item["stage_number"] != engaged_stage:
            assert item["fullness"] == 0.0


@pytest.mark.asyncio
async def test_wheel_endpoint_user_isolation(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """User A's engagement does not appear in User B's wheel response."""
    await _seed_all_stages(db_session)
    alice_headers, alice_id = await _signup(async_client, "wheel_alice")
    bob_headers, _bob_id = await _signup(async_client, "wheel_bob")

    # Only Alice engages stage 2
    await _seed_habit_with_completion(db_session, alice_id, 2)

    alice_resp = await async_client.get("/stages/wheel", headers=alice_headers)
    bob_resp = await async_client.get("/stages/wheel", headers=bob_headers)

    assert alice_resp.status_code == HTTPStatus.OK
    assert bob_resp.status_code == HTTPStatus.OK

    alice_stage2 = next(a for a in alice_resp.json()["aspects"] if a["stage_number"] == 2)
    bob_stage2 = next(a for a in bob_resp.json()["aspects"] if a["stage_number"] == 2)
    assert alice_stage2["fullness"] > 0.0
    assert bob_stage2["fullness"] == 0.0


# ── C. Creek Vault classification source ────────────────────────────────────


class _WheelVaultClient:
    """A minimal fake CreekVaultClient exposing only the wheel path."""

    def __init__(
        self,
        *,
        available: bool = True,
        capabilities: frozenset[CreekCapability] = frozenset({CreekCapability.WHEEL}),
        wheel_result: VaultWheelBalance | None = None,
    ) -> None:
        """Store the scripted handshake outcome and wheel result."""
        self.handshake_calls = 0
        self._available = available
        self._capabilities = capabilities
        self._wheel_result = wheel_result

    async def handshake(self) -> HandshakeResult:
        """Record the call and return the scripted availability/capabilities."""
        self.handshake_calls += 1
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
async def test_wheel_endpoint_uses_vault_values_when_connected(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A connected, valid vault's fullness values win over local math."""
    await _seed_all_stages(db_session)
    headers, user_id = await _signup(async_client, "wheel_vault_connected")
    # Local computation would give stage 1 fullness == 0.0 (no engagement); the
    # vault reports a distinct, non-zero value that must win instead.
    await _seed_habit_with_completion(db_session, user_id, 1)
    vault_aspects = tuple(
        VaultWheelAspect(stage_number=n, aspect=f"VaultAspect-{n}", fullness=0.42)
        for n in range(1, _TOTAL_STAGES + 1)
    )
    fake_vault = _WheelVaultClient(wheel_result=VaultWheelBalance(aspects=vault_aspects))
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault

    resp = await async_client.get("/stages/wheel", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    aspects = resp.json()["aspects"]
    assert len(aspects) == _TOTAL_STAGES
    for item in aspects:
        assert item["fullness"] == 0.42
        assert item["aspect"] == f"VaultAspect-{item['stage_number']}"


@pytest.mark.asyncio
async def test_wheel_endpoint_falls_back_to_local_when_vault_unavailable(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """No usable vault -> the endpoint keeps serving local math, same as before."""
    await _seed_all_stages(db_session)
    headers, user_id = await _signup(async_client, "wheel_vault_unavailable")
    engaged_stage = 3
    await _seed_habit_with_completion(db_session, user_id, engaged_stage)
    fake_vault = _WheelVaultClient(available=False)
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault

    resp = await async_client.get("/stages/wheel", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    aspects = resp.json()["aspects"]
    engaged = next(a for a in aspects if a["stage_number"] == engaged_stage)
    assert engaged["fullness"] > 0.0
    for item in aspects:
        if item["stage_number"] != engaged_stage:
            assert item["fullness"] == 0.0
    # The router must still probe the vault (and degrade) rather than never
    # wiring it in at all -- this is the delta the vault-consuming wiring adds.
    assert fake_vault.handshake_calls == 1
