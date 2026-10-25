"""Past questions survive a skipped week; answering is never an archive prerequisite."""

from datetime import UTC, datetime, timedelta, tzinfo
from http import HTTPStatus
from typing import Self

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from domain import weekly_prompts
from domain.constants import TOTAL_STAGES
from domain.stage_progress import ensure_user_progress
from domain.weekly_prompts import TOTAL_WEEKS, resolve_week_prompt
from models.stage_progress import StageProgress
from routers import prompts

NOW = datetime(2026, 10, 21, 12, tzinfo=UTC)


class HistoryClock(datetime):
    """Keep the API clock deterministic without replacing the calendar under test."""

    @classmethod
    def now(cls, tz: tzinfo | None = None) -> Self:
        return cls.fromtimestamp(NOW.timestamp(), tz)


async def arrange(
    client: AsyncClient,
    session: AsyncSession,
    *,
    days: float,
    name: str = "past-questions",
    timezone: str = "UTC",
) -> dict[str, str]:
    response = await client.post(
        "/auth/signup",
        json={
            "email": f"{name}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
            "timezone": timezone,
        },
    )
    assert response.status_code == HTTPStatus.OK, response.json()
    progress = await ensure_user_progress(session, response.json()["user_id"])
    progress.program_started_at = NOW - timedelta(days=days)
    session.add(progress)
    await session.commit()
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture(autouse=True)
def clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prompts, "datetime", HistoryClock)


