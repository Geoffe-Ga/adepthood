"""Accept / dismiss endpoints for completion suggestions (#818)."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, date, datetime, time, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col

from domain.dates import MAX_BACKFILL_DAYS, today_in_tz
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
from routers import journal as journal_router
from services import checkin as checkin_service

_BODY = "I went for a run today and it felt good."

# Enough simultaneous accepts that a lock which only ORDERS them, rather than
# de-duplicating them, shows up as a multiplied day total.
_CONCURRENT_ACCEPT_FANOUT = 5

# A completion logged 45 days back, accepted 20 days ago: inside the 30-day
# window when it was accepted, outside it today.
_STALE_LOGGED_DAYS = 45
_STALE_ACCEPTED_DAYS = 20


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
    session: AsyncSession, *, entry_id: int, user_id: int, goal_id: int, **over: object
) -> int:
    """Seed a pending (default) HABIT suggestion; return its id.

    Overrides ride in ``**over`` rather than as named parameters, mirroring
    ``test_completion_suggestion_model._habit_suggestion``: the row has more
    optional columns than a helper may carry as arguments.
    """
    base: dict[str, object] = {
        "journal_entry_id": entry_id,
        "user_id": user_id,
        "target_type": CompletionTargetType.HABIT,
        "goal_id": goal_id,
        "user_practice_id": None,
        "label": "went for a run",
        "anchor_start": 2,
        "anchor_end": 22,
        "anchor_text": "went for a run today",
        "status": SuggestionStatus.PENDING,
    }
    base.update(over)
    suggestion = CompletionSuggestion(**base)
    session.add(suggestion)
    await session.commit()
    await session.refresh(suggestion)
    assert suggestion.id is not None
    return suggestion.id


async def _completion_row(session: AsyncSession, goal_id: int) -> GoalCompletion:
    """The single GoalCompletion row for a goal (fails loudly if there are 0 or 2)."""
    session.expire_all()
    result = await session.execute(
        select(GoalCompletion).where(col(GoalCompletion.goal_id) == goal_id)
    )
    return result.scalars().one()


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
    """A same-day manual check-in then an amount-less accept changes nothing.

    Asserts the day's *units* as well as the row count. A row count alone
    cannot see a doubled day: once a suggestion carries explicit units the
    accept takes the explicit path, which accumulates into the existing row
    rather than inserting a second one.
    """
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id, target=5.0)
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
    row = await _completion_row(db_session, goal_id)
    assert row.completed_units == 5.0  # the single target-sized log, not 10.0


@pytest.mark.asyncio
async def test_accept_with_units_on_a_day_already_logged_accumulates(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An accept carrying units adds to the day already logged; it does not replace it.

    This is the shipped ``_apply_explicit_delta`` semantic, stated by value:
    one row, its units summed, and ``units_adjusted`` rather than a streak code.
    """
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id, target=5.0)
    entry_id = await _create_entry(async_client, headers)
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
        completed_units=3.0,
    )

    first = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal_id, "completed_units": 2.0},
        headers=headers,
    )
    assert first.status_code == HTTPStatus.OK
    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["check_in"]["reason_code"] == "units_adjusted"
    assert resp.json()["check_in"]["day_units"] == 5.0
    assert await _completion_count(db_session, goal_id) == 1
    row = await _completion_row(db_session, goal_id)
    assert row.completed_units == 5.0  # 2.0 accumulated with 3.0, not replaced


@pytest.mark.asyncio
async def test_accept_logs_the_suggested_amount_on_the_suggested_day(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """#2842: a suggestion carrying units + a day logs THAT amount on THAT day."""
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id, target=64.0)
    entry_id = await _create_entry(async_client, headers)
    yesterday = today_in_tz("UTC") - timedelta(days=1)
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
        completed_units=32.0,
        completed_on=yesterday,
    )

    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["suggestion"]["completed_units"] == 32.0
    assert resp.json()["suggestion"]["completed_on"] == yesterday.isoformat()
    row = await _completion_row(db_session, goal_id)
    assert row.completed_units == 32.0  # NOT the goal target of 64.0
    assert row.local_day == yesterday  # NOT today
    # In window, so the day logged IS the day detected (#2905).
    assert resp.json()["suggestion"]["logged_on"] == yesterday.isoformat()


