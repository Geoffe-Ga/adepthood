"""Tests for database-backed auth with JWT tokens, rate limiting, and account lockout."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from unittest.mock import patch

import jwt
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.login_attempt import LoginAttempt
from models.user import User
from routers.auth import LOCKOUT_DURATION, MAX_FAILED_ATTEMPTS

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


async def _fail_login(
    client: AsyncClient,
    email: str = "alice@example.com",
) -> None:
    """Perform a single failed login attempt."""
    await client.post(
        LOGIN_URL,
        json={"email": email, "password": "wrongpassword999"},  # pragma: allowlist secret
    )


# ── Email validation ───────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_email",
    [
        "not-an-email",
        "missing-at-sign.com",
        "@no-local-part.com",
        "spaces in@email.com",
        "",
        "   ",
    ],
    ids=[
        "plain-string",
        "no-at-sign",
        "no-local-part",
        "spaces-in-local",
        "empty-string",
        "whitespace-only",
    ],
)
async def test_signup_rejects_malformed_email(
    async_client: AsyncClient,
    bad_email: str,
) -> None:
    resp = await async_client.post(
        SIGNUP_URL,
        json={"email": bad_email, "password": "securepassword123"},  # pragma: allowlist secret
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_email",
    [
        "not-an-email",
        "",
    ],
    ids=["plain-string", "empty-string"],
)
async def test_login_rejects_malformed_email(
    async_client: AsyncClient,
    bad_email: str,
) -> None:
    resp = await async_client.post(
        LOGIN_URL,
        json={"email": bad_email, "password": "securepassword123"},  # pragma: allowlist secret
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


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
async def test_signup_duplicate_email_returns_same_shape(async_client: AsyncClient) -> None:
    """Signup with an existing email returns the same status and response shape
    as a fresh signup — no information leakage about registered emails."""
    first_resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "dup@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    second_resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "dup@example.com",
            "password": "anotherpassword456",  # pragma: allowlist secret
        },
    )
    assert second_resp.status_code == first_resp.status_code
    first_data = first_resp.json()
    second_data = second_resp.json()
    assert set(first_data.keys()) == set(second_data.keys())
    assert "token" in second_data
    assert "user_id" in second_data
    assert isinstance(second_data["user_id"], int)


@pytest.mark.asyncio
async def test_signup_duplicate_email_does_not_create_second_user(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A duplicate signup must not create a second user row."""
    await _signup(async_client, email="nodupe@example.com")
    await async_client.post(
        SIGNUP_URL,
        json={
            "email": "nodupe@example.com",
            "password": "anotherpassword456",  # pragma: allowlist secret
        },
    )
    result = await db_session.execute(select(User).where(User.email == "nodupe@example.com"))
    users = result.scalars().all()
    assert len(users) == 1