@pytest.mark.asyncio
async def test_skipped_weeks_are_readable_without_creating_answers(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await arrange(async_client, db_session, days=21)
    response = await async_client.get("/prompts/history?include_unanswered=true", headers=headers)
    assert response.status_code == HTTPStatus.OK, response.json()
    body = response.json()
    assert body["total"] == 3
    assert body["has_more"] is False
    assert [row["week_number"] for row in body["items"]] == [3, 2, 1]
    for item in body["items"]:
        resolved = resolve_week_prompt(item["week_number"])
        assert resolved is not None
        assert item["question"] == resolved.question
        assert item["default_title"] == resolved.default_title
        assert item["prompt_ordinal"] == resolved.prompt.ordinal
        assert item["has_responded"] is False
        assert item["response"] is None
        assert item["timestamp"] is None
    answers = await async_client.get("/prompts/history", headers=headers)
    assert answers.json()["items"] == []
    journal = await async_client.get("/journal/", headers=headers)
    assert journal.json()["items"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("include_total", [True, False])
async def test_mixed_history_pages_one_set_and_preserves_chosen_question(
    async_client: AsyncClient, db_session: AsyncSession, include_total: bool
) -> None:
    headers = await arrange(async_client, db_session, days=21)
    saved = await async_client.post(
        "/prompts/2/respond",
        headers=headers,
        json={"response": "A thought worth keeping.", "prompt_ordinal": 3},
    )
    assert saved.status_code == HTTPStatus.CREATED, saved.json()
    path = f"/prompts/history?include_unanswered=true&include_total={str(include_total).lower()}"
    first = (await async_client.get(f"{path}&limit=2", headers=headers)).json()
    last = (await async_client.get(f"{path}&limit=2&offset=2", headers=headers)).json()
    end = (await async_client.get(f"{path}&limit=2&offset=3", headers=headers)).json()
    assert [item["week_number"] for item in first["items"] + last["items"]] == [3, 2, 1]
    assert first["items"][1] == saved.json()
    assert first["total"] == last["total"] == (3 if include_total else None)
    assert first["has_more"] is True
    assert last["has_more"] is end["has_more"] is False
    assert end["items"] == []


@pytest.mark.asyncio
async def test_history_keeps_dismissed_questions_but_never_another_accounts_answer(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    alice = await arrange(async_client, db_session, days=21, name="alice-history")
    bob = await arrange(async_client, db_session, days=21, name="bob-history")
    await async_client.post(
        "/prompts/1/respond", headers=alice, json={"response": "Alice's own answer."}
    )
    declined = await async_client.post("/prompts/stage/1/1/dismiss", headers=bob)
    assert declined.status_code == HTTPStatus.OK
    body = (await async_client.get("/prompts/history?include_unanswered=true", headers=bob)).json()
    assert len(body["items"]) == 3
    assert all(item["response"] is None for item in body["items"])
    assert body["items"][-1]["dismissed"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(("days", "expected"), [(0, 0), (251, 35), (252, TOTAL_WEEKS)])
async def test_history_excludes_current_week_until_it_has_ended(
    async_client: AsyncClient, db_session: AsyncSession, days: int, expected: int
) -> None:
    headers = await arrange(async_client, db_session, days=days)
    body = (
        await async_client.get("/prompts/history?include_unanswered=true", headers=headers)
    ).json()
    assert body["total"] == expected
    assert [item["week_number"] for item in body["items"]] == list(range(expected, 0, -1))


@pytest.mark.asyncio
async def test_history_uses_the_users_midnight_for_past_week_boundary(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    # 7 local midnights in LA, 6 in UTC: UTC would hide a past week.
    headers = await arrange(
        async_client,
        db_session,
        days=6 + 9 / 24,  # Oct 15 at 03:00 UTC, Oct 14 in LA.
        timezone="America/Los_Angeles",
    )
    body = (
        await async_client.get("/prompts/history?include_unanswered=true", headers=headers)
    ).json()
    assert body["total"] == 1


@pytest.mark.asyncio
async def test_answered_current_week_stays_visible_when_past_questions_are_included(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await arrange(async_client, db_session, days=21)
    saved = await async_client.post(
        "/prompts/4/respond", headers=headers, json={"response": "This week's own reflection."}
    )
    assert saved.status_code == HTTPStatus.CREATED, saved.json()
    body = (
        await async_client.get("/prompts/history?include_unanswered=true", headers=headers)
    ).json()
    assert body["items"][0] == saved.json()
    assert [item["week_number"] for item in body["items"]] == [4, 3, 2, 1]


@pytest.mark.asyncio
async def test_retired_questions_keep_the_saved_answer_without_inventing_missing_content(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = await arrange(async_client, db_session, days=21)
    saved = await async_client.post(
        "/prompts/1/respond", headers=headers, json={"response": "An answer to a retired question."}
    )
    assert saved.status_code == HTTPStatus.CREATED, saved.json()
    monkeypatch.setattr(weekly_prompts, "TOTAL_WEEKS", 0)
    body = (
        await async_client.get("/prompts/history?include_unanswered=true", headers=headers)
    ).json()
    assert body["total"] == 1
    assert body["items"][0]["question"] == saved.json()["question"]
    assert body["items"][0]["response"] == saved.json()["response"]
    assert body["items"][0]["default_title"] is None


async def finish_and_restart(client: AsyncClient, session: AsyncSession) -> dict[str, str]:
    """A completed calendar with one sparse response, restarted over the real API."""
    headers = await arrange(client, session, days=252)
    saved = await client.post(
        "/prompts/10/respond",
        headers=headers,
        json={"response": "Only one prior answer.", "prompt_ordinal": 2},
    )
    assert saved.status_code == HTTPStatus.CREATED, saved.json()
    progress = (await session.execute(select(StageProgress))).scalars().one()
    progress.current_stage = TOTAL_STAGES
    progress.completed_stages = list(range(1, TOTAL_STAGES))
    session.add(progress)
    await session.commit()
    reset = await client.post("/stages/begin-again", headers=headers)
    assert reset.status_code == HTTPStatus.OK, reset.json()
    assert reset.json()["cycle_number"] == 2
    return headers


@pytest.mark.asyncio
async def test_past_questions_survive_a_real_begin_again(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await finish_and_restart(async_client, db_session)
    body = (
        await async_client.get("/prompts/history?include_unanswered=true", headers=headers)
    ).json()
    assert body["total"] == TOTAL_WEEKS
    assert [row["week_number"] for row in body["items"]] == list(range(TOTAL_WEEKS, 0, -1))
    answers = [row for row in body["items"] if row["has_responded"]]
    assert [row["week_number"] for row in answers] == [10]
    assert answers[0]["response"] == "Only one prior answer."
    default = (await async_client.get("/prompts/history", headers=headers)).json()
    assert default["items"] == answers


@pytest.mark.asyncio
async def test_unknown_cycle_calendar_does_not_guess_weeks_from_lifetime_answers(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await finish_and_restart(async_client, db_session)
    progress = (await db_session.execute(select(StageProgress))).scalars().one()
    # A cycle left before anchors were retained; there is no date to recover.
    progress.past_cycle_anchors = [None]
    db_session.add(progress)
    await db_session.commit()
    body = (
        await async_client.get("/prompts/history?include_unanswered=true", headers=headers)
    ).json()
    assert body["total"] == 1
    assert [row["week_number"] for row in body["items"]] == [10]
    assert body["items"][0]["response"] == "Only one prior answer."
