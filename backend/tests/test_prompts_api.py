"""Tests for the weekly reflection prompts API."""

from __future__ import annotations

import asyncio
from http import HTTPStatus

import pytest
from httpx import AsyncClient


async def _signup(client: AsyncClient, username: str = "alice") -> dict[str, str]:
    """Create a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


# ── Unauthenticated access ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unauthenticated_current_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/prompts/current")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_unauthenticated_history_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/prompts/history")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_unauthenticated_respond_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.post("/prompts/1/respond", json={"response": "test"})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── GET /prompts/current ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_current_prompt_returns_week_1_for_new_user(
    async_client: AsyncClient,
) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/prompts/current", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["week_number"] == 1
    assert data["has_responded"] is False
    assert data["question"] is not None
    assert len(data["question"]) > 0
    assert data["response"] is None


@pytest.mark.asyncio
async def test_get_current_prompt_advances_after_submit(
    async_client: AsyncClient,
) -> None:
    """After responding to week 1, current prompt advances to week 2 (BUG-JOURNAL-014)."""
    headers = await _signup(async_client)
    # Submit a response for week 1
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "I feel grounded today."},
        headers=headers,
    )
    resp = await async_client.get("/prompts/current", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    # Week advances to 2 after completing week 1
    assert data["week_number"] == 2
    assert data["has_responded"] is False


# ── GET /prompts/{week_number} ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_prompt_by_week(async_client: AsyncClient) -> None:
    """A user who has reached week 5 can fetch it (BUG-PROMPT-002 allow case)."""
    headers = await _signup(async_client)
    # Advance to week 5 by responding to weeks 1..4.
    for week in range(1, 5):
        resp_w = await async_client.post(
            f"/prompts/{week}/respond",
            json={"response": f"Week {week} answer"},
            headers=headers,
        )
        assert resp_w.status_code == HTTPStatus.CREATED
    resp = await async_client.get("/prompts/5", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["week_number"] == 5
    assert data["has_responded"] is False
    assert data["question"] is not None


@pytest.mark.asyncio
async def test_get_prompt_invalid_week_returns_404(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/prompts/99", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_get_prompt_week_zero_returns_404(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/prompts/0", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── POST /prompts/{week_number}/respond ─────────────────────────────────


@pytest.mark.asyncio
async def test_submit_prompt_response(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": "Safety means having a stable home."},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert data["week_number"] == 1
    assert data["has_responded"] is True
    assert data["response"] == "Safety means having a stable home."
    assert data["timestamp"] is not None


@pytest.mark.asyncio
async def test_submit_duplicate_response_returns_409(async_client: AsyncClient) -> None:
    """BUG-PROMPT-004: every duplicate submission must surface the same 409.

    The earlier handler split into a 400 fast path (pre-check matched)
    and a 409 race path (constraint fired).  Clients had to handle both
    codes for one semantic condition.  The pre-check is gone and the
    ``uq_promptresponse_user_week`` constraint is the single source of
    truth for "already responded."
    """
    headers = await _signup(async_client)
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "First response."},
        headers=headers,
    )
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": "Second response."},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "already_responded"


@pytest.mark.asyncio
async def test_submit_response_invalid_week_returns_404(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/prompts/99/respond",
        json={"response": "test"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── BUG-PROMPT-001 / BUG-PROMPT-002: weekly unlock gate ─────────────────


@pytest.mark.asyncio
async def test_get_future_week_is_forbidden(async_client: AsyncClient) -> None:
    """BUG-PROMPT-002: GET /prompts/{week} must 403 for weeks past user_week.

    Without the gate a week-1 user could enumerate /prompts/1..36 and lift
    every future question.  The curriculum is supposed to unlock one week
    at a time as responses are submitted.
    """
    headers = await _signup(async_client)
    resp = await async_client.get("/prompts/36", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "week_locked"


@pytest.mark.asyncio
async def test_submit_future_week_is_forbidden(async_client: AsyncClient) -> None:
    """BUG-PROMPT-001: POST to a future week must 403 before writing.

    Under the old max(week)+1 derivation, one POST to /prompts/36/respond
    would set the user's current_week to 36 on the next read, voiding the
    entire 36-week pacing in a single request.
    """
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/prompts/36/respond",
        json={"response": "skip-ahead attempt"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "week_locked"


@pytest.mark.asyncio
async def test_current_week_derives_from_response_count_not_max(
    async_client: AsyncClient,
) -> None:
    """BUG-PROMPT-001: user_week is ``count + 1``, never ``max + 1``.

    The skip-ahead POST from ``test_submit_future_week_is_forbidden`` would,
    under the old derivation, have left this user at week 37→clamped-to-36.
    With count-based derivation a blocked future submit doesn't count, so
    the user remains at week 1 — the intended behaviour.
    """
    headers = await _signup(async_client)
    # Submit a response for week 1 successfully.
    resp1 = await async_client.post(
        "/prompts/1/respond",
        json={"response": "Ground."},
        headers=headers,
    )
    assert resp1.status_code == HTTPStatus.CREATED

    # Attempt a future week — must fail and NOT be persisted.
    resp_skip = await async_client.post(
        "/prompts/10/respond",
        json={"response": "sneaky"},
        headers=headers,
    )
    assert resp_skip.status_code == HTTPStatus.FORBIDDEN

    # Current should be week 2 (count=1, next=2), not week 11.
    resp_current = await async_client.get("/prompts/current", headers=headers)
    assert resp_current.status_code == HTTPStatus.OK
    assert resp_current.json()["week_number"] == 2


@pytest.mark.asyncio
async def test_submit_response_creates_journal_entry(async_client: AsyncClient) -> None:
    """Submitting a prompt response also creates a journal entry with stage_reflection tag."""
    headers = await _signup(async_client)
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "I reflected on grounding."},
        headers=headers,
    )

    # Check journal entries
    journal_resp = await async_client.get("/journal/", headers=headers)
    assert journal_resp.status_code == HTTPStatus.OK
    journal_data = journal_resp.json()
    assert journal_data["total"] == 1
    entry = journal_data["items"][0]
    assert entry["message"] == "I reflected on grounding."
    assert entry["tag"] == "stage_reflection"
    assert entry["sender"] == "user"


# ── GET /prompts/history ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_prompt_history_empty_for_new_user(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/prompts/history", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["total"] == 0
    assert data["items"] == []
    assert data["has_more"] is False


@pytest.mark.asyncio
async def test_prompt_history_returns_responses(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    # Submit responses for weeks 1 and 2
    await async_client.post(
        "/prompts/1/respond", json={"response": "Week 1 answer"}, headers=headers
    )
    await async_client.post(
        "/prompts/2/respond", json={"response": "Week 2 answer"}, headers=headers
    )

    resp = await async_client.get("/prompts/history", headers=headers)
    data = resp.json()
    assert data["total"] == 2
    # Newest week first
    assert data["items"][0]["week_number"] == 2
    assert data["items"][1]["week_number"] == 1


@pytest.mark.asyncio
async def test_prompt_history_pagination(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    for week in range(1, 6):
        await async_client.post(
            f"/prompts/{week}/respond",
            json={"response": f"Week {week} answer"},
            headers=headers,
        )

    resp = await async_client.get("/prompts/history?limit=2&offset=0", headers=headers)
    data = resp.json()
    assert len(data["items"]) == 2
    assert data["total"] == 5
    assert data["has_more"] is True

    resp2 = await async_client.get("/prompts/history?limit=2&offset=4", headers=headers)
    data2 = resp2.json()
    assert len(data2["items"]) == 1
    assert data2["has_more"] is False


# ── User isolation ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_user_cannot_see_other_users_responses(async_client: AsyncClient) -> None:
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")

    await async_client.post(
        "/prompts/1/respond",
        json={"response": "Alice's reflection"},
        headers=alice_headers,
    )

    # Bob should not see Alice's response
    resp = await async_client.get("/prompts/1", headers=bob_headers)
    assert resp.json()["has_responded"] is False

    resp_history = await async_client.get("/prompts/history", headers=bob_headers)
    assert resp_history.json()["total"] == 0


@pytest.mark.asyncio
async def test_both_users_can_respond_to_same_week(async_client: AsyncClient) -> None:
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")

    resp_a = await async_client.post(
        "/prompts/1/respond",
        json={"response": "Alice's answer"},
        headers=alice_headers,
    )
    resp_b = await async_client.post(
        "/prompts/1/respond",
        json={"response": "Bob's answer"},
        headers=bob_headers,
    )
    assert resp_a.status_code == HTTPStatus.CREATED
    assert resp_b.status_code == HTTPStatus.CREATED


# ── Concurrency (BUG-JOURNAL-003) ─────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_prompt_responses_allow_exactly_one(
    concurrent_async_client: AsyncClient,
) -> None:
    """Only one of N concurrent prompt submissions for the same (user, week) wins."""
    headers = await _signup(concurrent_async_client)

    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(
                "/prompts/1/respond",
                json={"response": f"Attempt {i}"},
                headers=headers,
            )
            for i in range(5)
        ]
    )

    status_codes = [r.status_code for r in responses]
    successes = status_codes.count(HTTPStatus.CREATED)
    # With the pre-check gone the constraint is the only rejector; every
    # loser hits exactly 409 (BUG-PROMPT-004).
    rejections = status_codes.count(HTTPStatus.CONFLICT)

    assert successes == 1, f"Expected exactly 1 success, got {successes}"
    assert rejections == 4, f"Expected 4 conflicts, got {rejections}"
