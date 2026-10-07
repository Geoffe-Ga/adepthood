"""Restoring a backup must not resurrect what a user deleted (#3063 AC9-12).

A backup taken before a deletion still holds the deleted account and the
soft-deleted entry, and the deletion's own record (the audit row, the
``deleted_at`` stamp) lives in the same database, so restoring the backup
loses the record along with the deletion. The fix is to export content-free
tombstones *before* the restore and reapply them to the restored database
*before* cutover.

These drills run that sequence on a real file-backed SQLite database: seed,
snapshot (file copy), delete, export, restore the snapshot, reapply. Each one
first asserts that the resurrection is **observable** after the restore -- the
deleted account can sign in, the deleted entry can be read -- so the
after-reapply assertions cannot pass on an empty database.
"""

from __future__ import annotations

import json
import logging
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlmodel import col

from domain import retention
from domain.account_deletion import POLICY
from main import app, lifespan
from models.journal_entry import JournalEntry
from models.restore_marker import RestoreMarker, RestoreState
from models.user import User
from services import restore_suppression
from services.account_deletion import (
    Account,
    AccountVaultDisposition,
    DeletionReceipt,
    ErasurePolicyGapError,
)
from services.journal_retention import PURGE_MIN_RETENTION_DAYS, purge_soft_deleted_entries
from services.restore_suppression import (
    RESTORE_ID_ENV_VAR,
    RESTORE_SUPPRESSION_REQUIRED_ENV_VAR,
    AccountTombstone,
    EntryTombstone,
    RestoreAlreadyCompleteError,
    RestoreNotReappliedError,
    RetentionGapError,
    TombstoneSet,
    assert_restore_reapplied,
    export_tombstones,
    reapply_tombstones,
)
from tests.helpers.telemetry_canaries import SHORT_CANARY, assert_no_canary

_PASSWORD = "securepassword123"  # pragma: allowlist secret
_DB_FILE = "concurrent.db"
_SNAPSHOT_FILE = "snapshot.db"
_RESTORE_ID = "drill-1"
_GATE_RESTORE_ID = "r9"
# The tombstone file's complete, content-free field set. A new field is added
# here deliberately, after deciding it carries no email, prose or hash.
_TOMBSTONE_TOP_KEYS = {"version", "accounts", "entries"}
_ACCOUNT_KEYS = {"user_id", "deleted_at"}
_ENTRY_KEYS = {"entry_id", "user_id", "deleted_at"}


@dataclass(frozen=True)
class _Person:
    """One signed-up account in the drill."""

    headers: dict[str, str]
    user_id: int
    email: str


