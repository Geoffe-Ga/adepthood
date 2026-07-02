"""Router tests for chord journaling (primary_aspect / secondary_aspect) CRUD."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient


async def _signup(client: AsyncClient, username: str = "chorduser") -> dict[str, str]:
    """Create a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _create(
    client: AsyncClient, headers: dict[str, str], **overrides: object
) -> dict[str, object]:
    """POST a journal message and return the parsed response body."""
    payload: dict[str, object] = {"message": "A tagged reflection."}
    payload.update(overrides)
    resp = await client.post("/journal/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    body: dict[str, object] = resp.json()
    return body


@pytest.mark.asyncio
async def test_create_persists_and_echoes_both_aspects(async_client: AsyncClient) -> None:
    """POST with a full chord persists both fields and echoes them in the response."""
    headers = await _signup(async_client)
    body = await _create(async_client, headers, primary_aspect=3, secondary_aspect=7)
    assert body["primary_aspect"] == 3
    assert body["secondary_aspect"] == 7


@pytest.mark.asyncio
async def test_create_without_aspects_leaves_both_null(async_client: AsyncClient) -> None:
    """POST with neither aspect leaves both fields null (unchanged behavior)."""
    headers = await _signup(async_client, "noaspect")
    body = await _create(async_client, headers)
    assert body["primary_aspect"] is None
    assert body["secondary_aspect"] is None


@pytest.mark.asyncio
async def test_patch_updates_chord_pair(async_client: AsyncClient) -> None:
    """PATCH with both aspects updates and echoes the pair."""
    headers = await _signup(async_client, "patcher_chord")
    entry = await _create(async_client, headers)
    resp = await async_client.patch(
        f"/journal/{entry['id']}",
        json={"primary_aspect": 4, "secondary_aspect": 8},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["primary_aspect"] == 4
    assert body["secondary_aspect"] == 8


@pytest.mark.asyncio
async def test_patch_explicit_nulls_clears_chord(async_client: AsyncClient) -> None:
    """PATCH with explicit nulls for both aspects clears the chord."""
    headers = await _signup(async_client, "clearer_chord")
    entry = await _create(async_client, headers, primary_aspect=2, secondary_aspect=6)
    resp = await async_client.patch(
        f"/journal/{entry['id']}",
        json={"primary_aspect": None, "secondary_aspect": None},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["primary_aspect"] is None
    assert body["secondary_aspect"] is None


@pytest.mark.asyncio
async def test_patch_primary_only_resets_stale_secondary(async_client: AsyncClient) -> None:
    """PATCH with only primary_aspect must reset a stale secondary, not 500."""
    headers = await _signup(async_client, "atomic_chord")
    entry = await _create(async_client, headers, primary_aspect=1, secondary_aspect=5)
    resp = await async_client.patch(
        f"/journal/{entry['id']}",
        json={"primary_aspect": 5},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["primary_aspect"] == 5
    assert body["secondary_aspect"] is None


@pytest.mark.asyncio
async def test_create_secondary_without_primary_is_422(async_client: AsyncClient) -> None:
    """POST with a secondary but no primary is rejected."""
    headers = await _signup(async_client, "shape_a")
    resp = await async_client.post(
        "/journal/",
        json={"message": "x", "secondary_aspect": 4},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_primary_equal_secondary_is_422(async_client: AsyncClient) -> None:
    """POST with primary == secondary is rejected."""
    headers = await _signup(async_client, "shape_b")
    resp = await async_client.post(
        "/journal/",
        json={"message": "x", "primary_aspect": 5, "secondary_aspect": 5},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_primary_below_range_is_422(async_client: AsyncClient) -> None:
    """POST with primary_aspect=0 is rejected (below range)."""
    headers = await _signup(async_client, "range_a")
    resp = await async_client.post(
        "/journal/",
        json={"message": "x", "primary_aspect": 0},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_primary_above_range_is_422(async_client: AsyncClient) -> None:
    """POST with primary_aspect=11 is rejected (above range)."""
    headers = await _signup(async_client, "range_b")
    resp = await async_client.post(
        "/journal/",
        json={"message": "x", "primary_aspect": 11},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