@pytest.mark.asyncio
async def test_accept_with_a_day_past_the_backfill_window_logs_today_and_still_returns_200(
    async_client: AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """A stale suggested day falls back to today rather than refusing the accept.

    The guard is a pre-check, never a swallowed ``HTTPException``: without it
    ``_resolve_target_day`` answers 400 ``completion_date_too_old`` and the
    writer loses a check-off they can see no way to complete.
    """
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    too_old = today_in_tz("UTC") - timedelta(days=MAX_BACKFILL_DAYS + 15)
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
        completed_units=2.0,
        completed_on=too_old,
    )

    with caplog.at_level(logging.INFO):
        resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    row = await _completion_row(db_session, goal_id)
    assert row.local_day == today_in_tz("UTC")
    assert [r.message for r in caplog.records].count("suggestion_day_out_of_window") == 1
    # The suggestion still reports what was detected; only the log day moved,
    # and ``logged_on`` records where it moved to (#2905).
    assert resp.json()["suggestion"]["completed_on"] == too_old.isoformat()
    assert resp.json()["suggestion"]["logged_on"] == row.local_day.isoformat()


@pytest.mark.asyncio
async def test_accept_with_a_future_day_logs_today_and_still_returns_200(
    async_client: AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """A suggested day after today falls back to today too.

    Unreachable at detection time, but a user who moves their timezone
    westward turns a day that was "today" into tomorrow.
    """
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    tomorrow = today_in_tz("UTC") + timedelta(days=1)
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
        completed_units=2.0,
        completed_on=tomorrow,
    )

    with caplog.at_level(logging.INFO):
        resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    row = await _completion_row(db_session, goal_id)
    assert row.local_day == today_in_tz("UTC")
    assert [r.message for r in caplog.records].count("suggestion_day_out_of_window") == 1


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
async def test_accept_already_accepted_reports_the_day_that_was_logged(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-accepting a backdated suggestion reports *that* day's units, not today's.

    Kept beside the plain no-op rather than folded into it so a regression in
    the day resolution and a regression in the untouched amount-less path stay
    distinguishable.
    """
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id, target=5.0)
    entry_id = await _create_entry(async_client, headers)
    yesterday = today_in_tz("UTC") - timedelta(days=1)
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
        completed_units=3.0,
        completed_on=yesterday,
    )

    first = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)
    assert first.json()["check_in"]["day_units"] == 3.0
    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["check_in"]["day_units"] == 3.0  # yesterday's, not today's 0.0
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
    assert body["suggestion"]["logged_on"] is None  # a practice logs no day (#2905)
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


@pytest.mark.asyncio
async def test_accepting_the_same_suggestion_twice_logs_its_units_once(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A retried accept must not add the amount a second time.

    ``record_goal_completion`` commits its arithmetic BEFORE the status flip
    commits -- they are two transactions, not one -- so a process that dies in
    between leaves the completion logged and the suggestion still PENDING. The
    client's retry then arrives at a suggestion that looks untouched, and the
    explicit path accumulates rather than no-opping: the natural-key guard
    ``_legacy_existing_response`` stands down as soon as ``completed_units`` is
    non-null. The operation key is what makes the retry harmless.
    """
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id, target=64.0)
    entry_id = await _create_entry(async_client, headers)
    sug_id = await _seed_suggestion(
        db_session, entry_id=entry_id, user_id=user_id, goal_id=goal_id, completed_units=16.0
    )

    first = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)
    assert first.status_code == HTTPStatus.OK
    assert first.json()["check_in"]["day_units"] == 16.0

    # Reopen exactly the window above: the arithmetic is durable, the flip is not.
    db_session.expire_all()
    suggestion = await db_session.get(CompletionSuggestion, sug_id)
    assert suggestion is not None
    suggestion.status = SuggestionStatus.PENDING
    suggestion.accepted_at = None
    db_session.add(suggestion)
    await db_session.commit()

    second = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert second.status_code == HTTPStatus.OK
    assert second.json()["check_in"]["day_units"] == 16.0  # the replay, NOT 32.0
    assert second.json()["suggestion"]["status"] == "accepted"
    assert await _completion_count(db_session, goal_id) == 1
    row = await _completion_row(db_session, goal_id)
    assert row.completed_units == 16.0  # the user drank 16, not 32


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_accepts_of_one_suggestion_log_its_units_once(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Simultaneous accepts of one suggestion apply its amount exactly once.

    Nothing serializes the PENDING read against the ACCEPTED flip, so every
    in-flight request sees PENDING and reaches the explicit delta. The habit
    lock orders them; only the operation key de-duplicates them.
    """
    signup = await concurrent_async_client.post(
        "/auth/signup",
        json={
            "email": "accept-race@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert signup.status_code == HTTPStatus.OK
    headers = {"Authorization": f"Bearer {signup.json()['token']}"}
    user_id = signup.json()["user_id"]

    entry = await concurrent_async_client.post(
        "/journal/", json={"message": _BODY}, headers=headers
    )
    assert entry.status_code == HTTPStatus.CREATED
    entry_id = int(entry.json()["id"])

    async with concurrent_session_factory() as session:
        goal_id = await _seed_goal(session, user_id, target=64.0)
        sug_id = await _seed_suggestion(
            session, entry_id=entry_id, user_id=user_id, goal_id=goal_id, completed_units=16.0
        )

    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)
            for _ in range(_CONCURRENT_ACCEPT_FANOUT)
        ]
    )

    assert all(r.status_code == HTTPStatus.OK for r in responses)
    assert {r.json()["check_in"]["day_units"] for r in responses} == {16.0}
    async with concurrent_session_factory() as session:
        rows = list(
            (
                await session.execute(
                    select(GoalCompletion).where(col(GoalCompletion.goal_id) == goal_id)
                )
            )
            .scalars()
            .all()
        )
    assert len(rows) == 1
    assert rows[0].completed_units == 16.0


@pytest.mark.asyncio
async def test_replaying_an_accept_reports_the_day_it_logged_even_once_the_window_has_slid(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The replay's window question is asked as of the ACCEPT, not as of now.

    A suggestion accepted well inside the backfill window drops out of it as
    the window slides forward. Re-deriving the day against *today* then answers
    ``None`` -- meaning today -- and the writer is shown today's (empty) total
    for a completion that lives on a day weeks back.
    """
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id, target=64.0)
    entry_id = await _create_entry(async_client, headers)
    today = today_in_tz("UTC")
    logged_day = today - timedelta(days=_STALE_LOGGED_DAYS)
    accepted_day = today - timedelta(days=_STALE_ACCEPTED_DAYS)
    # In window when it was accepted (25 days back), out of it now (45).
    assert _STALE_LOGGED_DAYS - _STALE_ACCEPTED_DAYS <= MAX_BACKFILL_DAYS
    assert _STALE_LOGGED_DAYS > MAX_BACKFILL_DAYS
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
        completed_units=7.0,
        completed_on=logged_day,
        status=SuggestionStatus.ACCEPTED,
        accepted_at=datetime.combine(accepted_day, time(12, 0), tzinfo=UTC),
    )
    db_session.add(
        GoalCompletion(
            goal_id=goal_id,
            user_id=user_id,
            local_day=logged_day,
            completed_units=7.0,
        )
    )
    await db_session.commit()

    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["check_in"]["day_units"] == 7.0  # that day's, not today's 0.0