@pytest.fixture(autouse=True)
def _gate_env_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each test starts with the default-off gate, whatever the shell says."""
    monkeypatch.delenv(RESTORE_SUPPRESSION_REQUIRED_ENV_VAR, raising=False)
    monkeypatch.delenv(RESTORE_ID_ENV_VAR, raising=False)


async def _signup(client: AsyncClient, name: str) -> _Person:
    email = f"{name}@example.com"
    resp = await client.post("/auth/signup", json={"email": email, "password": _PASSWORD})
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return _Person({"Authorization": f"Bearer {data['token']}"}, data["user_id"], email)


async def _login_status(client: AsyncClient, person: _Person) -> int:
    resp = await client.post("/auth/login", json={"email": person.email, "password": _PASSWORD})
    return resp.status_code


async def _write(client: AsyncClient, person: _Person, body: str) -> int:
    resp = await client.post(
        "/journal/",
        json={"message": body, "classification": "personal"},
        headers=person.headers,
    )
    assert resp.status_code in {HTTPStatus.OK, HTTPStatus.CREATED}
    return int(resp.json()["id"])


async def _delete_account(client: AsyncClient, person: _Person) -> None:
    resp = await client.request(
        "DELETE", "/users/me", json={"confirm_email": person.email}, headers=person.headers
    )
    assert resp.status_code == HTTPStatus.OK


def _engine(factory: async_sessionmaker[AsyncSession]) -> AsyncEngine:
    engine = factory.kw["bind"]
    assert isinstance(engine, AsyncEngine)
    return engine


async def _snapshot(factory: async_sessionmaker[AsyncSession], tmp_path: Path) -> Path:
    """Copy the database file, with every pooled connection closed first."""
    await _engine(factory).dispose()
    target = tmp_path / _SNAPSHOT_FILE
    shutil.copyfile(tmp_path / _DB_FILE, target)
    return target


async def _restore(factory: async_sessionmaker[AsyncSession], snapshot: Path) -> None:
    """Swap the snapshot back in, as a restore into an empty database would."""
    await _engine(factory).dispose()
    shutil.copyfile(snapshot, snapshot.with_name(_DB_FILE))


async def _export(factory: async_sessionmaker[AsyncSession]) -> TombstoneSet:
    async with factory() as session:
        return await export_tombstones(session)


async def _entry_count(factory: async_sessionmaker[AsyncSession], user_id: int) -> int:
    async with factory() as session:
        result = await session.execute(
            select(func.count())
            .select_from(JournalEntry)
            .where(col(JournalEntry.user_id) == user_id)
        )
        return int(result.scalar_one())


async def _marker(
    factory: async_sessionmaker[AsyncSession], restore_id: str
) -> RestoreMarker | None:
    async with factory() as session:
        result = await session.execute(
            select(RestoreMarker).where(col(RestoreMarker.restore_id) == restore_id)
        )
        return result.scalar_one_or_none()


@pytest.mark.asyncio
async def test_restored_backup_does_not_resurrect_deleted_account(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    tmp_path: Path,
) -> None:
    """A deleted account cannot sign in again after a restore plus reapply."""
    client, factory = concurrent_async_client, concurrent_session_factory
    alice = await _signup(client, "alice")
    bob = await _signup(client, "bob")
    await _write(client, alice, "alice's page")
    await _write(client, bob, "bob's page")
    snapshot = await _snapshot(factory, tmp_path)

    await _delete_account(client, alice)
    tombstones = await _export(factory)
    await _restore(factory, snapshot)

    assert await _login_status(client, alice) == HTTPStatus.OK  # resurrection is real
    assert await _entry_count(factory, alice.user_id) == 1

    receipt = await reapply_tombstones(factory, tombstones, restore_id=_RESTORE_ID)

    assert await _login_status(client, alice) == HTTPStatus.UNAUTHORIZED
    assert await _entry_count(factory, alice.user_id) == 0
    assert await _login_status(client, bob) == HTTPStatus.OK
    assert await _entry_count(factory, bob.user_id) == 1
    assert receipt.accounts_reapplied == 1
    marker = await _marker(factory, _RESTORE_ID)
    assert marker is not None
    assert marker.state == RestoreState.COMPLETE.value
    assert marker.accounts_reapplied == 1


@pytest.mark.asyncio
async def test_restored_backup_does_not_resurrect_soft_deleted_entry(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    tmp_path: Path,
) -> None:
    """A deleted page is unreadable, unlisted and unexported after reapply."""
    client, factory = concurrent_async_client, concurrent_session_factory
    alice = await _signup(client, "alice")
    gone = await _write(client, alice, "the page alice deleted")
    kept = await _write(client, alice, "the page alice kept")
    snapshot = await _snapshot(factory, tmp_path)

    resp = await client.delete(f"/journal/{gone}", headers=alice.headers)
    assert resp.status_code == HTTPStatus.NO_CONTENT
    tombstones = await _export(factory)
    await _restore(factory, snapshot)

    resp = await client.get(f"/journal/{gone}", headers=alice.headers)
    assert resp.status_code == HTTPStatus.OK  # resurrection is real

    receipt = await reapply_tombstones(factory, tombstones, restore_id=_RESTORE_ID)

    assert receipt.entries_reapplied == 1
    resp = await client.get(f"/journal/{gone}", headers=alice.headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
    listed = {
        item["id"]
        for item in (await client.get("/journal/", headers=alice.headers)).json()["items"]
    }
    assert gone not in listed
    assert kept in listed
    export = (await client.get("/users/me/export", headers=alice.headers)).json()
    exported = {entry["id"] for entry in export["records"]["journal_entries"]}
    assert gone not in exported
    assert kept in exported


@pytest.mark.asyncio
async def test_reapply_is_idempotent_and_survives_interruption(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A run killed midway converges on rerun; a completed restore refuses a third."""
    client, factory = concurrent_async_client, concurrent_session_factory
    alice = await _signup(client, "alice")
    carol = await _signup(client, "carol")
    snapshot = await _snapshot(factory, tmp_path)
    await _delete_account(client, alice)
    await _delete_account(client, carol)
    tombstones = await _export(factory)
    await _restore(factory, snapshot)

    real_delete = restore_suppression.delete_account
    calls = 0

    async def _dies_on_second(
        session: AsyncSession,
        account: Account,
        *,
        vault_disposition: AccountVaultDisposition,
    ) -> DeletionReceipt:
        nonlocal calls
        calls += 1
        if calls == 2:
            msg = "synthetic crash mid-reapply"
            raise RuntimeError(msg)
        return await real_delete(session, account, vault_disposition=vault_disposition)

    monkeypatch.setattr(restore_suppression, "delete_account", _dies_on_second)
    with pytest.raises(RuntimeError, match="synthetic crash"):
        await reapply_tombstones(factory, tombstones, restore_id=_RESTORE_ID)
    marker = await _marker(factory, _RESTORE_ID)
    assert marker is not None
    assert marker.state == RestoreState.IN_PROGRESS.value
    assert await _login_status(client, alice) == HTTPStatus.UNAUTHORIZED
    assert await _login_status(client, carol) == HTTPStatus.OK

    monkeypatch.setattr(restore_suppression, "delete_account", real_delete)
    receipt = await reapply_tombstones(factory, tombstones, restore_id=_RESTORE_ID)
    assert receipt.accounts_reapplied == 1
    assert receipt.accounts_absent == 1
    assert await _login_status(client, carol) == HTTPStatus.UNAUTHORIZED

    with pytest.raises(RestoreAlreadyCompleteError):
        await reapply_tombstones(factory, tombstones, restore_id=_RESTORE_ID)


