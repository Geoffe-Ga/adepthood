"""Authentication endpoints with JWT tokens, rate limiting, and account lockout."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import secrets
from collections import defaultdict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import bcrypt
import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from errors import bad_request
from models.login_attempt import LoginAttempt
from models.user import DEFAULT_USER_TIMEZONE, User
from rate_limit import limiter
from services.users import get_user_timezone

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

SECRET_KEY = os.getenv("SECRET_KEY", "")
_JWT_ALGORITHM = "HS256"

# JWT token lifetime. One hour balances security (limits the window for a
# stolen token to be misused) with UX (a typical session lasts under an
# hour, so most users won't be interrupted by forced re-authentication).
_TOKEN_TTL = timedelta(hours=1)

_MIN_PASSWORD_LENGTH = 8

# bcrypt silently truncates input at 72 bytes (BUG-AUTH-004): a user who
# signs up with a 100-char passphrase has the last 28 bytes ignored, and
# any subsequent login that types those same bytes succeeds even on a
# typo'd suffix.  Reject before hashing so the failure is loud at
# signup/login rather than a silent security regression.
_BCRYPT_MAX_PASSWORD_BYTES = 72

# Cap on the application-level password length.  Lower than the bcrypt
# limit so the "password too long" error surfaces cleanly via Pydantic's
# 422 validation envelope rather than a 500 from the bcrypt helper, and
# high enough to comfortably support passphrases (NIST SP 800-63B
# encourages long passphrases).
_MAX_PASSWORD_LENGTH = 64

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
    """Login payload — email + password.

    ``password`` carries explicit length bounds (BUG-AUTH-017): an
    unbounded ``str`` field accepts arbitrarily large inputs, which both
    wastes the bcrypt cost on a guaranteed-rejected request and gives an
    attacker a free DoS lever (each attempt costs ~250 ms server-side).
    The bounds also keep the field aligned with the
    ``_BCRYPT_MAX_PASSWORD_BYTES`` ceiling so a request that would
    silently be truncated by bcrypt is rejected with 422 instead.
    """

    email: EmailStr
    password: str = Field(min_length=_MIN_PASSWORD_LENGTH, max_length=_MAX_PASSWORD_LENGTH)

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
    """Response shape for ``/auth/signup``, ``/auth/login``, ``/auth/refresh``.

    ``timezone`` is the IANA string the server has on record so the
    frontend can wire it into the auth context immediately and pass it
    to user-local helpers (Habit stats, streak displays) without a
    follow-up ``GET /users/me``.  Always populated -- defaults to
    ``"UTC"`` for the anti-enumeration dummy response and for legacy
    rows that pre-date the column.
    """

    token: str
    user_id: int
    timezone: str = DEFAULT_USER_TIMEZONE


def _hash_password(password: str) -> str:
    """Hash ``password`` with bcrypt-12 after enforcing the 72-byte input cap.

    bcrypt silently truncates input at 72 bytes (BUG-AUTH-004), so a
    user who typed a 100-char passphrase would later be authenticated by
    any string that shares the same first 72 bytes.  Reject explicitly
    here -- callers reach this helper after Pydantic's
    ``_MAX_PASSWORD_LENGTH`` cap so this branch only fires for
    multi-byte UTF-8 input that fits character-wise but overflows
    byte-wise (a 64-char password of 4-byte characters is 256 bytes).

    12 rounds of bcrypt hashing (~250 ms on modern hardware).  This is
    the OWASP-recommended minimum; it makes brute-force attacks
    prohibitively expensive while keeping login latency acceptable for
    users.
    """
    encoded = password.encode("utf-8")
    if len(encoded) > _BCRYPT_MAX_PASSWORD_BYTES:
        msg = f"password exceeds bcrypt's {_BCRYPT_MAX_PASSWORD_BYTES}-byte limit"
        raise ValueError(msg)
    hashed: bytes = bcrypt.hashpw(encoded, bcrypt.gensalt(rounds=12))
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


# Per-process per-email asyncio lock used to serialize the lockout check +
# attempt-record sequence so two concurrent failed attempts inside the same
# worker cannot both pass the check at the threshold-1 boundary
# (BUG-AUTH-007). For multi-worker deployments the matching PostgreSQL
# advisory lock below closes the cross-process race.  The dict is unbounded
# in principle but each entry is a bare ``asyncio.Lock`` (a few hundred
# bytes) and the email keys are already gated by per-route rate limits, so
# memory growth is naturally capped at the legitimate-user fan-out.
_login_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

# 8-byte advisory-lock key derived from a SHA-256 of the normalized email.
# Pinned to int8 because pg_advisory_xact_lock(bigint) is the single-arg
# form; truncating the digest is fine because collisions only cause spurious
# serialization, not a security failure.
_ADVISORY_LOCK_KEY_BYTES = 8


async def _acquire_email_lock_pg(session: AsyncSession, email: str) -> None:
    """Take a transaction-scoped advisory lock on ``email`` (PostgreSQL only).

    Closes the cross-worker half of BUG-AUTH-007: in production the
    ``_login_locks`` asyncio dictionary only serializes coroutines inside
    one Uvicorn worker, so a fleet of workers can still race the lockout
    check against the attempt insert.  ``pg_advisory_xact_lock`` lives in
    the database, so every worker observes the same lock and the
    check + record sequence is atomic per email.

    SQLite (used in tests) does not implement advisory locks, so the
    function is a no-op there; the in-process ``_login_locks`` is enough
    because every test runs in a single Python process.
    """
    bind = session.get_bind()
    if bind.dialect.name != "postgresql":
        return
    digest = hashlib.sha256(email.encode("utf-8")).digest()[:_ADVISORY_LOCK_KEY_BYTES]
    key = int.from_bytes(digest, "big", signed=True)
    await session.execute(text("SELECT pg_advisory_xact_lock(:k)").bindparams(k=key))


@asynccontextmanager
async def _serialize_login(session: AsyncSession, email: str) -> AsyncIterator[None]:
    """Acquire both the in-process and PG advisory locks for ``email``.

    Held for the duration of the login flow so the lockout check, the
    password verify, and the attempt-record commit run as one atomic
    decision per email (BUG-AUTH-007).  The advisory lock is
    transaction-scoped, so it releases when the session commits or rolls
    back at the end of the request — no manual ``pg_advisory_unlock``
    needed.
    """
    async with _login_locks[email]:
        await _acquire_email_lock_pg(session, email)
        yield


def _duplicate_signup_response() -> AuthResponse:
    """Identical-shape response for an email already in use.

    Returned both when the pre-empted insert would conflict and when a
    concurrent request wins the race and our insert raises
    ``IntegrityError``.  The dummy token is signed with a random key so
    it cannot be exchanged for access to the existing account.
    """
    return AuthResponse(token=_create_dummy_token(), user_id=0)


@router.post("/signup", response_model=AuthResponse)
@limiter.limit("3/minute")
async def signup(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: SignupRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuthResponse:
    # Pydantic enforces ``_MIN_PASSWORD_LENGTH`` / ``_MAX_PASSWORD_LENGTH``
    # before we get here (BUG-AUTH-017), so the only failure mode left is a
    # multi-byte UTF-8 password whose char-count fits the cap but whose
    # byte-length blows the bcrypt 72-byte limit.  Translate that into a
    # 422 instead of a 500 so the client gets a uniform validation
    # response and we never store a row that bcrypt has silently
    # truncated (BUG-AUTH-004).
    try:
        password_hash = _hash_password(payload.password)
    except ValueError as exc:
        raise bad_request("password_too_long") from exc
    user = User(
        email=payload.email,
        password_hash=password_hash,
        timezone=payload.timezone,
    )
    session.add(user)
    try:
        await session.commit()
    except IntegrityError:
        # The ``ix_user_lower_email_unique`` functional unique index (or
        # the case-sensitive ``ix_user_email`` for legacy schemas) raised
        # because either an earlier signup or a concurrent request won
        # the race.  Either way the response is the anti-enumeration
        # dummy — same shape, same timing — so the client cannot tell
        # whether the email was new or already registered.
        await session.rollback()
        return _duplicate_signup_response()
    await session.refresh(user)

    if user.id is None:
        msg = "User ID unexpectedly None after database commit"
        raise RuntimeError(msg)
    token = _create_token(user.id)
    return AuthResponse(token=token, user_id=user.id, timezone=user.timezone)


@router.post("/login", response_model=AuthResponse)
@limiter.limit("5/minute")
async def login(
    request: Request,
    payload: AuthRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuthResponse:
    ip_address = _get_client_ip(request)

    # Wrap the lockout-check + verify + record sequence in a per-email
    # serialization so concurrent failed attempts cannot all pass the
    # threshold-1 check before any of them inserts (BUG-AUTH-007).
    async with _serialize_login(session, payload.email):
        # Check lockout before even verifying credentials — prevents timing attacks
        if await _is_account_locked(session, payload.email):
            # Record the blocked attempt so a continuous attacker cannot
            # silently wait out the rolling window (BUG-AUTH-006): without
            # this row the oldest-of-last-N timestamp keeps aging out and
            # the lock can expire even while attempts are still arriving.
            # Recording each blocked try keeps the window fresh for as long
            # as the attacker keeps trying.
            await _record_attempt(session, payload.email, ip_address, success=False)
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
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid_credentials",
            )

        result = await session.execute(select(User).where(User.email == payload.email))
        user = result.scalars().first()

        if user is None or not _verify_password(payload.password, user.password_hash):
            await _record_attempt(session, payload.email, ip_address, success=False)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid_credentials",
            )

        # Successful login — record and reset the failure window
        await _record_attempt(session, payload.email, ip_address, success=True)

    if user.id is None:
        msg = "User ID unexpectedly None after database commit"
        raise RuntimeError(msg)
    token = _create_token(user.id)
    return AuthResponse(token=token, user_id=user.id, timezone=user.timezone)


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
    # ``sub`` may be missing or non-numeric on a forged / corrupted token
    # (BUG-AUTH-012).  Without this guard the bare ``int(payload["sub"])``
    # call raised ``KeyError`` / ``ValueError`` uncaught and Starlette
    # surfaced it as 500 -- leaking "your token confused us" diagnostics
    # to the attacker.  Convert into the same 401 every other auth path
    # uses so the rejection looks identical.
    sub = payload.get("sub")
    if not isinstance(sub, str | int):
        logger.info("token_rejected", extra={"reason": "malformed_sub"})
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")
    try:
        return int(sub)
    except (TypeError, ValueError) as exc:
        logger.info("token_rejected", extra={"reason": "malformed_sub"})
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized"
        ) from exc


@router.post("/refresh", response_model=AuthResponse)
@limiter.limit("1/minute")
async def refresh_token(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuthResponse:
    """Exchange a valid JWT for a fresh one.

    Rate-limited to 1 request per minute to prevent abuse. The caller must
    present a valid, non-expired token in the Authorization header; the
    response contains a new token with a reset TTL for the same user.

    The response also re-asserts the stored ``timezone`` so a frontend
    that hot-reloads or evicts its auth context receives the correct
    user-local zone after a refresh, not a stale ``"UTC"`` default.
    """
    new_token = _create_token(user_id)
    user_timezone = await get_user_timezone(session, user_id)
    return AuthResponse(token=new_token, user_id=user_id, timezone=user_timezone)
