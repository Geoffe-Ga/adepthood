"""Tests for the practice share-link API (issue #348)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import cast

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice import Practice
from models.practice_share_link import PracticeShareLink


def _timer_cfg(duration_minutes: float) -> dict[str, object]:
    return {
        "mode": "meditation_timer",
        "duration_minutes": duration_minutes,
        "start_bell": True,
        "halfway_bell": False,
        "end_bell": True,
    }


async def _signup(client: AsyncClient, username: str = "owner") -> tuple[dict[str, str], int]:
    """Create a user via the public signup endpoint and return (headers, id)."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, cast("int", data["user_id"])


async def _create_custom_practice(client: AsyncClient, headers: dict[str, str]) -> int:
    """Submit a user-owned practice and return its id."""
    payload = {
        "stage_number": 1,
        "name": "Sandbox practice",
        "description": "A draft",
        "instructions": "Sit and notice",
        "default_duration_minutes": 10,
    }
    resp = await client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    return cast("int", resp.json()["id"])


async def _seed_preset(db_session: AsyncSession) -> int:
    practice = Practice(
        stage_number=1,
        name="Preset",
        description="Catalog preset",
        instructions="Breathe",
        default_duration_minutes=10,
        approved=True,
        submitted_by_user_id=None,
        mode="meditation_timer",
        mode_config=_timer_cfg(10),
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    return cast("int", practice.id)


async def _mint_link(
    client: AsyncClient,
    headers: dict[str, str],
    practice_id: int,
    *,
    expires_in_days: int | None = None,
    max_uses: int | None = None,
) -> dict[str, object]:
    body: dict[str, object] = {}
    if expires_in_days is not None:
        body["expires_in_days"] = expires_in_days
    if max_uses is not None:
        body["max_uses"] = max_uses
    resp = await client.post(
        f"/practices/{practice_id}/share-link",
        json=body,
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    return cast("dict[str, object]", resp.json())


# -- Auth ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_share_link_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.post("/practices/1/share-link", json={})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_preview_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/practices/share/some-token")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_import_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.post("/practices/share/some-token/import")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# -- Mint ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_owner_can_mint_share_link(async_client: AsyncClient) -> None:
    owner_headers, _ = await _signup(async_client, "owner1")
    practice_id = await _create_custom_practice(async_client, owner_headers)

    link = await _mint_link(async_client, owner_headers, practice_id)
    assert link["practice_id"] == practice_id
    assert link["use_count"] == 0
    assert link["revoked_at"] is None
    # ``secrets.token_urlsafe(32)`` -> 43 char URL-safe string.
    token = cast("str", link["token"])
    assert len(token) >= 32
    assert "/" not in token
    assert "=" not in token


@pytest.mark.asyncio
async def test_anyone_can_mint_link_for_preset(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    preset_id = await _seed_preset(db_session)
    user_headers, _ = await _signup(async_client, "preset_sharer")
    link = await _mint_link(async_client, user_headers, preset_id)
    assert link["practice_id"] == preset_id


@pytest.mark.asyncio
async def test_non_owner_cannot_mint_share_link(async_client: AsyncClient) -> None:
    owner_headers, _ = await _signup(async_client, "owner2")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    other_headers, _ = await _signup(async_client, "other2")
    resp = await async_client.post(
        f"/practices/{practice_id}/share-link",
        json={},
        headers=other_headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_mint_share_link_missing_practice(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client, "mint_404")
    resp = await async_client.post(
        "/practices/9999/share-link",
        json={},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_mint_with_options_persists_expires_and_max_uses(
    async_client: AsyncClient,
) -> None:
    headers, _ = await _signup(async_client, "mint_opts")
    practice_id = await _create_custom_practice(async_client, headers)
    link = await _mint_link(async_client, headers, practice_id, expires_in_days=7, max_uses=3)
    assert link["max_uses"] == 3
    assert link["expires_at"] is not None


# -- Preview -------------------------------------------------------------


@pytest.mark.asyncio
async def test_preview_returns_practice_and_owner_display_name(
    async_client: AsyncClient,
) -> None:
    owner_headers, _ = await _signup(async_client, "alice")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    link = await _mint_link(async_client, owner_headers, practice_id)

    recipient_headers, _ = await _signup(async_client, "bob")
    token = cast("str", link["token"])
    resp = await async_client.get(
        f"/practices/share/{token}",
        headers=recipient_headers,
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["practice_id"] == practice_id
    assert data["name"] == "Sandbox practice"
    assert data["created_by_display_name"] == "alice"
    # Issue #348 constraint: do not expose the original owner's user id.
    assert "submitted_by_user_id" not in data
    assert "created_by_user_id" not in data


@pytest.mark.asyncio
async def test_preview_unknown_token_returns_404(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client, "tokenless")
    resp = await async_client.get(
        "/practices/share/this-token-does-not-exist",
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "share_link_not_found"


@pytest.mark.asyncio
async def test_preview_expired_link_returns_410(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    owner_headers, _ = await _signup(async_client, "owner_exp")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    link = await _mint_link(async_client, owner_headers, practice_id, expires_in_days=1)

    # Fast-forward by mutating the row.
    row = await db_session.get(PracticeShareLink, link["id"])
    assert row is not None
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db_session.add(row)
    await db_session.commit()

    recipient_headers, _ = await _signup(async_client, "recipient_exp")
    token = cast("str", link["token"])
    resp = await async_client.get(
        f"/practices/share/{token}",
        headers=recipient_headers,
    )
    assert resp.status_code == HTTPStatus.GONE
    assert resp.json()["detail"] == "share_link_expired"


@pytest.mark.asyncio
async def test_preview_revoked_link_returns_410(
    async_client: AsyncClient,
) -> None:
    owner_headers, _ = await _signup(async_client, "owner_rev")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    link = await _mint_link(async_client, owner_headers, practice_id)

    revoke = await async_client.delete(
        f"/practices/share-links/{link['id']}",
        headers=owner_headers,
    )
    assert revoke.status_code == HTTPStatus.NO_CONTENT

    recipient_headers, _ = await _signup(async_client, "recipient_rev")
    token = cast("str", link["token"])
    resp = await async_client.get(
        f"/practices/share/{token}",
        headers=recipient_headers,
    )
    assert resp.status_code == HTTPStatus.GONE
    assert resp.json()["detail"] == "share_link_revoked"


@pytest.mark.asyncio
async def test_preview_exhausted_link_returns_410(
    async_client: AsyncClient,
) -> None:
    owner_headers, _ = await _signup(async_client, "owner_exh")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    link = await _mint_link(async_client, owner_headers, practice_id, max_uses=1)

    # Recipient imports once -> use_count == 1, max_uses == 1.
    recipient_headers, _ = await _signup(async_client, "recipient_exh")
    token = cast("str", link["token"])
    import_resp = await async_client.post(
        f"/practices/share/{token}/import",
        headers=recipient_headers,
    )
    assert import_resp.status_code == HTTPStatus.CREATED

    # A second user can no longer redeem.
    second_headers, _ = await _signup(async_client, "recipient_exh2")
    resp = await async_client.get(
        f"/practices/share/{token}",
        headers=second_headers,
    )
    assert resp.status_code == HTTPStatus.GONE
    assert resp.json()["detail"] == "share_link_exhausted"


# -- Import --------------------------------------------------------------


@pytest.mark.asyncio
async def test_import_clones_practice_as_unapproved_recipient_draft(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    owner_headers, owner_id = await _signup(async_client, "owner_imp")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    link = await _mint_link(async_client, owner_headers, practice_id)

    recipient_headers, recipient_id = await _signup(async_client, "recipient_imp")
    token = cast("str", link["token"])
    resp = await async_client.post(
        f"/practices/share/{token}/import",
        headers=recipient_headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    body = resp.json()
    assert body["approved"] is False
    new_id = body["practice_id"]
    assert new_id != practice_id

    copy = await db_session.get(Practice, new_id)
    assert copy is not None
    assert copy.submitted_by_user_id == recipient_id
    assert copy.approved is False
    assert copy.name == "Sandbox practice"
    # The original row is untouched.
    original = await db_session.get(Practice, practice_id)
    assert original is not None
    assert original.submitted_by_user_id == owner_id


@pytest.mark.asyncio
async def test_import_increments_use_count(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    owner_headers, _ = await _signup(async_client, "owner_count")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    link = await _mint_link(async_client, owner_headers, practice_id)

    recipient_headers, _ = await _signup(async_client, "recipient_count")
    token = cast("str", link["token"])
    resp = await async_client.post(
        f"/practices/share/{token}/import",
        headers=recipient_headers,
    )
    assert resp.status_code == HTTPStatus.CREATED

    row = await db_session.get(PracticeShareLink, link["id"])
    assert row is not None
    await db_session.refresh(row)
    assert row.use_count == 1


@pytest.mark.asyncio
async def test_import_recipient_sees_imported_practice_in_their_catalog(
    async_client: AsyncClient,
) -> None:
    """End-to-end smoke from issue #348 acceptance criteria.

    Owner creates -> shares -> recipient imports -> recipient can GET
    the new private draft (approved=False, only visible to them).
    """
    owner_headers, _ = await _signup(async_client, "smoke_owner")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    link = await _mint_link(async_client, owner_headers, practice_id)

    recipient_headers, _ = await _signup(async_client, "smoke_recipient")
    token = cast("str", link["token"])
    import_resp = await async_client.post(
        f"/practices/share/{token}/import",
        headers=recipient_headers,
    )
    assert import_resp.status_code == HTTPStatus.CREATED
    new_id = import_resp.json()["practice_id"]

    # Recipient can GET the new private draft.
    detail = await async_client.get(f"/practices/{new_id}", headers=recipient_headers)
    assert detail.status_code == HTTPStatus.OK
    assert detail.json()["approved"] is False

    # And the original owner cannot see the recipient's copy (visibility
    # filter restricts unapproved rows to the submitter).
    forbidden = await async_client.get(f"/practices/{new_id}", headers=owner_headers)
    assert forbidden.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_self_import_rejected_with_400(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client, "self_share")
    practice_id = await _create_custom_practice(async_client, headers)
    link = await _mint_link(async_client, headers, practice_id)
    token = cast("str", link["token"])
    resp = await async_client.post(
        f"/practices/share/{token}/import",
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert resp.json()["detail"] == "cannot_import_own_practice"


@pytest.mark.asyncio
async def test_import_revoked_link_410(async_client: AsyncClient) -> None:
    owner_headers, _ = await _signup(async_client, "owner_imp_rev")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    link = await _mint_link(async_client, owner_headers, practice_id)

    revoke = await async_client.delete(
        f"/practices/share-links/{link['id']}",
        headers=owner_headers,
    )
    assert revoke.status_code == HTTPStatus.NO_CONTENT

    recipient_headers, _ = await _signup(async_client, "recipient_imp_rev")
    token = cast("str", link["token"])
    resp = await async_client.post(
        f"/practices/share/{token}/import",
        headers=recipient_headers,
    )
    assert resp.status_code == HTTPStatus.GONE


# -- Revoke --------------------------------------------------------------


@pytest.mark.asyncio
async def test_owner_can_revoke_share_link(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    owner_headers, _ = await _signup(async_client, "owner_revoke")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    link = await _mint_link(async_client, owner_headers, practice_id)

    resp = await async_client.delete(
        f"/practices/share-links/{link['id']}",
        headers=owner_headers,
    )
    assert resp.status_code == HTTPStatus.NO_CONTENT

    row = await db_session.get(PracticeShareLink, link["id"])
    assert row is not None
    await db_session.refresh(row)
    assert row.revoked_at is not None


@pytest.mark.asyncio
async def test_revoke_idempotent_for_already_revoked(
    async_client: AsyncClient,
) -> None:
    owner_headers, _ = await _signup(async_client, "owner_revoke2")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    link = await _mint_link(async_client, owner_headers, practice_id)

    first = await async_client.delete(
        f"/practices/share-links/{link['id']}",
        headers=owner_headers,
    )
    second = await async_client.delete(
        f"/practices/share-links/{link['id']}",
        headers=owner_headers,
    )
    assert first.status_code == HTTPStatus.NO_CONTENT
    assert second.status_code == HTTPStatus.NO_CONTENT


@pytest.mark.asyncio
async def test_non_owner_cannot_revoke_share_link(async_client: AsyncClient) -> None:
    owner_headers, _ = await _signup(async_client, "owner_revoke3")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    link = await _mint_link(async_client, owner_headers, practice_id)
    other_headers, _ = await _signup(async_client, "other_revoke3")
    resp = await async_client.delete(
        f"/practices/share-links/{link['id']}",
        headers=other_headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_revoke_unknown_share_link_returns_404(
    async_client: AsyncClient,
) -> None:
    headers, _ = await _signup(async_client, "revoke_404")
    resp = await async_client.delete(
        "/practices/share-links/99999",
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


# -- List ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_owner_can_list_share_links(async_client: AsyncClient) -> None:
    owner_headers, _ = await _signup(async_client, "owner_list")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    first = await _mint_link(async_client, owner_headers, practice_id)
    second = await _mint_link(async_client, owner_headers, practice_id)

    resp = await async_client.get(
        f"/practices/{practice_id}/share-links",
        headers=owner_headers,
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    ids = {row["id"] for row in body}
    assert ids == {first["id"], second["id"]}


@pytest.mark.asyncio
async def test_non_owner_cannot_list_share_links(async_client: AsyncClient) -> None:
    owner_headers, _ = await _signup(async_client, "owner_list2")
    practice_id = await _create_custom_practice(async_client, owner_headers)
    await _mint_link(async_client, owner_headers, practice_id)
    other_headers, _ = await _signup(async_client, "other_list2")
    resp = await async_client.get(
        f"/practices/{practice_id}/share-links",
        headers=other_headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN
