"""Authentication endpoints with JWT tokens, rate limiting, and account lockout."""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import bcrypt
import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from errors import bad_request
from models.login_attempt import LoginAttempt
from models.user import DEFAULT_USER_TIMEZONE, User
from rate_limit import limiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

SECRET_KEY = os.getenv("SECRET_KEY", "")
_JWT_ALGORITHM = "HS256"

# JWT token lifetime. One hour balances security (limits the window for a
# stolen token to be misused) with UX (a typical session lasts under an
# hour, so most users won't be interrupted by forced re-authentication).
_TOKEN_TTL = timedelta(hours=1)

_MIN_PASSWORD_LENGTH = 8

# Account lockout: lock after this many consecutive failed attempts.
MAX_FAILED_ATTEMPTS = 5

# How long the lockout lasts before the user can try again.
LOCKOUT_DURATION = timedelta(minutes=15)


_SECRET_PLACEHOLDER = "replace-me"  # noqa: S105  # nosec B105  # pragma: allowlist secret


def _get_secret_key() -> str:
    if not SECRET_KEY or SECRET_KEY == _SECRET_PLACEHOLDER:
        msg = "SECRET_KEY environment variable must be set to a secure value"
        raise RuntimeError(msg)
    return SECRET_KEY


# Length of the email log fingerprint. Twelve hex chars (48 bits) is ample to
# distinguish accounts in a single tenant's log stream while remaining short
# enough to read at a glance, and it is not reversible to the original email.
_EMAIL_LOG_FINGERPRINT_LEN = 12


def _email_log_fingerprint(email: str) -> str:
    """Stable, non-reversible identifier safe for logs — never log raw emails.

    Returned value is deterministic for a given normalized email, so operators
    can still correlate events across log lines (e.g. repeated failed logins)
    without exposing PII to log aggregation.
    """
    digest = hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()
    return digest[:_EMAIL_LOG_FINGERPRINT_LEN]


class AuthRequest(BaseModel):
    email: EmailStr
    password: str

    @field_validator("email", mode="before")
    @classmethod
    def _normalize_email(cls, value: object) -> object:
        """Strip whitespace and lowercase emails at the boundary.

        Addresses BUG-AUTH-003 (case-sensitive lookups) and BUG-AUTH-010
        (whitespace from paste/autofill). Applied before ``EmailStr``
        validation so the normalized form is what gets stored and compared.
        """
        if isinstance(value, str):
            return value.strip().lower()
        return value


# Cap matches ``User.timezone`` column width.  IANA names are at most 33
# chars today (``America/Argentina/ComodRivadavia``); 64 leaves headroom.
_MAX_TIMEZONE_LENGTH = 64


def _coerce_timezone_input(value: object) -> str | None:
    """Normalise inbound ``timezone`` field values to ``str | None``.

    Returns ``None`` for inputs that should fall back to the column
    default (missing, non-string, empty / whitespace-only).  Anything
    else is returned trimmed for downstream validation.  Split out so
    the ``_validate_timezone`` validator stays at xenon rank A.
    """
    if value is None or not isinstance(value, str):
        return None
    candidate = value.strip()
    return candidate or None


def _check_timezone_resolves(candidate: str) -> None:
    """Raise ``ValueError`` if ``candidate`` is too long or unknown to ``zoneinfo``."""
    if len(candidate) > _MAX_TIMEZONE_LENGTH:
        msg = f"timezone must be {_MAX_TIMEZONE_LENGTH} chars or fewer"
        raise ValueError(msg)
    try:
        ZoneInfo(candidate)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        msg = f"unknown IANA timezone: {candidate!r}"
        raise ValueError(msg) from exc


class SignupRequest(AuthRequest):
    """Signup payload — email + password + optional IANA ``timezone``.

    The timezone is sent by the frontend on first signup (read from
    ``Intl.DateTimeFormat().resolvedOptions().timeZone``) so streak and
    daily-completion math computes "today" in the user's local calendar
    from day one.  Validated at the trust boundary (here) rather than
    silently coerced at runtime so a malformed value surfaces as 422
    instead of permanently storing bad data — the runtime fallback to
    UTC inside :mod:`domain.dates` is a safety net, not a license to
    accept garbage.

    Omitting ``timezone`` keeps the column at its ``"UTC"`` default, so
    existing clients that have not been migrated to send the field do
    not break.
    """

    timezone: str = DEFAULT_USER_TIMEZONE

    @field_validator("timezone", mode="before")
    @classmethod
    def _validate_timezone(cls, value: object) -> str:
        """Reject malformed IANA strings before they reach the DB."""
        candidate = _coerce_timezone_input(value)
        if candidate is None:
            return DEFAULT_USER_TIMEZONE
        _check_timezone_resolves(candidate)
        return candidate


class AuthResponse(BaseModel):
    token: str
    user_id: int


def _hash_password(password: str) -> str:
    # 12 rounds of bcrypt hashing (~250 ms on modern hardware). This is the
    # OWASP-recommended minimum; it makes brute-force attacks prohibitively
    # expensive while keeping login latency acceptable for users.
    hashed: bytes = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12))
    return hashed.decode("utf-8")


def _verify_password(password: str, password_hash: str) -> bool:
    return bool(bcrypt.checkpw(password.encode(), password_hash.encode("utf-8")))


def _create_token(user_id: int) -> str:
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(UTC) + _TOKEN_TTL,
        "iat": datetime.now(UTC),
    }
    return str(jwt.encode(payload, _get_secret_key(), algorithm=_JWT_ALGORITHM))