# #2905: a detected day one past today -- what a westward timezone move turns
# "today" into -- so the accept must fall back and log today instead.
_ONE_DAY = 1
# How far the clock is advanced before a replay / reopen: past the backfill
# window, so any re-derivation of the logged day against today would drop it.
_REOPEN_AFTER_DAYS = MAX_BACKFILL_DAYS + 10
# A timezone 14 hours ahead of UTC: noon UTC on day D is already D+1 there.
_FAR_EAST_TZ = "Pacific/Kiritimati"
_NOON = time(12, 0)
# Slack for "the stored timestamp is now": the request round-trip, not a day.
_NOW_TOLERANCE = timedelta(minutes=5)


@pytest.mark.asyncio
async def test_accept_persists_logged_on_as_the_day_actually_logged_not_the_detected_day(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """#2905: the suggestion records the day the accept LOGGED, not the day detected.

    The settled card names this day. Re-deriving it from ``completed_on`` and
    the live clock can name a day the completion was never on -- here the
    detected day is tomorrow, the accept logs today, and the card would read
    "today" only once tomorrow arrives.
    """
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    today = today_in_tz("UTC")
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
        completed_units=2.0,
        completed_on=today + timedelta(days=_ONE_DAY),
    )

    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["suggestion"]["logged_on"] == today.isoformat()
    row = await _completion_row(db_session, goal_id)
    assert row.local_day == today
    listed = await async_client.get(f"/journal/{entry_id}/suggestions", headers=headers)
    assert listed.status_code == HTTPStatus.OK
    (item,) = listed.json()["items"]
    assert item["logged_on"] == today.isoformat()


