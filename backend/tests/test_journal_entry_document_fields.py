"""Tests for the JournalEntry document fields (journal-resonance-02)."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.journal_entry import EntryStatus, JournalEntry
from models.user import User


async def _signup(client: AsyncClient, username: str = "doc") -> dict[str, str]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


@pytest.mark.asyncio
async def test_new_entry_defaults_to_draft_with_no_title(async_client: AsyncClient) -> None:
    """A freshly created entry is a draft with a null title and an updated_at."""
    headers = await _signup(async_client)
    resp = await async_client.post("/journal/", json={"message": "First page."}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    body = resp.json()
    assert body["status"] == EntryStatus.DRAFT
    assert body["title"] is None
    assert body["updated_at"] is not None


@pytest.mark.asyncio
async def test_response_still_hides_user_id(async_client: AsyncClient) -> None:
    """The document fields are serialized; user_id stays excluded."""
    headers = await _signup(async_client, "hide")
    await async_client.post("/journal/", json={"message": "A page."}, headers=headers)
    resp = await async_client.get("/journal/", headers=headers)
    item = resp.json()["items"][0]
    assert {"title", "status", "updated_at"} <= item.keys()
    assert "user_id" not in item


@pytest.mark.asyncio
async def test_model_defaults(db_session: AsyncSession) -> None:
    """The model defaults status to draft and stamps updated_at."""
    user = User(email="m@example.com", password_hash="x")  # pragma: allowlist secret
    db_session.add(user)
    await db_session.flush()
    entry = JournalEntry(sender="user", user_id=user.id, message="body")
    db_session.add(entry)
    await db_session.commit()
    await db_session.refresh(entry)
    assert entry.status == EntryStatus.DRAFT
    assert entry.title is None
    assert entry.updated_at is not None


@pytest.mark.asyncio
async def test_finished_status_round_trips(db_session: AsyncSession) -> None:
    """The 'finished' status (what the migration backfills existing rows to) persists.

    The migration's NULL->finished backfill is exercised by the Postgres
    migration-drift gate; here we assert the value the backfill writes survives a
    write/read cycle through the model.
    """
    user = User(email="b@example.com", password_hash="x")  # pragma: allowlist secret
    db_session.add(user)
    await db_session.flush()
    entry = JournalEntry(
        sender="user", user_id=user.id, message="legacy", status=EntryStatus.FINISHED
    )
    db_session.add(entry)
    await db_session.commit()

    row = await db_session.get(JournalEntry, entry.id)
    assert row is not None
    assert row.status == EntryStatus.FINISHED


@pytest.mark.asyncio
async def test_updated_at_advances_on_edit(db_session: AsyncSession) -> None:
    """updated_at advances when the entry is mutated and flushed (onupdate)."""
    user = User(email="u@example.com", password_hash="x")  # pragma: allowlist secret
    db_session.add(user)
    await db_session.flush()
    entry = JournalEntry(sender="user", user_id=user.id, message="v1")
    db_session.add(entry)
    await db_session.commit()
    await db_session.refresh(entry)
    original = entry.updated_at

    entry.title = "Now titled"
    await db_session.commit()
    await db_session.refresh(entry)
    assert entry.updated_at > original
