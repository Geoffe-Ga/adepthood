"""CORS is configured for a cookieless Bearer-token API (audit §5.3).

Credentials mode is disabled: the middleware is registered with
``allow_credentials=False``, a preflight never advertises
``Access-Control-Allow-Credentials: true``, and an ``Authorization: Bearer``
request from an allowed origin still succeeds without relying on cookies.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
from httpx import AsyncClient

from main import app

ALLOWED_ORIGIN = "http://localhost:3000"
_PASSWORD = "securepassword123"  # pragma: allowlist secret

client = TestClient(app)


def _cors_kwargs() -> dict[str, object]:
    for middleware in app.user_middleware:
        if getattr(middleware.cls, "__name__", "") == CORSMiddleware.__name__:
            return dict(middleware.kwargs)
    pytest.fail("CORSMiddleware is not registered")
    return {}  # pragma: no cover - pytest.fail raises


def test_cors_middleware_disables_credentials() -> None:
    assert _cors_kwargs()["allow_credentials"] is False


def test_preflight_omits_allow_credentials() -> None:
    """A preflight OPTIONS must not return Access-Control-Allow-Credentials: true."""
    response = client.options(
        "/auth/login",
        headers={
            "Origin": ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
        },
    )
    assert response.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN
    assert response.headers.get("access-control-allow-credentials") != "true"


@pytest.mark.asyncio
async def test_bearer_request_from_allowed_origin_succeeds(async_client: AsyncClient) -> None:
    """An authenticated Bearer request from an allowed origin still works (no cookies)."""
    signup = await async_client.post(
        "/auth/signup",
        json={"email": "cors@example.com", "password": _PASSWORD},
    )
    assert signup.status_code == HTTPStatus.OK
    token = signup.json()["token"]

    resp = await async_client.get(
        "/user/balance",
        headers={"Authorization": f"Bearer {token}", "Origin": ALLOWED_ORIGIN},
    )
    assert resp.status_code == HTTPStatus.OK
    # Auth rode entirely on the Bearer header — no Set-Cookie / cookie reliance.
    assert "set-cookie" not in {k.lower() for k in resp.headers}
