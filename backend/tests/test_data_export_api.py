"""End-to-end contract for ``GET /users/me/export`` — take your writing with you.

GDPR Art. 20 asks for portability; a journal-first product asking people to
trust it with their most private sentences owes the same thing for its own
reasons. These tests pin the observable half of that promise: the route exists,
it answers only for the caller, it emits what the user wrote rather than what
the database stores, it keeps streaming past the size where a single buffered
response would stop working, and the fact that an export happened is recorded
without any of what it contained.

The exhaustive "which tables are in scope" half lives in
``test_data_export_manifest.py``, which drives the schema itself rather than a
hand-maintained list.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import Any

import pytest
from cryptography.fernet import Fernet
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from domain.data_export import EXPORT_PAGE_SIZE
from models.journal_entry import JournalEntry
from services import journal_encryption as je
from services.data_export import ExportSubject, stream_json_export

_EXPORT_PATH = "/users/me/export"
_JOURNAL_MARKDOWN_PATH = "/users/me/export/journal.md"

_PASSWORD = "securepassword123"  # pragma: allowlist secret

# The marker real ciphertext carries. Spelled out rather than imported from the
# private constant so this file pins the shape an export must never contain.
_CIPHERTEXT_MARKER = "enc::v1::"

_MINE = "The sentence I would least like a database dump to be able to read."
_MY_TITLE = "What I could not say out loud"
_THEIRS = "A stranger's confession, which is none of my business."

# The one log line an export is allowed to emit, matched exactly so a future
# line that narrates more than a count cannot hide behind it.
_EXPORT_LOG_EVENT = "data_exported"


@pytest.fixture
def keyed(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Configure a throwaway encryption key for the duration of one test.

    The key registry is process-cached on purpose (rotation is a deploy-time
    operation), so it is reset on both sides or later tests read the wrong
    answer.
    """
    monkeypatch.setenv(je.KEYS_ENV_VAR, Fernet.generate_key().decode())
    je.reset_cache()
    yield
    je.reset_cache()


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create a user; return ``(auth headers, user id)``."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user_id"]


async def _write_entry(client: AsyncClient, headers: dict[str, str], message: str) -> int:
    """Write one journal entry through the real write path; return its id."""
    resp = await client.post(
        "/journal/",
        json={"message": message, "classification": "personal"},
        headers=headers,
    )
    assert resp.status_code in {HTTPStatus.OK, HTTPStatus.CREATED}
    return int(resp.json()["id"])


