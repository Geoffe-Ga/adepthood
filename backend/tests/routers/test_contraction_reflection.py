"""Router tests -- contraction reflection riding the resonance endpoint.

These tests FAIL until ``ResonanceResponse.contraction`` (schemas/marginalia.py)
and its wiring into ``run_resonance`` (routers/journal.py) exist. That is the
correct RED state for Gate 1.

The reflection is a warm, declinable Higher Self surface -- never a demotion --
and must never alter stage progression, never touch the intimate privacy floor,
and never drift from the domain's ContractionVariant enum.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from domain.contraction import FOUNDATION_UNMET_CONSECUTIVE_DAYS, ContractionVariant
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.stage_progress import StageProgress
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse

_BODY = "I walked by the river and the willow bent without breaking."


async def _signup(
    client: AsyncClient, username: str = "contractionuser"
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


async def _create_entry(
    client: AsyncClient,
    headers: dict[str, str],
    *,
    body: str = _BODY,
    classification: str | None = None,
) -> int:
    """POST a journal entry and return its id."""
    payload: dict[str, str] = {"message": body}
    if classification is not None:
        payload["classification"] = classification
    resp = await client.post("/journal/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


def _fake_llm(monkeypatch: pytest.MonkeyPatch, *notes: dict[str, str]) -> None:
    """Patch the resonance LLM seam to return canned JSON notes."""
    payload = json.dumps({"notes": list(notes)})

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        return LLMResponse(
            text=payload,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)


async def _make_flagged_habit(session: AsyncSession, user_id: int) -> None:
    """Seed a habit whose goal has gone unmet for the full contraction window."""
    habit = Habit(
        name="Meditate",
        icon="flame",
        start_date=date(2020, 1, 1),
        stage="1",
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
        is_additive=True,
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    assert goal.id is not None

    now = datetime.now(UTC)
    for days_ago in range(FOUNDATION_UNMET_CONSECUTIVE_DAYS):
        session.add(
            GoalCompletion(
                goal_id=goal.id,
                user_id=user_id,
                completed_units=0.0,
                timestamp=now - timedelta(days=days_ago),
            )
        )
    await session.commit()


async def _make_healthy_habit(session: AsyncSession, user_id: int) -> None:
    """Seed a habit with recent positive completions -- no contraction signal."""
    habit = Habit(
        name="Meditate",
        icon="flame",
        start_date=date(2020, 1, 1),
        stage="1",
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
        is_additive=True,
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    assert goal.id is not None

    now = datetime.now(UTC)
    for days_ago in range(3):
        session.add(
            GoalCompletion(
                goal_id=goal.id,
                user_id=user_id,
                completed_units=1.0,
                timestamp=now - timedelta(days=days_ago),
            )
        )
    await session.commit()


# ---------------------------------------------------------------------------
# 1. Flagged user -> non-null contraction reflection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_flagged_user_receives_contraction_reflection(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A user in a flagged contraction condition gets a non-null contraction object."""
    _fake_llm(monkeypatch, {"kind": "theme", "quote": "the willow bent", "note": "It holds."})
    headers, user_id = await _signup(async_client, "flaggeduser")
    await _make_flagged_habit(db_session, user_id)
    entry_id = await _create_entry(async_client, headers, classification="personal")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["contraction"] is not None
    assert body["contraction"]["variant"]
    assert body["contraction"]["message"]


# ---------------------------------------------------------------------------
# 2. Healthy user -> contraction is null/absent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_healthy_user_has_no_contraction_reflection(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A healthy user's resonance response carries no contraction object."""
    _fake_llm(monkeypatch, {"kind": "theme", "quote": "the willow bent", "note": "It holds."})
    headers, user_id = await _signup(async_client, "healthyuser")
    await _make_healthy_habit(db_session, user_id)
    entry_id = await _create_entry(async_client, headers, classification="personal")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body.get("contraction") is None


# ---------------------------------------------------------------------------
# 3. Intimate entry -> private path, contraction null, no cloud call
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_intimate_entry_keeps_contraction_null_and_stays_private(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An intimate entry's resonance stays private: contraction is null, LLM untouched."""

    class _SpyLLM:
        """Counts calls; must never be reached for an intimate entry."""

        def __init__(self) -> None:
            self.calls = 0

        async def __call__(
            self, prompt: str, history: object, *, system_prompt: object, api_key: object
        ) -> LLMResponse:
            del prompt, history, system_prompt, api_key
            self.calls += 1
            return LLMResponse(
                text='{"notes":[]}',
                provider="stub",
                model=STUB_MODEL_NAME,
                prompt_tokens=0,
                completion_tokens=0,
            )

    spy = _SpyLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    headers, user_id = await _signup(async_client, "intimatecontraction")
    await _make_flagged_habit(db_session, user_id)
    entry_id = await _create_entry(async_client, headers, classification="intimate")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body.get("contraction") is None
    assert body["private"] is True
    assert spy.calls == 0, "the intimate privacy floor must hold even under a flagged contraction"


# ---------------------------------------------------------------------------
# 4. No side effects on progression
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resonance_pass_does_not_mutate_progression(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A resonance pass under a flagged contraction never changes stage progress."""
    _fake_llm(monkeypatch, {"kind": "theme", "quote": "the willow bent", "note": "It holds."})
    headers, user_id = await _signup(async_client, "noprogressmutation")
    await _make_flagged_habit(db_session, user_id)

    progress = StageProgress(user_id=user_id, current_stage=2, completed_stages=[1])
    db_session.add(progress)
    await db_session.commit()

    entries_before = (
        await db_session.execute(select(func.count()).select_from(JournalEntry))
    ).scalar_one()

    entry_id = await _create_entry(async_client, headers, classification="personal")
    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text

    refreshed = (
        await db_session.execute(select(StageProgress).where(col(StageProgress.user_id) == user_id))
    ).scalar_one()
    assert refreshed.current_stage == 2
    assert refreshed.completed_stages == [1]

    # One new entry from _create_entry is expected; the resonance pass itself
    # must not create any additional journal entries.
    entries_after = (
        await db_session.execute(select(func.count()).select_from(JournalEntry))
    ).scalar_one()
    assert entries_after == entries_before + 1


# ---------------------------------------------------------------------------
# 5. Schema<->enum drift guard
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_contraction_variant_does_not_drift_from_domain_enum(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The variant returned by the endpoint is always a valid ContractionVariant value."""
    _fake_llm(monkeypatch, {"kind": "theme", "quote": "the willow bent", "note": "It holds."})
    headers, user_id = await _signup(async_client, "driftguard")
    await _make_flagged_habit(db_session, user_id)
    entry_id = await _create_entry(async_client, headers, classification="personal")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    contraction = body.get("contraction")
    assert contraction is not None
    valid_variants = {v.value for v in ContractionVariant}
    assert contraction["variant"] in valid_variants
