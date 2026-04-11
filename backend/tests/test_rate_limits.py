"""Tests for data endpoint rate limiting (sec-16).

Verifies that:
- The global default rate limit (60/minute) applies to endpoints without explicit limits
- Expensive operations have stricter per-endpoint limits
- 429 responses are returned with the correct JSON body
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient

# Number of requests matching each rate limit — used to fire exactly at the boundary.
GLOBAL_DEFAULT_LIMIT = 60
CHAT_LIMIT = 10
BALANCE_ADD_LIMIT = 5
PRACTICE_SUBMIT_LIMIT = 5


async def _signup(client: AsyncClient, username: str = "limiter") -> dict[str, str]:
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


# ── Per-endpoint limits ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chat_rate_limit_returns_429(async_client: AsyncClient) -> None:
    """POST /journal/chat returns 429 after exceeding 10 requests/minute."""
    headers = await _signup(async_client)

    # Make 10 requests (the limit). They'll return 402 (no balance) but still
    # count against the rate limiter — the decorator runs before the handler.
    for _ in range(CHAT_LIMIT):
        await async_client.post("/journal/chat", json={"message": "hello"}, headers=headers)

    # The 11th request should be rate-limited
    resp = await async_client.post("/journal/chat", json={"message": "hello"}, headers=headers)
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "rate_limit_exceeded"


@pytest.mark.asyncio
async def test_add_balance_rate_limit_returns_429(async_client: AsyncClient) -> None:
    """POST /user/balance/add returns 429 after exceeding 5 requests/minute."""
    headers = await _signup(async_client)

    for _ in range(BALANCE_ADD_LIMIT):
        await async_client.post("/user/balance/add", json={"amount": 1}, headers=headers)

    resp = await async_client.post("/user/balance/add", json={"amount": 1}, headers=headers)
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "rate_limit_exceeded"


@pytest.mark.asyncio
async def test_practice_submit_rate_limit_returns_429(
    async_client: AsyncClient,
) -> None:
    """POST /practices/ returns 429 after exceeding 5 requests/minute."""
    headers = await _signup(async_client)

    practice_payload = {
        "stage_number": 1,
        "name": "Test Practice",
        "description": "A test practice",
        "instructions": "Do the thing",
        "default_duration_minutes": 10,
    }

    for _ in range(PRACTICE_SUBMIT_LIMIT):
        await async_client.post("/practices/", json=practice_payload, headers=headers)

    resp = await async_client.post("/practices/", json=practice_payload, headers=headers)
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "rate_limit_exceeded"


# ── Global default limit ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_global_default_rate_limit_returns_429(
    async_client: AsyncClient,
) -> None:
    """GET /user/balance (no explicit limit) returns 429 after 60 requests/minute."""
    headers = await _signup(async_client)

    for _ in range(GLOBAL_DEFAULT_LIMIT):
        await async_client.get("/user/balance", headers=headers)

    resp = await async_client.get("/user/balance", headers=headers)
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "rate_limit_exceeded"


# ── Auth limits unchanged ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_auth_limits_still_enforced(async_client: AsyncClient) -> None:
    """Auth endpoints retain their explicit limits (not overridden by global default).

    Signup is 3/minute — verify the 4th request is rate-limited.
    """
    for i in range(3):
        await async_client.post(
            "/auth/signup",
            json={
                "email": f"ratelimit{i}@example.com",
                "password": "secret12345",  # pragma: allowlist secret
            },
        )

    resp = await async_client.post(
        "/auth/signup",
        json={
            "email": "ratelimit99@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "rate_limit_exceeded"


# ── Below-limit requests succeed ──────────────────────────────────────


@pytest.mark.asyncio
async def test_requests_within_limit_succeed(async_client: AsyncClient) -> None:
    """Requests within the per-endpoint limit return normal responses (not 429)."""
    headers = await _signup(async_client)

    # 4 add-balance requests (limit is 5) — all should succeed
    for _ in range(BALANCE_ADD_LIMIT - 1):
        resp = await async_client.post("/user/balance/add", json={"amount": 1}, headers=headers)
        assert resp.status_code == HTTPStatus.OK
