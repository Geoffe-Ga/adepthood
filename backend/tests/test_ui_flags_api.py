"""Tests for GET /ui-flags and PATCH /ui-flags."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient

_FLAGS_URL = "/ui-flags"

# Both flag keys the response must carry.
_FLAG_KEYS = ("has_seen_welcome", "energy_scaffolding_archived")


async def _signup(client: AsyncClient, username: str = "uiflagsuser") -> dict[str, str]:
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
async def test_get_auto_provisions_defaults(async_client: AsyncClient) -> None:
    """Fresh user with no flags row gets 200 with both flags false."""
    headers = await _signup(async_client)

    resp = await async_client.get(_FLAGS_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    for key in _FLAG_KEYS:
        assert body[key] is False, f"expected {key}=False, got {body[key]}"


@pytest.mark.asyncio
async def test_get_is_idempotent(async_client: AsyncClient) -> None:
    """Calling GET twice returns identical all-false state (no duplicate/error)."""
    headers = await _signup(async_client, "idem_flags")

    first = await async_client.get(_FLAGS_URL, headers=headers)
    second = await async_client.get(_FLAGS_URL, headers=headers)

    assert first.status_code == HTTPStatus.OK
    assert second.status_code == HTTPStatus.OK
    assert first.json() == second.json()
    for key in _FLAG_KEYS:
        assert second.json()[key] is False


# ---------------------------------------------------------------------------
# PATCH — partial update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_toggles_one_flag(async_client: AsyncClient) -> None:
    """PATCH with one key flips that flag and leaves the other false."""
    headers = await _signup(async_client, "one_flag")

    resp = await async_client.patch(
        _FLAGS_URL,
        json={"has_seen_welcome": True},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["has_seen_welcome"] is True
    assert body["energy_scaffolding_archived"] is False


@pytest.mark.asyncio
async def test_patch_partial_preserves_previous(async_client: AsyncClient) -> None:
    """Second PATCH keeps the first flag true; both flags end up true."""
    headers = await _signup(async_client, "two_patch_flags")

    first_patch = await async_client.patch(
        _FLAGS_URL,
        json={"has_seen_welcome": True},
        headers=headers,
    )
    assert first_patch.status_code == HTTPStatus.OK

    second_patch = await async_client.patch(
        _FLAGS_URL,
        json={"energy_scaffolding_archived": True},
        headers=headers,
    )

    assert second_patch.status_code == HTTPStatus.OK
    body = second_patch.json()
    assert body["has_seen_welcome"] is True
    assert body["energy_scaffolding_archived"] is True


@pytest.mark.asyncio
async def test_patch_returns_both_keys(async_client: AsyncClient) -> None:
    """PATCH response always includes both flag booleans."""
    headers = await _signup(async_client, "full_resp_flags")

    resp = await async_client.patch(
        _FLAGS_URL,
        json={"has_seen_welcome": True},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    for key in _FLAG_KEYS:
        assert key in body, f"response missing key '{key}'"
        assert isinstance(body[key], bool), f"expected bool for '{key}', got {type(body[key])}"


# ---------------------------------------------------------------------------
# Auth required
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_requires_auth(async_client: AsyncClient) -> None:
    """GET without a token returns 401."""
    resp = await async_client.get(_FLAGS_URL)

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_get_invalid_token_returns_401(async_client: AsyncClient) -> None:
    """GET with a malformed token returns 401."""
    resp = await async_client.get(
        _FLAGS_URL,
        headers={"Authorization": "Bearer not.a.valid.token"},
    )

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_patch_requires_auth(async_client: AsyncClient) -> None:
    """PATCH without a token returns 401."""
    resp = await async_client.patch(_FLAGS_URL, json={"has_seen_welcome": True})

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ---------------------------------------------------------------------------
# Caller-only isolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_does_not_affect_other_user(async_client: AsyncClient) -> None:
    """Toggling one user's flag leaves another user's flags all-false."""
    alice_headers = await _signup(async_client, "alice_flags")
    bob_headers = await _signup(async_client, "bob_flags")

    # Alice marks the welcome flag seen.
    patch = await async_client.patch(
        _FLAGS_URL,
        json={"has_seen_welcome": True},
        headers=alice_headers,
    )
    assert patch.status_code == HTTPStatus.OK
    assert patch.json()["has_seen_welcome"] is True

    # Bob's flags are untouched; no user_id in the request body.
    bob_resp = await async_client.get(_FLAGS_URL, headers=bob_headers)
    assert bob_resp.status_code == HTTPStatus.OK
    for key in _FLAG_KEYS:
        assert bob_resp.json()[key] is False, f"Bob's {key} was mutated by Alice's PATCH"

    # Alice's state is her own; re-GET confirms persistence.
    alice_resp = await async_client.get(_FLAGS_URL, headers=alice_headers)
    assert alice_resp.json()["has_seen_welcome"] is True


# ---------------------------------------------------------------------------
# Empty-body rejection (mirrors JournalEntryUpdate at-least-one guard)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_empty_body_returns_422(async_client: AsyncClient) -> None:
    """PATCH with no fields set is rejected so a no-op cannot reach the DB."""
    headers = await _signup(async_client, "empty_flags")

    resp = await async_client.patch(_FLAGS_URL, json={}, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