async def _created_at(factory: async_sessionmaker[AsyncSession], user_id: int) -> datetime:
    async with factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        created = user.created_at
    return created if created.tzinfo else created.replace(tzinfo=UTC)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("offset", "survives"),
    [
        (timedelta(seconds=-1), True),  # created after the deletion: a reused id
        (timedelta(0), True),  # created the instant it was deleted: not the same account
        (timedelta(seconds=1), False),  # created before the deletion: the deleted account
    ],
)
async def test_tombstone_never_touches_a_reused_id(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    offset: timedelta,
    *,
    survives: bool,
) -> None:
    """An account created at or after the tombstone's instant is someone else."""
    client, factory = concurrent_async_client, concurrent_session_factory
    dana = await _signup(client, "dana")
    created = await _created_at(factory, dana.user_id)
    tombstones = TombstoneSet(
        accounts=(AccountTombstone(user_id=dana.user_id, deleted_at=created + offset),),
        entries=(),
    )

    receipt = await reapply_tombstones(factory, tombstones, restore_id=_RESTORE_ID)

    expected = HTTPStatus.OK if survives else HTTPStatus.UNAUTHORIZED
    assert await _login_status(client, dana) == expected
    assert receipt.identity_mismatches == (1 if survives else 0)


@pytest.mark.asyncio
async def test_entry_tombstone_for_another_owner_is_a_mismatch(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """An entry id now owned by a different account is never re-stamped."""
    client, factory = concurrent_async_client, concurrent_session_factory
    erin = await _signup(client, "erin")
    entry_id = await _write(client, erin, "erin's page")
    tombstones = TombstoneSet(
        accounts=(),
        entries=(
            EntryTombstone(
                entry_id=entry_id, user_id=erin.user_id + 1, deleted_at=datetime.now(UTC)
            ),
        ),
    )

    receipt = await reapply_tombstones(factory, tombstones, restore_id=_RESTORE_ID)

    assert receipt.identity_mismatches == 1
    resp = await client.get(f"/journal/{entry_id}", headers=erin.headers)
    assert resp.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_reapply_refuses_on_policy_gap(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A hole in the deletion policy or the retention registry changes nothing."""
    client, factory = concurrent_async_client, concurrent_session_factory
    fay = await _signup(client, "fay")
    tombstones = TombstoneSet(
        accounts=(
            AccountTombstone(user_id=fay.user_id, deleted_at=datetime.now(UTC) + timedelta(days=1)),
        ),
        entries=(),
    )

    with monkeypatch.context() as patched:
        patched.setattr(
            "domain.account_deletion.POLICY",
            {name: rule for name, rule in POLICY.items() if name != "habit"},
        )
        with pytest.raises(ErasurePolicyGapError):
            await reapply_tombstones(factory, tombstones, restore_id=_RESTORE_ID)

    with monkeypatch.context() as patched:
        patched.setattr(
            retention,
            "RETENTION",
            {name: rule for name, rule in retention.RETENTION.items() if name != "habit"},
        )
        with pytest.raises(RetentionGapError):
            await reapply_tombstones(factory, tombstones, restore_id=_RESTORE_ID)

    assert await _login_status(client, fay) == HTTPStatus.OK
    assert await _marker(factory, _RESTORE_ID) is None


@pytest.mark.asyncio
async def test_startup_gate_refuses_without_marker(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With the gate on, the app will not serve until this restore was reapplied."""
    del concurrent_async_client
    factory = concurrent_session_factory

    await assert_restore_reapplied(factory)  # default off: returns without a marker

    monkeypatch.setenv(RESTORE_SUPPRESSION_REQUIRED_ENV_VAR, "1")
    with pytest.raises(RestoreNotReappliedError, match="RESTORE_ID"):
        await assert_restore_reapplied(factory)

    monkeypatch.setenv(RESTORE_ID_ENV_VAR, _GATE_RESTORE_ID)
    with pytest.raises(RestoreNotReappliedError, match=f"RESTORE_ID={_GATE_RESTORE_ID}"):
        await assert_restore_reapplied(factory)

    with (
        patch("main.async_session_factory", new=factory),
        patch("main.require_database_schema_current", new=AsyncMock()),
        patch("main._seed_startup_data", new=AsyncMock()) as seed,
        pytest.raises(RestoreNotReappliedError),
    ):
        async with lifespan(app):
            pytest.fail("an unreapplied restore reached the serving lifespan")
    seed.assert_not_called()

    await reapply_tombstones(
        factory, TombstoneSet(accounts=(), entries=()), restore_id=_GATE_RESTORE_ID
    )
    await assert_restore_reapplied(factory)  # a complete marker satisfies the gate


@pytest.mark.parametrize("raw", ["yes", "on", "2"])
@pytest.mark.asyncio
async def test_startup_gate_refuses_an_unreadable_switch(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    raw: str,
) -> None:
    """A switch nobody can read fails closed rather than quietly serving."""
    monkeypatch.setenv(RESTORE_SUPPRESSION_REQUIRED_ENV_VAR, raw)
    with pytest.raises(RestoreNotReappliedError, match=RESTORE_SUPPRESSION_REQUIRED_ENV_VAR):
        await assert_restore_reapplied(concurrent_session_factory)


@pytest.mark.asyncio
async def test_tombstone_file_and_logs_are_content_free(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Neither the tombstone file nor any log line carries an email or a word written."""
    client, factory = concurrent_async_client, concurrent_session_factory
    name = SHORT_CANARY.lower()
    gina = await _signup(client, name)
    hal = await _signup(client, "hal")
    await _write(client, gina, SHORT_CANARY)
    page = await _write(client, hal, SHORT_CANARY)
    snapshot = await _snapshot(factory, tmp_path)
    await client.delete(f"/journal/{page}", headers=hal.headers)
    await _delete_account(client, gina)

    caplog.set_level(logging.INFO)
    tombstones = await _export(factory)
    await _restore(factory, snapshot)
    await reapply_tombstones(factory, tombstones, restore_id=_RESTORE_ID)

    document = tombstones.to_json()
    blob = json.dumps(document)
    assert_no_canary(blob, SHORT_CANARY)
    assert gina.email not in blob
    assert set(document) == _TOMBSTONE_TOP_KEYS
    accounts, entries = document["accounts"], document["entries"]
    assert isinstance(accounts, list)
    assert isinstance(entries, list)
    assert accounts
    assert entries
    assert all(set(item) == _ACCOUNT_KEYS for item in accounts)
    assert all(set(item) == _ENTRY_KEYS for item in entries)

    records = [record for record in caplog.records if record.name.startswith("services.restore")]
    assert records, "reapply logged nothing -- the absence check would be vacuous"
    for record in caplog.records:
        rendered = f"{record.getMessage()} {record.__dict__!r}"
        assert_no_canary(rendered, SHORT_CANARY)
        assert gina.email not in rendered


def test_tombstone_file_round_trips_and_rejects_junk() -> None:
    """A tombstone file survives JSON and a malformed one is refused, not guessed at."""
    original = TombstoneSet(
        accounts=(AccountTombstone(user_id=3, deleted_at=datetime(2026, 1, 2, tzinfo=UTC)),),
        entries=(
            EntryTombstone(entry_id=9, user_id=4, deleted_at=datetime(2026, 1, 3, tzinfo=UTC)),
        ),
    )
    assert TombstoneSet.from_json(json.loads(json.dumps(original.to_json()))) == original
    junk_documents: tuple[object, ...] = (
        [],
        {"version": 99, "accounts": [], "entries": []},
        {
            "version": 1,
            "accounts": [{"user_id": "x", "deleted_at": "2026-01-01T00:00:00+00:00"}],
            "entries": [],
        },
        {"version": 1, "accounts": [], "entries": [{"entry_id": 1, "user_id": 1}]},
        {"version": 1, "accounts": [{"user_id": 1, "deleted_at": "not a date"}], "entries": []},
        {"version": 1, "accounts": [], "entries": [], "email": "x@example.com"},
    )
    for junk in junk_documents:
        with pytest.raises(restore_suppression.MalformedTombstoneError):
            TombstoneSet.from_json(junk)


@pytest.mark.asyncio
async def test_purge_at_the_floor_leaves_every_live_backup_holding_the_entry_deleted(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    tmp_path: Path,
) -> None:
    """A purged entry needs no tombstone, because no live backup holds it undeleted.

    The purge refuses any window shorter than the longest backup lifetime. So
    when it removes an entry soft-deleted more than that long ago, every backup
    still alive was taken after the soft delete and holds the row *deleted*.
    The snapshot below stands for the oldest such backup: taken after the
    delete, restored after the purge. The page stays gone without any
    tombstone to reapply.
    """
    client, factory = concurrent_async_client, concurrent_session_factory
    alice = await _signup(client, "alice")
    gone = await _write(client, alice, "the page alice deleted")
    kept = await _write(client, alice, "the page alice kept")
    resp = await client.delete(f"/journal/{gone}", headers=alice.headers)
    assert resp.status_code == HTTPStatus.NO_CONTENT
    async with factory() as session:
        await session.execute(
            update(JournalEntry)
            .where(col(JournalEntry.id) == gone)
            .values(deleted_at=datetime.now(UTC) - timedelta(days=PURGE_MIN_RETENTION_DAYS + 1))
        )
        await session.commit()
    oldest_live_backup = await _snapshot(factory, tmp_path)

    async with factory() as session:
        result = await purge_soft_deleted_entries(session, older_than_days=PURGE_MIN_RETENTION_DAYS)
    assert result.deleted == 1
    await _restore(factory, oldest_live_backup)

    assert await _entry_count(factory, alice.user_id) == 2  # the row is back...
    resp = await client.get(f"/journal/{gone}", headers=alice.headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND  # ...but still deleted
    listed = {
        item["id"]
        for item in (await client.get("/journal/", headers=alice.headers)).json()["items"]
    }
    assert listed == {kept}
    export = (await client.get("/users/me/export", headers=alice.headers)).json()
    assert {entry["id"] for entry in export["records"]["journal_entries"]} == {kept}


def _utc(stamp: datetime) -> datetime:
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=UTC)


async def _entry_instants(
    factory: async_sessionmaker[AsyncSession], entry_id: int
) -> tuple[datetime, datetime]:
    """``(timestamp, updated_at)`` of one entry, read as UTC."""
    async with factory() as session:
        entry = await session.get(JournalEntry, entry_id)
        assert entry is not None
        return _utc(entry.timestamp), _utc(entry.updated_at)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("offset", "survives"),
    [
        (timedelta(seconds=-1), True),  # written after the deletion: a reused id
        (timedelta(0), True),  # written the instant it was deleted: not the same page
        (timedelta(seconds=1), False),  # last written before the deletion: the deleted page
    ],
)
async def test_entry_tombstone_never_touches_a_reused_id(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    offset: timedelta,
    *,
    survives: bool,
) -> None:
    """A same-owner page last written at or after the tombstone's instant is a new page.

    After a restore the entry sequence rewinds, so a page the owner writes
    afterwards can take a deleted page's id. It was necessarily written after
    the deletion; the deleted page never was.
    """
    client, factory = concurrent_async_client, concurrent_session_factory
    ida = await _signup(client, "ida")
    entry_id = await _write(client, ida, "ida's new page")
    _, written = await _entry_instants(factory, entry_id)
    tombstones = TombstoneSet(
        accounts=(),
        entries=(
            EntryTombstone(entry_id=entry_id, user_id=ida.user_id, deleted_at=written + offset),
        ),
    )

    receipt = await reapply_tombstones(factory, tombstones, restore_id=_RESTORE_ID)

    resp = await client.get(f"/journal/{entry_id}", headers=ida.headers)
    assert resp.status_code == (HTTPStatus.OK if survives else HTTPStatus.NOT_FOUND)
    assert receipt.identity_mismatches == (1 if survives else 0)


@pytest.mark.asyncio
async def test_a_backdated_new_page_is_still_recognised_as_new(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """``timestamp`` cannot tell a new page from the deleted one; ``updated_at`` can.

    A writer may backdate a page (``entry_date``), so its ``timestamp`` can sit
    before a tombstone it postdates. The guard reads the server-only
    ``updated_at`` instead, which no request can move into the past.
    """
    client, factory = concurrent_async_client, concurrent_session_factory
    jo = await _signup(client, "jo")
    deleted_at = datetime.now(UTC) - timedelta(hours=1)
    resp = await client.post(
        "/journal/",
        json={"message": "backdated", "classification": "personal", "entry_date": "2020-01-01"},
        headers=jo.headers,
    )
    assert resp.status_code in {HTTPStatus.OK, HTTPStatus.CREATED}
    entry_id = int(resp.json()["id"])
    stamped, _ = await _entry_instants(factory, entry_id)
    assert stamped < deleted_at  # a timestamp guard would wrongly delete this page
    tombstones = TombstoneSet(
        accounts=(),
        entries=(EntryTombstone(entry_id=entry_id, user_id=jo.user_id, deleted_at=deleted_at),),
    )

    receipt = await reapply_tombstones(factory, tombstones, restore_id=_RESTORE_ID)

    assert receipt.identity_mismatches == 1
    assert (
        await client.get(f"/journal/{entry_id}", headers=jo.headers)
    ).status_code == HTTPStatus.OK
