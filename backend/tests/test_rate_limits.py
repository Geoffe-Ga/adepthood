"""Tests for global and per-endpoint rate limiting (sec-11).

Verifies that:
- All endpoints have a global default rate limit (60/minute)
- Expensive endpoints have stricter per-endpoint limits
- 429 responses include a Retry-After header
- Existing auth rate limits remain unchanged
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient

from rate_limit import DEFAULT_RATE_LIMIT


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


async def _add_balance(client: AsyncClient, headers: dict[str, str], amount: int = 50) -> None:
    """Add offering credits to the authenticated user."""
    resp = await client.post("/user/balance/add", json={"amount": amount}, headers=headers)
    assert resp.status_code == HTTPStatus.OK


# ── Configuration ────────────────────────────────────────────────────────


def test_default_rate_limit_constant() -> None:
    """The DEFAULT_RATE_LIMIT constant is set to 60 requests per minute."""
    assert DEFAULT_RATE_LIMIT == "60/minute"


# ── Retry-After header ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_rate_limit_response_includes_retry_after(async_client: AsyncClient) -> None:
    """429 responses include a Retry-After header."""
    # Use signup endpoint (3/minute) to trigger rate limit quickly
    for i in range(3):
        await async_client.post(
            "/auth/signup",
            json={
                "email": f"ratelimit{i}@example.com",
                "password": "secret12345",  # pragma: allowlist secret
            },
        )

    # 4th request exceeds the limit
    resp = await async_client.post(
        "/auth/signup",
        json={
            "email": "ratelimit99@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "rate_limit_exceeded"
    assert "retry-after" in resp.headers


# ── Per-endpoint: POST /journal/chat (10/minute) ────────────────────────


@pytest.mark.asyncio
async def test_chat_rate_limit_returns_429(async_client: AsyncClient) -> None:
    """POST /journal/chat returns 429 after exceeding 10 requests/minute."""
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=20)

    # Make 10 requests (the limit)
    for _ in range(10):
        await async_client.post(
            "/journal/chat",
            json={"message": "Hello BotMason"},
            headers=headers,
        )

    # 11th request should be rate-limited
    resp = await async_client.post(
        "/journal/chat",
        json={"message": "One too many"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "rate_limit_exceeded"
    assert "retry-after" in resp.headers


# ── Per-endpoint: POST /user/balance/add (5/minute) ─────────────────────


@pytest.mark.asyncio
async def test_add_balance_rate_limit_returns_429(async_client: AsyncClient) -> None:
    """POST /user/balance/add returns 429 after exceeding 5 requests/minute."""
    headers = await _signup(async_client)

    # Make 5 requests (the limit)
    for _ in range(5):
        await async_client.post(
            "/user/balance/add",
            json={"amount": 1},
            headers=headers,
        )

    # 6th request should be rate-limited
    resp = await async_client.post(
        "/user/balance/add",
        json={"amount": 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "rate_limit_exceeded"
    assert "retry-after" in resp.headers


# ── Per-endpoint: POST /practices/ (5/minute) ───────────────────────────


@pytest.mark.asyncio
async def test_submit_practice_rate_limit_returns_429(async_client: AsyncClient) -> None:
    """POST /practices/ returns 429 after exceeding 5 requests/minute."""
    headers = await _signup(async_client)

    practice_payload = {
        "stage_number": 1,
        "name": "Test Practice",
        "description": "Test desc",
        "instructions": "Test instructions",
        "default_duration_minutes": 10,
    }

    # Make 5 requests (the limit)
    for _ in range(5):
        await async_client.post("/practices/", json=practice_payload, headers=headers)

    # 6th request should be rate-limited
    resp = await async_client.post("/practices/", json=practice_payload, headers=headers)
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "rate_limit_exceeded"
    assert "retry-after" in resp.headers


# ── Per-endpoint: GET /journal/ (30/minute) ──────────────────────────────


@pytest.mark.asyncio
async def test_journal_list_rate_limit_returns_429(async_client: AsyncClient) -> None:
    """GET /journal/ returns 429 after exceeding 30 requests/minute."""
    headers = await _signup(async_client)

    # Make 30 requests (the limit)
    for _ in range(30):
        await async_client.get("/journal/", headers=headers)

    # 31st request should be rate-limited
    resp = await async_client.get("/journal/", headers=headers)
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "rate_limit_exceeded"
    assert "retry-after" in resp.headers


# ── Auth rate limits unchanged ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_auth_signup_limit_unchanged_at_3_per_minute(async_client: AsyncClient) -> None:
    """Auth signup rate limit remains at 3/minute (not overridden by default)."""
    for i in range(3):
        await async_client.post(
            "/auth/signup",
            json={
                "email": f"auth{i}@example.com",
                "password": "secret12345",  # pragma: allowlist secret
            },
        )

    resp = await async_client.post(
        "/auth/signup",
        json={
            "email": "auth99@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS


@pytest.mark.asyncio
async def test_auth_login_limit_unchanged_at_5_per_minute(async_client: AsyncClient) -> None:
    """Auth login rate limit remains at 5/minute (not overridden by default)."""
    await _signup(async_client)

    for _ in range(5):
        await async_client.post(
            "/auth/login",
            json={
                "email": "alice@example.com",
                "password": "secret12345",  # pragma: allowlist secret
            },
        )

    resp = await async_client.post(
        "/auth/login",
        json={
            "email": "alice@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
