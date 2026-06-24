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


# ── Pagination (issue #465) ────────────────────────────────────────────────

_DEFAULT_PAGE_SIZE = 50  # mirror schemas.pagination.DEFAULT_PAGE_SIZE


async def _seed_system_tags(db_session: AsyncSession, count: int) -> None:
    """Seed ``count`` system tags with deterministically label-ordered rows."""
    for i in range(count):
        db_session.add(PracticeTag(slug=f"sys_{i:02d}", label=f"Sys {i:02d}", owner_user_id=None))
    await db_session.commit()


@pytest.mark.asyncio
async def test_list_bare_path_returns_plain_list(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Omitting ?paginate=true returns the historical bare-list shape + order."""
    await _seed_system_tags(db_session, 3)
    headers = await _signup(async_client)

    resp = await async_client.get("/practice-tags/", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert isinstance(body, list)
    labels = [row["label"] for row in body]
    assert labels == sorted(labels)


@pytest.mark.asyncio
async def test_list_paginated_returns_envelope(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """?paginate=true returns the Page envelope with the default limit."""
    await _seed_system_tags(db_session, 3)
    headers = await _signup(async_client)

    resp = await async_client.get("/practice-tags/?paginate=true", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert set(body) == {"items", "total", "limit", "offset", "has_more"}
    assert body["limit"] == _DEFAULT_PAGE_SIZE
    assert body["offset"] == 0
    assert body["total"] == 3
    assert body["has_more"] is False
    assert len(body["items"]) == 3


@pytest.mark.asyncio
async def test_list_pagination_limit_offset_and_has_more(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The limit slices the page, offset skips, and total/has_more cover the set."""
    await _seed_system_tags(db_session, 5)
    headers = await _signup(async_client)

    first = await async_client.get(
        "/practice-tags/?paginate=true&limit=2&offset=0", headers=headers
    )
    page1 = first.json()
    assert page1["total"] == 5
    assert page1["limit"] == 2
    assert page1["offset"] == 0
    assert page1["has_more"] is True
    assert len(page1["items"]) == 2

    second = await async_client.get(
        "/practice-tags/?paginate=true&limit=2&offset=2", headers=headers
    )
    page2 = second.json()
    assert page2["offset"] == 2
    assert page2["has_more"] is True
    assert len(page2["items"]) == 2

    page1_slugs = {row["slug"] for row in page1["items"]}
    page2_slugs = {row["slug"] for row in page2["items"]}
    assert page1_slugs.isdisjoint(page2_slugs)
    combined = [row["label"] for row in page1["items"] + page2["items"]]
    assert combined == sorted(combined)


@pytest.mark.asyncio
async def test_list_pagination_last_page_has_no_more(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The final slice reports has_more=false even with a partial page."""
    await _seed_system_tags(db_session, 5)
    headers = await _signup(async_client)

    resp = await async_client.get("/practice-tags/?paginate=true&limit=2&offset=4", headers=headers)

    body = resp.json()
    assert body["total"] == 5
    assert body["offset"] == 4
    assert body["has_more"] is False
    assert len(body["items"]) == 1


@pytest.mark.asyncio
async def test_list_pagination_preserves_system_first_ordering(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """System tags (owner None) sort before personal tags through pagination."""
    await _seed_system_tags(db_session, 2)
    headers = await _signup(async_client)
    # "AAA personal" sorts before the system labels by label alone, so seeing
    # it last proves the system-first (nulls_first) ordering is authoritative.
    await async_client.post(
        "/practice-tags/",
        json={"slug": "aaa_personal", "label": "AAA personal"},
        headers=headers,
    )

    resp = await async_client.get("/practice-tags/?paginate=true", headers=headers)

    items = resp.json()["items"]
    owners = [row["owner_user_id"] for row in items]
    personal_index = next(i for i, owner in enumerate(owners) if owner is not None)
    assert all(owner is None for owner in owners[:personal_index])
    assert items[-1]["slug"] == "aaa_personal"


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [0, 201])
async def test_list_pagination_rejects_out_of_range_limit(
    async_client: AsyncClient, limit: int
) -> None:
    """The limit bounds are enforced by the shared PaginationParams validators."""
    headers = await _signup(async_client)
    resp = await async_client.get(f"/practice-tags/?paginate=true&limit={limit}", headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
