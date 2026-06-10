"""Tests for ``PUT /users/me/timezone`` (issue #261).

Covers the acceptance criteria: a valid IANA name is persisted and echoed
back by subsequent auth responses, invalid / oversized names are rejected
with 422, blank input coerces to ``"UTC"``, the route requires auth (401),
and one user's update never touches another's stored zone.
"""

from http import HTTPStatus

import pytest
from httpx import AsyncClient

# A name comfortably over the 64-char ``User.timezone`` column cap.
_OVERSIZED_TIMEZONE = "Area/" + ("x" * 70)


async def _signup(
    client: AsyncClient,
    username: str = "tzuser",
    timezone: str | None = None,
) -> tuple[dict[str, str], int]:
    """Create a user and return ``(auth headers, user_id)``."""
    payload: dict[str, str] = {
        "email": f"{username}@example.com",
        "password": "securepassword123",  # pragma: allowlist secret
    }
    if timezone is not None:
        payload["timezone"] = timezone
    resp = await client.post("/auth/signup", json=payload)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user_id"]


async def _login_timezone(client: AsyncClient, username: str = "tzuser") -> str:
    """Log in as ``username`` and return the timezone the server echoes back."""
    resp = await client.post(
        "/auth/login",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    timezone = resp.json()["timezone"]
    assert isinstance(timezone, str)
    return timezone


@pytest.mark.asyncio
async def test_update_timezone_persists_valid_iana(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)

    resp = await async_client.put(
        "/users/me/timezone",
        json={"timezone": "America/Los_Angeles"},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"timezone": "America/Los_Angeles"}
    # Persisted: a fresh login echoes the updated zone (PR #260 contract).
    assert await _login_timezone(async_client) == "America/Los_Angeles"


@pytest.mark.asyncio
async def test_update_timezone_rejects_unknown_iana(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)

    resp = await async_client.put(
        "/users/me/timezone",
        json={"timezone": "Mars/Phobos"},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_update_timezone_rejects_oversized(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)

    resp = await async_client.put(
        "/users/me/timezone",
        json={"timezone": _OVERSIZED_TIMEZONE},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_update_timezone_blank_coerces_to_utc(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client, timezone="America/New_York")

    resp = await async_client.put(
        "/users/me/timezone",
        json={"timezone": "   "},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"timezone": "UTC"}
    assert await _login_timezone(async_client) == "UTC"


@pytest.mark.asyncio
async def test_update_timezone_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.put(
        "/users/me/timezone",
        json={"timezone": "America/Los_Angeles"},
    )

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_update_timezone_is_scoped_to_caller(async_client: AsyncClient) -> None:
    alice_headers, _ = await _signup(async_client, username="alice", timezone="Europe/Paris")
    bob_headers, _ = await _signup(async_client, username="bob", timezone="Asia/Tokyo")

    resp = await async_client.put(
        "/users/me/timezone",
        json={"timezone": "America/Chicago"},
        headers=alice_headers,
    )
    assert resp.status_code == HTTPStatus.OK

    # Bob's stored zone is untouched by Alice's update.
    assert await _login_timezone(async_client, username="bob") == "Asia/Tokyo"
    assert await _login_timezone(async_client, username="alice") == "America/Chicago"
