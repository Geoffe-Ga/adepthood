"""Tests for GET /depth-preferences and PATCH /depth-preferences."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient

_PREFS_URL = "/depth-preferences"

# All four ring keys the response must carry.
_RING_KEYS = ("enable_habits", "enable_practices", "enable_course", "enable_sangha")


async def _signup(client: AsyncClient, username: str = "depthuser") -> dict[str, str]:
    """Create an account and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# GET — auto-provision
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_depth_prefs_auto_provisions_defaults(async_client: AsyncClient) -> None:
    """Fresh user with no prefs row gets 200 with all four rings true."""
    headers = await _signup(async_client)

    resp = await async_client.get(_PREFS_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    for key in _RING_KEYS:
        assert body[key] is True, f"expected {key}=True, got {body[key]}"


@pytest.mark.asyncio
async def test_get_depth_prefs_is_idempotent(async_client: AsyncClient) -> None:
    """Calling GET twice returns identical all-true state (no duplicate/error)."""
    headers = await _signup(async_client, "idem")

    first = await async_client.get(_PREFS_URL, headers=headers)
    second = await async_client.get(_PREFS_URL, headers=headers)

    assert first.status_code == HTTPStatus.OK
    assert second.status_code == HTTPStatus.OK
    assert first.json() == second.json()
    for key in _RING_KEYS:
        assert second.json()[key] is True


# ---------------------------------------------------------------------------
# PATCH — partial update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_toggles_one_ring(async_client: AsyncClient) -> None:
    """PATCH with one key flips that ring and leaves the other three true."""
    headers = await _signup(async_client, "one_ring")

    resp = await async_client.patch(
        _PREFS_URL,
        json={"enable_habits": False},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["enable_habits"] is False
    assert body["enable_practices"] is True
    assert body["enable_course"] is True
    assert body["enable_sangha"] is True


@pytest.mark.asyncio
async def test_patch_partial_preserves_previous_toggles(async_client: AsyncClient) -> None:
    """Second PATCH keeps the first ring flipped; only the new key changes."""
    headers = await _signup(async_client, "two_patch")

    first_patch = await async_client.patch(
        _PREFS_URL,
        json={"enable_habits": False},
        headers=headers,
    )
    assert first_patch.status_code == HTTPStatus.OK

    second_patch = await async_client.patch(
        _PREFS_URL,
        json={"enable_sangha": False},
        headers=headers,
    )

    assert second_patch.status_code == HTTPStatus.OK
    body = second_patch.json()
    # First toggle must still be false.
    assert body["enable_habits"] is False
    # New toggle applied.
    assert body["enable_sangha"] is False
    # Untouched rings remain true.
    assert body["enable_practices"] is True
    assert body["enable_course"] is True


@pytest.mark.asyncio
async def test_patch_returns_all_four_ring_keys(async_client: AsyncClient) -> None:
    """PATCH response always includes all four ring booleans."""
    headers = await _signup(async_client, "full_resp")

    resp = await async_client.patch(
        _PREFS_URL,
        json={"enable_course": False},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    for key in _RING_KEYS:
        assert key in body, f"response missing key '{key}'"
        assert isinstance(body[key], bool), f"expected bool for '{key}', got {type(body[key])}"


# ---------------------------------------------------------------------------
# Auth required
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_depth_prefs_requires_auth(async_client: AsyncClient) -> None:
    """GET without a token returns 401."""
    resp = await async_client.get(_PREFS_URL)

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_get_depth_prefs_invalid_token_returns_401(async_client: AsyncClient) -> None:
    """GET with a malformed token returns 401."""
    resp = await async_client.get(
        _PREFS_URL,
        headers={"Authorization": "Bearer not.a.valid.token"},
    )

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_patch_depth_prefs_requires_auth(async_client: AsyncClient) -> None:
    """PATCH without a token returns 401."""
    resp = await async_client.patch(_PREFS_URL, json={"enable_habits": False})

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ---------------------------------------------------------------------------
# Caller-only isolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_does_not_affect_other_user(async_client: AsyncClient) -> None:
    """Toggling one user's ring leaves another user's prefs all-true."""
    alice_headers = await _signup(async_client, "alice_dp")
    bob_headers = await _signup(async_client, "bob_dp")

    # Alice disables her habits ring.
    patch = await async_client.patch(
        _PREFS_URL,
        json={"enable_habits": False},
        headers=alice_headers,
    )
    assert patch.status_code == HTTPStatus.OK
    assert patch.json()["enable_habits"] is False

    # Bob's prefs are untouched; no user_id in the request body.
    bob_resp = await async_client.get(_PREFS_URL, headers=bob_headers)
    assert bob_resp.status_code == HTTPStatus.OK
    for key in _RING_KEYS:
        assert bob_resp.json()[key] is True, f"Bob's {key} was mutated by Alice's PATCH"

    # Alice's state is her own; re-GET confirms persistence.
    alice_resp = await async_client.get(_PREFS_URL, headers=alice_headers)
    assert alice_resp.json()["enable_habits"] is False


# ---------------------------------------------------------------------------
# Empty-body rejection (mirrors JournalEntryUpdate at-least-one guard)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_empty_body_returns_422(async_client: AsyncClient) -> None:
    """PATCH with no fields set is rejected so a no-op cannot reach the DB."""
    headers = await _signup(async_client, "empty_dp")

    resp = await async_client.patch(_PREFS_URL, json={}, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
