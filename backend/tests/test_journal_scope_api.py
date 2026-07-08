"""Tests for the reflection_level / reflection_scope_key pair on the journal API.

``JournalMessageCreate`` / ``JournalEntryUpdate`` do not carry these fields yet,
so every payload below is silently accepted (extra keys ignored) instead of
validated or persisted -- the assertions on the (currently absent) behavior
fail, which is the correct RED state for Gate 1. The model layer and its
partial-unique index already exist; only the schema + router wiring is new.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient


async def _signup(client: AsyncClient, username: str = "alice") -> dict[str, str]:
    """Create a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


# ── Create ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_with_scope_pair_persists_both_fields(async_client: AsyncClient) -> None:
    """A valid (level, scope_key) pair is persisted and echoed back."""
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/journal/",
        json={
            "message": "Week one, closing thoughts.",
            "reflection_level": "week",
            "reflection_scope_key": "c1:w1",
            "tag": "hierarchical_reflection",
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert data.get("reflection_level") == "week"
    assert data.get("reflection_scope_key") == "c1:w1"
    assert data.get("tag") == "hierarchical_reflection"


@pytest.mark.asyncio
async def test_create_with_level_only_returns_422(async_client: AsyncClient) -> None:
    """reflection_level with no reflection_scope_key is rejected (both-or-neither)."""
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/journal/",
        json={"message": "Partial pair", "reflection_level": "week"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_with_scope_key_only_returns_422(async_client: AsyncClient) -> None:
    """reflection_scope_key with no reflection_level is rejected (both-or-neither)."""
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/journal/",
        json={"message": "Partial pair", "reflection_scope_key": "c1:w1"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_with_mismatched_pair_returns_422(async_client: AsyncClient) -> None:
    """A stage level with a week-token key is rejected."""
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/journal/",
        json={
            "message": "Mismatched pair",
            "reflection_level": "stage",
            "reflection_scope_key": "c1:w1",
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_with_malformed_scope_key_returns_422(async_client: AsyncClient) -> None:
    """A scope key that fails the c{cycle}:{token} grammar is rejected."""
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/journal/",
        json={
            "message": "Bad grammar",
            "reflection_level": "week",
            "reflection_scope_key": "nope",
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_duplicate_live_scope_returns_409(async_client: AsyncClient) -> None:
    """A second live entry claiming the same scope key for the same user 409s."""
    headers = await _signup(async_client)
    payload = {
        "message": "First take",
        "reflection_level": "week",
        "reflection_scope_key": "c1:w1",
        "tag": "hierarchical_reflection",
    }
    first = await async_client.post("/journal/", json=payload, headers=headers)
    assert first.status_code == HTTPStatus.CREATED

    second = await async_client.post(
        "/journal/",
        json={**payload, "message": "Second take, same scope"},
        headers=headers,
    )
    assert second.status_code == HTTPStatus.CONFLICT
    assert second.json()["detail"] == "reflection_scope_taken"


@pytest.mark.asyncio
async def test_soft_delete_frees_scope_for_reuse(async_client: AsyncClient) -> None:
    """Soft-deleting a scoped entry frees its scope key for a new one."""
    headers = await _signup(async_client)
    payload = {
        "message": "First take",
        "reflection_level": "week",
        "reflection_scope_key": "c1:w1",
        "tag": "hierarchical_reflection",
    }
    first = await async_client.post("/journal/", json=payload, headers=headers)
    assert first.status_code == HTTPStatus.CREATED
    entry_id = first.json()["id"]

    delete_resp = await async_client.delete(f"/journal/{entry_id}", headers=headers)
    assert delete_resp.status_code == HTTPStatus.NO_CONTENT

    second = await async_client.post(
        "/journal/",
        json={**payload, "message": "Retaken after delete"},
        headers=headers,
    )
    assert second.status_code == HTTPStatus.CREATED


# ── Update ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_patch_sets_scope_pair(async_client: AsyncClient) -> None:
    """PATCHing a freeform entry with a valid pair persists both fields."""
    headers = await _signup(async_client)
    create_resp = await async_client.post(
        "/journal/", json={"message": "Freeform thoughts"}, headers=headers
    )
    assert create_resp.status_code == HTTPStatus.CREATED
    entry_id = create_resp.json()["id"]

    patch_resp = await async_client.patch(
        f"/journal/{entry_id}",
        json={"reflection_level": "week", "reflection_scope_key": "c1:w1"},
        headers=headers,
    )
    assert patch_resp.status_code == HTTPStatus.OK
    data = patch_resp.json()
    assert data.get("reflection_level") == "week"
    assert data.get("reflection_scope_key") == "c1:w1"


@pytest.mark.asyncio
async def test_patch_single_scope_field_only_returns_422(async_client: AsyncClient) -> None:
    """PATCHing only reflection_level (no scope_key) is rejected -- the pair is atomic."""
    headers = await _signup(async_client)
    create_resp = await async_client.post(
        "/journal/", json={"message": "Freeform thoughts"}, headers=headers
    )
    assert create_resp.status_code == HTTPStatus.CREATED
    entry_id = create_resp.json()["id"]

    patch_resp = await async_client.patch(
        f"/journal/{entry_id}",
        json={"reflection_level": "week"},
        headers=headers,
    )
    assert patch_resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
