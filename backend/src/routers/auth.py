"""Simple authentication endpoints issuing session tokens."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from itertools import count
from typing import cast

import bcrypt  # type: ignore[import-not-found]
from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel

router = APIRouter(prefix="/auth", tags=["auth"])

_users: dict[str, tuple[bytes, int]] = {}
_tokens: dict[str, tuple[int, datetime]] = {}
_id_counter = count(1)
_TOKEN_TTL = timedelta(hours=1)


def _cleanup_tokens() -> None:
    now = datetime.now(UTC)
    expired = [t for t, (_, exp) in _tokens.items() if exp < now]
    for token in expired:
        _tokens.pop(token, None)


class AuthRequest(BaseModel):
    username: str
    password: str


class AuthResponse(BaseModel):
    token: str
    user_id: int


def _hash_password(password: str) -> bytes:
    hashed = cast(bytes, bcrypt.hashpw(password.encode(), bcrypt.gensalt()))
    return hashed


def _create_token(user_id: int) -> str:
    _cleanup_tokens()
    token = secrets.token_hex(16)
    expires = datetime.now(UTC) + _TOKEN_TTL
    _tokens[token] = (user_id, expires)
    return token


@router.post("/signup", response_model=AuthResponse)
def signup(payload: AuthRequest) -> AuthResponse:
    if payload.username in _users:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "user exists")
    user_id = next(_id_counter)
    _users[payload.username] = (_hash_password(payload.password), user_id)
    token = _create_token(user_id)
    return AuthResponse(token=token, user_id=user_id)


@router.post("/login", response_model=AuthResponse)
def login(payload: AuthRequest) -> AuthResponse:
    record = _users.get(payload.username)
    if not record or not bcrypt.checkpw(payload.password.encode(), record[0]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    user_id = record[1]
    token = _create_token(user_id)
    return AuthResponse(token=token, user_id=user_id)


def get_current_user(authorization: str | None = Header(default=None)) -> int:
    _cleanup_tokens()
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing token")
    token = authorization.split(" ", 1)[1]
    data = _tokens.get(token)
    if data is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token")
    user_id, expires = data
    if expires < datetime.now(UTC):
        _tokens.pop(token, None)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "expired token")
    return user_id
