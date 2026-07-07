"""Tests for global and per-endpoint rate limiting (sec-11).

Verifies that:
- All endpoints have a global default rate limit (60/minute)
- Expensive endpoints have stricter per-endpoint limits
- 429 responses include a Retry-After header
- Existing auth rate limits remain unchanged

Every limit is pinned at its exact value: each test proves the limit-th
request is admitted *and* the (limit + 1)-th request is rejected, so a
mutation that tightens a limit (e.g. 5/minute -> 2/minute) fails the test
instead of slipping through unnoticed.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from models.user import User

_LIMIT_3 = 3
_LIMIT_5 = 5
_LIMIT_30 = 30
_LIMIT_60 = 60

_PRACTICE_PAYLOAD: dict[str, object] = {
    "stage_number": 1,
    "name": "Test Practice",
    "description": "Test desc",
    "instructions": "Test instructions",
    "default_duration_minutes": 10,
}


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


async def _promote_admin(db_session: AsyncSession, username: str = "alice") -> None:
    """Flip ``is_admin`` for the signed-up user so they can hit admin routes."""
    email = f"{username}@example.com"
    await db_session.execute(update(User).where(col(User.email) == email).values(is_admin=True))
    await db_session.commit()


async def _assert_limit_pinned(send: Callable[[], Awaitable[Response]], limit: int) -> None:
    """Assert a rate limit is pinned at exactly ``limit`` requests per window.

    Fires ``limit - 1`` warm-up requests, asserts the ``limit``-th request is
    admitted (any non-429 status), then asserts request ``limit + 1`` is
    rejected with the standard 429 payload and a Retry-After header.
    """
    for _ in range(limit - 1):
        await send()

    admitted = await send()
    assert admitted.status_code != HTTPStatus.TOO_MANY_REQUESTS

    throttled = await send()
    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == "rate_limit_exceeded"
    assert "retry-after" in throttled.headers


def _post_practice(client: AsyncClient, headers: dict[str, str]) -> Awaitable[Response]:
    return client.post("/practices/", json=_PRACTICE_PAYLOAD, headers=headers)


def _get_journal_list(client: AsyncClient, headers: dict[str, str]) -> Awaitable[Response]:
    return client.get("/journal/", headers=headers)


def _get_content_body(client: AsyncClient, headers: dict[str, str]) -> Awaitable[Response]:
    return client.get("/course/content/1/body", headers=headers)


def _get_site_resource_body(client: AsyncClient, headers: dict[str, str]) -> Awaitable[Response]:
    return client.get("/course/site-resources/about/body", headers=headers)


# ── Default global limit ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_default_rate_limit_pinned_at_60_per_minute(async_client: AsyncClient) -> None:
    """A route with no ``@limiter.limit()`` override inherits the 60/minute default."""

    async def send() -> Response:
        return await async_client.get("/health")

    await _assert_limit_pinned(send, _LIMIT_60)


# ── Retry-After header ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_rate_limit_response_includes_retry_after(async_client: AsyncClient) -> None:
    """429 responses include a Retry-After header, pinned at signup's 3/minute limit."""
    emails = iter(range(_LIMIT_3 + 1))

    async def send() -> Response:
        return await async_client.post(
            "/auth/signup",
            json={
                "email": f"retryafter{next(emails)}@example.com",
                "password": "secret12345",  # pragma: allowlist secret
            },
        )

    await _assert_limit_pinned(send, _LIMIT_3)


# ── Per-endpoint: POST /user/balance/add (5/minute) ─────────────────────


@pytest.mark.asyncio
async def test_add_balance_rate_limit_pinned_at_5_per_minute(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """POST /user/balance/add is pinned at exactly 5 requests/minute.

    The endpoint is admin-only, so promote before hammering to verify the
    rate-limit gate fires *after* authz.
    """
    headers = await _signup(async_client)
    await _promote_admin(db_session)

    async def send() -> Response:
        return await async_client.post(
            "/user/balance/add",
            json={"amount": 1},
            headers=headers,
        )

    await _assert_limit_pinned(send, _LIMIT_5)


# ── Per-endpoint limits pinned exactly ───────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("make_request", "limit"),
    [
        (_post_practice, _LIMIT_5),
        (_get_journal_list, _LIMIT_30),
        (_get_content_body, _LIMIT_30),
        (_get_site_resource_body, _LIMIT_30),
    ],
    ids=[
        "post-practices-pinned-at-5-per-minute",
        "get-journal-list-pinned-at-30-per-minute",
        "get-content-body-pinned-at-30-per-minute",
        "get-site-resource-body-pinned-at-30-per-minute",
    ],
)
async def test_per_endpoint_rate_limit_pinned(
    async_client: AsyncClient,
    make_request: Callable[[AsyncClient, dict[str, str]], Awaitable[Response]],
    limit: int,
) -> None:
    """Each per-route limit is pinned at exactly its documented value."""
    headers = await _signup(async_client)

    async def send() -> Response:
        return await make_request(async_client, headers)

    await _assert_limit_pinned(send, limit)


# ── Auth rate limits unchanged ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_auth_signup_limit_unchanged_at_3_per_minute(async_client: AsyncClient) -> None:
    """Auth signup rate limit remains at 3/minute (not overridden by default)."""
    for i in range(_LIMIT_3 - 1):
        await async_client.post(
            "/auth/signup",
            json={
                "email": f"auth{i}@example.com",
                "password": "secret12345",  # pragma: allowlist secret
            },
        )

    third = await async_client.post(
        "/auth/signup",
        json={
            "email": "auth-third@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert third.status_code == HTTPStatus.OK

    fourth = await async_client.post(
        "/auth/signup",
        json={
            "email": "auth-fourth@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert fourth.status_code == HTTPStatus.TOO_MANY_REQUESTS


@pytest.mark.asyncio
async def test_auth_login_limit_unchanged_at_5_per_minute(async_client: AsyncClient) -> None:
    """Auth login rate limit remains at 5/minute (not overridden by default)."""
    await _signup(async_client)

    login_payload = {
        "email": "alice@example.com",
        "password": "secret12345",  # pragma: allowlist secret
    }

    for _ in range(_LIMIT_5 - 1):
        await async_client.post("/auth/login", json=login_payload)

    fifth = await async_client.post("/auth/login", json=login_payload)
    assert fifth.status_code == HTTPStatus.OK

    sixth = await async_client.post("/auth/login", json=login_payload)
    assert sixth.status_code == HTTPStatus.TOO_MANY_REQUESTS
