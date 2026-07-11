"""Tests for the quote-promotion API: POST /journal/{id}/promote, DELETE and PATCH /promotions/{id}.

These pin the contract for a router that does not exist yet
(``routers/promotions.py``) and a new sub-route on the journal router. Every
request below either 404s (route missing) or the assertion on the (currently
absent) response shape fails -- both are the correct RED state for Gate 1.
"""

from __future__ import annotations

from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.journal_entry import EntryStatus, JournalEntry, JournalTag
from models.promoted_quote import PROMOTED_QUOTE_TEXT_MAX, PromotedQuote
from models.user import User

_OVER_MAX_SPAN_LENGTH = PROMOTED_QUOTE_TEXT_MAX + 1
_OVER_MAX_BODY_LENGTH = PROMOTED_QUOTE_TEXT_MAX + 500


async def _signup(
    client: AsyncClient, db_session: AsyncSession, username: str = "alice"
) -> tuple[dict[str, str], int]:
    """Create a user, return its auth headers and DB id."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    user = (
        await db_session.execute(select(User).where(col(User.email) == f"{username}@example.com"))
    ).scalar_one()
    assert user.id is not None
    return {"Authorization": f"Bearer {token}"}, user.id


async def _seed_entry(
    db_session: AsyncSession, user_id: int, message: str, **overrides: object
) -> JournalEntry:
    """Create and persist a JournalEntry, defaulting to a finished user entry."""
    defaults: dict[str, object] = {"sender": "user", "status": EntryStatus.FINISHED}
    defaults.update(overrides)
    entry = JournalEntry(user_id=user_id, message=message, **defaults)
    db_session.add(entry)
    await db_session.commit()
    await db_session.refresh(entry)
    return entry


async def _seed_quote(
    db_session: AsyncSession,
    user_id: int,
    source_entry_id: int | None,
    anchor_text: str,
    **overrides: object,
) -> PromotedQuote:
    """Create and persist a PromotedQuote spanning ``anchor_text``'s length from offset 0."""
    defaults: dict[str, object] = {
        "anchor_start": 0,
        "anchor_end": len(anchor_text),
    }
    defaults.update(overrides)
    quote = PromotedQuote(
        user_id=user_id, source_entry_id=source_entry_id, anchor_text=anchor_text, **defaults
    )
    db_session.add(quote)
    await db_session.commit()
    await db_session.refresh(quote)
    return quote


# ── POST /journal/{entry_id}/promote ─────────────────────────────────────


