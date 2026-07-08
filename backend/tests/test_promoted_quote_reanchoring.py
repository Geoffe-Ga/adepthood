"""Tests for re-anchoring (or stale-marking) promoted quotes on entry edit."""

from __future__ import annotations

from http import HTTPStatus
from typing import cast

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.journal_entry import JournalEntry, JournalTag
from models.promoted_quote import PromotedQuote

_BODY = "I walked by the river and the willow bent without breaking."
_ANCHOR = "the willow"
_ANCHOR_START = _BODY.index(_ANCHOR)
_ANCHOR_END = _ANCHOR_START + len(_ANCHOR)


async def _signup(client: AsyncClient, username: str = "quoter") -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    return {"Authorization": f"Bearer {payload['token']}"}, int(payload["user_id"])


async def _seed_entry(
    session: AsyncSession, user_id: int, message: str = _BODY, **overrides: object
) -> JournalEntry:
    """Create and persist a user-authored JournalEntry."""
    defaults: dict[str, object] = {"sender": "user"}
    defaults.update(overrides)
    entry = JournalEntry(user_id=user_id, message=message, **defaults)
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    assert entry.id is not None
    return entry


async def _seed_quote(
    session: AsyncSession,
    user_id: int,
    source_entry_id: int | None,
    anchor_text: str = _ANCHOR,
    anchor_start: int | None = None,
    **overrides: object,
) -> PromotedQuote:
    """Create and persist a PromotedQuote anchored to ``anchor_text`` in ``_BODY``.

    ``source_entry_id`` is accepted as ``int | None`` for the caller's convenience
    (a freshly refreshed ``entry.id`` is typed nullable) and narrowed here.
    """
    start = _BODY.index(anchor_text) if anchor_start is None else anchor_start
    defaults: dict[str, object] = {
        "anchor_start": start,
        "anchor_end": start + len(anchor_text),
    }
    defaults.update(overrides)
    quote = PromotedQuote(
        user_id=user_id,
        source_entry_id=cast("int", source_entry_id),
        anchor_text=anchor_text,
        **defaults,
    )
    session.add(quote)
    await session.commit()
    await session.refresh(quote)
    assert quote.id is not None
    return quote