@pytest.mark.asyncio
async def test_signup_duplicate_email_token_is_not_valid(async_client: AsyncClient) -> None:
    """The token returned for a duplicate signup must not grant access."""
    await _signup(async_client, email="invalid-tok@example.com")
    resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "invalid-tok@example.com",
            "password": "anotherpassword456",  # pragma: allowlist secret
        },
    )
    fake_token = resp.json()["token"]
    headers = {"Authorization": f"Bearer {fake_token}"}
    protected_resp = await async_client.get("/habits/", headers=headers)
    assert protected_resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_signup_short_password_returns_400(async_client: AsyncClient) -> None:
    resp = await async_client.post(
        SIGNUP_URL,
        json={"email": "short@example.com", "password": "short"},  # pragma: allowlist secret
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert resp.json()["detail"] == "password_too_short"


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


# ── Account lockout ────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_account_locks_after_max_failed_attempts(async_client: AsyncClient) -> None:
    """After MAX_FAILED_ATTEMPTS consecutive failures, login is blocked."""
    await _signup(async_client)

    for _ in range(MAX_FAILED_ATTEMPTS):
        await _fail_login(async_client)

    # The next attempt should still return 401 with the same generic message,
    # even with the correct password (account is locked)
    resp = await async_client.post(
        LOGIN_URL,
        json={
            "email": "alice@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.UNAUTHORIZED
    assert resp.json()["detail"] == "invalid_credentials"


@pytest.mark.asyncio
async def test_lockout_expires_after_duration(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """After LOCKOUT_DURATION, the account is unlocked and login works again."""
    await _signup(async_client)

    # Create old failed attempts that are outside the lockout window
    expired_time = datetime.now(UTC) - LOCKOUT_DURATION - timedelta(minutes=1)
    for _ in range(MAX_FAILED_ATTEMPTS):
        attempt = LoginAttempt(
            email="alice@example.com",
            ip_address="127.0.0.1",
            success=False,
            created_at=expired_time,
        )
        db_session.add(attempt)
    await db_session.commit()

    # Login should succeed because all failures are outside the lockout window
    resp = await async_client.post(
        LOGIN_URL,
        json={
            "email": "alice@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_successful_login_resets_lockout(async_client: AsyncClient) -> None:
    """A successful login resets the failure count so lockout doesn't trigger."""
    await _signup(async_client)

    # Accumulate failures just below the threshold
    for _ in range(MAX_FAILED_ATTEMPTS - 1):
        await _fail_login(async_client)

    # Successful login breaks the streak
    resp = await async_client.post(
        LOGIN_URL,
        json={
            "email": "alice@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK

    # Now fail again — the previous success reset the window, so we're not locked
    for _ in range(MAX_FAILED_ATTEMPTS - 1):
        await _fail_login(async_client)

    resp = await async_client.post(
        LOGIN_URL,
        json={
            "email": "alice@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_lockout_returns_generic_message(async_client: AsyncClient) -> None:
    """Locked accounts return 'invalid_credentials', not 'account_locked'."""
    await _signup(async_client)

    for _ in range(MAX_FAILED_ATTEMPTS):
        await _fail_login(async_client)

    resp = await async_client.post(
        LOGIN_URL,
        json={
            "email": "alice@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    # Must be generic to prevent account enumeration
    assert resp.json()["detail"] == "invalid_credentials"


# ── Audit logging ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_login_records_attempt_on_failure(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Failed login creates a LoginAttempt record with success=False."""
    await _signup(async_client)
    await _fail_login(async_client)

    result = await db_session.execute(select(LoginAttempt))
    attempts = result.scalars().all()
    failed_attempts = [a for a in attempts if not a.success]
    assert len(failed_attempts) >= 1
    assert failed_attempts[0].email == "alice@example.com"


@pytest.mark.asyncio
async def test_login_records_attempt_on_success(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Successful login creates a LoginAttempt record with success=True."""
    await _signup(async_client)
    await async_client.post(
        LOGIN_URL,
        json={
            "email": "alice@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )

    result = await db_session.execute(select(LoginAttempt))
    attempts = result.scalars().all()
    success_attempts = [a for a in attempts if a.success]
    assert len(success_attempts) >= 1
    assert success_attempts[0].email == "alice@example.com"


# ── Security headers ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_security_headers_present(async_client: AsyncClient) -> None:
    """All responses include X-Content-Type-Options and X-Frame-Options."""
    resp = await async_client.get("/")
    assert resp.headers.get("x-content-type-options") == "nosniff"
    assert resp.headers.get("x-frame-options") == "DENY"


@pytest.mark.asyncio
async def test_hsts_header_in_production(async_client: AsyncClient) -> None:
    """Strict-Transport-Security is set when ENV=production."""
    with patch.dict("os.environ", {"ENV": "production"}):
        resp = await async_client.get("/")
    assert "strict-transport-security" in resp.headers
    assert "max-age=31536000" in resp.headers["strict-transport-security"]


@pytest.mark.asyncio
async def test_no_hsts_header_in_development(async_client: AsyncClient) -> None:
    """Strict-Transport-Security is NOT set in development."""
    resp = await async_client.get("/")
    assert "strict-transport-security" not in resp.headers


# ── Rate limiting ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_login_rate_limit_returns_429(async_client: AsyncClient) -> None:
    """Login endpoint returns 429 after exceeding 5 requests/minute."""
    await _signup(async_client)

    # Make 5 requests (the limit)
    for _ in range(5):
        await async_client.post(
            LOGIN_URL,
            json={
                "email": "alice@example.com",
                "password": "securepassword123",  # pragma: allowlist secret
            },
        )

    # The 6th request should be rate-limited
    resp = await async_client.post(
        LOGIN_URL,
        json={
            "email": "alice@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "rate_limit_exceeded"


@pytest.mark.asyncio
async def test_signup_rate_limit_returns_429(async_client: AsyncClient) -> None:
    """Signup endpoint returns 429 after exceeding 3 requests/minute."""
    # Make 3 requests (the limit)
    for i in range(3):
        await async_client.post(
            SIGNUP_URL,
            json={
                "email": f"user{i}@example.com",
                "password": "securepassword123",  # pragma: allowlist secret
            },
        )

    # The 4th request should be rate-limited
    resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "user99@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "rate_limit_exceeded"
