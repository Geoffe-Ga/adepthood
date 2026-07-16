"""Accept / dismiss endpoints for completion suggestions (#818)."""

from __future__ import annotations

from datetime import date
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from models.completion_suggestion import (
    CompletionSuggestion,
    CompletionTargetType,
    SuggestionStatus,
)
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.practice import Practice
from models.practice_session import PracticeSession
from models.user import User
from models.user_practice import UserPractice

_BODY = "I went for a run today and it felt good."


async def _signup(client: AsyncClient, username: str = "acc") -> dict[str, str]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _user_id(session: AsyncSession, username: str = "acc") -> int:
    user = (
        await session.execute(select(User).where(col(User.email) == f"{username}@example.com"))
    ).scalar_one()
    assert user.id is not None
    return user.id


async def _create_entry(client: AsyncClient, headers: dict[str, str]) -> int:
    resp = await client.post("/journal/", json={"message": _BODY}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


async def _seed_goal(session: AsyncSession, user_id: int, target: float = 5.0) -> int:
    """Seed a habit + clear-tier goal; return the goal id."""
    habit = Habit(
        name="Run",
        icon="🏃",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    goal = Goal(
        habit_id=habit.id,
        title="clear",
        tier="clear",
        target=target,
        target_unit="miles",
        frequency=1.0,
        frequency_unit="per_day",
        is_additive=True,
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    assert goal.id is not None
    return goal.id


async def _seed_user_practice(session: AsyncSession, user_id: int) -> int:
    """Seed a Practice + UserPractice; return the user_practice id."""
    practice = Practice(
        stage_number=1,
        name="Sit",
        description="A sit.",
        instructions="Sit and breathe.",
        default_duration_minutes=10.0,
        mode="meditation_timer",
        mode_config={"mode": "meditation_timer", "duration_minutes": 10},
    )
    session.add(practice)
    await session.commit()
    await session.refresh(practice)
    user_practice = UserPractice(
        user_id=user_id,
        practice_id=practice.id,
        stage_number=1,
        start_date=date(2025, 1, 1),
    )
    session.add(user_practice)
    await session.commit()
    await session.refresh(user_practice)
    assert user_practice.id is not None
    return user_practice.id


async def _seed_locked_user_practice(session: AsyncSession, user_id: int) -> int:
    """Seed a Practice + UserPractice assigned to a locked future stage (stage 2).

    A fresh user has no ``StageProgress``, so stage 2 is locked. Forward-planning
    a practice there is allowed, but journaling it into a real session must not be.
    """
    practice = Practice(
        stage_number=2,
        name="Sit",
        description="A sit.",
        instructions="Sit and breathe.",
        default_duration_minutes=10.0,
        mode="meditation_timer",
        mode_config={"mode": "meditation_timer", "duration_minutes": 10},
    )
    session.add(practice)
    await session.commit()
    await session.refresh(practice)
    user_practice = UserPractice(
        user_id=user_id,
        practice_id=practice.id,
        stage_number=2,
        start_date=date(2025, 1, 1),
    )
    session.add(user_practice)
    await session.commit()
    await session.refresh(user_practice)
    assert user_practice.id is not None
    return user_practice.id


async def _seed_suggestion(
    session: AsyncSession,
    *,
    entry_id: int,
    user_id: int,
    goal_id: int,
    status: SuggestionStatus = SuggestionStatus.PENDING,
) -> int:
    """Seed a pending (default) HABIT suggestion; return its id."""
    suggestion = CompletionSuggestion(
        journal_entry_id=entry_id,
        user_id=user_id,
        target_type=CompletionTargetType.HABIT,
        goal_id=goal_id,
        user_practice_id=None,
        label="went for a run",
        anchor_start=2,
        anchor_end=22,
        anchor_text="went for a run today",
        status=status,
    )
    session.add(suggestion)
    await session.commit()
    await session.refresh(suggestion)
    assert suggestion.id is not None
    return suggestion.id


async def _completion_count(session: AsyncSession, goal_id: int) -> int:
    result = await session.execute(
        select(func.count())
        .select_from(GoalCompletion)
        .where(col(GoalCompletion.goal_id) == goal_id)
    )
    return int(result.scalar_one())


@pytest.mark.asyncio
async def test_accept_logs_completion_and_flips_to_accepted(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Accept a pending habit suggestion → logs a completion + accepted + streak."""
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    sug_id = await _seed_suggestion(db_session, entry_id=entry_id, user_id=user_id, goal_id=goal_id)

    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["suggestion"]["status"] == "accepted"
    assert data["suggestion"]["accepted_at"] is not None
    assert "user_id" not in data["suggestion"]
    assert data["check_in"]["streak"] == 1
    assert await _completion_count(db_session, goal_id) == 1


@pytest.mark.asyncio
async def test_accept_is_idempotent_per_goal_day(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A same-day manual check-in then accept does NOT double-count the completion."""
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    sug_id = await _seed_suggestion(db_session, entry_id=entry_id, user_id=user_id, goal_id=goal_id)

    # Manual check-in first, then accept the suggestion the same day.
    first = await async_client.post(
        "/goal_completions/", json={"goal_id": goal_id, "did_complete": True}, headers=headers
    )
    assert first.status_code == HTTPStatus.OK
    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["suggestion"]["status"] == "accepted"
    assert await _completion_count(db_session, goal_id) == 1  # not 2


@pytest.mark.asyncio
async def test_accept_already_accepted_is_noop(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-accepting an accepted suggestion is a no-op (no second completion)."""
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    sug_id = await _seed_suggestion(db_session, entry_id=entry_id, user_id=user_id, goal_id=goal_id)

    await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)
    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["suggestion"]["status"] == "accepted"
    assert await _completion_count(db_session, goal_id) == 1


@pytest.mark.asyncio
async def test_accept_dismissed_is_conflict(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Accepting a dismissed suggestion is a 409 illegal transition."""
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
        status=SuggestionStatus.DISMISSED,
    )

    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.CONFLICT


async def _seed_practice_suggestion(
    session: AsyncSession, *, entry_id: int, user_id: int, user_practice_id: int
) -> int:
    """Seed a pending PRACTICE suggestion targeting ``user_practice_id``."""
    suggestion = CompletionSuggestion(
        journal_entry_id=entry_id,
        user_id=user_id,
        target_type=CompletionTargetType.PRACTICE,
        goal_id=None,
        user_practice_id=user_practice_id,
        label="a sit",
        anchor_start=0,
        anchor_end=5,
        anchor_text="I sat",
        status=SuggestionStatus.PENDING,
    )
    session.add(suggestion)
    await session.commit()
    await session.refresh(suggestion)
    assert suggestion.id is not None
    return suggestion.id


async def _practice_session_count(session: AsyncSession, user_practice_id: int) -> int:
    result = await session.execute(
        select(func.count())
        .select_from(PracticeSession)
        .where(col(PracticeSession.user_practice_id) == user_practice_id)
    )
    return int(result.scalar_one())


@pytest.mark.asyncio
async def test_accept_practice_logs_journal_attested_session(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Accepting a practice logs a completed, journal-attested PracticeSession (#821)."""
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    entry_id = await _create_entry(async_client, headers)
    up_id = await _seed_user_practice(db_session, user_id)
    sug_id = await _seed_practice_suggestion(
        db_session, entry_id=entry_id, user_id=user_id, user_practice_id=up_id
    )

    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["suggestion"]["status"] == "accepted"
    assert body["check_in"] is None  # practices carry no streak
    assert "user_id" not in body["suggestion"]
    ps = (
        await db_session.execute(
            select(PracticeSession).where(col(PracticeSession.user_practice_id) == up_id)
        )
    ).scalar_one()
    assert ps.completed is True
    assert ps.mode_metadata is not None
    assert ps.mode_metadata["attested_via"] == "journal"


@pytest.mark.asyncio
async def test_accept_practice_is_idempotent(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-accepting a practice suggestion does not log a second session (#821)."""
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    entry_id = await _create_entry(async_client, headers)
    up_id = await _seed_user_practice(db_session, user_id)
    sug_id = await _seed_practice_suggestion(
        db_session, entry_id=entry_id, user_id=user_id, user_practice_id=up_id
    )

    first = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)
    second = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert first.status_code == HTTPStatus.OK
    assert second.status_code == HTTPStatus.OK
    assert second.json()["check_in"] is None
    assert await _practice_session_count(db_session, up_id) == 1


@pytest.mark.asyncio
async def test_accept_practice_for_locked_stage_is_forbidden(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Accepting a suggestion for a locked-stage practice must 403 and log nothing.

    Forward-planning a practice into a future stage is allowed, but journal
    attestation cannot log a real session there before the stage unlocks --
    the same access boundary the direct session endpoint enforces.
    """
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    entry_id = await _create_entry(async_client, headers)
    up_id = await _seed_locked_user_practice(db_session, user_id)
    sug_id = await _seed_practice_suggestion(
        db_session, entry_id=entry_id, user_id=user_id, user_practice_id=up_id
    )

    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "stage_locked"
    assert await _practice_session_count(db_session, up_id) == 0
    suggestion = (
        await db_session.execute(
            select(CompletionSuggestion).where(col(CompletionSuggestion.id) == sug_id)
        )
    ).scalar_one()
    await db_session.refresh(suggestion)
    assert suggestion.status == SuggestionStatus.PENDING


@pytest.mark.asyncio
async def test_dismiss_pending_then_idempotent(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Dismiss flips pending → dismissed and is idempotent on repeat."""
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    sug_id = await _seed_suggestion(db_session, entry_id=entry_id, user_id=user_id, goal_id=goal_id)

    first = await async_client.post(f"/journal/suggestions/{sug_id}/dismiss", headers=headers)
    assert first.status_code == HTTPStatus.OK
    assert first.json()["status"] == "dismissed"
    assert "user_id" not in first.json()

    again = await async_client.post(f"/journal/suggestions/{sug_id}/dismiss", headers=headers)
    assert again.status_code == HTTPStatus.OK
    assert again.json()["status"] == "dismissed"


@pytest.mark.asyncio
async def test_dismiss_accepted_is_conflict(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Dismissing an accepted suggestion is a 409 illegal transition."""
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
        status=SuggestionStatus.ACCEPTED,
    )

    resp = await async_client.post(f"/journal/suggestions/{sug_id}/dismiss", headers=headers)

    assert resp.status_code == HTTPStatus.CONFLICT


@pytest.mark.asyncio
async def test_accept_foreign_suggestion_is_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Another user's suggestion is 404 (enumeration-safe) on both verbs."""
    owner_headers = await _signup(async_client, "owner")
    owner_id = await _user_id(db_session, "owner")
    goal_id = await _seed_goal(db_session, owner_id)
    entry_id = await _create_entry(async_client, owner_headers)
    sug_id = await _seed_suggestion(
        db_session, entry_id=entry_id, user_id=owner_id, goal_id=goal_id
    )

    attacker_headers = await _signup(async_client, "attacker")
    accept = await async_client.post(
        f"/journal/suggestions/{sug_id}/accept", headers=attacker_headers
    )
    dismiss = await async_client.post(
        f"/journal/suggestions/{sug_id}/dismiss", headers=attacker_headers
    )

    assert accept.status_code == HTTPStatus.NOT_FOUND
    assert dismiss.status_code == HTTPStatus.NOT_FOUND
