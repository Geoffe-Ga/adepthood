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
from cryptography.fernet import Fernet
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.journal_entry import EntryStatus, JournalEntry, JournalTag
from models.promoted_quote import PROMOTED_QUOTE_TEXT_MAX, PromotedQuote
from models.user import User
from services import journal_encryption as je

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


# ── Unicode code-point offsets (regression guard; Python indexing is code-point-native) ──

_EMOJI = "\U0001f600"


@pytest.mark.asyncio
async def test_promote_slices_exact_phrase_after_leading_emoji(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A code-point span after a leading astral character slices exactly."""
    headers, user_id = await _signup(async_client, db_session)
    body = f"{_EMOJI}went for a daily walk."
    entry = await _seed_entry(db_session, user_id, body)

    resp = await async_client.post(
        f"/journal/{entry.id}/promote",
        json={"anchor_start": 1, "anchor_end": 17},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["anchor_text"] == "went for a daily"


@pytest.mark.asyncio
async def test_promote_accepts_anchor_end_at_code_point_length_of_emoji_final_body(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An anchor_end equal to the body's code-point length (trailing emoji) is accepted."""
    headers, user_id = await _signup(async_client, db_session)
    body = f"went for a walk{_EMOJI}"
    entry = await _seed_entry(db_session, user_id, body)
    assert len(body) == 16

    resp = await async_client.post(
        f"/journal/{entry.id}/promote",
        json={"anchor_start": 11, "anchor_end": len(body)},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["anchor_text"] == f"walk{_EMOJI}"


@pytest.mark.asyncio
async def test_promote_rejects_anchor_end_one_past_code_point_length_422(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An anchor_end one past the body's code-point length is anchor_out_of_range."""
    headers, user_id = await _signup(async_client, db_session)
    body = f"went for a walk{_EMOJI}"
    entry = await _seed_entry(db_session, user_id, body)

    resp = await async_client.post(
        f"/journal/{entry.id}/promote",
        json={"anchor_start": 11, "anchor_end": len(body) + 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "anchor_out_of_range"


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


# ── GET /promotions (every quote, across entries) ────────────────────────

_LIST_ALL_URL = "/promotions"
_PAGED_QUOTE_COUNT = 5
_PAGE_LIMIT = 2
_OVER_MAX_LIMIT = 201
_OVER_MAX_OFFSET = 1_000_001


def _moment(minutes: int) -> datetime:
    """A fixed, distinct ``created_at`` so ordering never rides on insert speed."""
    return datetime(2026, 3, 1, 9, 0, tzinfo=UTC).replace(minute=minutes)


async def _seed_review(db_session: AsyncSession, user_id: int, title: str) -> JournalEntry:
    """A live hierarchical reflection -- the only kind of entry a quote folds into."""
    return await _seed_entry(
        db_session,
        user_id,
        "The week, looked back on",
        title=title,
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level="week",
        reflection_scope_key="c1:w1",
    )


@pytest.mark.asyncio
async def test_list_all_promotions_requires_auth(async_client: AsyncClient) -> None:
    """Unauthenticated callers get 401."""
    resp = await async_client.get(_LIST_ALL_URL)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_list_all_promotions_returns_callers_quotes_across_entries_newest_first(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Every live quote of the caller's, from every entry, newest first, with its sources."""
    headers, alice_id = await _signup(async_client, db_session)
    _bob_headers, bob_id = await _signup(async_client, db_session, username="bob")
    first = await _seed_entry(db_session, alice_id, "A morning of rain", title="Rain")
    second = await _seed_entry(db_session, alice_id, "An evening of wind", title="Wind")
    review = await _seed_review(db_session, alice_id, "The windy week")
    gone = await _seed_entry(db_session, alice_id, "Deleted page", deleted_at=datetime.now(UTC))
    bobs = await _seed_entry(db_session, bob_id, "Bob's page", title="Bob")

    oldest = await _seed_quote(db_session, alice_id, first.id, "A morning", created_at=_moment(1))
    middle = await _seed_quote(
        db_session,
        alice_id,
        second.id,
        "An evening",
        created_at=_moment(2),
        included_in_entry_id=review.id,
    )
    newest = await _seed_quote(
        db_session,
        alice_id,
        first.id,
        "rain",
        anchor_start=13,
        anchor_end=17,
        created_at=_moment(3),
    )
    await _seed_quote(db_session, alice_id, gone.id, "Deleted", created_at=_moment(4))
    await _seed_quote(db_session, bob_id, bobs.id, "Bob's", created_at=_moment(5))

    resp = await async_client.get(_LIST_ALL_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    items = body["items"]
    assert [item["id"] for item in items] == [newest.id, middle.id, oldest.id]
    assert body["total"] == 3
    assert body["has_more"] is False
    assert [item["source_title"] for item in items] == ["Rain", "Wind", "Rain"]
    assert items[1]["source_timestamp"] == second.timestamp.isoformat().replace("+00:00", "Z")
    assert items[1]["included_in_entry_id"] == review.id
    assert items[1]["included_in_title"] == "The windy week"
    assert items[1]["pending"] is False
    for other in (items[0], items[2]):
        assert other["included_in_entry_id"] is None
        assert other["included_in_title"] is None
        assert other["pending"] is True
    assert items[0]["anchor_start"] == 13
    assert items[0]["anchor_end"] == 17
    assert items[0]["anchor_text"] == "rain"
    assert items[0]["source_entry_id"] == first.id
    for item in items:
        assert item["stale"] is False
        assert "user_id" not in item


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "expected"),
    [("pending", ["waiting"]), ("included", ["used"]), ("all", ["used", "waiting"]), (None, None)],
)
async def test_list_all_promotions_filters_by_status(
    async_client: AsyncClient,
    db_session: AsyncSession,
    status: str | None,
    expected: list[str] | None,
) -> None:
    """``status`` narrows to pending or folded quotes; omitted, it means ``all``."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "waiting and used")
    review = await _seed_review(db_session, user_id, "A review")
    await _seed_quote(db_session, user_id, entry.id, "waiting", created_at=_moment(1))
    await _seed_quote(
        db_session,
        user_id,
        entry.id,
        "used",
        created_at=_moment(2),
        included_in_entry_id=review.id,
    )

    params = {} if status is None else {"status": status}
    resp = await async_client.get(_LIST_ALL_URL, params=params, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    texts = [item["anchor_text"] for item in resp.json()["items"]]
    assert texts == (expected if expected is not None else ["used", "waiting"])
    assert resp.json()["total"] == len(texts)


@pytest.mark.asyncio
async def test_list_all_promotions_rejects_unknown_status_422(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A status outside pending/included/all is a 422, not a silent ``all``."""
    headers, _user_id = await _signup(async_client, db_session)
    resp = await async_client.get(_LIST_ALL_URL, params={"status": "stale"}, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_list_all_promotions_breaks_created_at_ties_by_id_desc(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Quotes promoted in the same instant order by id, newest id first."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "abc")
    first = await _seed_quote(db_session, user_id, entry.id, "a", created_at=_moment(7))
    second = await _seed_quote(db_session, user_id, entry.id, "b", created_at=_moment(7))
    third = await _seed_quote(db_session, user_id, entry.id, "c", created_at=_moment(7))

    resp = await async_client.get(_LIST_ALL_URL, headers=headers)

    assert [item["id"] for item in resp.json()["items"]] == [third.id, second.id, first.id]


@pytest.mark.asyncio
async def test_list_all_promotions_pages_across_a_boundary(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``total`` counts every row and ``has_more`` flips false on the last page."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "abcde")
    quotes = [
        await _seed_quote(db_session, user_id, entry.id, letter, created_at=_moment(minute))
        for minute, letter in enumerate("abcde", start=1)
    ]
    newest_first = [quote.id for quote in reversed(quotes)]

    pages = []
    for offset in range(0, _PAGED_QUOTE_COUNT, _PAGE_LIMIT):
        resp = await async_client.get(
            _LIST_ALL_URL, params={"limit": _PAGE_LIMIT, "offset": offset}, headers=headers
        )
        assert resp.status_code == HTTPStatus.OK, resp.text
        pages.append(resp.json())

    assert [page["total"] for page in pages] == [_PAGED_QUOTE_COUNT] * 3
    assert [page["has_more"] for page in pages] == [True, True, False]
    assert [item["id"] for page in pages for item in page["items"]] == newest_first


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "params",
    [{"limit": 0}, {"limit": _OVER_MAX_LIMIT}, {"offset": -1}, {"offset": _OVER_MAX_OFFSET}],
)
async def test_list_all_promotions_rejects_out_of_bounds_page_422(
    async_client: AsyncClient, db_session: AsyncSession, params: dict[str, int]
) -> None:
    """The page window is bounded both ways: limit 1..200, offset 0..MAX_PAGE_OFFSET."""
    headers, _user_id = await _signup(async_client, db_session)
    resp = await async_client.get(_LIST_ALL_URL, params=params, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_list_all_promotions_accepts_the_maximum_page(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The bounds are inclusive: limit 200 and the maximum offset are both served."""
    headers, _user_id = await _signup(async_client, db_session)
    resp = await async_client.get(
        _LIST_ALL_URL,
        params={"limit": _OVER_MAX_LIMIT - 1, "offset": _OVER_MAX_OFFSET - 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json() == {"items": [], "total": 0, "has_more": False}


@pytest.mark.asyncio
async def test_list_all_promotions_keeps_a_quote_whose_review_was_deleted(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A deleted review hides its title but not the quote, which still reads as used."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "kept")
    review = await _seed_review(db_session, user_id, "A review I deleted")
    quote = await _seed_quote(db_session, user_id, entry.id, "kept", included_in_entry_id=review.id)
    review.deleted_at = datetime.now(UTC)
    db_session.add(review)
    await db_session.commit()

    resp = await async_client.get(_LIST_ALL_URL, params={"status": "included"}, headers=headers)

    items = resp.json()["items"]
    assert [item["id"] for item in items] == [quote.id]
    assert items[0]["included_in_entry_id"] == review.id
    assert items[0]["included_in_title"] is None
    assert items[0]["pending"] is False


@pytest.mark.asyncio
async def test_list_all_promotions_excludes_soft_deleted_sources_from_total(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A quote from a deleted entry is gone from both the page and its count."""
    headers, user_id = await _signup(async_client, db_session)
    live = await _seed_entry(db_session, user_id, "live")
    gone = await _seed_entry(db_session, user_id, "gone", deleted_at=datetime.now(UTC))
    kept = await _seed_quote(db_session, user_id, live.id, "live")
    await _seed_quote(db_session, user_id, gone.id, "gone")

    resp = await async_client.get(_LIST_ALL_URL, params={"limit": 1}, headers=headers)

    assert resp.json() == {
        "items": [resp.json()["items"][0]],
        "total": 1,
        "has_more": False,
    }
    assert resp.json()["items"][0]["id"] == kept.id


@pytest.mark.asyncio
async def test_list_all_promotions_carries_stale(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A quote whose passage was edited away is listed with ``stale`` true."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "rewritten")
    await _seed_quote(db_session, user_id, entry.id, "original", stale=True)

    resp = await async_client.get(_LIST_ALL_URL, headers=headers)

    assert resp.json()["items"][0]["stale"] is True
    assert resp.json()["items"][0]["source_title"] is None


@pytest.mark.asyncio
async def test_list_all_promotions_decrypts_for_the_owner(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With encryption on, the quote and both titles come back as the owner's plaintext."""
    monkeypatch.setenv("JOURNAL_ENCRYPTION_KEYS", Fernet.generate_key().decode())
    je.reset_cache()
    try:
        headers, user_id = await _signup(async_client, db_session)
        entry = await _seed_entry(db_session, user_id, "Grief was anger", title="A hard day")
        review = await _seed_review(db_session, user_id, "Looking back")
        await _seed_quote(db_session, user_id, entry.id, "Grief", included_in_entry_id=review.id)
        raw = (await db_session.execute(text("SELECT anchor_text FROM promotedquote"))).scalar_one()
        assert "Grief" not in raw

        resp = await async_client.get(_LIST_ALL_URL, headers=headers)

        item = resp.json()["items"][0]
        assert item["anchor_text"] == "Grief"
        assert item["source_title"] == "A hard day"
        assert item["included_in_title"] == "Looking back"
    finally:
        je.reset_cache()
