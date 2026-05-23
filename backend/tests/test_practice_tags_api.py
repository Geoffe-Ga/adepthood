"""Tests for /practice-tags CRUD endpoints."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice_tag import PracticeTag


async def _signup(client: AsyncClient, username: str = "owner") -> dict[str, str]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _seed_system_tag(
    db_session: AsyncSession, slug: str = "sight", label: str = "Sight"
) -> PracticeTag:
    tag = PracticeTag(slug=slug, label=label, owner_user_id=None)
    db_session.add(tag)
    await db_session.commit()
    await db_session.refresh(tag)
    return tag


@pytest.mark.asyncio
async def test_list_returns_system_and_own_tags(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    await _seed_system_tag(db_session, slug="sight", label="Sight")
    headers = await _signup(async_client)
    create = await async_client.post(
        "/practice-tags/",
        json={"slug": "my_custom", "label": "Custom"},
        headers=headers,
    )
    assert create.status_code == HTTPStatus.CREATED, create.text

    resp = await async_client.get("/practice-tags/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    slugs = {row["slug"] for row in body}
    assert {"sight", "my_custom"} <= slugs


@pytest.mark.asyncio
async def test_list_excludes_other_users_tags(async_client: AsyncClient) -> None:
    headers_alice = await _signup(async_client, "alice")
    headers_bob = await _signup(async_client, "bob")
    await async_client.post(
        "/practice-tags/",
        json={"slug": "alice_only", "label": "Alice's tag"},
        headers=headers_alice,
    )
    resp = await async_client.get("/practice-tags/", headers=headers_bob)
    slugs = {row["slug"] for row in resp.json()}
    assert "alice_only" not in slugs


@pytest.mark.asyncio
async def test_create_personal_tag_201(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/practice-tags/",
        json={"slug": "my_tag", "label": "My Tag"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    body = resp.json()
    assert body["slug"] == "my_tag"
    assert body["label"] == "My Tag"
    assert body["owner_user_id"] is not None


@pytest.mark.asyncio
async def test_create_rejects_invalid_slug(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/practice-tags/",
        json={"slug": "BadSlug", "label": "x"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_duplicate_user_slug_409(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await async_client.post("/practice-tags/", json={"slug": "dup", "label": "A"}, headers=headers)
    resp = await async_client.post(
        "/practice-tags/", json={"slug": "dup", "label": "B"}, headers=headers
    )
    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "tag_slug_taken"


@pytest.mark.asyncio
async def test_user_can_create_same_slug_as_system(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """System and user namespaces are independent (partial unique indexes)."""
    await _seed_system_tag(db_session, slug="sight", label="Sight")
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/practice-tags/",
        json={"slug": "sight", "label": "My Sight"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED, resp.text


@pytest.mark.asyncio
async def test_get_visible_tag_200(async_client: AsyncClient, db_session: AsyncSession) -> None:
    tag = await _seed_system_tag(db_session)
    headers = await _signup(async_client)
    resp = await async_client.get(f"/practice-tags/{tag.id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["slug"] == "sight"


@pytest.mark.asyncio
async def test_get_invisible_tag_404(async_client: AsyncClient) -> None:
    headers_alice = await _signup(async_client, "alice")
    headers_bob = await _signup(async_client, "bob")
    create = await async_client.post(
        "/practice-tags/",
        json={"slug": "alice_secret", "label": "secret"},
        headers=headers_alice,
    )
    tag_id = create.json()["id"]
    resp = await async_client.get(f"/practice-tags/{tag_id}", headers=headers_bob)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_update_renames_personal_tag(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    create = await async_client.post(
        "/practice-tags/", json={"slug": "to_rename", "label": "Old"}, headers=headers
    )
    tag_id = create.json()["id"]
    resp = await async_client.patch(
        f"/practice-tags/{tag_id}", json={"label": "New"}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["label"] == "New"
    assert resp.json()["slug"] == "to_rename"


@pytest.mark.asyncio
async def test_update_system_tag_403(async_client: AsyncClient, db_session: AsyncSession) -> None:
    tag = await _seed_system_tag(db_session)
    headers = await _signup(async_client)
    resp = await async_client.patch(
        f"/practice-tags/{tag.id}", json={"label": "New"}, headers=headers
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "cannot_modify_system_tag"


@pytest.mark.asyncio
async def test_delete_personal_tag_204(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    create = await async_client.post(
        "/practice-tags/", json={"slug": "doomed", "label": "x"}, headers=headers
    )
    tag_id = create.json()["id"]
    resp = await async_client.delete(f"/practice-tags/{tag_id}", headers=headers)
    assert resp.status_code == HTTPStatus.NO_CONTENT
    get_resp = await async_client.get(f"/practice-tags/{tag_id}", headers=headers)
    assert get_resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_delete_system_tag_403(async_client: AsyncClient, db_session: AsyncSession) -> None:
    tag = await _seed_system_tag(db_session)
    headers = await _signup(async_client)
    resp = await async_client.delete(f"/practice-tags/{tag.id}", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_unauthenticated_rejected(async_client: AsyncClient) -> None:
    resp = await async_client.get("/practice-tags/")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED
