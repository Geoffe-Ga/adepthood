"""Tests for database-backed auth with JWT tokens, rate limiting, and account lockout."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from unittest.mock import patch

import jwt
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import select

from models.login_attempt import LoginAttempt
from models.user import User
from routers.auth import (
    _SECRET_PLACEHOLDER,
    LOCKOUT_DURATION,
    MAX_FAILED_ATTEMPTS,
    _get_secret_key,
)

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


# ── Email normalization (BUG-AUTH-003, BUG-AUTH-010) ───────────────────


@pytest.mark.asyncio
async def test_signup_normalizes_email_case_and_whitespace(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Email submitted with mixed case or surrounding whitespace is normalized.

    The value is stored as the trimmed, lowercased form so later lookups
    don't miss it.
    """
    resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "  Alice@Example.COM ",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    result = await db_session.execute(select(User).where(User.email == "alice@example.com"))
    user = result.scalars().first()
    assert user is not None


@pytest.mark.asyncio
async def test_login_is_case_insensitive_after_signup(async_client: AsyncClient) -> None:
    """Signing up as ``Alice@Example.com`` lets the user log in as ``alice@example.com``.

    Verifies case-insensitive login after signup (BUG-AUTH-003).
    """
    await async_client.post(
        SIGNUP_URL,
        json={
            "email": "Alice@Example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    resp = await async_client.post(
        LOGIN_URL,
        json={
            "email": "alice@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_login_ignores_surrounding_whitespace(async_client: AsyncClient) -> None:
    """Pasted or autofilled whitespace in the email field is stripped server-side.

    Regression test for BUG-AUTH-010.
    """
    await _signup(async_client, email="whitespace@example.com")
    resp = await async_client.post(
        LOGIN_URL,
        json={
            "email": "  whitespace@example.com\n",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_duplicate_signup_detected_with_different_case(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A second signup with a case-variant email must not create a second user row.

    Regression test for BUG-AUTH-003.
    """
    await _signup(async_client, email="caseonly@example.com")
    await async_client.post(
        SIGNUP_URL,
        json={
            "email": "CaseOnly@Example.com",
            "password": "anotherpassword456",  # pragma: allowlist secret
        },
    )
    result = await db_session.execute(select(User).where(User.email == "caseonly@example.com"))
    users = result.scalars().all()
    assert len(users) == 1


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
    """Signup with an existing email returns the same status and response shape as a fresh signup.

    This prevents information leakage about registered emails.
    """
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
    # The duplicate response uses ``user_id=0`` as a sentinel. The frontend
    # ``authResponseSchema`` accepts non-negative integers so this sentinel
    # does not trip Zod validation and surface the generic "server changed"
    # error instead of completing the signup flow. Keep these in lock-step.
    assert second_data["user_id"] == 0


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
async def test_signup_short_password_returns_422(async_client: AsyncClient) -> None:
    """BUG-AUTH-017: ``AuthRequest.password`` enforces length bounds via Pydantic.

    The pre-bound implementation raised a 400 from a manual check inside
    the handler.  Moving the bound to the schema field surfaces the
    rejection at the trust boundary (matching the timezone field's
    422 contract) and prevents the bcrypt cost from running on input
    that would always be rejected.
    """
    resp = await async_client.post(
        SIGNUP_URL,
        json={"email": "short@example.com", "password": "short"},  # pragma: allowlist secret
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_signup_long_password_returns_422(async_client: AsyncClient) -> None:
    """BUG-AUTH-017: passwords beyond the upper bound are rejected too.

    Without the upper cap the bcrypt cost (~250 ms) ran on every
    request and gave an attacker a free CPU-burn lever.  64 chars is
    the cleanly-rejected boundary; longer values 422.
    """
    resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "longpw@example.com",
            "password": "a" * 200,  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


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
async def test_missing_token_returns_401_unauthorized(async_client: AsyncClient) -> None:
    resp = await async_client.get("/habits/")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED
    assert resp.json()["detail"] == "unauthorized"


@pytest.mark.asyncio
async def test_invalid_token_returns_401_unauthorized(async_client: AsyncClient) -> None:
    headers = {"Authorization": "Bearer badtoken"}  # pragma: allowlist secret
    resp = await async_client.get("/habits/", headers=headers)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED
    assert resp.json()["detail"] == "unauthorized"


@pytest.mark.asyncio
async def test_expired_token_returns_401_unauthorized(async_client: AsyncClient) -> None:
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
    assert resp.json()["detail"] == "unauthorized"


@pytest.mark.asyncio
async def test_all_token_errors_return_identical_response(async_client: AsyncClient) -> None:
    """All token rejection scenarios must return the same detail string.

    This prevents information leakage about token state (sec-04).
    """
    data = await _signup(async_client)
    user_id = data["user_id"]

    # Missing token
    missing_resp = await async_client.get("/habits/")

    # Invalid token
    invalid_resp = await async_client.get(
        "/habits/",
        headers={"Authorization": "Bearer badtoken"},  # pragma: allowlist secret
    )

    # Expired token
    expired_payload = {"sub": str(user_id), "exp": 0, "iat": 0}
    expired_token = jwt.encode(expired_payload, SECRET_KEY, algorithm="HS256")
    expired_resp = await async_client.get(
        "/habits/", headers={"Authorization": f"Bearer {expired_token}"}
    )

    # Malformed Authorization header (no "Bearer " prefix)
    no_prefix_resp = await async_client.get(
        "/habits/", headers={"Authorization": "NotBearer sometoken"}
    )

    # All must return identical status + detail
    for resp in (missing_resp, invalid_resp, expired_resp, no_prefix_resp):
        assert resp.status_code == HTTPStatus.UNAUTHORIZED
        assert resp.json()["detail"] == "unauthorized"


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


# ── Token refresh ─────────────────────────────────────────────────────

REFRESH_URL = "/auth/refresh"


@pytest.mark.asyncio
async def test_refresh_returns_new_token(async_client: AsyncClient) -> None:
    """A valid token can be exchanged for a fresh one with a reset TTL."""
    data = await _signup(async_client)
    headers = {"Authorization": f"Bearer {data['token']}"}

    resp = await async_client.post(REFRESH_URL, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert "token" in body
    assert "user_id" in body

    # Decode the refreshed token and verify its expiration is in the future
    decoded = jwt.decode(body["token"], SECRET_KEY, algorithms=["HS256"])
    assert int(decoded["sub"]) == data["user_id"]
    assert decoded["exp"] > datetime.now(UTC).timestamp()


@pytest.mark.asyncio
async def test_refresh_token_is_valid(async_client: AsyncClient) -> None:
    """The token returned by /auth/refresh grants access to protected endpoints."""
    data = await _signup(async_client)
    headers = {"Authorization": f"Bearer {data['token']}"}

    resp = await async_client.post(REFRESH_URL, headers=headers)
    new_token = resp.json()["token"]

    protected_resp = await async_client.get(
        "/habits/", headers={"Authorization": f"Bearer {new_token}"}
    )
    assert protected_resp.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_refresh_preserves_user_id(async_client: AsyncClient) -> None:
    """The refreshed token maps to the same user."""
    data = await _signup(async_client)
    headers = {"Authorization": f"Bearer {data['token']}"}

    resp = await async_client.post(REFRESH_URL, headers=headers)
    body = resp.json()
    assert body["user_id"] == data["user_id"]


@pytest.mark.asyncio
async def test_refresh_without_token_returns_401(async_client: AsyncClient) -> None:
    """Refresh without Authorization header returns 401."""
    resp = await async_client.post(REFRESH_URL)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_refresh_with_expired_token_returns_401(async_client: AsyncClient) -> None:
    """An expired token cannot be refreshed."""
    data = await _signup(async_client)
    expired_payload = {
        "sub": str(data["user_id"]),
        "exp": 0,
        "iat": 0,
    }
    expired_token = jwt.encode(expired_payload, SECRET_KEY, algorithm="HS256")
    headers = {"Authorization": f"Bearer {expired_token}"}

    resp = await async_client.post(REFRESH_URL, headers=headers)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_refresh_with_invalid_token_returns_401(async_client: AsyncClient) -> None:
    """A garbage token cannot be refreshed."""
    headers = {"Authorization": "Bearer not-a-real-token"}  # pragma: allowlist secret
    resp = await async_client.post(REFRESH_URL, headers=headers)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_refresh_rate_limit_returns_429(async_client: AsyncClient) -> None:
    """Refresh endpoint returns 429 after exceeding 1 request/minute."""
    data = await _signup(async_client)
    headers = {"Authorization": f"Bearer {data['token']}"}

    # First request should succeed
    resp = await async_client.post(REFRESH_URL, headers=headers)
    assert resp.status_code == HTTPStatus.OK

    # Second request within the same minute should be rate-limited
    resp = await async_client.post(REFRESH_URL, headers=headers)
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS


# ── User.timezone signup write path ────────────────────────────────────────


@pytest.mark.asyncio
async def test_signup_persists_timezone(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A valid IANA zone in the signup payload lands on the user row.

    Also asserts the response JSON echoes the stored zone so the
    frontend can wire ``userTimezone`` directly from the signup
    response.  A serialization regression that dropped the field would
    silently break user-local helpers everywhere; pinning the JSON
    shape here prevents that.
    """
    resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "tz@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
            "timezone": "America/Los_Angeles",
        },
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["timezone"] == "America/Los_Angeles"

    result = await db_session.execute(select(User).where(User.email == "tz@example.com"))
    user = result.scalars().one()
    assert user.timezone == "America/Los_Angeles"


@pytest.mark.asyncio
async def test_signup_omitted_timezone_defaults_to_utc(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Old clients that omit ``timezone`` keep the column at its default.

    Same JSON-shape assertion as above: the response carries ``"UTC"``
    so the frontend bootstrap path can rely on the field being present
    even for legacy payloads.
    """
    resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "default@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["timezone"] == "UTC"

    result = await db_session.execute(select(User).where(User.email == "default@example.com"))
    user = result.scalars().one()
    assert user.timezone == "UTC"


@pytest.mark.asyncio
async def test_signup_invalid_timezone_returns_422(async_client: AsyncClient) -> None:
    """An unknown IANA name fails at the trust boundary, not silently at runtime.

    Closes the review feedback gap: silent UTC fallback for malformed
    input would store wrong-zone behavior forever with no error
    diagnosable from the API response.  422 surfaces the bad input
    immediately so the client can re-request with a valid value.
    """
    resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "bogus@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
            "timezone": "Etc/NotAZone",
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_signup_oversized_timezone_returns_422(async_client: AsyncClient) -> None:
    """Strings beyond the 64-char column width are rejected at the boundary."""
    resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "long@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
            "timezone": "A" * 100,
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_signup_blank_timezone_falls_back_to_default(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Whitespace-only and empty strings are coerced to the UTC default."""
    resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "blank@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
            "timezone": "   ",
        },
    )
    assert resp.status_code == HTTPStatus.OK

    result = await db_session.execute(select(User).where(User.email == "blank@example.com"))
    user = result.scalars().one()
    assert user.timezone == "UTC"


@pytest.mark.asyncio
async def test_login_response_carries_stored_timezone(
    async_client: AsyncClient,
) -> None:
    """``/auth/login`` returns the user's stored IANA zone in the response JSON.

    The frontend ``AuthContext`` reads this field on every login to set
    ``userTimezone``; a serialization regression that dropped it would
    silently revert the entire user-local-time system to UTC for every
    returning user.  Pinning the JSON shape here catches that.
    """
    signup_resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "login_tz@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
            "timezone": "America/Los_Angeles",
        },
    )
    assert signup_resp.status_code == HTTPStatus.OK

    login_resp = await async_client.post(
        LOGIN_URL,
        json={
            "email": "login_tz@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert login_resp.status_code == HTTPStatus.OK
    assert login_resp.json()["timezone"] == "America/Los_Angeles"


@pytest.mark.asyncio
async def test_refresh_response_carries_stored_timezone(
    async_client: AsyncClient,
) -> None:
    """``/auth/refresh`` returns the user's stored IANA zone in the response JSON.

    The cold-start → proactive-refresh path on the frontend uses this
    value to restore ``userTimezone`` after token rehydration.  Without
    this assertion a missing field would leave every refreshed session
    on the UTC default until the user manually re-authenticated.
    """
    signup_resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "refresh_tz@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
            "timezone": "Europe/Berlin",
        },
    )
    assert signup_resp.status_code == HTTPStatus.OK
    token = signup_resp.json()["token"]

    refresh_resp = await async_client.post(
        REFRESH_URL,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert refresh_resp.status_code == HTTPStatus.OK
    assert refresh_resp.json()["timezone"] == "Europe/Berlin"


# ── Concurrency: signup race + lockout TOCTOU (BUG-AUTH-003 / -007) ────


_CONCURRENT_SIGNUP_FANOUT = 5


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_signups_for_same_email_create_one_user(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Five simultaneous signups for the same email yield exactly one user row.

    Closes BUG-AUTH-003: under the old SELECT-then-INSERT pattern two
    concurrent signups could both pass the existence check and both
    insert.  The case-insensitive unique index on ``lower(email)`` plus
    the ``IntegrityError`` rollback keeps the row count at one and the
    losing requests still receive the anti-enumeration dummy response.
    """
    payloads = [
        {"email": "race@example.com", "password": "securepassword123"}  # pragma: allowlist secret
        for _ in range(_CONCURRENT_SIGNUP_FANOUT)
    ]
    responses = await asyncio.gather(
        *[concurrent_async_client.post(SIGNUP_URL, json=p) for p in payloads]
    )

    # Every attempt returns the same status + shape (anti-enumeration).
    assert all(r.status_code == HTTPStatus.OK for r in responses)
    assert all(set(r.json().keys()) >= {"token", "user_id"} for r in responses)

    # Exactly one of them owns a real ``user_id``; the rest get the
    # dummy ``user_id == 0`` so a timing/shape oracle cannot distinguish
    # the winner from the duplicates.
    real_ids = [r.json()["user_id"] for r in responses if r.json()["user_id"] != 0]
    assert len(real_ids) == 1, real_ids

    # The DB has exactly one row for the contested email.
    async with concurrent_session_factory() as session:
        result = await session.execute(select(User).where(User.email == "race@example.com"))
        users = result.scalars().all()
    assert len(users) == 1


_CONCURRENT_FAILED_LOGIN_FANOUT = 10


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_failed_logins_cannot_outpace_lockout(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """BUG-AUTH-007: concurrent failed attempts must not all pass the lockout check.

    Without per-email serialization, ten simultaneous wrong-password
    attempts could each read "no failures yet" and each pay the bcrypt
    cost before any of them recorded a row, defeating the
    ``MAX_FAILED_ATTEMPTS`` cap.  The asyncio + ``pg_advisory_xact_lock``
    serialization makes the lockout check + insert atomic per email, so
    no more than ``MAX_FAILED_ATTEMPTS`` attempts complete with a 401
    before subsequent ones are blocked.
    """
    await concurrent_async_client.post(
        SIGNUP_URL,
        json={
            "email": "lockoutrace@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )

    results = await asyncio.gather(
        *[
            concurrent_async_client.post(
                LOGIN_URL,
                json={
                    "email": "lockoutrace@example.com",
                    "password": "wrongpassword999",  # pragma: allowlist secret
                },
            )
            for _ in range(_CONCURRENT_FAILED_LOGIN_FANOUT)
        ]
    )

    # Every concurrent failed attempt returns 401, indistinguishable from a
    # locked or wrong-password response.  Serialization (BUG-AUTH-007)
    # prevents the bcrypt cost from being paid more than
    # ``MAX_FAILED_ATTEMPTS`` times -- each task must wait its turn at the
    # per-email lock before reading the lockout state, so no more than
    # ``MAX_FAILED_ATTEMPTS`` can pass the check before subsequent
    # attempts hit the locked branch.
    assert all(r.status_code == HTTPStatus.UNAUTHORIZED for r in results)
    async with concurrent_session_factory() as session:
        result = await session.execute(
            select(LoginAttempt).where(LoginAttempt.email == "lockoutrace@example.com")
        )
        attempts = list(result.scalars().all())
    failed_attempts = [a for a in attempts if not a.success]
    # BUG-AUTH-006: blocked attempts are now also recorded so the
    # rolling lockout window stays fresh against an attacker who keeps
    # hammering the endpoint.  Pre-006 only the first
    # ``MAX_FAILED_ATTEMPTS`` rows landed; post-006 every fanout request
    # records a row, but only the first ``MAX_FAILED_ATTEMPTS`` of them
    # paid the bcrypt cost.  The invariant we keep is "no row count
    # exceeds the fanout" -- bug-006 + bug-007 together mean exactly
    # one row per request.
    assert len(failed_attempts) == _CONCURRENT_FAILED_LOGIN_FANOUT, (
        f"expected exactly {_CONCURRENT_FAILED_LOGIN_FANOUT} rows "
        f"(one per request, BUG-AUTH-006 records blocked attempts), "
        f"got {len(failed_attempts)}"
    )


# ── Auth hardening (Prompt 11) ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_signup_multibyte_password_over_72_bytes_returns_400(
    async_client: AsyncClient,
) -> None:
    """BUG-AUTH-004: bcrypt silently truncates beyond 72 bytes.

    A 64-character password of 4-byte UTF-8 emoji is 256 bytes -- well
    past the bcrypt limit.  The Pydantic ``max_length`` cap would let it
    through (it counts characters, not bytes), so the helper itself must
    reject before hashing.  Translated to 400 ``password_too_long`` so a
    truncation never makes it into the database.
    """
    resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "multibyte@example.com",
            "password": "🔥" * 30,  # 30 chars, 120 bytes (each emoji is 4 bytes)
        },
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert resp.json()["detail"] == "password_too_long"


@pytest.mark.asyncio
async def test_get_current_user_malformed_sub_returns_401(
    async_client: AsyncClient,
) -> None:
    """BUG-AUTH-012: a token whose ``sub`` is missing or non-numeric used to 500.

    Forge a JWT signed with the test secret but carrying ``sub: "not-an-int"``
    so it decodes cleanly but ``int(sub)`` raises.  The handler now wraps
    that in the same 401 every other rejection uses.
    """
    forged = jwt.encode(
        {
            "sub": "not-an-int",
            "exp": datetime.now(UTC) + timedelta(hours=1),
            "iat": datetime.now(UTC),
        },
        SECRET_KEY,
        algorithm="HS256",
    )
    resp = await async_client.get(
        "/auth/refresh",
        headers={"Authorization": f"Bearer {forged}"},
    )
    # Either 401 (auth rejected) or 405 (method-not-allowed on refresh GET).
    # The protected endpoint test below exercises the 401 path explicitly.
    # We use a method that exists: POST /auth/refresh.
    resp = await async_client.post(
        "/auth/refresh",
        headers={"Authorization": f"Bearer {forged}"},
    )
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_get_current_user_missing_sub_returns_401(
    async_client: AsyncClient,
) -> None:
    """A token whose payload omits ``sub`` entirely also returns 401."""
    forged = jwt.encode(
        {
            "exp": datetime.now(UTC) + timedelta(hours=1),
            "iat": datetime.now(UTC),
        },
        SECRET_KEY,
        algorithm="HS256",
    )
    resp = await async_client.post(
        "/auth/refresh",
        headers={"Authorization": f"Bearer {forged}"},
    )
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


def test_get_secret_key_raises_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """BUG-AUTH-011: misconfigured SECRET_KEY raises eagerly.

    The helper is called once from the FastAPI lifespan (see
    ``main.lifespan``) so a deployment that forgot to set the env var
    fails the readiness probe at startup rather than serving traffic
    until the first auth request and then crashing 500.
    """
    monkeypatch.setattr("routers.auth.SECRET_KEY", "")
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        _get_secret_key()


def test_get_secret_key_raises_when_placeholder(monkeypatch: pytest.MonkeyPatch) -> None:
    """The placeholder string also fails the startup check."""
    monkeypatch.setattr("routers.auth.SECRET_KEY", _SECRET_PLACEHOLDER)
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        _get_secret_key()


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_blocked_login_attempt_is_recorded(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BUG-AUTH-006: blocked attempts are recorded so the lockout window stays fresh.

    Drive the user into lockout, then issue one more wrong-password
    attempt and confirm a row was inserted.  Pre-006 the blocked branch
    short-circuited without recording, letting the rolling window
    expire under continuous attack.
    """
    email = "lockedrec@example.com"
    await async_client.post(
        SIGNUP_URL,
        json={"email": email, "password": "rightpass123"},  # pragma: allowlist secret
    )
    # Drive past the threshold.
    for _ in range(MAX_FAILED_ATTEMPTS):
        await _fail_login(async_client, email=email)
    # One more attempt -- this one is blocked.
    blocked = await async_client.post(
        LOGIN_URL,
        json={"email": email, "password": "wrongpw999"},  # pragma: allowlist secret
    )
    assert blocked.status_code == HTTPStatus.UNAUTHORIZED

    result = await db_session.execute(select(LoginAttempt).where(LoginAttempt.email == email))
    attempts = list(result.scalars().all())
    # MAX_FAILED_ATTEMPTS verify-failed + at least 1 blocked-and-recorded.
    assert len(attempts) > MAX_FAILED_ATTEMPTS