@pytest.mark.asyncio
async def test_promote_requires_auth(async_client: AsyncClient) -> None:
    """Unauthenticated callers get 401."""
    resp = await async_client.post("/journal/1/promote", json={"anchor_start": 0, "anchor_end": 5})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_promote_slices_body_server_side(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The server slices anchor_text from the persisted body -- the client sends no text."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "The quick brown fox jumps")

    resp = await async_client.post(
        f"/journal/{entry.id}/promote",
        json={"anchor_start": 4, "anchor_end": 9},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert data["anchor_text"] == "quick"
    assert data["source_entry_id"] == entry.id
    assert data["anchor_start"] == 4
    assert data["anchor_end"] == 9
    assert data["pending"] is True
    assert data["stale"] is False
    assert "user_id" not in data


@pytest.mark.asyncio
async def test_promote_rejects_other_users_entry_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Promoting a span from an entry owned by another user 404s (enumeration-safe)."""
    _owner_headers, owner_id = await _signup(async_client, db_session, username="alice")
    other_headers, _other_id = await _signup(async_client, db_session, username="bob")
    entry = await _seed_entry(db_session, owner_id, "Some private body text")

    resp = await async_client.post(
        f"/journal/{entry.id}/promote",
        json={"anchor_start": 0, "anchor_end": 4},
        headers=other_headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_promote_rejects_soft_deleted_entry_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A soft-deleted entry is treated as gone."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "Deleted body", deleted_at=datetime.now(UTC))

    resp = await async_client.post(
        f"/journal/{entry.id}/promote",
        json={"anchor_start": 0, "anchor_end": 4},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_promote_rejects_missing_entry_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A nonexistent entry id 404s."""
    headers, _user_id = await _signup(async_client, db_session)
    resp = await async_client.post(
        "/journal/999999/promote",
        json={"anchor_start": 0, "anchor_end": 4},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_promote_rejects_span_past_body_length_422(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An anchor_end past the body's length is unprocessable."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "short body")

    resp = await async_client.post(
        f"/journal/{entry.id}/promote",
        json={"anchor_start": 0, "anchor_end": 10000},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_promote_rejects_span_over_1000_chars_422(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A span longer than PROMOTED_QUOTE_TEXT_MAX chars is unprocessable."""
    headers, user_id = await _signup(async_client, db_session)
    body = "x" * _OVER_MAX_BODY_LENGTH
    entry = await _seed_entry(db_session, user_id, body)

    resp = await async_client.post(
        f"/journal/{entry.id}/promote",
        json={"anchor_start": 0, "anchor_end": _OVER_MAX_SPAN_LENGTH},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_promote_rejects_inverted_span_422(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """anchor_end <= anchor_start is unprocessable (Pydantic-level)."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "abcdef")

    resp = await async_client.post(
        f"/journal/{entry.id}/promote",
        json={"anchor_start": 5, "anchor_end": 2},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ── DELETE /promotions/{id} ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_promotion_requires_auth(async_client: AsyncClient) -> None:
    """Unauthenticated callers get 401."""
    resp = await async_client.delete("/promotions/1")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_delete_promotion_removes_owned_quote(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The owner can delete their own quote; a second delete then 404s."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "Some body worth quoting")
    quote = await _seed_quote(db_session, user_id, entry.id, "Some body")

    resp = await async_client.delete(f"/promotions/{quote.id}", headers=headers)
    assert resp.status_code == HTTPStatus.NO_CONTENT

    resp_again = await async_client.delete(f"/promotions/{quote.id}", headers=headers)
    assert resp_again.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_delete_promotion_rejects_other_users_quote_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Deleting a quote owned by another user 404s."""
    _owner_headers, owner_id = await _signup(async_client, db_session, username="alice")
    other_headers, _other_id = await _signup(async_client, db_session, username="bob")
    entry = await _seed_entry(db_session, owner_id, "Body text here")
    quote = await _seed_quote(db_session, owner_id, entry.id, "Body text")

    resp = await async_client.delete(f"/promotions/{quote.id}", headers=other_headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── PATCH /promotions/{id} ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_patch_promotion_requires_auth(async_client: AsyncClient) -> None:
    """Unauthenticated callers get 401."""
    resp = await async_client.patch("/promotions/1", json={"included_in_entry_id": 1})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_patch_promotion_sets_and_clears_inclusion(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Setting included_in_entry_id flips pending False; clearing it flips pending True."""
    headers, user_id = await _signup(async_client, db_session)
    source_entry = await _seed_entry(db_session, user_id, "Source body text")
    target_entry = await _seed_entry(
        db_session,
        user_id,
        "Target reflection body",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level="week",
        reflection_scope_key="c1:w1",
    )
    quote = await _seed_quote(db_session, user_id, source_entry.id, "Source")

    resp = await async_client.patch(
        f"/promotions/{quote.id}",
        json={"included_in_entry_id": target_entry.id},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["pending"] is False

    resp_clear = await async_client.patch(
        f"/promotions/{quote.id}",
        json={"included_in_entry_id": None},
        headers=headers,
    )
    assert resp_clear.status_code == HTTPStatus.OK
    assert resp_clear.json()["pending"] is True


@pytest.mark.asyncio
async def test_patch_promotion_rejects_non_hierarchical_target_422(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A target entry that isn't tagged HIERARCHICAL_REFLECTION is unprocessable."""
    headers, user_id = await _signup(async_client, db_session)
    source_entry = await _seed_entry(db_session, user_id, "Source body text")
    freeform_target = await _seed_entry(
        db_session, user_id, "Freeform target", tag=JournalTag.FREEFORM
    )
    quote = await _seed_quote(db_session, user_id, source_entry.id, "Source")

    resp = await async_client.patch(
        f"/promotions/{quote.id}",
        json={"included_in_entry_id": freeform_target.id},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_patch_promotion_rejects_other_users_promotion_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Patching a quote owned by another user 404s."""
    _owner_headers, owner_id = await _signup(async_client, db_session, username="alice")
    other_headers, _other_id = await _signup(async_client, db_session, username="bob")
    source_entry = await _seed_entry(db_session, owner_id, "Source body text")
    target_entry = await _seed_entry(
        db_session,
        owner_id,
        "Target reflection body",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level="week",
        reflection_scope_key="c1:w1",
    )
    quote = await _seed_quote(db_session, owner_id, source_entry.id, "Source")

    resp = await async_client.patch(
        f"/promotions/{quote.id}",
        json={"included_in_entry_id": target_entry.id},
        headers=other_headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_patch_promotion_rejects_unowned_target_entry_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A target entry that doesn't exist (or isn't the caller's) 404s."""
    headers, user_id = await _signup(async_client, db_session)
    source_entry = await _seed_entry(db_session, user_id, "Source body text")
    quote = await _seed_quote(db_session, user_id, source_entry.id, "Source")

    resp = await async_client.patch(
        f"/promotions/{quote.id}",
        json={"included_in_entry_id": 999999},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_patch_promotion_rejects_empty_body_422(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An empty PATCH body is rejected -- included_in_entry_id is required."""
    headers, user_id = await _signup(async_client, db_session)
    source_entry = await _seed_entry(db_session, user_id, "Source body text")
    quote = await _seed_quote(db_session, user_id, source_entry.id, "Source")

    resp = await async_client.patch(f"/promotions/{quote.id}", json={}, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ── GET /journal/{entry_id}/promotions ───────────────────────────────────


@pytest.mark.asyncio
async def test_list_promotions_requires_auth(async_client: AsyncClient) -> None:
    """Unauthenticated callers get 401."""
    resp = await async_client.get("/journal/1/promotions")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_list_promotions_orders_by_anchor_start_then_id(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Returns a bare array ordered by (anchor_start, id), with no user_id leak."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "abcdefghijklmnopqrstuvwxyz")

    # Seeded out of anchor order; two quotes share anchor_start=5 to pin the id tiebreak.
    quote_c = await _seed_quote(db_session, user_id, entry.id, "j", anchor_start=9, anchor_end=10)
    quote_a1 = await _seed_quote(db_session, user_id, entry.id, "f", anchor_start=5, anchor_end=6)
    quote_a2 = await _seed_quote(db_session, user_id, entry.id, "g", anchor_start=5, anchor_end=6)
    quote_b = await _seed_quote(db_session, user_id, entry.id, "b", anchor_start=1, anchor_end=2)

    resp = await async_client.get(f"/journal/{entry.id}/promotions", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert isinstance(data, list)
    assert [item["id"] for item in data] == [
        quote_b.id,
        quote_a1.id,
        quote_a2.id,
        quote_c.id,
    ]
    for item in data:
        assert "user_id" not in item
    assert data[0] == {
        "id": quote_b.id,
        "source_entry_id": entry.id,
        "anchor_start": 1,
        "anchor_end": 2,
        "anchor_text": "b",
        "pending": True,
        "stale": False,
    }


@pytest.mark.asyncio
async def test_list_promotions_includes_folded_quotes(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A quote already folded into a reflection is still listed, with pending False."""
    headers, user_id = await _signup(async_client, db_session)
    source_entry = await _seed_entry(db_session, user_id, "Source body text")
    target_entry = await _seed_entry(
        db_session,
        user_id,
        "Target reflection body",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level="week",
        reflection_scope_key="c1:w1",
    )
    quote = await _seed_quote(
        db_session,
        user_id,
        source_entry.id,
        "Source",
        included_in_entry_id=target_entry.id,
    )

    resp = await async_client.get(f"/journal/{source_entry.id}/promotions", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert [item["id"] for item in data] == [quote.id]
    assert data[0]["pending"] is False


@pytest.mark.asyncio
async def test_list_promotions_empty_entry_returns_empty_list(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An entry with no promotions returns an empty array, not 404."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "No quotes taken from here")

    resp = await async_client.get(f"/journal/{entry.id}/promotions", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_promotions_rejects_other_users_entry_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Listing promotions on an entry owned by another user 404s (enumeration-safe).

    Checks the ownership-dependency's detail body, not just the status code --
    a route-not-found 404 would otherwise match by accident.
    """
    _owner_headers, owner_id = await _signup(async_client, db_session, username="alice")
    other_headers, _other_id = await _signup(async_client, db_session, username="bob")
    entry = await _seed_entry(db_session, owner_id, "Bob's private body text")
    await _seed_quote(db_session, owner_id, entry.id, "Bob's")

    resp = await async_client.get(f"/journal/{entry.id}/promotions", headers=other_headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "journal_entry_not_found"


@pytest.mark.asyncio
async def test_list_promotions_rejects_missing_entry_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A nonexistent entry id 404s with the ownership-dependency's detail body."""
    headers, _user_id = await _signup(async_client, db_session)
    resp = await async_client.get("/journal/999999/promotions", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "journal_entry_not_found"


@pytest.mark.asyncio
async def test_list_promotions_rejects_soft_deleted_entry_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A soft-deleted entry is treated as gone, with the ownership-dependency's detail."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "Deleted body", deleted_at=datetime.now(UTC))

    resp = await async_client.get(f"/journal/{entry.id}/promotions", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "journal_entry_not_found"


@pytest.mark.asyncio
async def test_list_promotions_isolated_by_entry(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A quote seeded on a different entry of the same user is not returned."""
    headers, user_id = await _signup(async_client, db_session)
    entry_a = await _seed_entry(db_session, user_id, "Entry A body")
    entry_b = await _seed_entry(db_session, user_id, "Entry B body")
    quote_a = await _seed_quote(db_session, user_id, entry_a.id, "Entry A")
    await _seed_quote(db_session, user_id, entry_b.id, "Entry B")

    resp = await async_client.get(f"/journal/{entry_a.id}/promotions", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert [item["id"] for item in resp.json()] == [quote_a.id]
