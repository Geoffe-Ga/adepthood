"""Tests for database-backed auth with JWT tokens."""

from __future__ import annotations

from http import HTTPStatus

import jwt
import pytest
from httpx import AsyncClient

SIGNUP_URL = "/auth/signup"
LOGIN_URL = "/auth/login"
SECRET_KEY = "test-secret-key-for-unit-tests-only"  # pragma: allowlist secret


async def _signup(
    client: AsyncClient,
    email: str = "alice@example.com",
    password: str = "securepassword123",
) -> dict[str, object]:
    resp = await client.post(
        SIGNUP_URL,
        json={"email": email, "password": password},
    )
    result: dict[str, object] = resp.json()
    return result


# ── Signup ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_signup_returns_token_and_user_id(async_client: AsyncClient) -> None:
    resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "alice@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert "token" in data
    assert "user_id" in data
    assert isinstance(data["user_id"], int)


@pytest.mark.asyncio
async def test_signup_duplicate_email_returns_400(async_client: AsyncClient) -> None:
    await _signup(async_client, email="dup@example.com")
    resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "dup@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert "user exists" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_signup_short_password_returns_400(async_client: AsyncClient) -> None:
    resp = await async_client.post(
        SIGNUP_URL,
        json={"email": "short@example.com", "password": "short"},  # pragma: allowlist secret
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert "at least 8 characters" in resp.json()["detail"]


# ── Login ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_login_returns_token(async_client: AsyncClient) -> None:
    await _signup(async_client)
    resp = await async_client.post(
        LOGIN_URL,
        json={
            "email": "alice@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert "token" in data
    assert "user_id" in data


@pytest.mark.asyncio
async def test_login_wrong_password_returns_401(async_client: AsyncClient) -> None:
    await _signup(async_client)
    resp = await async_client.post(
        LOGIN_URL,
        json={
            "email": "alice@example.com",
            "password": "wrongpassword123",  # pragma: allowlist secret
        },  # pragma: allowlist secret
    )
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_login_nonexistent_user_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.post(
        LOGIN_URL,
        json={
            "email": "nobody@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── Token validation ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_valid_token_accesses_protected_endpoint(async_client: AsyncClient) -> None:
    data = await _signup(async_client)
    headers = {"Authorization": f"Bearer {data['token']}"}
    resp = await async_client.get("/habits/", headers=headers)
    assert resp.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_missing_token_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/habits/")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_invalid_token_returns_401(async_client: AsyncClient) -> None:
    headers = {"Authorization": "Bearer badtoken"}  # pragma: allowlist secret
    resp = await async_client.get("/habits/", headers=headers)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_expired_token_returns_401(async_client: AsyncClient) -> None:
    data = await _signup(async_client)
    user_id = data["user_id"]
    # Create an already-expired JWT
    expired_payload = {
        "sub": str(user_id),
        "exp": 0,  # epoch = already expired
        "iat": 0,
    }
    expired_token = jwt.encode(expired_payload, SECRET_KEY, algorithm="HS256")
    headers = {"Authorization": f"Bearer {expired_token}"}
    resp = await async_client.get("/habits/", headers=headers)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── Full flow ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_signup_login_use_token_flow(async_client: AsyncClient) -> None:
    # Signup
    signup_resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "flow@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert signup_resp.status_code == HTTPStatus.OK
    user_id = signup_resp.json()["user_id"]

    # Login
    login_resp = await async_client.post(
        LOGIN_URL,
        json={
            "email": "flow@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert login_resp.status_code == HTTPStatus.OK
    token = login_resp.json()["token"]

    # Use token to access protected endpoint
    headers = {"Authorization": f"Bearer {token}"}
    habits_resp = await async_client.get("/habits/", headers=headers)
    assert habits_resp.status_code == HTTPStatus.OK

    # Same user_id from login as signup
    assert login_resp.json()["user_id"] == user_id