@pytest.mark.asyncio
async def test_edit_before_anchor_shifts_offsets_and_stays_active(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Prepending text before the anchor re-anchors it to the shifted offset."""
    headers, user_id = await _signup(async_client, "before")
    entry = await _seed_entry(db_session, user_id)
    quote = await _seed_quote(db_session, user_id, entry.id)
    new_body = "Yesterday: " + _BODY

    resp = await async_client.patch(
        f"/journal/{entry.id}", json={"message": new_body}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK

    reloaded = await db_session.get(PromotedQuote, quote.id)
    assert reloaded is not None
    assert reloaded.anchor_start == new_body.index(_ANCHOR)
    assert reloaded.anchor_end == reloaded.anchor_start + len(_ANCHOR)
    assert reloaded.anchor_text == _ANCHOR
    assert reloaded.stale is False


@pytest.mark.asyncio
async def test_edit_after_anchor_keeps_offsets_via_fast_path(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Appending text after the anchor keeps the original offsets (fast path)."""
    headers, user_id = await _signup(async_client, "after")
    entry = await _seed_entry(db_session, user_id)
    quote = await _seed_quote(db_session, user_id, entry.id)
    new_body = _BODY + " And then it was still."

    resp = await async_client.patch(
        f"/journal/{entry.id}", json={"message": new_body}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK

    reloaded = await db_session.get(PromotedQuote, quote.id)
    assert reloaded is not None
    assert reloaded.anchor_start == _ANCHOR_START
    assert reloaded.anchor_end == _ANCHOR_END
    assert reloaded.stale is False


@pytest.mark.asyncio
async def test_edit_inside_anchor_marks_stale_with_offsets_unchanged(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Mutating the spanned characters goes stale, leaving the offsets untouched."""
    headers, user_id = await _signup(async_client, "inside")
    entry = await _seed_entry(db_session, user_id)
    quote = await _seed_quote(db_session, user_id, entry.id)
    new_body = _BODY.replace("the willow", "the oak")

    resp = await async_client.patch(
        f"/journal/{entry.id}", json={"message": new_body}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK

    reloaded = await db_session.get(PromotedQuote, quote.id)
    assert reloaded is not None
    assert reloaded.anchor_start == _ANCHOR_START
    assert reloaded.anchor_end == _ANCHOR_END
    assert reloaded.stale is True


@pytest.mark.asyncio
async def test_deleting_anchor_passage_marks_stale(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Removing the anchored passage entirely goes stale, offsets left unchanged."""
    headers, user_id = await _signup(async_client, "deleted")
    entry = await _seed_entry(db_session, user_id)
    quote = await _seed_quote(db_session, user_id, entry.id)

    resp = await async_client.patch(
        f"/journal/{entry.id}",
        json={"message": "An entirely different entry today."},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK

    reloaded = await db_session.get(PromotedQuote, quote.id)
    assert reloaded is not None
    assert reloaded.anchor_start == _ANCHOR_START
    assert reloaded.anchor_end == _ANCHOR_END
    assert reloaded.stale is True


@pytest.mark.asyncio
async def test_included_quote_untouched_by_source_edit(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A quote already folded into a reflection is left alone by a source-body edit."""
    headers, user_id = await _signup(async_client, "included")
    entry = await _seed_entry(db_session, user_id)
    target = await _seed_entry(
        db_session,
        user_id,
        "Target reflection body",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level="week",
        reflection_scope_key="c1:w1",
    )
    quote = await _seed_quote(db_session, user_id, entry.id, included_in_entry_id=target.id)

    resp = await async_client.patch(
        f"/journal/{entry.id}",
        json={"message": "An entirely different entry today."},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK

    reloaded = await db_session.get(PromotedQuote, quote.id)
    assert reloaded is not None
    assert reloaded.anchor_start == _ANCHOR_START
    assert reloaded.anchor_end == _ANCHOR_END
    assert reloaded.anchor_text == _ANCHOR
    assert reloaded.stale is False


@pytest.mark.asyncio
async def test_same_value_patch_leaves_quote_untouched(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """PATCHing the identical message leaves the quote's anchor and stale flag untouched."""
    headers, user_id = await _signup(async_client, "samevalue")
    entry = await _seed_entry(db_session, user_id)
    quote = await _seed_quote(db_session, user_id, entry.id)

    resp = await async_client.patch(
        f"/journal/{entry.id}", json={"message": _BODY}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK

    reloaded = await db_session.get(PromotedQuote, quote.id)
    assert reloaded is not None
    assert reloaded.anchor_start == _ANCHOR_START
    assert reloaded.anchor_end == _ANCHOR_END
    assert reloaded.stale is False


@pytest.mark.asyncio
async def test_single_edit_produces_mixed_outcomes_across_quotes(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One edit can re-anchor one quote while marking a second one stale."""
    headers, user_id = await _signup(async_client, "mixed")
    entry = await _seed_entry(db_session, user_id)
    quote_a = await _seed_quote(db_session, user_id, entry.id, anchor_text=_ANCHOR)
    other_anchor = "without breaking"
    quote_b = await _seed_quote(db_session, user_id, entry.id, anchor_text=other_anchor)
    new_body = "Yesterday: I walked by the river and the willow bent."

    resp = await async_client.patch(
        f"/journal/{entry.id}", json={"message": new_body}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK

    reloaded_a = await db_session.get(PromotedQuote, quote_a.id)
    reloaded_b = await db_session.get(PromotedQuote, quote_b.id)
    assert reloaded_a is not None
    assert reloaded_b is not None
    assert reloaded_a.anchor_start == new_body.index(_ANCHOR)
    assert reloaded_a.anchor_end == reloaded_a.anchor_start + len(_ANCHOR)
    assert reloaded_b.anchor_start == _BODY.index(other_anchor)
    assert reloaded_b.anchor_end == _BODY.index(other_anchor) + len(other_anchor)
    assert reloaded_a.stale is False
    assert reloaded_b.stale is True


@pytest.mark.asyncio
async def test_stale_quote_stays_stale_after_passage_returns(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Once a quote goes stale, restoring the original passage does not revive it."""
    headers, user_id = await _signup(async_client, "stalestays")
    entry = await _seed_entry(db_session, user_id)
    quote = await _seed_quote(db_session, user_id, entry.id)

    removed = await async_client.patch(
        f"/journal/{entry.id}",
        json={"message": "An entirely different entry today."},
        headers=headers,
    )
    assert removed.status_code == HTTPStatus.OK

    restored = await async_client.patch(
        f"/journal/{entry.id}", json={"message": _BODY}, headers=headers
    )
    assert restored.status_code == HTTPStatus.OK

    reloaded = await db_session.get(PromotedQuote, quote.id)
    assert reloaded is not None
    assert reloaded.anchor_start == _ANCHOR_START
    assert reloaded.anchor_end == _ANCHOR_END
    assert reloaded.stale is True


@pytest.mark.asyncio
async def test_duplicate_anchor_text_reanchors_to_first_occurrence(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A body containing the anchor text twice re-anchors to the first occurrence."""
    headers, user_id = await _signup(async_client, "duplicate")
    entry = await _seed_entry(db_session, user_id)
    quote = await _seed_quote(db_session, user_id, entry.id)
    new_body = f"{_ANCHOR} ... and again {_ANCHOR}."

    resp = await async_client.patch(
        f"/journal/{entry.id}", json={"message": new_body}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK

    reloaded = await db_session.get(PromotedQuote, quote.id)
    assert reloaded is not None
    assert reloaded.anchor_start == 0
    assert reloaded.anchor_end == len(_ANCHOR)
    assert reloaded.stale is False