def _create_dummy_token() -> str:
    """Generate a structurally-valid JWT that will never decode with the real secret.

    Used to return an indistinguishable response when a signup is attempted
    with an already-registered email, preventing account enumeration.
    """
    nonce_key = secrets.token_hex(32)
    payload = {
        "sub": "0",
        "exp": datetime.now(UTC) + _TOKEN_TTL,
        "iat": datetime.now(UTC),
    }
    return str(jwt.encode(payload, nonce_key, algorithm=_JWT_ALGORITHM))


def _get_client_ip(request: Request) -> str:
    """Extract client IP from the request, respecting X-Forwarded-For."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        # First address in the chain is the original client
        return forwarded.split(",")[0].strip()
    client = request.client
    if client is not None:
        return client.host
    return "unknown"


async def _record_attempt(
    session: AsyncSession,
    email: str,
    ip_address: str,
    *,
    success: bool,
) -> None:
    """Persist a login attempt record for auditing and lockout tracking."""
    attempt = LoginAttempt(
        email=email,
        ip_address=ip_address,
        success=success,
    )
    session.add(attempt)
    await session.commit()

    logger.info(
        "auth_attempt",
        extra={
            "email_fingerprint": _email_log_fingerprint(email),
            "ip_address": ip_address,
            "success": success,
            "timestamp": datetime.now(UTC).isoformat(),
        },
    )


async def _is_account_locked(session: AsyncSession, email: str) -> bool:
    """Check whether the account is locked due to excessive failed attempts.

    An account is locked when the most recent MAX_FAILED_ATTEMPTS login
    attempts are all failures and the oldest of those failures is within
    the LOCKOUT_DURATION window.
    """
    cutoff = datetime.now(UTC) - LOCKOUT_DURATION
    result = await session.execute(
        select(LoginAttempt)
        .where(LoginAttempt.email == email, LoginAttempt.created_at >= cutoff)
        .order_by(LoginAttempt.created_at.desc())  # type: ignore[attr-defined]
        .limit(MAX_FAILED_ATTEMPTS)
    )
    recent_attempts = result.scalars().all()

    if len(recent_attempts) < MAX_FAILED_ATTEMPTS:
        return False

    # All recent attempts within the window must be failures to trigger lockout
    return all(not attempt.success for attempt in recent_attempts)


@router.post("/signup", response_model=AuthResponse)
@limiter.limit("3/minute")
async def signup(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: SignupRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuthResponse:
    if len(payload.password) < _MIN_PASSWORD_LENGTH:
        raise bad_request("password_too_short")
    result = await session.execute(select(User).where(User.email == payload.email))
    if result.scalars().first() is not None:
        # Perform a dummy hash so the response time is indistinguishable from
        # a real signup (bcrypt takes ~250 ms). Without this, an attacker could
        # use timing to detect whether the email already exists.
        _hash_password(payload.password)
        # Return an identical response shape to prevent account enumeration.
        # The dummy token is signed with a random key and will fail validation,
        # so it cannot be used to access the existing account.
        return AuthResponse(token=_create_dummy_token(), user_id=0)

    user = User(
        email=payload.email,
        password_hash=_hash_password(payload.password),
        timezone=payload.timezone,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)

    if user.id is None:
        msg = "User ID unexpectedly None after database commit"
        raise RuntimeError(msg)
    token = _create_token(user.id)
    return AuthResponse(token=token, user_id=user.id)


@router.post("/login", response_model=AuthResponse)
@limiter.limit("5/minute")
async def login(
    request: Request,
    payload: AuthRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuthResponse:
    ip_address = _get_client_ip(request)

    # Check lockout before even verifying credentials — prevents timing attacks
    if await _is_account_locked(session, payload.email):
        logger.info(
            "auth_attempt_blocked",
            extra={
                "email_fingerprint": _email_log_fingerprint(payload.email),
                "ip_address": ip_address,
                "reason": "account_locked",
                "timestamp": datetime.now(UTC).isoformat(),
            },
        )
        # Return the same generic message to prevent account enumeration
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_credentials")

    result = await session.execute(select(User).where(User.email == payload.email))
    user = result.scalars().first()

    if user is None or not _verify_password(payload.password, user.password_hash):
        await _record_attempt(session, payload.email, ip_address, success=False)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_credentials")

    # Successful login — record and reset the failure window
    await _record_attempt(session, payload.email, ip_address, success=True)

    if user.id is None:
        msg = "User ID unexpectedly None after database commit"
        raise RuntimeError(msg)
    token = _create_token(user.id)
    return AuthResponse(token=token, user_id=user.id)


def get_current_user(authorization: str | None = Header(default=None)) -> int:
    """Extract and validate the JWT from the Authorization header.

    All rejection scenarios return an identical 401 with detail="unauthorized"
    to prevent attackers from distinguishing token states (OWASP A07:2021,
    sec-04). The specific reason is logged server-side for debugging.
    """
    if not authorization or not authorization.startswith("Bearer "):
        logger.info("token_rejected", extra={"reason": "missing_or_malformed_header"})
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(token, _get_secret_key(), algorithms=[_JWT_ALGORITHM])
    except jwt.PyJWTError as exc:
        reason = "expired" if isinstance(exc, jwt.ExpiredSignatureError) else "invalid"
        logger.info("token_rejected", extra={"reason": reason})
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized"
        ) from exc
    return int(payload["sub"])


@router.post("/refresh", response_model=AuthResponse)
@limiter.limit("1/minute")
async def refresh_token(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    user_id: Annotated[int, Depends(get_current_user)],
) -> AuthResponse:
    """Exchange a valid JWT for a fresh one.

    Rate-limited to 1 request per minute to prevent abuse. The caller must
    present a valid, non-expired token in the Authorization header; the
    response contains a new token with a reset TTL for the same user.
    """
    new_token = _create_token(user_id)
    return AuthResponse(token=new_token, user_id=user_id)
