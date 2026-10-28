"""Practice Story API ownership, configuration and stage-window integration."""

from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice import Practice
from models.practice_session import PracticeSession
from models.stage_progress import StageProgress
from models.user_practice import UserPractice
from schemas.practice import MAX_FUTURE_SKEW

_STORY_URL = "/practice-sessions/story"


async def _signup(client: AsyncClient, name: str) -> tuple[dict[str, str], int]:
    """Create one account with its own bearer credential."""
    response = await client.post(
        "/auth/signup",
        json={
            "email": f"{name}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert response.status_code == HTTPStatus.OK
    body = response.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


async def _practice(session: AsyncSession) -> Practice:
    """Seed a valid timer practice with a ten-minute catalog default."""
    practice = Practice(
        stage_number=1,
        name="Story timer",
        description="Sit quietly",
        instructions="Breathe",
        default_duration_minutes=10,
        mode_config={"mode": "meditation_timer", "duration_minutes": 10},
    )
    session.add(practice)
    await session.commit()
    await session.refresh(practice)
    return practice


async def _adopt(
    session: AsyncSession, user_id: int, practice: Practice, stage: int = 1
) -> UserPractice:
    """Insert a stage adoption without changing the progression state."""
    selection = UserPractice(
        user_id=user_id, practice_id=practice.id, stage_number=stage, start_date=date(2026, 1, 1)
    )
    session.add(selection)
    await session.commit()
    await session.refresh(selection)
    return selection


@pytest.mark.asyncio
async def test_story_requires_auth_and_a_selection(async_client: AsyncClient) -> None:
    """A Story cannot become an anonymous or implicitly global read."""
    response = await async_client.get(_STORY_URL, params={"user_practice_id": 1})
    assert response.status_code == HTTPStatus.UNAUTHORIZED
    headers, _ = await _signup(async_client, "story_unkeyed")
    response = await async_client.get(_STORY_URL, headers=headers)
    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    response = await async_client.get(
        _STORY_URL, params={"user_practice_id": 999999}, headers=headers
    )
    assert response.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_empty_story_has_private_uncacheable_response(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The post-save read is never served from an old browser or shared cache."""
    headers, user_id = await _signup(async_client, "story_empty")
    selected = await _adopt(db_session, user_id, await _practice(db_session))
    response = await async_client.get(
        _STORY_URL, params={"user_practice_id": selected.id}, headers=headers
    )
    assert response.status_code == HTTPStatus.OK
    body = response.json()
    assert body["total_sessions"] == body["total_minutes"] == 0
    assert body["stage_average_minutes"] is None
    assert body["stage_session_count"] == body["stage_partial_sessions"] == 0
    assert body["last_insight_timestamp"] is None
    assert body["stage_ask_minutes"] == 10
    assert len(body["weekly"]) == 8
    assert body["observations"] == ["No sits recorded yet. The record starts with the first one."]
    assert body["milestones"] == []
    assert response.headers["cache-control"] == "private, no-store"
    assert "Authorization" in response.headers["vary"]


@pytest.mark.asyncio
async def test_story_keeps_readopted_history_but_not_another_owners_rows(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Lifetime is per catalog practice and owner, across all their adoptions."""
    headers, owner = await _signup(async_client, "story_owner")
    _, stranger = await _signup(async_client, "story_stranger")
    practice = await _practice(db_session)
    selected = await _adopt(db_session, owner, practice)
    readopted = await _adopt(db_session, owner, practice, stage=2)
    foreign = await _adopt(db_session, stranger, practice)
    for user_id, adoption, minutes in [
        (owner, selected, 10),
        (owner, readopted, 20),
        (stranger, foreign, 500),
        (owner, foreign, 600),
        (stranger, selected, 700),
    ]:
        db_session.add(
            PracticeSession(user_id=user_id, user_practice_id=adoption.id, duration_minutes=minutes)
        )
    await db_session.commit()
    response = await async_client.get(
        _STORY_URL, params={"user_practice_id": readopted.id}, headers=headers
    )
    assert response.status_code == HTTPStatus.OK
    assert response.json()["total_sessions"] == 2
    assert response.json()["total_minutes"] == 30


@pytest.mark.parametrize(
    ("mode", "config", "expected"),
    [
        ("meditation_timer", {"mode": "meditation_timer", "duration_minutes": 35}, 35),
        (
            "metronome",
            {
                "mode": "metronome",
                "bpm": 80,
                "timer": {"mode": "meditation_timer", "duration_minutes": 25},
            },
            25,
        ),
        (
            "sense_grounding",
            {"mode": "sense_grounding", "prompts": [{"sense": "sight", "label": "Notice"}]},
            10,
        ),
    ],
)
@pytest.mark.asyncio
async def test_story_honors_resolved_duration_and_falls_back_for_nontimer_modes(
    async_client: AsyncClient,
    db_session: AsyncSession,
    mode: str,
    config: dict[str, object],
    expected: float,
) -> None:
    """The ask matches the configured player rather than a stale catalog duration."""
    headers, owner = await _signup(async_client, f"story_config_{mode}")
    practice = await _practice(db_session)
    practice.mode = mode
    practice.mode_config = config
    selected = await _adopt(db_session, owner, practice)
    selected.mode_config_override = config
    await db_session.commit()
    response = await async_client.get(
        _STORY_URL, params={"user_practice_id": selected.id}, headers=headers
    )
    assert response.status_code == HTTPStatus.OK
    assert response.json()["stage_ask_minutes"] == expected


@pytest.mark.asyncio
async def test_story_override_can_differ_from_catalog_ask(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The exact duration the person configured takes precedence over the preset."""
    headers, owner = await _signup(async_client, "story_distinct_override")
    selected = await _adopt(db_session, owner, await _practice(db_session))
    selected.mode_config_override = {"mode": "meditation_timer", "duration_minutes": 35}
    await db_session.commit()
    response = await async_client.get(
        _STORY_URL, params={"user_practice_id": selected.id}, headers=headers
    )
    assert response.status_code == HTTPStatus.OK
    assert response.json()["stage_ask_minutes"] == 35


@pytest.mark.asyncio
async def test_just_saved_sit_from_an_accepted_fast_clock_counts_in_this_stage(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The write policy's permitted clock skew must not briefly hide a valid stage sit."""
    headers, owner = await _signup(async_client, "story_fast_clock")
    selected = await _adopt(db_session, owner, await _practice(db_session))
    started = datetime.now(UTC) - timedelta(days=1)
    db_session.add(
        StageProgress(
            user_id=owner, current_stage=1, stage_started_at=started, program_started_at=started
        )
    )
    await db_session.commit()
    ended = datetime.now(UTC) + MAX_FUTURE_SKEW - timedelta(seconds=1)
    created = await async_client.post(
        "/practice-sessions/",
        headers=headers,
        json={
            "user_practice_id": selected.id,
            "started_at": (ended - timedelta(minutes=5)).isoformat(),
            "ended_at": ended.isoformat(),
        },
    )
    assert created.status_code == HTTPStatus.CREATED
    response = await async_client.get(
        _STORY_URL, params={"user_practice_id": selected.id}, headers=headers
    )
    assert ended > datetime.now(UTC), "the regression must exercise an instant still ahead of now"
    assert response.status_code == HTTPStatus.OK
    assert response.json()["total_sessions"] == response.json()["stage_session_count"] == 1
    assert response.json()["total_minutes"] == response.json()["stage_average_minutes"] == 5
    ask = response.json()["stage_ask_minutes"]
    assert (
        f"Beige asks for {round(ask)} minutes; your sits this stage average 5."
        in (response.json()["observations"])
    )


@pytest.mark.asyncio
async def test_stage_average_excludes_earlier_cycles_and_later_timestamps(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An adoption retained across begin-again cannot pull old sits into this stage."""
    headers, owner = await _signup(async_client, "story_stage_window")
    selected = await _adopt(db_session, owner, await _practice(db_session))
    now = datetime.now(UTC)
    db_session.add(
        StageProgress(
            user_id=owner,
            current_stage=1,
            cycle_number=2,
            stage_started_at=now - timedelta(days=2),
            program_started_at=now - timedelta(days=2),
        )
    )
    for days_ago, duration, completed in [(30, 50, True), (1, 5, False), (0, 15, True)]:
        db_session.add(
            PracticeSession(
                user_id=owner,
                user_practice_id=selected.id,
                duration_minutes=duration,
                completed=completed,
                timestamp=now - timedelta(days=days_ago),
            )
        )
    await db_session.commit()
    response = await async_client.get(
        _STORY_URL, params={"user_practice_id": selected.id}, headers=headers
    )
    assert response.status_code == HTTPStatus.OK
    assert response.json()["total_sessions"] == 3
    assert response.json()["stage_average_minutes"] == 10
    assert response.json()["stage_session_count"] == 2
    assert response.json()["stage_partial_sessions"] == 1


@pytest.mark.parametrize("has_anchor", [True, False])
@pytest.mark.asyncio
async def test_other_stage_uses_cycle_calendar_or_adoption_when_unknown(
    async_client: AsyncClient, db_session: AsyncSession, has_anchor: bool
) -> None:
    """A known cycle gives date bounds; a missing anchor never becomes a guessed calendar."""
    headers, owner = await _signup(async_client, f"story_other_stage_{has_anchor}")
    practice = await _practice(db_session)
    first = await _adopt(db_session, owner, practice)
    selected = await _adopt(db_session, owner, practice, stage=2)
    anchor = datetime(2026, 1, 1, tzinfo=UTC)
    db_session.add(
        StageProgress(
            user_id=owner, current_stage=3, program_started_at=anchor if has_anchor else None
        )
    )
    for adoption, moment, duration in [
        (first, anchor + timedelta(days=22), 5),
        (selected, anchor + timedelta(days=25), 15),
        (first, anchor, 100),
    ]:
        db_session.add(
            PracticeSession(
                user_id=owner,
                user_practice_id=adoption.id,
                duration_minutes=duration,
                timestamp=moment,
            )
        )
    await db_session.commit()
    response = await async_client.get(
        _STORY_URL, params={"user_practice_id": selected.id}, headers=headers
    )
    assert response.status_code == HTTPStatus.OK
    assert response.json()["stage_average_minutes"] == (10 if has_anchor else 15)
    assert response.json()["stage_session_count"] == (2 if has_anchor else 1)
