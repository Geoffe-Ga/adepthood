"""Authentication endpoints with JWT tokens and database-backed users."""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import bcrypt
import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from errors import bad_request
from models.user import User

router = APIRouter(prefix="/auth", tags=["auth"])

SECRET_KEY = os.getenv("SECRET_KEY", "")
_JWT_ALGORITHM = "HS256"

# JWT token lifetime. One hour balances security (limits the window for a
# stolen token to be misused) with UX (a typical session lasts under an
# hour, so most users won't be interrupted by forced re-authentication).
_TOKEN_TTL = timedelta(hours=1)

_MIN_PASSWORD_LENGTH = 8


def _get_secret_key() -> str:
    if not SECRET_KEY or SECRET_KEY == "replace-me":  # nosec B105  # pragma: allowlist secret
        msg = "SECRET_KEY environment variable must be set to a secure value"
        raise RuntimeError(msg)
    return SECRET_KEY


class AuthRequest(BaseModel):
    email: str
    password: str


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


@router.post("/signup", response_model=AuthResponse)
async def signup(
    payload: AuthRequest,
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> AuthResponse:
    if len(payload.password) < _MIN_PASSWORD_LENGTH:
        raise bad_request("password_too_short")
    result = await session.execute(select(User).where(User.email == payload.email))
    if result.scalars().first() is not None:
        raise bad_request("user_already_exists")

    user = User(
        email=payload.email,
        password_hash=_hash_password(payload.password),
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)

    assert user.id is not None
    token = _create_token(user.id)
    return AuthResponse(token=token, user_id=user.id)


@router.post("/login", response_model=AuthResponse)
async def login(
    payload: AuthRequest,
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> AuthResponse:
    result = await session.execute(select(User).where(User.email == payload.email))
    user = result.scalars().first()
    if user is None or not _verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_credentials")

    assert user.id is not None
    token = _create_token(user.id)
    return AuthResponse(token=token, user_id=user.id)


def get_current_user(authorization: str | None = Header(default=None)) -> int:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing_token")
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(token, _get_secret_key(), algorithms=[_JWT_ALGORITHM])
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="expired_token"
        ) from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_token"
        ) from exc
    user_id = int(payload["sub"])
    return user_id
