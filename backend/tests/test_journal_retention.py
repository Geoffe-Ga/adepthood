"""The operator-invoked purge of soft-deleted journal entries (#3063 AC13).

A soft-deleted entry is hidden but kept, together with its encrypted margin
notes, promoted passages and the rest, until the account is erased. The purge
is the operator's lever for ending that: it hard-deletes entries soft-deleted
more than ``older_than_days`` ago and acts on every row that points at them,
as the schema's foreign keys (and :mod:`domain.retention`) say.

The database is seeded through :mod:`tests.helpers.account_seed`, which writes
one row into every table the schema has, so every table that references an
entry -- including the next one somebody adds -- has a row the purge must deal
with. The assertions then read the action off ``entry_dependants`` rather than
off a hand-kept list.

It has no schedule and no default window: the window is a required parameter,
because choosing one is a promise to users that belongs to the owner (#3063
AC15, AC18).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
import sqlalchemy as sa
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel, col

from domain.retention import PurgeAction, entry_dependants
from models.journal_entry import JournalEntry
from models.user import User
from models.voice_draft_retraction import VoiceDraftRetraction, VoiceDraftRetractionState
from tests.helpers.account_seed import SeedAccount, seed_one_row_everywhere, seed_shared_tables
from tests.helpers.telemetry_canaries import SHORT_CANARY, assert_no_canary

_PURGE = "/admin/maintenance/journal-entries"
_PASSWORD = "securepassword123"  # pragma: allowlist secret
_WINDOW_DAYS = 1
_OLD = timedelta(days=3)
_RECENT = timedelta(hours=12)
_LOG_EVENT = "journalentry_purge"


async def _signup(client: AsyncClient, name: str) -> tuple[SeedAccount, dict[str, str]]:
    email = f"{name}@example.com"
    resp = await client.post("/auth/signup", json={"email": email, "password": _PASSWORD})
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return SeedAccount(user_id=body["user_id"], email=email), {
        "Authorization": f"Bearer {body['token']}"
    }


async def _admin(client: AsyncClient, session: AsyncSession) -> dict[str, str]:
    account, headers = await _signup(client, "operator")
    await session.execute(
        sa.update(User).where(col(User.id) == account.user_id).values(is_admin=True)
    )
    await session.commit()
    return headers


async def _seeded_entry(session: AsyncSession, account: SeedAccount) -> int:
    """The one entry the seeder gave ``account``."""
    entries = SQLModel.metadata.tables["journalentry"]
    result = await session.execute(
        sa.select(entries.c["id"]).where(entries.c["user_id"] == account.user_id)
    )
    return int(result.scalar_one())


async def _soft_delete(session: AsyncSession, entry_id: int, age: timedelta) -> None:
    await session.execute(
        sa.update(JournalEntry)
        .where(col(JournalEntry.id) == entry_id)
        .values(deleted_at=datetime.now(UTC) - age)
    )
    await session.commit()


async def _settle_obligations(session: AsyncSession, entry_id: int, state: str) -> None:
    await session.execute(
        sa.update(VoiceDraftRetraction)
        .where(col(VoiceDraftRetraction.journal_entry_id) == entry_id)
        .values(state=state)
    )
    await session.commit()


async def _rows(session: AsyncSession, table_name: str, column: str, value: int) -> int:
    table = SQLModel.metadata.tables[table_name]
    result = await session.execute(
        sa.select(sa.func.count()).select_from(table).where(table.c[column] == value)
    )
    return int(result.scalar_one())


async def _table_counts(session: AsyncSession) -> dict[str, int]:
    counts: dict[str, int] = {}
    for name, table in SQLModel.metadata.tables.items():
        result = await session.execute(sa.select(sa.func.count()).select_from(table))
        counts[name] = int(result.scalar_one())
    return counts


async def _seed_two_accounts(
    client: AsyncClient, session: AsyncSession
) -> tuple[SeedAccount, dict[str, str], SeedAccount]:
    shared = await seed_shared_tables(session)
    alice, alice_headers = await _signup(client, "alice")
    bob, _ = await _signup(client, "bob")
    await seed_one_row_everywhere(session, alice, shared)
    await seed_one_row_everywhere(session, bob, shared)
    return alice, alice_headers, bob


async def _copy_row(session: AsyncSession, table_name: str, row_id: int, **changes: int) -> None:
    table = SQLModel.metadata.tables[table_name]
    row = (await session.execute(sa.select(table).where(table.c["id"] == row_id))).mappings().one()
    values = {str(key): value for key, value in row.items() if key != "id"}
    values.update(changes)
    await session.execute(sa.insert(table).values(**values))
    await session.commit()


@pytest.mark.asyncio
async def test_purge_removes_soft_deleted_entry_and_derivatives(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Old soft-deleted entries go, with every dependant handled as the schema says."""
    alice, alice_headers, bob = await _seed_two_accounts(async_client, db_session)
    doomed = await _seeded_entry(db_session, alice)
    live = (
        await async_client.post(
            "/journal/",
            json={"message": "kept", "classification": "personal"},
            headers=alice_headers,
        )
    ).json()["id"]
    quote = SQLModel.metadata.tables["promotedquote"]
    quote_id = (
        await db_session.execute(
            sa.select(quote.c["id"]).where(quote.c["source_entry_id"] == doomed)
        )
    ).scalar_one()
    # A passage from the live entry that was folded into the doomed one.
    await _copy_row(db_session, "promotedquote", quote_id, source_entry_id=live)
    await _soft_delete(db_session, doomed, _OLD)
    await _settle_obligations(db_session, doomed, VoiceDraftRetractionState.CONFIRMED.value)
    bob_entry = await _seeded_entry(db_session, bob)
    headers = await _admin(async_client, db_session)

    resp = await async_client.post(
        _PURGE, params={"older_than_days": _WINDOW_DAYS}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["deleted"] == 1
    assert body["blocked"] == 0
    assert body["older_than_days"] == _WINDOW_DAYS
    assert await _rows(db_session, "journalentry", "id", doomed) == 0
    dependants = [d for d in entry_dependants(SQLModel.metadata) if d.parent is None]
    assert dependants
    for dependant in dependants:
        assert await _rows(db_session, dependant.table, dependant.column, doomed) == 0, dependant
    nulled = {(d.table, d.column) for d in dependants if d.action is PurgeAction.NULL}
    assert ("llmusagelog", "journal_entry_id") in nulled
    # The metering row is kept, with its link to the writing cleared.
    assert await _rows(db_session, "llmusagelog", "user_id", alice.user_id) == 1
    survivors = await db_session.execute(
        sa.select(quote.c["included_in_entry_id"]).where(quote.c["source_entry_id"] == live)
    )
    assert survivors.scalars().all() == [None]
    # Nothing of bob's moved: every dependant of his entry is still attached to it.
    assert await _rows(db_session, "journalentry", "id", bob_entry) == 1
    for dependant in dependants:
        assert await _rows(db_session, dependant.table, dependant.column, bob_entry) == 1, dependant


@pytest.mark.asyncio
async def test_purge_spares_recent_live_and_other_tenants(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A recent soft-delete, a live entry and another account's rows are untouched."""
    alice, _, bob = await _seed_two_accounts(async_client, db_session)
    recent = await _seeded_entry(db_session, alice)
    bob_entry = await _seeded_entry(db_session, bob)
    await _soft_delete(db_session, recent, _RECENT)
    await _settle_obligations(db_session, recent, VoiceDraftRetractionState.CONFIRMED.value)
    before = await _table_counts(db_session)
    headers = await _admin(async_client, db_session)
    before_admin = await _table_counts(db_session)

    resp = await async_client.post(
        _PURGE, params={"older_than_days": _WINDOW_DAYS}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["deleted"] == 0
    after = await _table_counts(db_session)
    changed = {name for name in after if after[name] != before_admin[name]}
    assert changed <= {"loginattempt"}, changed
    assert before["journalentry"] == after["journalentry"]
    assert await _rows(db_session, "journalentry", "id", bob_entry) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state",
    [VoiceDraftRetractionState.PENDING.value, VoiceDraftRetractionState.MIRROR_INTENT.value],
)
async def test_purge_skips_entries_with_an_unconfirmed_withdrawal(
    async_client: AsyncClient, db_session: AsyncSession, state: str
) -> None:
    """An owed remote withdrawal keeps its entry; once confirmed, it no longer blocks."""
    alice, _, _ = await _seed_two_accounts(async_client, db_session)
    entry_id = await _seeded_entry(db_session, alice)
    await _soft_delete(db_session, entry_id, _OLD)
    await _settle_obligations(db_session, entry_id, state)
    headers = await _admin(async_client, db_session)

    resp = await async_client.post(
        _PURGE, params={"older_than_days": _WINDOW_DAYS}, headers=headers
    )

    assert resp.json() == {"deleted": 0, "blocked": 1, "older_than_days": _WINDOW_DAYS}
    assert await _rows(db_session, "journalentry", "id", entry_id) == 1
    assert await _rows(db_session, "voicedraftretraction", "journal_entry_id", entry_id) == 1

    await _settle_obligations(db_session, entry_id, VoiceDraftRetractionState.CONFIRMED.value)
    resp = await async_client.post(
        _PURGE, params={"older_than_days": _WINDOW_DAYS}, headers=headers
    )

    assert resp.json() == {"deleted": 1, "blocked": 0, "older_than_days": _WINDOW_DAYS}
    assert await _rows(db_session, "journalentry", "id", entry_id) == 0
    assert await _rows(db_session, "voicedraftretraction", "journal_entry_id", entry_id) == 0


@pytest.mark.asyncio
async def test_purge_requires_admin_and_explicit_window(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Non-admins are refused; the window is mandatory and must be positive."""
    _, plain = await _signup(async_client, "plain")
    resp = await async_client.post(_PURGE, params={"older_than_days": _WINDOW_DAYS}, headers=plain)
    assert resp.status_code == HTTPStatus.FORBIDDEN

    headers = await _admin(async_client, db_session)
    assert (await async_client.post(_PURGE, headers=headers)).status_code == (
        HTTPStatus.UNPROCESSABLE_ENTITY
    )
    resp = await async_client.post(_PURGE, params={"older_than_days": 0}, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_purge_log_is_content_free(
    async_client: AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """The sweep logs counts and ids, never what was written."""
    _, author_headers = await _signup(async_client, "author")
    entry_id = (
        await async_client.post(
            "/journal/",
            json={"message": SHORT_CANARY, "classification": "personal"},
            headers=author_headers,
        )
    ).json()["id"]
    assert (
        await async_client.delete(f"/journal/{entry_id}", headers=author_headers)
    ).status_code == (HTTPStatus.NO_CONTENT)
    await _soft_delete(db_session, entry_id, _OLD)
    headers = await _admin(async_client, db_session)
    caplog.set_level(logging.INFO)

    resp = await async_client.post(
        _PURGE, params={"older_than_days": _WINDOW_DAYS}, headers=headers
    )

    assert resp.json()["deleted"] == 1
    events = [record for record in caplog.records if record.getMessage() == _LOG_EVENT]
    assert len(events) == 1
    assert events[0].__dict__["deleted"] == 1
    for record in caplog.records:
        assert_no_canary(f"{record.getMessage()} {record.__dict__!r}", SHORT_CANARY)
