"""Authentication endpoints with JWT tokens, rate limiting, and account lockout."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Annotated

import bcrypt
import jwt
from cachetools import TTLCache
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from domain.timezone import normalize_timezone
from errors import bad_request
from models.login_attempt import LoginAttempt
from models.password_reset_token import PasswordResetToken
from models.revoked_token import RevokedToken
from models.user import DEFAULT_USER_TIMEZONE, User
from rate_limit import limiter
from schemas.password_reset import (
    PasswordResetAccepted,
    PasswordResetCancel,
    PasswordResetConfirm,
    PasswordResetRequest,
)
from services.email import (
    EmailDeliveryError,
    EmailMessagePayload,
    EmailSender,
    get_email_sender,
)
from services.users import get_user_timezone

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

SECRET_KEY = os.getenv("SECRET_KEY", "")
_JWT_ALGORITHM = "HS256"

# JWT token lifetime. One hour balances security (limits the window for a
# stolen token to be misused) with UX (a typical session lasts under an
# hour, so most users won't be interrupted by forced re-authentication).
_TOKEN_TTL = timedelta(hours=1)

# Password-reset token TTL.  30 minutes is long enough for slow inboxes
# and a user who walks away mid-flow, short enough to bound exposure if
# the link leaks via screenshot or shoulder surf.  Mirrors ``_TOKEN_TTL``
# below for visual parity.
_PASSWORD_RESET_TTL = timedelta(minutes=30)

# bcrypt cost for the reset-token digest.  These tokens are 256-bit
# random URL-safe strings (not user-typed input), so cost-12 is wasted.
# Cost 10 is fast enough that the constant-time miss-path computation
# in the request endpoint stays within the SPEC R4 timing window.
_PASSWORD_RESET_BCRYPT_ROUNDS = 10

# Cap on simultaneous outstanding reset rows for one user.  When a
# fourth request arrives the oldest active row is auto-cancelled --
# the wire response is still 202 to preserve the anti-enumeration
# contract (SPEC R5).
_MAX_OUTSTANDING_TOKENS_PER_USER = 3

# Single-source-of-truth message body for the request endpoint --
# returning the exact same bytes on hit and miss is the SPEC R4
# anti-enumeration contract.  Keep this immutable; do not interpolate
# per-request data.
_RESET_REQUEST_GENERIC_MESSAGE = (
    "If an account exists for that address, a reset link has been sent."
)

# Number of bytes consumed by ``secrets.token_urlsafe`` when minting a
# fresh reset token.  32 bytes encodes to a 43-character URL-safe
# string and gives 256 bits of entropy.
_RESET_TOKEN_BYTES = 32

# Anti-enumeration dummy bcrypt inputs.  Two pre-computed digests at
# different costs so each timing-parity site spends the same bcrypt
# budget as the operation it is masking:
#
# * cost-10 -- masks the reset-token verify (``_hash_reset_token`` /
#   ``_verify_reset_token``).  Used by the request endpoint's miss
#   branch so an attacker cannot tell registered from unknown emails
#   from response timing (SPEC R4).
# * cost-12 -- masks the user-password verify (``_verify_password``).
#   Used by the confirm endpoint's invalid-token branch so an attacker
#   cannot tell "real token + reused password" from "bogus token" by
#   measuring whether ``_reject_if_password_reuse`` ran.
#
# The work runs at module import once; each ``_consume_dummy_*`` call
# only pays the verify cost.  The plaintext is a fixed throwaway so
# the same digest can be reused across calls without collision risk.
_DUMMY_BCRYPT_PASSWORD = b"adepthood-reset-anti-enumeration-dummy"
_DUMMY_BCRYPT_HASH = bcrypt.hashpw(_DUMMY_BCRYPT_PASSWORD, bcrypt.gensalt(rounds=10))
_DUMMY_PASSWORD_VERIFY_HASH = bcrypt.hashpw(_DUMMY_BCRYPT_PASSWORD, bcrypt.gensalt(rounds=12))

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
        return normalize_timezone(value, DEFAULT_USER_TIMEZONE)


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


def _new_jti() -> str:
    """Return a fresh per-token unique identifier.

    Used as the ``jti`` claim on every issued JWT so ``/auth/refresh``
    can revoke the old token by storing this value in
    :class:`models.revoked_token.RevokedToken` (BUG-AUTH-013).
    16 bytes of entropy (32 hex chars) is plenty -- the value is
    namespaced by user, so collision is irrelevant for security and
    only needs to be unique enough that two tokens issued within the
    same millisecond don't share a row.
    """
    return secrets.token_hex(16)


def _create_token(user_id: int) -> tuple[str, str]:
    """Mint a fresh JWT with a per-token ``jti`` claim.

    Returns ``(token, jti)`` so callers that need to revoke the
    previous token (e.g. ``/auth/refresh``) can persist the old jti
    before swapping in the new one.  Tokens minted before the jti
    column existed have no claim and are treated as legacy-but-valid
    by ``get_current_user`` -- the 1-hour TTL is the grace window.

    ``iat`` is encoded as a fractional Unix timestamp (RFC 7519
    NumericDate allows non-integer values) so the SPEC R7
    ``password_changed_at`` gate can distinguish two tokens issued in
    the same wall-clock second.  Without sub-second precision the
    integer-second iat collides with a same-second password reset and
    the wrong token wins (CI repro: BUG-AUTH-024).

    ``exp`` stays an integer.  Sub-second precision is only needed for
    the ``iat`` gate; ``exp`` is consumed by external decoders (the
    mobile client, future admin dashboards) where some JWT libraries
    use strict integer coercion and a float would surprise them.
    Keeping the float change minimum-blast-radius.
    """
    now = datetime.now(UTC)
    jti = _new_jti()
    payload = {
        "sub": str(user_id),
        "exp": int((now + _TOKEN_TTL).timestamp()),
        "iat": now.timestamp(),
        "jti": jti,
    }
    token = str(jwt.encode(payload, _get_secret_key(), algorithm=_JWT_ALGORITHM))
    return token, jti


def _create_dummy_token() -> str:
    """Generate a structurally-valid JWT that will never decode with the real secret.

    Used to return an indistinguishable response when a signup is attempted
    with an already-registered email, preventing account enumeration.
    """
    now = datetime.now(UTC)
    nonce_key = secrets.token_hex(32)
    payload = {
        "sub": "0",
        "exp": int((now + _TOKEN_TTL).timestamp()),
        "iat": now.timestamp(),
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
# advisory lock below closes the cross-process race.
#
# Issue #273: a TTL+LRU cache, not a defaultdict — an adversary cycling
# unique synthesized emails across enough source IPs to dodge per-IP rate
# limits could otherwise grow the dict by one Lock per address for the
# life of the worker.  Eviction is safe: a lock is held only for a single
# sub-second login flow, and a fresh lock after eviction reopens no race
# because the cross-worker ``pg_advisory_xact_lock`` layer is independent
# of this in-process one.
_LOGIN_LOCKS_MAX = 10_000
# Matches ``LOCKOUT_DURATION`` so a hot email's lock survives the whole
# window it is serializing.
_LOGIN_LOCKS_TTL_SECONDS = LOCKOUT_DURATION.total_seconds()

_login_locks: TTLCache[str, asyncio.Lock] = TTLCache(
    maxsize=_LOGIN_LOCKS_MAX, ttl=_LOGIN_LOCKS_TTL_SECONDS
)


def _login_lock_for(email: str) -> asyncio.Lock:
    """Get-or-create the serialization lock for ``email``.

    Safe without its own guard: coroutines on one event loop cannot
    interleave between the ``get`` miss and the store, so two concurrent
    callers for the same email always share one lock instance.
    """
    lock = _login_locks.get(email)
    if lock is None:
        lock = asyncio.Lock()
        _login_locks[email] = lock
    return lock


# 8-byte advisory-lock key derived from a SHA-256 of the normalized email.
# Pinned to int8 because pg_advisory_xact_lock(bigint) is the single-arg
# form; truncating the digest is fine because collisions only cause spurious
# serialization, not a security failure.
_ADVISORY_LOCK_KEY_BYTES = 8


def _advisory_lock_key(email: str) -> int:
    """Derive the int8 advisory-lock key for ``email``.

    First 8 bytes of the SHA-256 digest, packed big-endian SIGNED so the
    result always fits ``pg_advisory_xact_lock(bigint)``.  Extracted from
    ``_acquire_email_lock_pg`` so the packing is pinned by unit tests
    (issue #274): truncating to a different width or packing unsigned
    would either break the int8 range or silently change every lock key,
    and both now fail the derivation tests instead of surfacing as a
    production Postgres error.
    """
    digest = hashlib.sha256(email.encode("utf-8")).digest()[:_ADVISORY_LOCK_KEY_BYTES]
    return int.from_bytes(digest, "big", signed=True)


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
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:k)").bindparams(k=_advisory_lock_key(email))
    )


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
    async with _login_lock_for(email):
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
    token, _ = _create_token(user.id)
    return AuthResponse(token=token, user_id=user.id, timezone=user.timezone)


def _log_blocked_attempt(email: str, ip_address: str, reason: str) -> None:
    """Emit the ``auth_attempt_blocked`` audit log line.

    Extracted from :func:`login` so the body stays at xenon rank A
    after the BUG-MODEL-001 disabled-user gate added a third blocked
    branch (lockout, missing/wrong-password, disabled / deleted).
    """
    logger.info(
        "auth_attempt_blocked",
        extra={
            "email_fingerprint": _email_log_fingerprint(email),
            "ip_address": ip_address,
            "reason": reason,
            "timestamp": datetime.now(UTC).isoformat(),
        },
    )


def _user_state_reject_reason(user: User) -> str | None:
    """Return the audit reason if the user is disabled / deleted, else ``None``.

    Centralises the BUG-MODEL-001 gate so the same classification is
    used in :func:`login` (after credential verification) and
    :func:`_check_user_active` (on every authenticated request).
    """
    if user.deleted_at is not None:
        return "user_deleted"
    if not user.is_active:
        return "user_disabled"
    return None


async def _verify_login_or_raise(
    session: AsyncSession, payload: AuthRequest, ip_address: str
) -> User:
    """Run the lockout + credential + account-state gates for ``login``.

    Each rejection raises ``invalid_credentials`` with the same shape
    so the caller cannot distinguish "locked" from "wrong password"
    from "disabled" -- only the server-side log records the specific
    reason.  The state gate runs *after* the password check so the
    response timing matches that of an ordinary wrong-password attempt
    against a regular account.
    """
    if await _is_account_locked(session, payload.email):
        await _record_attempt(session, payload.email, ip_address, success=False)
        _log_blocked_attempt(payload.email, ip_address, "account_locked")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_credentials")

    result = await session.execute(select(User).where(User.email == payload.email))
    user = result.scalars().first()

    if user is None or not _verify_password(payload.password, user.password_hash):
        await _record_attempt(session, payload.email, ip_address, success=False)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_credentials")

    reject_reason = _user_state_reject_reason(user)
    if reject_reason is not None:
        _log_blocked_attempt(payload.email, ip_address, reject_reason)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_credentials")

    await _record_attempt(session, payload.email, ip_address, success=True)
    return user


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
        user = await _verify_login_or_raise(session, payload, ip_address)

    if user.id is None:
        msg = "User ID unexpectedly None after database commit"
        raise RuntimeError(msg)
    token, _ = _create_token(user.id)
    return AuthResponse(token=token, user_id=user.id, timezone=user.timezone)


def _decode_token_payload(authorization: str | None) -> dict[str, object]:
    """Decode the bearer JWT and return its payload, or raise 401.

    Split out from ``get_current_user`` so the JWT-decode + ``sub``
    coercion logic stays at xenon rank A while the async revocation
    check lives in the wrapper.  All rejection paths return an
    identical 401 ``unauthorized`` (OWASP A07:2021) so attackers
    cannot distinguish "token expired" from "token forged".
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
    return payload


def _coerce_sub(payload: dict[str, object]) -> int:
    """Convert the ``sub`` claim to ``int`` or raise 401 (BUG-AUTH-012).

    Without this guard the bare ``int(payload["sub"])`` call raised
    ``KeyError`` / ``ValueError`` uncaught and Starlette surfaced 500
    -- leaking "your token confused us" diagnostics to the attacker.
    """
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


def extract_user_id_from_authorization(authorization: str | None) -> int:
    """Decode a Bearer JWT and return the user id, or raise 401.

    Public wrapper combining :func:`_decode_token_payload` and
    :func:`_coerce_sub` so non-router callers (e.g. ``slowapi`` rate-limit
    key functions) can derive the stable user id from the request without
    poking at private helpers.  Skips the revocation check on purpose --
    rate-limiting ahead of FastAPI's DI runs before the canonical
    ``get_current_user`` dependency, and the revocation lookup needs an
    ``AsyncSession`` we don't have here; the route handler itself still
    enforces revocation through :func:`get_current_user`.
    """
    return _coerce_sub(_decode_token_payload(authorization))


async def _check_token_not_revoked(session: AsyncSession, payload: dict[str, object]) -> None:
    """Reject the request if the token's ``jti`` is in the revocation table.

    Tokens minted before the ``jti`` claim existed are treated as
    legacy-but-valid -- the missing claim short-circuits without a DB
    hit, and the 1-hour TTL is the grace window the prompt requires
    so existing sessions do not all 401 at once on deploy
    (BUG-AUTH-013).
    """
    jti = payload.get("jti")
    if not isinstance(jti, str) or not jti:
        return  # Legacy token -- no revocation possible.
    result = await session.execute(select(RevokedToken.jti).where(RevokedToken.jti == jti))
    if result.scalar_one_or_none() is not None:
        logger.info("token_rejected", extra={"reason": "revoked"})
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")


def _user_row_reject_reason(row: object | None) -> str | None:
    """Return the rejection reason for a user-state row (or ``None`` if OK).

    Split out from :func:`_check_user_active` so that helper stays at
    xenon rank A while keeping the three distinct outcomes
    (``user_missing``, ``user_deleted``, ``user_disabled``) for
    server-side logging.
    """
    if row is None:
        return "user_missing"
    if getattr(row, "deleted_at", None) is not None:
        return "user_deleted"
    if not getattr(row, "is_active", True):
        return "user_disabled"
    return None


def _coerce_iat_to_datetime(payload: dict[str, object]) -> datetime | None:
    """Return the JWT's ``iat`` claim as a UTC datetime, or ``None`` if absent.

    Tokens minted before the ``iat`` claim existed simply skip the
    SPEC R7 password-changed gate -- their 1-hour TTL is the grace
    window the same way it is for the ``jti`` revocation check.
    """
    iat = payload.get("iat")
    if not isinstance(iat, int | float):
        return None
    return datetime.fromtimestamp(iat, tz=UTC)


def _as_utc_aware(value: datetime) -> datetime:
    """Tag a naive datetime as UTC; pass aware datetimes through unchanged.

    SQLite (used in tests) drops timezone info on round-trip, so a column
    written as ``datetime.now(UTC)`` returns naive on read.  Forcing UTC
    here keeps the SPEC R7 comparison correct on both backends; on
    PostgreSQL the column is already aware and the call is a no-op.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def _token_predates_password_reset(
    token_iat: datetime | None,
    password_changed_at: datetime | None,
) -> bool:
    """Return ``True`` when the token was minted before the user's last reset.

    Either side being ``None`` disables the gate -- legacy tokens
    without an ``iat`` cannot be compared, and an account that has
    never had a password reset has no floor to compare against.

    Both ``token_iat`` and ``password_changed_at`` carry sub-second
    precision (the former because :func:`_create_token` encodes
    ``iat`` as a fractional Unix timestamp; the latter because the
    column is a ``timestamptz`` populated from ``datetime.now(UTC)``).
    A direct ``<`` comparison correctly distinguishes tokens issued
    even microseconds before vs. after a password reset.

    Legacy tokens whose ``iat`` was encoded as integer seconds (by an
    older ``_create_token`` or by an external test fixture) compare
    against ``password_changed_at`` at second resolution -- the
    integer-second iat reads as the ``T.000000`` boundary, which is
    strictly less than any reset that happened later in the same
    second.  That is the desired semantics: every token from a prior
    moment is rejected.
    """
    if token_iat is None or password_changed_at is None:
        return False
    return _as_utc_aware(token_iat) < _as_utc_aware(password_changed_at)


async def _check_user_active(
    session: AsyncSession,
    user_id: int,
    token_iat: datetime | None,
) -> None:
    """Reject the request if the user is soft-disabled, soft-deleted, or pre-reset.

    Mirrors the gate the column docstrings on ``User.is_active`` /
    ``User.deleted_at`` promise: an operator who flips ``is_active`` or
    sets ``deleted_at`` expects the affected user's existing tokens to
    stop authenticating immediately (BUG-MODEL-001).  Looked up by
    primary key so the cost is a single indexed SELECT per
    authenticated request, paired with the revocation lookup in
    :func:`_check_token_not_revoked`.

    Also enforces the SPEC R7 "log out everywhere" lever: any token
    whose ``iat`` predates ``user.password_changed_at`` is rejected
    with the same 401 so a successful reset implicitly revokes every
    outstanding session.

    Returns the same 401 ``unauthorized`` as every other rejection path
    so attackers cannot distinguish disabled-account from
    invalid-token (OWASP A07:2021).
    """
    result = await session.execute(
        select(User.is_active, User.deleted_at, User.password_changed_at).where(User.id == user_id)
    )
    row = result.first()
    reason = _user_row_reject_reason(row)
    if reason is not None:
        logger.info("token_rejected", extra={"reason": reason})
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")
    password_changed_at = getattr(row, "password_changed_at", None)
    if _token_predates_password_reset(token_iat, password_changed_at):
        logger.info("token_rejected", extra={"reason": "password_changed"})
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")


async def get_current_user(
    session: Annotated[AsyncSession, Depends(get_session)],
    authorization: str | None = Header(default=None),
) -> int:
    """Extract, validate, and revocation-check the JWT.

    Async because ``BUG-AUTH-013`` requires a DB lookup against the
    ``revokedtoken`` table on every authenticated request.  The check
    is keyed on the primary-key ``jti`` so the cost is one indexed
    SELECT per request, not a full scan.

    Also gates on the account-state flags landed in BUG-MODEL-001: a
    soft-disabled (``is_active=False``) or soft-deleted
    (``deleted_at IS NOT NULL``) user cannot ride an existing token
    past the deletion / disable boundary.

    All rejection scenarios return an identical 401 with
    ``detail="unauthorized"`` to prevent attackers from distinguishing
    token states (OWASP A07:2021, sec-04). The specific reason is
    logged server-side for debugging.
    """
    payload = _decode_token_payload(authorization)
    await _check_token_not_revoked(session, payload)
    user_id = _coerce_sub(payload)
    await _check_user_active(session, user_id, _coerce_iat_to_datetime(payload))
    return user_id


async def _revoke_token_payload(
    session: AsyncSession,
    payload: dict[str, object],
) -> None:
    """Persist the token's ``jti`` to ``revokedtoken`` so it cannot be reused.

    Tokens minted before the ``jti`` claim existed are silently passed
    through (no row to insert) -- the 1-hour TTL is the grace window.
    The ``exp`` claim is mirrored into ``expires_at`` so a periodic
    cleanup job can prune past-due rows without re-decoding the JWT.
    Conflicting writes (same jti revoked twice) are caught and ignored
    so an idempotent retry of ``/auth/refresh`` does not 500.
    """
    jti = payload.get("jti")
    exp = payload.get("exp")
    if not isinstance(jti, str) or not jti:
        return  # legacy token, no jti
    expires_at = (
        datetime.fromtimestamp(exp, tz=UTC)
        if isinstance(exp, int | float)
        else datetime.now(UTC) + _TOKEN_TTL
    )
    session.add(RevokedToken(jti=jti, expires_at=expires_at))
    try:
        await session.commit()
    except IntegrityError:
        # Already revoked (e.g. double-clicked refresh); same outcome.
        await session.rollback()


@router.post("/refresh", response_model=AuthResponse)
@limiter.limit("1/minute")
async def refresh_token(
    request: Request,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuthResponse:
    """Exchange a valid JWT for a fresh one.

    Rate-limited to 1 request per minute to prevent abuse. The caller
    must present a valid, non-expired token in the Authorization
    header; the response contains a new token with a reset TTL for the
    same user.

    The old token's ``jti`` is revoked (BUG-AUTH-013) before the new
    one is minted so a stolen-and-refreshed token cannot be replayed
    until its original ``exp``.  Tokens minted before the jti claim
    existed are passed through transparently for the duration of their
    TTL -- the 1-hour grace window the prompt requires for the
    JWT-shape change.

    The response also re-asserts the stored ``timezone`` so a frontend
    that hot-reloads or evicts its auth context receives the correct
    user-local zone after a refresh, not a stale ``"UTC"`` default.
    """
    # Re-decode the header (``get_current_user`` only surfaces the int
    # ``sub``) so we can persist the old ``jti`` against
    # ``revokedtoken`` before minting the new one.
    old_payload = _decode_token_payload(request.headers.get("Authorization"))
    await _revoke_token_payload(session, old_payload)

    new_token, _ = _create_token(user_id)
    user_timezone = await get_user_timezone(session, user_id)
    return AuthResponse(token=new_token, user_id=user_id, timezone=user_timezone)


# ---------------------------------------------------------------------------
# Password recovery (SPEC plans/SPEC.md)
# ---------------------------------------------------------------------------


def _hash_reset_token(plaintext: str) -> str:
    """Bcrypt-digest a reset-token plaintext at the cheap-cost (10) setting.

    These tokens are 256-bit randoms, not human input -- the cost-12
    used for passwords is wasted entropy on something already at the
    full hash floor.  Cost 10 is fast enough (~50 ms) that the
    constant-time miss-path computation in ``request`` stays in the
    SPEC R4 timing window.
    """
    digest: bytes = bcrypt.hashpw(
        plaintext.encode("utf-8"),
        bcrypt.gensalt(rounds=_PASSWORD_RESET_BCRYPT_ROUNDS),
    )
    return digest.decode("utf-8")


def _verify_reset_token(plaintext: str, token_hash: str) -> bool:
    """Constant-time bcrypt compare for reset-token verification."""
    return bool(bcrypt.checkpw(plaintext.encode("utf-8"), token_hash.encode("utf-8")))


def _consume_dummy_bcrypt() -> None:
    """Spend the cost-10 reset-token verify budget on the request miss path.

    Mirrors the hit path's ``_verify_reset_token`` cost so the request
    endpoint cannot be timing-distinguished by an attacker scraping
    every email in a leak corpus (SPEC R4).
    """
    bcrypt.checkpw(_DUMMY_BCRYPT_PASSWORD, _DUMMY_BCRYPT_HASH)


def _consume_dummy_password_verify() -> None:
    """Spend the cost-12 user-password verify budget on the confirm-miss path.

    Mirrors ``_verify_password(new_password, user.password_hash)`` cost
    so the invalid-token branch of confirm cannot be timing-
    distinguished from the valid-token-with-reused-password branch.
    The user's stored hash is cost-12 (``_hash_password`` uses
    ``bcrypt.gensalt(rounds=12)``) so the masking dummy must also be
    cost-12 -- the cost-10 one is too fast.
    """
    bcrypt.checkpw(_DUMMY_BCRYPT_PASSWORD, _DUMMY_PASSWORD_VERIFY_HASH)


def _build_reset_email(to_address: str, plaintext_token: str) -> EmailMessagePayload:
    """Render the reset email containing both action URLs, addressed to ``to_address``.

    The "this wasn't me" link hits ``/auth/password-reset/cancel`` and
    invalidates the token without requiring a login -- possession of
    the token is enough, which is the same trust model as confirm
    (SPEC Example D).
    """
    body = (
        "Someone requested a password reset for your Adepthood account.\n\n"
        f"Reset your password:  adepthood://reset-password?token={plaintext_token}\n"
        f"This wasn't me:       adepthood://cancel-reset?token={plaintext_token}\n\n"
        "Links expire in 30 minutes.  If you did not request this, you can\n"
        "ignore this email -- nothing happens until you click a link."
    )
    return EmailMessagePayload(
        to=to_address,
        subject="Reset your Adepthood password",
        body=body,
    )


def _get_security_contact_address() -> str:
    """Return the operator-monitored security contact address.

    Read from ``SECURITY_CONTACT_ADDRESS`` so ops can change the
    inbox without a code deploy.  Defaults to a placeholder
    documented in DEPLOYMENT.md for dev / test / first-deploy
    environments; production deployments MUST set the env var to
    a real, monitored mailbox -- the change-notification email
    routes "this wasn't me" responses there.
    """
    return os.getenv("SECURITY_CONTACT_ADDRESS", "security@adepthood.example")


def _build_change_notification_email(to_address: str) -> EmailMessagePayload:
    """Render the post-confirm out-of-band notification (SPEC R8).

    Sent on every successful confirm so the legitimate user learns
    immediately if an attacker resets their password.  The "this wasn't
    me" link is delivered by the same channel as the original reset
    -- if the attacker controls the inbox the channel is already lost,
    but in the much more common case where they merely guessed a leak
    credential the user catches the takeover within seconds.
    """
    body = (
        "Your Adepthood password was just changed.\n\n"
        "If this was you, no action is needed.\n\n"
        "If this was NOT you, request another reset immediately so we can\n"
        f"freeze the account and email {_get_security_contact_address()}."
    )
    return EmailMessagePayload(
        to=to_address,
        subject="Your Adepthood password was changed",
        body=body,
    )


async def _auto_cancel_oldest_active_token(session: AsyncSession, user_id: int) -> None:
    """Cancel the oldest active reset token if the per-user cap is hit.

    SPEC R5 caps a user at three outstanding tokens -- when a fourth
    arrives the oldest is silently auto-cancelled so the new request
    still succeeds (the wire response stays 202 either way to honour
    R4).  Skips the work entirely if the count is below the cap.

    Concurrency: callers must hold the per-user row lock taken in
    ``_mint_and_persist_reset_token`` (``SELECT user FOR UPDATE``).
    Without it, two near-simultaneous requests can both read
    ``count == cap``, both skip the cancel, and both insert -- leaving
    one extra active row above the cap.  The lock serializes the
    check-then-cancel-then-insert sequence per user.
    """
    now = datetime.now(UTC)
    result = await session.execute(
        select(PasswordResetToken)
        .where(
            PasswordResetToken.user_id == user_id,
            col(PasswordResetToken.used_at).is_(None),
            col(PasswordResetToken.cancelled_at).is_(None),
            PasswordResetToken.expires_at > now,
        )
        .order_by(col(PasswordResetToken.created_at).asc())
    )
    active = list(result.scalars().all())
    if len(active) < _MAX_OUTSTANDING_TOKENS_PER_USER:
        return
    overflow = len(active) - _MAX_OUTSTANDING_TOKENS_PER_USER + 1
    for row in active[:overflow]:
        row.cancelled_at = now
        session.add(row)


# Width of the SHA-256 prefix used as ``PasswordResetToken.lookup_key``.
# 16 hex chars = 64 bits = ~18 quintillion-to-one collision odds against
# any other plaintext, which is fine because bcrypt is the actual
# security gate -- the lookup key is a pre-filter to keep the SQL scan
# cheap.  Wider would gain nothing; narrower starts to risk avoidable
# scans on collisions.
_LOOKUP_KEY_HEX_LEN = 16


def _make_lookup_key(plaintext: str) -> str:
    """Return a deterministic non-secret SHA-256 prefix of ``plaintext``.

    Used as a fast indexed pre-filter when looking up a reset token by
    its plaintext value -- the alternative is a full-table bcrypt scan
    on every confirm / cancel, which becomes a DoS amplifier above
    modest user counts.  Bcrypt verify is still the security gate; the
    prefix is just a cheap way to find "the maybe-row".
    """
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()[:_LOOKUP_KEY_HEX_LEN]


async def _mint_and_persist_reset_token(
    session: AsyncSession,
    user: User,
    request: Request,
) -> str:
    """Create a fresh reset token row and return the plaintext to email out.

    Takes a ``SELECT FOR UPDATE`` lock on the user row before counting
    active tokens so the SPEC R5 cap (max 3 outstanding) holds under
    concurrent requests for the same account.  Without the lock, two
    requests landing in the same millisecond can both observe
    ``count == 3``, both decide a cancel is unnecessary, and both
    insert -- producing 4 active rows and breaking the cap.  SQLite
    (test backend) ignores ``FOR UPDATE`` but serializes writes at
    the connection level anyway, so this is safe in both environments.
    """
    if user.id is None:
        msg = "User without ID hit reset-token mint path"
        raise RuntimeError(msg)
    await session.execute(select(User.id).where(User.id == user.id).with_for_update())
    await _auto_cancel_oldest_active_token(session, user.id)
    plaintext = secrets.token_urlsafe(_RESET_TOKEN_BYTES)
    user_agent = request.headers.get("user-agent", "")[:256]
    row = PasswordResetToken(
        user_id=user.id,
        lookup_key=_make_lookup_key(plaintext),
        token_hash=_hash_reset_token(plaintext),
        requested_ip=_get_client_ip(request),
        requested_user_agent=user_agent,
        expires_at=datetime.now(UTC) + _PASSWORD_RESET_TTL,
    )
    session.add(row)
    await session.commit()
    return plaintext


async def _send_reset_email_safely(
    sender: EmailSender,
    to_address: str,
    plaintext_token: str,
) -> None:
    """Send the reset email, swallowing transport errors for R4 parity.

    A transient SMTP outage must not change the response shape -- it
    would otherwise leak "this email is registered" by raising 500
    on the hit path while the miss path stayed at 202.  Failures are
    logged with a fingerprint so the operator still has the audit
    trail.

    Only :class:`EmailDeliveryError` (transient wire failure) is
    swallowed; programmer / configuration errors propagate so they
    surface in monitoring rather than being masked by the
    anti-enumeration shield.
    """
    payload = _build_reset_email(to_address, plaintext_token)
    try:
        # The plaintext token rides ``redact_for_log`` so the sender
        # implementation can mask it before writing the body to a log
        # stream (the dev console adapter does exactly this).  The
        # transmission path (SMTP) ignores the hint and sends the
        # body verbatim because the user receiving the mail needs the
        # unredacted link.
        await sender.send(payload, redact_for_log=plaintext_token)
    except EmailDeliveryError:
        logger.warning(
            "password_reset_email_failed",
            extra={"email_fingerprint": _email_log_fingerprint(to_address)},
        )


async def _send_change_notification_safely(
    sender: EmailSender,
    to_address: str,
) -> None:
    """Send the post-confirm notification, swallowing transport errors.

    Catches :class:`EmailDeliveryError` only; the reset already
    succeeded so a downed SMTP relay must not surface a 500 to the
    user, but a programmer error in the renderer is something we want
    to see in monitoring (and which would not affect the user-visible
    flow either way).
    """
    try:
        await sender.send(_build_change_notification_email(to_address))
    except EmailDeliveryError:
        logger.warning(
            "password_change_notification_failed",
            extra={"email_fingerprint": _email_log_fingerprint(to_address)},
        )


async def _lookup_active_user(session: AsyncSession, email: str) -> User | None:
    """Return the active row for ``email`` (or ``None`` for the miss path).

    "Active" excludes soft-deleted and disabled rows -- a reset on a
    disabled account would be a foothold for re-enabling it via
    password possession alone.
    """
    result = await session.execute(select(User).where(User.email == email))
    user = result.scalars().first()
    if user is None or user.deleted_at is not None or not user.is_active:
        return None
    return user


def _log_reset_event(action: str, email: str, request: Request) -> None:
    """Audit log line for every reset-flow event (SPEC R9 fingerprint-only)."""
    logger.info(
        "password_reset_event",
        extra={
            "action": action,
            "email_fingerprint": _email_log_fingerprint(email),
            "ip_address": _get_client_ip(request),
            "timestamp": datetime.now(UTC).isoformat(),
        },
    )


@router.post(
    "/password-reset/request",
    response_model=PasswordResetAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
@limiter.limit("3/hour")
async def request_password_reset(
    request: Request,
    payload: PasswordResetRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    sender: Annotated[EmailSender, Depends(get_email_sender)],
) -> PasswordResetAccepted:
    """Issue a reset link by email, with anti-enumeration timing parity.

    Always returns 202 with the same body shape regardless of whether
    the email is registered (SPEC R4).  A miss path computes one bcrypt
    digest (``_consume_dummy_bcrypt``) so the response time matches the
    hit path within the SPEC R4 ~50 ms tolerance.
    """
    user = await _lookup_active_user(session, payload.email)
    if user is None:
        # Miss path: do NOT log ``action=requested`` -- the runbook
        # promises that line means "the server accepted the request
        # and called the email backend".  Emitting it here would send
        # operators chasing a missing SMTP delivery for an email that
        # was never sent.  The constant-time bcrypt below preserves
        # SPEC R4 timing parity.
        _consume_dummy_bcrypt()
        return PasswordResetAccepted(message=_RESET_REQUEST_GENERIC_MESSAGE)
    plaintext = await _mint_and_persist_reset_token(session, user, request)
    await _send_reset_email_safely(sender, payload.email, plaintext)
    _log_reset_event("requested", payload.email, request)
    return PasswordResetAccepted(message=_RESET_REQUEST_GENERIC_MESSAGE)


async def _select_active_token_only(
    session: AsyncSession, plaintext: str
) -> PasswordResetToken | None:
    """Find the still-live reset row matching ``plaintext``, or ``None``.

    Pre-filters by the indexed ``lookup_key`` (a non-secret SHA-256
    prefix of the plaintext) so the SQL hits at most a handful of rows
    even at large user counts.  The bcrypt verify is still the security
    gate -- the lookup_key is a deterministic hash, not a secret, and
    even a 1-in-quintillion collision on the prefix is filtered out by
    the constant-time bcrypt comparison.
    """
    now = datetime.now(UTC)
    result = await session.execute(
        select(PasswordResetToken).where(
            PasswordResetToken.lookup_key == _make_lookup_key(plaintext),
            col(PasswordResetToken.used_at).is_(None),
            col(PasswordResetToken.cancelled_at).is_(None),
            PasswordResetToken.expires_at > now,
        )
    )
    # ``.first()`` rather than iterating: with a 64-bit lookup_key
    # collision odds are 1-in-18-quintillion, so the result set is
    # effectively size-zero or size-one.  On the astronomical-collision
    # case bcrypt rejects the row and confirm 400s -- the user simply
    # re-requests a reset.  No security loss; cleaner than a for loop
    # that almost never iterates.
    row = result.scalars().first()
    if row is None or not _verify_reset_token(plaintext, row.token_hash):
        return None
    return row


async def _cancel_token_for_disabled_user(
    session: AsyncSession,
    token_row: PasswordResetToken,
    user_row: User | None,
) -> None:
    """Auto-cancel a reset token whose owning user is gone / disabled.

    Without this the row would linger as ``active`` for the full
    30-minute TTL even though confirm refuses it -- consuming the
    per-user cap and going untraced in the audit log.  Cancelling
    here closes the window and emits the correlated ``user_disabled``
    reason so the operator trail does not go cold.
    """
    # Single ``now`` so the column stamp and the audit log line carry
    # exactly the same timestamp -- avoids confusing microsecond drift
    # in ops dashboards correlating row state with log lines.
    now = datetime.now(UTC)
    token_row.cancelled_at = now
    session.add(token_row)
    await session.commit()
    fingerprint_email = user_row.email if user_row is not None else ""
    logger.info(
        "password_reset_event",
        extra={
            "action": "confirm_rejected_user_disabled",
            "email_fingerprint": _email_log_fingerprint(fingerprint_email),
            "timestamp": now.isoformat(),
        },
    )


async def _select_active_token_for_email(
    session: AsyncSession, plaintext: str
) -> tuple[PasswordResetToken, User] | None:
    """Find the (token, user) pair matching the supplied plaintext, or ``None``.

    If the token is real but the owning user has been soft-deleted /
    disabled (or vanished entirely), the token is auto-cancelled and
    a ``confirm_rejected_user_disabled`` audit line is emitted before
    we return ``None``.  Caller still sees the same generic
    ``invalid_or_expired_token`` response -- the disabled-user state
    is server-side audit data only.
    """
    token_row = await _select_active_token_only(session, plaintext)
    if token_row is None:
        return None
    user_row = await session.get(User, token_row.user_id)
    if user_row is None or user_row.deleted_at is not None or not user_row.is_active:
        await _cancel_token_for_disabled_user(session, token_row, user_row)
        return None
    return token_row, user_row


def _reject_if_password_reuse(user: User, new_password: str) -> None:
    """Reject reuse of the current password (SPEC R10)."""
    if _verify_password(new_password, user.password_hash):
        raise bad_request("password_unchanged")


async def _clear_recent_failed_attempts(session: AsyncSession, email: str) -> None:
    """Clear the rolling lockout window after a successful reset (SPEC R6).

    The user has proven identity via email possession, so any
    accumulated failed-login attempts (which fed the ``MAX_FAILED_ATTEMPTS``
    lockout) should not block them from logging in with the freshly
    set password.  Deletes only rows inside the active lockout window
    so older audit history is preserved.
    """
    cutoff = datetime.now(UTC) - LOCKOUT_DURATION
    result = await session.execute(
        select(LoginAttempt).where(
            LoginAttempt.email == email,
            LoginAttempt.created_at >= cutoff,
            col(LoginAttempt.success).is_(False),
        )
    )
    for row in result.scalars().all():
        await session.delete(row)


async def _apply_reset_to_user(
    session: AsyncSession,
    user: User,
    token_row: PasswordResetToken,
    new_password_hash: str,
) -> None:
    """Persist the new password hash, mark token used, advance ``password_changed_at``.

    Takes a pre-computed bcrypt digest so the caller can hash the
    plaintext exactly once (the previous shape hashed twice -- one
    upfront validation throwaway, one inside this helper -- doubling
    the bcrypt budget on every confirm).
    """
    # Single ``now`` so the JWT-revocation floor and the token's
    # consumed-at stamp are exactly identical -- avoids confusing
    # microsecond drift in audit dashboards.
    now = datetime.now(UTC)
    user.password_hash = new_password_hash
    user.password_changed_at = now
    token_row.used_at = now
    session.add(user)
    session.add(token_row)
    await _clear_recent_failed_attempts(session, user.email)
    await session.commit()
    await session.refresh(user)


@router.post("/password-reset/confirm", response_model=AuthResponse)
@limiter.limit("5/hour")
async def confirm_password_reset(
    request: Request,
    payload: PasswordResetConfirm,
    session: Annotated[AsyncSession, Depends(get_session)],
    sender: Annotated[EmailSender, Depends(get_email_sender)],
) -> AuthResponse:
    """Set a new password from a valid reset token; logs the user in.

    On success the SPEC R7 ``password_changed_at`` column is advanced
    so every outstanding JWT for this user becomes invalid (their
    ``iat`` will predate the new floor).  The post-confirm out-of-band
    notification (R8) is sent best-effort -- failure does not roll
    back the reset.
    """
    found = await _select_active_token_for_email(session, payload.token)
    if found is None:
        # Spend the cost-12 password-verify budget that the success
        # branch's ``_reject_if_password_reuse`` will spend, so the
        # invalid-token vs. valid-token-with-password-reuse paths
        # cannot be timing-distinguished.  The user's stored hash is
        # cost-12 so the dummy must match that cost; the cost-10
        # ``_consume_dummy_bcrypt`` is too fast to mask the verify.
        _consume_dummy_password_verify()
        _log_reset_event("confirm_rejected", "", request)
        raise bad_request("invalid_or_expired_token")
    token_row, user = found
    _reject_if_password_reuse(user, payload.new_password)
    # Hash the new password only AFTER the token is validated -- bcrypt
    # is the most expensive operation in this handler (~250 ms cost-12),
    # so deferring saves the cost on the (expected-common) invalid-token
    # path.
    try:
        new_password_hash = _hash_password(payload.new_password)
    except ValueError as exc:
        raise bad_request("password_too_long") from exc
    await _apply_reset_to_user(session, user, token_row, new_password_hash)
    if user.id is None:
        msg = "User missing ID after reset commit"
        raise RuntimeError(msg)
    await _send_change_notification_safely(sender, user.email)
    _log_reset_event("confirmed", user.email, request)
    new_token, _ = _create_token(user.id)
    return AuthResponse(token=new_token, user_id=user.id, timezone=user.timezone)


@router.post("/password-reset/cancel", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("10/hour")
async def cancel_password_reset(
    request: Request,
    payload: PasswordResetCancel,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    """Mark a still-live reset token as cancelled.

    Possession of the token is the only auth -- the same trust model
    as confirm.  Returns 204 on both hit and miss so the endpoint is
    safe to embed in an email link without leaking whether the link
    is live.

    On the hit path we look up the owning user so the audit log line
    carries the same email fingerprint as ``request`` and ``confirmed``
    -- the runbook's symptom table tells operators to grep by
    fingerprint when investigating "this wasn't me" reports, and an
    empty string would render that flow useless.  The miss path
    (``cancel_noop``) has no user to look up -- the token was never
    valid -- so the empty fingerprint is correct there.
    """
    row = await _select_active_token_only(session, payload.token)
    if row is None:
        _log_reset_event("cancel_noop", "", request)
        return
    row.cancelled_at = datetime.now(UTC)
    session.add(row)
    user = await session.get(User, row.user_id)
    cancelled_email = user.email if user is not None else ""
    await session.commit()
    _log_reset_event("cancelled", cancelled_email, request)
