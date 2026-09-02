"""Tests for the Voice Drafts listing — a cross-entry shelf of expanded essays.

The listing is a read-only projection over :class:`Marginalia` rows whose
``essay`` is set.  Nothing is generated on read, so these tests also pin the
"no regeneration path" constraint with a counting LLM seam.
"""

from __future__ import annotations

from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.journal_entry import JournalClassification, JournalEntry
from models.marginalia import Marginalia, MarginaliaKind, MarginaliaStatus
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse

_BODY = "I walked by the river and the willow bent without breaking."

_DRAFTS_URL = "/journal/voice-drafts"


async def _signup(client: AsyncClient, username: str = "drafts") -> tuple[dict[str, str], int]:
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
    session: AsyncSession,
    user_id: int,
    *,
    classification: JournalClassification | None = None,
) -> int:
    """Persist one journal entry for ``user_id`` and return its id."""
    entry = JournalEntry(sender="user", user_id=user_id, message=_BODY)
    if classification is not None:
        entry.classification = classification
    session.add(entry)
    await session.flush()
    await session.commit()
    assert entry.id is not None
    return entry.id


async def _seed_draft(  # noqa: PLR0913 — each knob pins one listing predicate
    session: AsyncSession,
    *,
    user_id: int,
    entry_id: int,
    essay: str | None = "A warm letter.",
    generated_at: datetime | None = None,
    status: MarginaliaStatus = MarginaliaStatus.ACTIVE,
    anchor_text: str = "I walk",
) -> int:
    """Persist one margin note (expanded unless ``essay`` is ``None``)."""
    stamped = generated_at if essay is not None else None
    note = Marginalia(
        journal_entry_id=entry_id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=6,
        anchor_text=anchor_text,
        note="A beginning.",
        essay=essay,
        essay_generated_at=stamped,
        status=status,
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    assert note.id is not None
    return note.id


async def _seed_user_with_draft(
    client: AsyncClient,
    session: AsyncSession,
    username: str,
    *,
    generated_at: datetime,
) -> tuple[dict[str, str], int, int]:
    """Sign a user up and give them one expanded draft; return headers, uid, note id."""
    headers, user_id = await _signup(client, username)
    entry_id = await _seed_entry(session, user_id)
    note_id = await _seed_draft(
        session, user_id=user_id, entry_id=entry_id, generated_at=generated_at
    )
    return headers, user_id, note_id


class _CountingLLM:
    """Patches the LLM seam, returning fixed text and counting calls."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.calls = 0

    async def __call__(
        self, prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        self.calls += 1
        return LLMResponse(
            text=self.text,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )


_OLDER = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
_NEWER = datetime(2024, 6, 1, 12, 0, tzinfo=UTC)


@pytest.mark.asyncio
async def test_voice_drafts_lists_expanded_essays_newest_first(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The shelf answers 200 at its literal path and orders newest essay first.

    A 422 here means the route was declared after ``GET /{entry_id}`` and is
    shadowed by its ``RowIdPath`` converter.
    """
    headers, user_id = await _signup(async_client)
    older_entry = await _seed_entry(db_session, user_id)
    newer_entry = await _seed_entry(db_session, user_id)
    older_id = await _seed_draft(
        db_session, user_id=user_id, entry_id=older_entry, generated_at=_OLDER
    )
    newer_id = await _seed_draft(
        db_session, user_id=user_id, entry_id=newer_entry, generated_at=_NEWER
    )

    resp = await async_client.get(_DRAFTS_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["total"] == 2
    assert body["has_more"] is False
    assert [item["marginalia_id"] for item in body["items"]] == [newer_id, older_id]


@pytest.mark.asyncio
async def test_unexpanded_marginalia_never_lists(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A margin note with no essay is not a draft and never appears."""
    headers, user_id = await _signup(async_client, "unexpanded")
    entry_id = await _seed_entry(db_session, user_id)
    expanded = await _seed_draft(
        db_session, user_id=user_id, entry_id=entry_id, generated_at=_NEWER
    )
    await _seed_draft(db_session, user_id=user_id, entry_id=entry_id, essay=None)

    body = (await async_client.get(_DRAFTS_URL, headers=headers)).json()

    assert body["total"] == 1
    assert [item["marginalia_id"] for item in body["items"]] == [expanded]


@pytest.mark.asyncio
async def test_soft_deleted_entry_drops_its_draft(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Deleting an entry withdraws its draft from the shelf (BUG-JOURNAL-007).

    Soft deletion does not cascade to marginalia, so a listing scoped only by
    the denormalized ``Marginalia.user_id`` would republish writing the user
    deleted.
    """
    headers, user_id = await _signup(async_client, "softdel")
    entry_id = await _seed_entry(db_session, user_id)
    await _seed_draft(db_session, user_id=user_id, entry_id=entry_id, generated_at=_NEWER)
    assert (await async_client.get(_DRAFTS_URL, headers=headers)).json()["total"] == 1

    deleted = await async_client.delete(f"/journal/{entry_id}", headers=headers)
    assert deleted.status_code == HTTPStatus.NO_CONTENT

    body = (await async_client.get(_DRAFTS_URL, headers=headers)).json()
    assert body["total"] == 0
    assert body["items"] == []


@pytest.mark.asyncio
async def test_drifted_owner_column_does_not_leak_another_users_draft(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The parent entry's owner is authoritative, not the denormalized column.

    The model defers enforcement of ``Marginalia.user_id`` to the endpoint
    layer, so a drifted row must not be readable by whoever that column names.
    """
    alice_headers, alice_id = await _signup(async_client, "alice_drift")
    _bob_headers, bob_id = await _signup(async_client, "bob_drift")
    bobs_entry = await _seed_entry(db_session, bob_id)
    # Drifted: the column says Alice, the parent entry says Bob.
    await _seed_draft(db_session, user_id=alice_id, entry_id=bobs_entry, generated_at=_NEWER)

    body = (await async_client.get(_DRAFTS_URL, headers=alice_headers)).json()

    assert body["total"] == 0
    assert body["items"] == []


@pytest.mark.asyncio
async def test_cross_user_isolation_leaks_no_rows_and_no_count(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Each writer sees only their own shelf, and ``total`` does not leak."""
    alice_headers, _alice_id, alice_note = await _seed_user_with_draft(
        async_client, db_session, "alice_iso", generated_at=_NEWER
    )
    bob_headers, _bob_id, bob_note = await _seed_user_with_draft(
        async_client, db_session, "bob_iso", generated_at=_OLDER
    )

    alice_body = (await async_client.get(_DRAFTS_URL, headers=alice_headers)).json()
    bob_body = (await async_client.get(_DRAFTS_URL, headers=bob_headers)).json()

    assert alice_body["total"] == 1
    assert [item["marginalia_id"] for item in alice_body["items"]] == [alice_note]
    assert bob_body["total"] == 1
    assert [item["marginalia_id"] for item in bob_body["items"]] == [bob_note]


@pytest.mark.asyncio
async def test_tied_timestamps_page_stably(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Drafts sharing one timestamp page disjointly via the id tiebreak."""
    headers, user_id = await _signup(async_client, "tied")
    entry_id = await _seed_entry(db_session, user_id)
    first = await _seed_draft(db_session, user_id=user_id, entry_id=entry_id, generated_at=_NEWER)
    second = await _seed_draft(db_session, user_id=user_id, entry_id=entry_id, generated_at=_NEWER)

    page_one = (await async_client.get(f"{_DRAFTS_URL}?limit=1&offset=0", headers=headers)).json()
    page_two = (await async_client.get(f"{_DRAFTS_URL}?limit=1&offset=1", headers=headers)).json()

    assert page_one["total"] == 2
    assert page_one["has_more"] is True
    assert page_two["has_more"] is False
    assert [item["marginalia_id"] for item in page_one["items"]] == [second]
    assert [item["marginalia_id"] for item in page_two["items"]] == [first]


@pytest.mark.asyncio
async def test_offset_past_the_end_returns_an_empty_page(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An out-of-range offset is an empty page, not an error, and keeps ``total``."""
    headers, _user_id, _note_id = await _seed_user_with_draft(
        async_client, db_session, "past_end", generated_at=_NEWER
    )

    resp = await async_client.get(f"{_DRAFTS_URL}?limit=10&offset=50", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["items"] == []
    assert body["total"] == 1
    assert body["has_more"] is False


@pytest.mark.asyncio
async def test_empty_shelf_is_200_not_404(async_client: AsyncClient) -> None:
    """A writer with no expanded essays gets an empty shelf, never an error."""
    headers, _user_id = await _signup(async_client, "empty")

    resp = await async_client.get(_DRAFTS_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"items": [], "total": 0, "has_more": False}


@pytest.mark.asyncio
async def test_item_shape_carries_the_draft_and_omits_user_id(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Each item names its note, its parent entry, and the letter itself."""
    headers, user_id = await _signup(async_client, "shape")
    entry_id = await _seed_entry(db_session, user_id)
    note_id = await _seed_draft(
        db_session,
        user_id=user_id,
        entry_id=entry_id,
        essay="A letter about beginnings.",
        generated_at=_NEWER,
        anchor_text="the willow",
    )

    item = (await async_client.get(_DRAFTS_URL, headers=headers)).json()["items"][0]

    assert item["marginalia_id"] == note_id
    assert item["journal_entry_id"] == entry_id
    assert item["kind"] == MarginaliaKind.SYMBOL
    assert item["anchor_text"] == "the willow"
    assert item["essay"] == "A letter about beginnings."
    assert item["essay_generated_at"] is not None
    assert "user_id" not in item
    assert "id" not in item


@pytest.mark.asyncio
async def test_stale_marginalia_still_lists(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A drifted anchor does not un-write the letter it produced."""
    headers, user_id = await _signup(async_client, "stale")
    entry_id = await _seed_entry(db_session, user_id)
    note_id = await _seed_draft(
        db_session,
        user_id=user_id,
        entry_id=entry_id,
        generated_at=_NEWER,
        status=MarginaliaStatus.STALE,
    )

    body = (await async_client.get(_DRAFTS_URL, headers=headers)).json()

    assert [item["marginalia_id"] for item in body["items"]] == [note_id]


@pytest.mark.asyncio
async def test_intimate_parent_draft_still_lists(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An INTIMATE parent does not hide the writer's own letter from the writer.

    Retrieval is not egress: the same essay is already returned by
    ``GET /journal/{entry_id}/marginalia`` today.
    """
    headers, user_id = await _signup(async_client, "intimate")
    entry_id = await _seed_entry(db_session, user_id, classification=JournalClassification.INTIMATE)
    note_id = await _seed_draft(db_session, user_id=user_id, entry_id=entry_id, generated_at=_NEWER)

    body = (await async_client.get(_DRAFTS_URL, headers=headers)).json()

    assert [item["marginalia_id"] for item in body["items"]] == [note_id]


@pytest.mark.asyncio
async def test_listing_makes_zero_llm_calls(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reading the shelf never regenerates: the LLM seam is untouched."""
    headers, _user_id, _note_id = await _seed_user_with_draft(
        async_client, db_session, "nollm", generated_at=_NEWER
    )
    spy = _CountingLLM("should never be called")
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    resp = await async_client.get(_DRAFTS_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert spy.calls == 0


@pytest.mark.asyncio
async def test_voice_drafts_requires_authentication(async_client: AsyncClient) -> None:
    """The shelf is owner-only; an anonymous caller is rejected."""
    resp = await async_client.get(_DRAFTS_URL)

    assert resp.status_code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}
