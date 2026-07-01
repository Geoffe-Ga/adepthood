"""Endpoint tests for the JournalClassification tier (issue #894).

Scope: persistence and serialisation only.
Routing / LLM behaviour for 'intimate' entries is issue #895 — not tested here.

Covers:
- POST /journal/ without classification → response.classification == "personal".
- POST /journal/ with classification="intimate" → response.classification == "intimate".
- PATCH /journal/{id} with classification="intimate" → response echoes "intimate".
- PATCH /journal/{id} with classification="public" → response echoes "public".
"""

from __future__ import annotations

from http import HTTPStatus
from typing import cast

import pytest
from httpx import AsyncClient


async def _signup(client: AsyncClient, username: str = "classif_ep") -> dict[str, str]:
    """Create a user account and return auth headers."""
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


async def _create(
    client: AsyncClient,
    headers: dict[str, str],
    *,
    message: str = "A journal entry.",
    **extra: object,
) -> dict[str, object]:
    """POST a journal entry and return the parsed response body."""
    payload: dict[str, object] = {"message": message}
    payload.update(extra)
    resp = await client.post("/journal/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    return cast("dict[str, object]", resp.json())


# ---------------------------------------------------------------------------
# POST create
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_without_classification_defaults_to_personal(
    async_client: AsyncClient,
) -> None:
    """POST /journal/ omitting classification must return classification == 'personal'."""
    headers = await _signup(async_client)
    data = await _create(async_client, headers)
    assert data["classification"] == "personal"


@pytest.mark.asyncio
async def test_create_with_intimate_echoes_intimate(async_client: AsyncClient) -> None:
    """POST /journal/ with classification='intimate' must echo 'intimate' (persistence only).

    NOTE: this test asserts only the stored value — #895 owns the routing
    behaviour that intimate entries must never reach cloud LLMs.
    """
    headers = await _signup(async_client, "intimate_ep")
    data = await _create(async_client, headers, classification="intimate")
    assert data["classification"] == "intimate"


@pytest.mark.asyncio
async def test_create_with_public_echoes_public(async_client: AsyncClient) -> None:
    """POST /journal/ with classification='public' must echo 'public'."""
    headers = await _signup(async_client, "public_ep")
    data = await _create(async_client, headers, classification="public")
    assert data["classification"] == "public"


@pytest.mark.asyncio
async def test_create_with_invalid_classification_returns_422(async_client: AsyncClient) -> None:
    """POST /journal/ with an invalid classification value must return 422."""
    headers = await _signup(async_client, "invalid_ep")
    resp = await async_client.post(
        "/journal/",
        json={"message": "Hello.", "classification": "secret"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ---------------------------------------------------------------------------
# PATCH update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_classification_to_intimate(async_client: AsyncClient) -> None:
    """PATCH /journal/{id} with classification='intimate' persists and echoes the value."""
    headers = await _signup(async_client, "patch_intimate")
    entry_id = (await _create(async_client, headers))["id"]

    resp = await async_client.patch(
        f"/journal/{entry_id}",
        json={"classification": "intimate"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["classification"] == "intimate"


@pytest.mark.asyncio
async def test_patch_classification_to_public(async_client: AsyncClient) -> None:
    """PATCH /journal/{id} with classification='public' persists and echoes the value."""
    headers = await _signup(async_client, "patch_public")
    entry_id = (await _create(async_client, headers))["id"]

    resp = await async_client.patch(
        f"/journal/{entry_id}",
        json={"classification": "public"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["classification"] == "public"


@pytest.mark.asyncio
async def test_patch_classification_alone_is_not_422(async_client: AsyncClient) -> None:
    """PATCH with only classification satisfies the at-least-one-field guard (not 422)."""
    headers = await _signup(async_client, "patch_only_classif")
    entry_id = (await _create(async_client, headers))["id"]

    resp = await async_client.patch(
        f"/journal/{entry_id}",
        json={"classification": "personal"},
        headers=headers,
    )
    # Must not be rejected as an empty payload.
    assert resp.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_list_response_includes_classification(async_client: AsyncClient) -> None:
    """GET /journal/ items must include the classification field."""
    headers = await _signup(async_client, "list_classif")
    await _create(async_client, headers, classification="intimate")

    resp = await async_client.get("/journal/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    item = resp.json()["items"][0]
    assert "classification" in item
    assert item["classification"] == "intimate"