@pytest.mark.asyncio
async def test_accept_without_a_detected_day_records_today_as_logged_on(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """#2905: no detected day means the accept logged today, and says so."""
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    sug_id = await _seed_suggestion(db_session, entry_id=entry_id, user_id=user_id, goal_id=goal_id)

    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    today = today_in_tz("UTC")
    assert resp.json()["suggestion"]["logged_on"] == today.isoformat()
    assert (await _completion_row(db_session, goal_id)).local_day == today


@pytest.mark.asyncio
async def test_a_today_fallback_accept_stamps_the_completion_now_not_at_local_midday(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The accept names its day explicitly now; today must still read as "now".

    ``_completion_timestamp`` anchors an explicit day at local midday. Applied
    to today that would put a morning log in the future for every
    ``timestamp >= since`` reader.
    """
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    sug_id = await _seed_suggestion(db_session, entry_id=entry_id, user_id=user_id, goal_id=goal_id)

    before = datetime.now(UTC)
    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    stamped = (await _completion_row(db_session, goal_id)).timestamp
    stamped = stamped if stamped.tzinfo else stamped.replace(tzinfo=UTC)
    assert abs(stamped - before) < _NOW_TOLERANCE
    # Near noon UTC the midday anchor also falls inside the tolerance, so pin
    # that it was not used: only a real clock read lands off the exact anchor.
    assert stamped != datetime.combine(today_in_tz("UTC"), _NOON, tzinfo=UTC)


@pytest.mark.asyncio
async def test_an_accept_straddling_local_midnight_records_the_day_it_logged(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One resolved day feeds both writes: ``logged_on`` IS ``local_day``.

    The service's clock is moved a day past the router's -- the accept
    request crossing local midnight between the two reads. If the router let
    the service re-read the clock for a fallback day, the suggestion would
    record one day and the completion would land on the next.
    """
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    today = today_in_tz("UTC")
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
        completed_units=2.0,
        completed_on=today + timedelta(days=_ONE_DAY),
    )
    monkeypatch.setattr(
        checkin_service, "today_in_tz", lambda _tz: today + timedelta(days=_ONE_DAY)
    )

    resp = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    row = await _completion_row(db_session, goal_id)
    assert resp.json()["suggestion"]["logged_on"] == row.local_day.isoformat()
    assert row.local_day == today


async def _accept_yesterdays_suggestion(
    client: AsyncClient, session: AsyncSession
) -> tuple[dict[str, str], int, int, date]:
    """Accept a backdated (yesterday) habit suggestion; return headers, entry, suggestion, day."""
    headers = await _signup(client)
    user_id = await _user_id(session)
    goal_id = await _seed_goal(session, user_id)
    entry_id = await _create_entry(client, headers)
    yesterday = today_in_tz("UTC") - timedelta(days=_ONE_DAY)
    sug_id = await _seed_suggestion(
        session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
        completed_units=3.0,
        completed_on=yesterday,
    )
    first = await client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)
    assert first.json()["suggestion"]["logged_on"] == yesterday.isoformat()
    return headers, entry_id, sug_id, yesterday


@pytest.mark.asyncio
async def test_replay_and_list_keep_logged_on_once_the_clock_has_moved_on(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#2905: the recorded day is a fact; advancing the clock past the window cannot move it."""
    headers, entry_id, sug_id, yesterday = await _accept_yesterdays_suggestion(
        async_client, db_session
    )
    later = today_in_tz("UTC") + timedelta(days=_REOPEN_AFTER_DAYS)
    monkeypatch.setattr(journal_router, "today_in_tz", lambda _tz: later)
    monkeypatch.setattr(checkin_service, "today_in_tz", lambda _tz: later)

    replay = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)
    listed = await async_client.get(f"/journal/{entry_id}/suggestions", headers=headers)

    assert replay.status_code == HTTPStatus.OK
    assert replay.json()["suggestion"]["logged_on"] == yesterday.isoformat()
    assert replay.json()["check_in"]["day_units"] == 3.0
    (item,) = listed.json()["items"]
    assert item["logged_on"] == yesterday.isoformat()


@pytest.mark.asyncio
async def test_replay_reports_the_recorded_day_after_the_user_moves_far_east(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """#2905: a replay reads ``logged_on`` rather than re-bucketing ``accepted_at``.

    A future-dated suggestion accepted at noon UTC logs today (the fallback).
    Re-derived in a timezone fourteen hours east, ``accepted_at`` falls on
    tomorrow -- the day the suggestion names -- so the re-derivation would
    report tomorrow's empty total for a completion that lives on today.
    """
    headers = await _signup(async_client)
    user_id = await _user_id(db_session)
    goal_id = await _seed_goal(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    today = today_in_tz("UTC")
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
        completed_units=2.0,
        completed_on=today + timedelta(days=_ONE_DAY),
    )
    first = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)
    assert first.json()["suggestion"]["logged_on"] == today.isoformat()
    # Pin the accept instant to noon UTC so the far-east bucket is tomorrow
    # whatever time of day the suite runs, then move the user.
    db_session.expire_all()
    suggestion = await db_session.get(CompletionSuggestion, sug_id)
    user = await db_session.get(User, user_id)
    assert suggestion is not None
    assert user is not None
    suggestion.accepted_at = datetime.combine(today, _NOON, tzinfo=UTC)
    user.timezone = _FAR_EAST_TZ
    db_session.add_all([suggestion, user])
    await db_session.commit()

    replay = await async_client.post(f"/journal/suggestions/{sug_id}/accept", headers=headers)
    listed = await async_client.get(f"/journal/{entry_id}/suggestions", headers=headers)

    assert replay.status_code == HTTPStatus.OK
    assert replay.json()["suggestion"]["logged_on"] == today.isoformat()
    assert replay.json()["check_in"]["day_units"] == 2.0  # today's, not tomorrow's 0.0
    (item,) = listed.json()["items"]
    assert item["logged_on"] == today.isoformat()
