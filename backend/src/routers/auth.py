"""Simple authentication endpoints issuing session tokens."""

from __future__ import annotations

import hashlib
import secrets
from itertools import count

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel

router = APIRouter(prefix="/auth", tags=["auth"])

_users: dict[str, tuple[str, int]] = {}
_tokens: dict[str, int] = {}
_id_counter = count(1)


class AuthRequest(BaseModel):
    username: str
    password: str


class AuthResponse(BaseModel):
    token: str
    user_id: int


def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def _create_token(user_id: int) -> str:
    token = secrets.token_hex(16)
    _tokens[token] = user_id
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
    if not record or record[0] != _hash_password(payload.password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    user_id = record[1]
    token = _create_token(user_id)
    return AuthResponse(token=token, user_id=user_id)


def get_current_user(authorization: str | None = Header(default=None)) -> int:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing token")
    token = authorization.split(" ", 1)[1]
    user_id = _tokens.get(token)
    if user_id is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token")
    return user_id
