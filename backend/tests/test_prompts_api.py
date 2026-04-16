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
    assert data["week_number"] == 2  # noqa: PLR2004
    assert data["has_responded"] is False


# ── GET /prompts/{week_number} ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_prompt_by_week(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/prompts/5", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["week_number"] == 5  # noqa: PLR2004
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
async def test_submit_duplicate_response_returns_error(async_client: AsyncClient) -> None:
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
    # Application-level check returns 400; DB constraint returns 409 — both
    # report ``already_responded`` so the client can handle both uniformly.
    assert resp.status_code in {HTTPStatus.BAD_REQUEST, HTTPStatus.CONFLICT}
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
    assert data["total"] == 2  # noqa: PLR2004
    # Newest week first
    assert data["items"][0]["week_number"] == 2  # noqa: PLR2004
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
    assert len(data["items"]) == 2  # noqa: PLR2004
    assert data["total"] == 5  # noqa: PLR2004
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
    # The loser hits either the app-level 400 or the DB-level 409.
    rejections = sum(1 for s in status_codes if s in {HTTPStatus.BAD_REQUEST, HTTPStatus.CONFLICT})

    assert successes == 1, f"Expected exactly 1 success, got {successes}"
    assert rejections == 4, f"Expected 4 rejections, got {rejections}"  # noqa: PLR2004
