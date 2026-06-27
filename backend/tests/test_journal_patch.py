"""Tests for PATCH /journal/{id} (journal-resonance-03)."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient


async def _signup(client: AsyncClient, username: str = "patcher") -> dict[str, str]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _create(client: AsyncClient, headers: dict[str, str], message: str = "Original.") -> int:
    resp = await client.post("/journal/", json={"message": message}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


@pytest.mark.asyncio
async def test_patch_updates_message_title_status(async_client: AsyncClient) -> None:
    """A PATCH applies the provided fields and advances updated_at."""
    headers = await _signup(async_client)
    entry_id = await _create(async_client, headers)
    before = (await async_client.get(f"/journal/{entry_id}", headers=headers)).json()

    resp = await async_client.patch(
        f"/journal/{entry_id}",
        json={"message": "Revised body.", "title": "A Title", "status": "finished"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["message"] == "Revised body."
    assert body["title"] == "A Title"
    assert body["status"] == "finished"
    assert body["updated_at"] >= before["updated_at"]


@pytest.mark.asyncio
async def test_patch_same_value_does_not_bump_updated_at(async_client: AsyncClient) -> None:
    """A PATCH that doesn't actually change anything leaves updated_at untouched."""
    headers = await _signup(async_client, "noop")
    entry_id = await _create(async_client, headers)
    first = (
        await async_client.patch(
            f"/journal/{entry_id}", json={"status": "finished"}, headers=headers
        )
    ).json()
    again = (
        await async_client.patch(
            f"/journal/{entry_id}", json={"status": "finished"}, headers=headers
        )
    ).json()
    assert again["updated_at"] == first["updated_at"]


@pytest.mark.asyncio
async def test_patch_empty_payload_is_422(async_client: AsyncClient) -> None:
    """An empty PATCH body is rejected so a no-op can't bump updated_at."""
    headers = await _signup(async_client, "empty")
    entry_id = await _create(async_client, headers)
    resp = await async_client.patch(f"/journal/{entry_id}", json={}, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_patch_other_users_entry_is_404(async_client: AsyncClient) -> None:
    """Another user's entry is invisible (404), not 403."""
    alice = await _signup(async_client, "alice_p")
    bob = await _signup(async_client, "bob_p")
    entry_id = await _create(async_client, alice)
    resp = await async_client.patch(f"/journal/{entry_id}", json={"title": "hijack"}, headers=bob)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_patch_soft_deleted_entry_is_404(async_client: AsyncClient) -> None:
    """A soft-deleted entry can no longer be patched."""
    headers = await _signup(async_client, "deleted")
    entry_id = await _create(async_client, headers)
    assert (
        await async_client.delete(f"/journal/{entry_id}", headers=headers)
    ).status_code == HTTPStatus.NO_CONTENT
    resp = await async_client.patch(
        f"/journal/{entry_id}", json={"title": "ghost"}, headers=headers
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_patch_bot_entry_is_404(async_client: AsyncClient) -> None:
    """A bot-authored entry shares the user's id but isn't user-editable (404)."""
    headers = await _signup(async_client, "botpatch")
    resp = await async_client.post(
        "/journal/bot-response", json={"message": "AI says hi"}, headers=headers
    )
    entry_id = resp.json()["id"]
    patch = await async_client.patch(
        f"/journal/{entry_id}", json={"title": "tampered"}, headers=headers
    )
    assert patch.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_patch_missing_entry_is_404(async_client: AsyncClient) -> None:
    """Patching a nonexistent id is a 404."""
    headers = await _signup(async_client, "missing")
    resp = await async_client.patch("/journal/999999", json={"title": "x"}, headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_patch_sanitizes_message(async_client: AsyncClient) -> None:
    """The patched body is sanitized — an embedded zero-width space is stripped."""
    headers = await _signup(async_client, "sanitize")
    entry_id = await _create(async_client, headers)
    resp = await async_client.patch(
        f"/journal/{entry_id}",
        json={"message": "clean\u200bbody"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["message"] == "cleanbody"