async def _title_entry(client: AsyncClient, headers: dict[str, str], entry_id: int) -> None:
    """Give an entry a title, which is encrypted at rest alongside its body."""
    resp = await client.patch(
        f"/journal/{entry_id}",
        json={"title": _MY_TITLE},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK


async def _export(client: AsyncClient, headers: dict[str, str]) -> tuple[str, dict[str, Any]]:
    """Fetch the JSON export; return the raw text and the parsed document."""
    resp = await client.get(_EXPORT_PATH, headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    return resp.text, json.loads(resp.text)


def _records(document: dict[str, Any], key: str) -> list[dict[str, Any]]:
    """The rows the export filed under one collection name."""
    records: dict[str, list[dict[str, Any]]] = document["records"]
    return records[key]


@pytest.mark.asyncio
async def test_export_returns_the_callers_own_writing(async_client: AsyncClient) -> None:
    """The document names the account and carries the entry it just wrote."""
    headers, _ = await _signup(async_client, "exporter")
    await _write_entry(async_client, headers, _MINE)

    raw, document = await _export(async_client, headers)

    assert document["format"] == "adepthood-export"
    assert document["format_version"] >= 1
    assert _records(document, "account")[0]["email"] == "exporter@example.com"
    assert [entry["message"] for entry in _records(document, "journal_entries")] == [_MINE]
    assert _MINE in raw


@pytest.mark.asyncio
async def test_export_is_offered_as_a_downloadable_file(async_client: AsyncClient) -> None:
    """The response is a named attachment, not a page the caller must save by hand."""
    headers, _ = await _signup(async_client, "attachment")

    resp = await async_client.get(_EXPORT_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.headers["content-type"].startswith("application/json")
    assert "attachment" in resp.headers["content-disposition"]
    assert ".json" in resp.headers["content-disposition"]


@pytest.mark.asyncio
@pytest.mark.usefixtures("keyed")
async def test_export_emits_plaintext_and_never_ciphertext(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The star of this file: an export must decrypt, not copy the column.

    The raw-column assertion is what keeps the rest of it honest. Without it a
    reader could not tell whether the export decrypted anything or whether the
    database simply had nothing encrypted to begin with, and the test would
    stay green against an export that shipped ciphertext.
    """
    headers, _ = await _signup(async_client, "cipher")
    entry_id = await _write_entry(async_client, headers, _MINE)
    await _title_entry(async_client, headers, entry_id)

    stored = await db_session.execute(
        text("SELECT message, title FROM journalentry WHERE id = :id"),
        {"id": entry_id},
    )
    at_rest = stored.one()
    assert at_rest.message.startswith(_CIPHERTEXT_MARKER)
    assert at_rest.title.startswith(_CIPHERTEXT_MARKER)

    raw, document = await _export(async_client, headers)

    assert _CIPHERTEXT_MARKER not in raw
    entry = _records(document, "journal_entries")[0]
    assert entry["message"] == _MINE
    assert entry["title"] == _MY_TITLE


@pytest.mark.asyncio
async def test_export_excludes_another_accounts_writing(async_client: AsyncClient) -> None:
    """User A's export can contain nothing of user B's, and vice versa."""
    mine, _ = await _signup(async_client, "mine")
    theirs, _ = await _signup(async_client, "theirs")
    await _write_entry(async_client, mine, _MINE)
    await _write_entry(async_client, theirs, _THEIRS)

    raw, document = await _export(async_client, mine)

    assert _THEIRS not in raw
    assert "theirs@example.com" not in raw
    assert [entry["message"] for entry in _records(document, "journal_entries")] == [_MINE]
    assert [row["email"] for row in _records(document, "account")] == ["mine@example.com"]


@pytest.mark.asyncio
async def test_export_never_exposes_a_credential(async_client: AsyncClient) -> None:
    """The account's own password hash is not part of "everything you wrote"."""
    headers, _ = await _signup(async_client, "secretless")

    raw, document = await _export(async_client, headers)

    assert "password_hash" not in raw
    assert "password_hash" not in _records(document, "account")[0]


@pytest.mark.asyncio
async def test_export_requires_authentication(async_client: AsyncClient) -> None:
    """There is no anonymous export: the subject comes from the token alone."""
    resp = await async_client.get(_EXPORT_PATH)

    assert resp.status_code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}


@pytest.mark.asyncio
async def test_export_reaches_past_a_single_page_of_a_long_corpus(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A corpus larger than one read page comes back whole, not truncated."""
    headers, user_id = await _signup(async_client, "prolific")
    written = EXPORT_PAGE_SIZE + 5
    start = datetime.now(UTC) - timedelta(days=written)
    db_session.add_all(
        [
            JournalEntry(
                sender="user",
                user_id=user_id,
                message=f"Entry number {index}.",
                timestamp=start + timedelta(days=index),
            )
            for index in range(written)
        ],
    )
    await db_session.commit()

    _, document = await _export(async_client, headers)

    entries = _records(document, "journal_entries")
    assert len(entries) == written
    assert {entry["message"] for entry in entries} == {
        f"Entry number {index}." for index in range(written)
    }


@pytest.mark.asyncio
async def test_export_is_produced_incrementally_not_buffered_whole(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Bytes are ready before the last row is read, so no gateway waits on the total.

    A buffered response for a long-tenured account is the failure mode this
    design exists to avoid: it works for a new account and times out for the
    person with the most to lose. The claim is asserted against the generator
    rather than against the response, because the in-process test transport
    collects the whole body before handing any of it back and would report a
    buffered archive and a streamed one identically.
    """
    _, user_id = await _signup(async_client, "streamer")
    written = EXPORT_PAGE_SIZE + 5
    db_session.add_all(
        [
            JournalEntry(sender="user", user_id=user_id, message=f"Entry {index}.")
            for index in range(written)
        ],
    )
    await db_session.commit()

    archive = stream_json_export(
        db_session,
        ExportSubject(user_id=user_id, email="streamer@example.com"),
    )
    opening = await anext(archive)
    rest = [chunk async for chunk in archive]

    # The archive describes itself before a single row has been fetched.
    assert '"format":"adepthood-export"' in opening
    # And every row is its own chunk, so nothing is assembled whole in memory.
    assert len(rest) > written
    assert json.loads(opening + "".join(rest))["format"] == "adepthood-export"


@pytest.mark.asyncio
async def test_export_records_a_content_free_audit_event(
    async_client: AsyncClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """That an export happened is auditable; what it said is not logged."""
    headers, user_id = await _signup(async_client, "audited")
    await _write_entry(async_client, headers, _MINE)

    with caplog.at_level(logging.INFO):
        await _export(async_client, headers)

    emitted = "\n".join(record.getMessage() for record in caplog.records)
    assert _MINE not in emitted
    events = [record for record in caplog.records if record.getMessage() == _EXPORT_LOG_EVENT]
    assert len(events) == 1
    assert events[0].__dict__["user_id"] == user_id
    assert events[0].__dict__["records_exported"] > 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("keyed")
async def test_journal_markdown_is_readable_prose_not_ciphertext(
    async_client: AsyncClient,
) -> None:
    """The companion format a person can read without a JSON viewer."""
    headers, _ = await _signup(async_client, "reader")
    entry_id = await _write_entry(async_client, headers, _MINE)
    await _title_entry(async_client, headers, entry_id)

    resp = await async_client.get(_JOURNAL_MARKDOWN_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.headers["content-type"].startswith("text/markdown")
    assert "attachment" in resp.headers["content-disposition"]
    assert _CIPHERTEXT_MARKER not in resp.text
    assert resp.text.startswith("# ")
    assert _MY_TITLE in resp.text
    assert _MINE in resp.text


@pytest.mark.asyncio
async def test_journal_markdown_excludes_another_accounts_writing(
    async_client: AsyncClient,
) -> None:
    """The Markdown path is scoped to the caller exactly as the JSON path is."""
    mine, _ = await _signup(async_client, "mdmine")
    theirs, _ = await _signup(async_client, "mdtheirs")
    await _write_entry(async_client, mine, _MINE)
    await _write_entry(async_client, theirs, _THEIRS)

    resp = await async_client.get(_JOURNAL_MARKDOWN_PATH, headers=mine)

    assert resp.status_code == HTTPStatus.OK
    assert _MINE in resp.text
    assert _THEIRS not in resp.text


@pytest.mark.asyncio
async def test_journal_markdown_leaves_out_entries_the_user_deleted(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A deleted entry is not offered back as if it were still in the journal."""
    headers, user_id = await _signup(async_client, "tidy")
    db_session.add(
        JournalEntry(
            sender="user",
            user_id=user_id,
            message=_THEIRS,
            deleted_at=datetime.now(UTC),
        ),
    )
    await db_session.commit()
    await _write_entry(async_client, headers, _MINE)

    resp = await async_client.get(_JOURNAL_MARKDOWN_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert _MINE in resp.text
    assert _THEIRS not in resp.text


@pytest.mark.asyncio
async def test_journal_markdown_requires_authentication(async_client: AsyncClient) -> None:
    """Same door, same lock."""
    resp = await async_client.get(_JOURNAL_MARKDOWN_PATH)

    assert resp.status_code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}
