"""Stop a backup restore from resurrecting what users deleted (#3063 AC9-12).

A backup taken before a deletion still holds the deleted account or the
soft-deleted entry, and the deletion's own record -- the
:class:`~models.account_deletion_audit.AccountDeletionAudit` receipt, the
``deleted_at`` stamp -- lives in the same database, so a restore loses the
record together with the deletion. The deleted account can sign in again.

The procedure this module implements:

1. **Before** the restore, :func:`export_tombstones` reads every deletion the
   live database records (the account and entry sources declared in
   :data:`domain.retention.TOMBSTONE_SOURCES`) into a
   content-free :class:`TombstoneSet`: ids and instants only -- no email, no
   content, no content hash. Where that file is kept is an owner decision
   (#3063 AC17).
2. **After** the restore and **before** cutover, :func:`reapply_tombstones`
   re-runs the account-deletion sweep for every resurrected account and
   re-stamps every resurrected entry, then marks the restore complete.

Safety properties:

* It refuses before touching a row while the deletion policy, the retention
  registry or the tombstone registry has a gap.
* It is idempotent: an account already gone is skipped, an entry already
  stamped is skipped, and a run interrupted midway converges when rerun.
* An account created at or after its tombstone's instant is not the deleted
  account (an id reused after the backup) and is never touched; an entry
  whose owner or stored creation stamp differs from its tombstone's is a new
  page holding a reused id, and is likewise skipped. Both are counted as
  identity mismatches.
* A restore marked complete refuses to be reapplied again: after cutover the
  database's sequences have moved on and an entry id could name a new row.
* It dials nothing outside adepthood: resurrected accounts are swept with
  :meth:`AccountVaultDisposition.unconfigured`, and entries are only re-stamped.

Every log line carries the restore id, counts, the build version and safe
failure codes -- never an email, a user id list, or a word anyone wrote.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import SQLModel, col

from domain.retention import retention_gaps, tombstone_gaps
from models.account_deletion_audit import AccountDeletionAudit
from models.journal_entry import JournalEntry
from models.restore_marker import RestoreMarker, RestoreState
from models.user import User
from sentry import configured_release
from services.account_deletion import (
    Account,
    AccountVaultDisposition,
    delete_account,
    require_total_policy,
)

# The local corpus withdrawal (not the Creek journal DELETE): aliased as the
# journal router aliases it, so the two never read as the same operation.
from services.corpus_ingest import withdraw_journal_entry as withdraw_local_journal_entry
from services.creek_vault_voice_drafts import mark_entry_retractions_pending

logger = logging.getLogger(__name__)

#: The tombstone file's format version. Bump on any field change.
#: Version 2 added the entry's creation stamp; version 1 files are refused.
TOMBSTONE_FORMAT_VERSION: Final = 2

#: Opt-in startup gate: refuse to serve until this restore was reapplied.
RESTORE_SUPPRESSION_REQUIRED_ENV_VAR: Final = "RESTORE_SUPPRESSION_REQUIRED"
#: The restore id the gate requires a complete marker for.
RESTORE_ID_ENV_VAR: Final = "RESTORE_ID"
_GATE_ON = frozenset({"1", "true"})
_GATE_OFF = frozenset({"", "0", "false"})

_TOP_KEYS = frozenset({"version", "accounts", "entries"})
_ACCOUNT_KEYS = frozenset({"user_id", "deleted_at"})
_ENTRY_KEYS = frozenset({"entry_id", "user_id", "timestamp", "deleted_at"})


class MalformedTombstoneError(ValueError):
    """A tombstone file that is not exactly the shape this module writes."""


class RetentionGapError(RuntimeError):
    """The retention or tombstone registry no longer covers the schema."""


class RestoreAlreadyCompleteError(RuntimeError):
    """This restore was already reapplied; running it again after cutover is unsafe."""


class RestoreNotReappliedError(RuntimeError):
    """The startup gate is on and the configured restore has not been reapplied."""


def _aware(instant: datetime) -> datetime:
    """Read a stored instant as UTC; SQLite hands timezone-aware columns back naive."""
    return instant if instant.tzinfo is not None else instant.replace(tzinfo=UTC)


@dataclass(frozen=True)
class AccountTombstone:
    """An account that was erased, and when."""

    user_id: int
    deleted_at: datetime


@dataclass(frozen=True)
class EntryTombstone:
    """A journal entry that was soft-deleted, by whom, and when.

    ``timestamp`` is the entry's stored creation stamp. It is not content
    (``GET /journal`` already returns it to its owner), and it is what tells the
    deleted page apart from a new page that later took the same id.
    """

    entry_id: int
    user_id: int
    timestamp: datetime
    deleted_at: datetime


def _int_field(item: Mapping[str, object], key: str) -> int:
    value = item[key]
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        msg = f"{key} must be a positive integer"
        raise MalformedTombstoneError(msg)
    return value


def _instant_field(item: Mapping[str, object], key: str) -> datetime:
    value = item[key]
    if not isinstance(value, str):
        msg = f"{key} must be an ISO-8601 string"
        raise MalformedTombstoneError(msg)
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        msg = f"{key} is not an ISO-8601 instant"
        raise MalformedTombstoneError(msg) from exc
    return _aware(parsed)


def _items(
    document: Mapping[str, object], key: str, fields: frozenset[str]
) -> list[Mapping[str, object]]:
    value = document[key]
    if not isinstance(value, list):
        msg = f"{key} must be a list"
        raise MalformedTombstoneError(msg)
    for item in value:
        if not isinstance(item, dict) or set(item) != fields:
            msg = f"every {key} item must have exactly the fields {sorted(fields)}"
            raise MalformedTombstoneError(msg)
    return value


def _checked_document(document: object) -> Mapping[str, object]:
    """The top level of a tombstone file: exactly the known keys, a known version."""
    if not isinstance(document, dict) or set(document) != _TOP_KEYS:
        msg = f"a tombstone file has exactly the fields {sorted(_TOP_KEYS)}"
        raise MalformedTombstoneError(msg)
    if document["version"] != TOMBSTONE_FORMAT_VERSION:
        msg = f"unsupported tombstone format version {document['version']!r}"
        raise MalformedTombstoneError(msg)
    return document


def _account_tombstone(item: Mapping[str, object]) -> AccountTombstone:
    return AccountTombstone(
        user_id=_int_field(item, "user_id"),
        deleted_at=_instant_field(item, "deleted_at"),
    )


def _entry_tombstone(item: Mapping[str, object]) -> EntryTombstone:
    return EntryTombstone(
        entry_id=_int_field(item, "entry_id"),
        user_id=_int_field(item, "user_id"),
        timestamp=_instant_field(item, "timestamp"),
        deleted_at=_instant_field(item, "deleted_at"),
    )


@dataclass(frozen=True)
class TombstoneSet:
    """Content-free record of every deletion a restore could undo."""

    accounts: tuple[AccountTombstone, ...]
    entries: tuple[EntryTombstone, ...]
    version: int = TOMBSTONE_FORMAT_VERSION

    def to_json(self) -> dict[str, object]:
        """The file form: ids and ISO-8601 instants, nothing else."""
        return {
            "version": self.version,
            "accounts": [
                {"user_id": t.user_id, "deleted_at": t.deleted_at.isoformat()}
                for t in self.accounts
            ],
            "entries": [
                {
                    "entry_id": t.entry_id,
                    "user_id": t.user_id,
                    "timestamp": t.timestamp.isoformat(),
                    "deleted_at": t.deleted_at.isoformat(),
                }
                for t in self.entries
            ],
        }

    @classmethod
    def from_json(cls, document: object) -> TombstoneSet:
        """Parse a tombstone file strictly; anything unexpected is refused."""
        checked = _checked_document(document)
        accounts = tuple(
            _account_tombstone(item) for item in _items(checked, "accounts", _ACCOUNT_KEYS)
        )
        entries = tuple(_entry_tombstone(item) for item in _items(checked, "entries", _ENTRY_KEYS))
        return cls(accounts=accounts, entries=entries)


@dataclass(frozen=True)
class ReapplyReceipt:
    """What one reapply run did, in counts."""

    restore_id: str
    accounts_reapplied: int
    accounts_absent: int
    entries_reapplied: int
    entries_absent: int
    identity_mismatches: int


async def _account_tombstones(session: AsyncSession) -> tuple[AccountTombstone, ...]:
    """The latest erasure instant per erased account id."""
    rows = await session.execute(
        select(col(AccountDeletionAudit.user_id), col(AccountDeletionAudit.deleted_at)).order_by(
            col(AccountDeletionAudit.user_id), col(AccountDeletionAudit.deleted_at)
        )
    )
    latest: dict[int, datetime] = {}
    for user_id, deleted_at in rows.all():
        latest[user_id] = _aware(deleted_at)
    return tuple(AccountTombstone(user_id=uid, deleted_at=at) for uid, at in latest.items())


async def _entry_tombstones(session: AsyncSession, erased: set[int]) -> tuple[EntryTombstone, ...]:
    """Every soft-deleted entry whose owner was not erased outright."""
    rows = await session.execute(
        select(
            col(JournalEntry.id),
            col(JournalEntry.user_id),
            col(JournalEntry.timestamp),
            col(JournalEntry.deleted_at),
        )
        .where(col(JournalEntry.deleted_at).is_not(None))
        .order_by(col(JournalEntry.id))
    )
    return tuple(
        EntryTombstone(
            entry_id=entry_id,
            user_id=user_id,
            timestamp=_aware(created),
            deleted_at=_aware(deleted_at),
        )
        for entry_id, user_id, created, deleted_at in rows.all()
        if user_id not in erased
    )


def _require_complete_registries() -> None:
    """Refuse while any registry this procedure trusts has a hole in it."""
    require_total_policy()
    gaps = retention_gaps(SQLModel.metadata) + tombstone_gaps(SQLModel.metadata)
    if gaps:
        msg = "restore suppression refused: " + "; ".join(gaps)
        raise RetentionGapError(msg)


async def export_tombstones(session: AsyncSession) -> TombstoneSet:
    """Read every deletion the live database records, content-free.

    An entry whose owner was erased is not exported separately: reapplying the
    account sweep removes it with everything else the account owned.
    """
    _require_complete_registries()
    accounts = await _account_tombstones(session)
    entries = await _entry_tombstones(session, {t.user_id for t in accounts})
    tombstones = TombstoneSet(accounts=accounts, entries=entries)
    logger.info(
        "restore_tombstones_exported",
        extra={
            "accounts": len(accounts),
            "entries": len(entries),
            "build_version": configured_release(),
        },
    )
    return tombstones


async def _open_marker(factory: async_sessionmaker[AsyncSession], restore_id: str) -> None:
    """Refuse a completed restore; otherwise record (or resume) an in-progress one."""
    async with factory() as session:
        marker = (
            await session.execute(
                select(RestoreMarker).where(col(RestoreMarker.restore_id) == restore_id)
            )
        ).scalar_one_or_none()
        if marker is not None and marker.state == RestoreState.COMPLETE.value:
            msg = f"restore {restore_id!r} was already reapplied; refusing to run it again"
            raise RestoreAlreadyCompleteError(msg)
        if marker is None:
            session.add(RestoreMarker(restore_id=restore_id, build_version=configured_release()))
            await session.commit()


@dataclass
class _Tally:
    accounts_reapplied: int = 0
    accounts_absent: int = 0
    entries_reapplied: int = 0
    entries_absent: int = 0
    identity_mismatches: int = 0


async def _reapply_account(
    factory: async_sessionmaker[AsyncSession], tombstone: AccountTombstone, tally: _Tally
) -> None:
    """Re-run the erasure for one resurrected account, unless it is someone else."""
    async with factory() as session:
        user = await session.get(User, tombstone.user_id)
        if user is None:
            tally.accounts_absent += 1
            return
        # An account cannot have been created at or after its own deletion, so
        # one that was is a different person holding a reused id.
        if _aware(user.created_at) >= tombstone.deleted_at:
            tally.identity_mismatches += 1
            return
        await delete_account(
            session,
            Account(user_id=tombstone.user_id, email=user.email),
            vault_disposition=AccountVaultDisposition.unconfigured(),
        )
        tally.accounts_reapplied += 1


async def _reapply_entry(
    factory: async_sessionmaker[AsyncSession], tombstone: EntryTombstone, tally: _Tally
) -> None:
    """Re-stamp one resurrected entry's soft delete."""
    async with factory() as session:
        entry = await session.get(JournalEntry, tombstone.entry_id)
        if entry is None or entry.deleted_at is not None:
            tally.entries_absent += 1
            return
        # Only the very page the tombstone describes is re-deleted: same owner
        # and the same stored creation stamp. After a restore the rewound
        # sequence can hand a deleted page's id to a new page, which will not
        # share its creation stamp to the microsecond. The one residual case is
        # two pages both backdated (``entry_date``) to the same calendar day,
        # which share a noon-UTC stamp; the startup gate, which keeps the
        # restored app from taking writes before reapply, closes that window.
        # ``updated_at`` would not do: any write after the restore (an edit, a
        # recovery sweep) moves it, and would leave the deleted page live.
        if entry.user_id != tombstone.user_id or _aware(entry.timestamp) != tombstone.timestamp:
            tally.identity_mismatches += 1
            return
        await withdraw_local_journal_entry(
            session, user_id=tombstone.user_id, entry_id=tombstone.entry_id
        )
        # The original delete stamped ``deleted_at`` only after the vault
        # confirmed the remote copy absent (routers.journal.delete_journal_entry),
        # so the restored handle names nothing; clearing it stops a retry
        # dialling for a copy that is already gone.
        entry.vault_ref = None
        entry.deleted_at = tombstone.deleted_at
        # Any essay offer the restore resurrected becomes an owed, idempotent
        # withdrawal again rather than a silent "never offered".
        await mark_entry_retractions_pending(
            session, user_id=tombstone.user_id, entry_id=tombstone.entry_id
        )
        session.add(entry)
        await session.commit()
        tally.entries_reapplied += 1


async def _close_marker(
    factory: async_sessionmaker[AsyncSession], restore_id: str, tally: _Tally
) -> None:
    async with factory() as session:
        marker = (
            await session.execute(
                select(RestoreMarker).where(col(RestoreMarker.restore_id) == restore_id)
            )
        ).scalar_one()
        marker.state = RestoreState.COMPLETE.value
        marker.completed_at = datetime.now(UTC)
        marker.accounts_reapplied = tally.accounts_reapplied
        marker.entries_reapplied = tally.entries_reapplied
        marker.identity_mismatches = tally.identity_mismatches
        marker.build_version = configured_release()
        session.add(marker)
        await session.commit()


async def reapply_tombstones(
    factory: async_sessionmaker[AsyncSession],
    tombstones: TombstoneSet,
    *,
    restore_id: str,
) -> ReapplyReceipt:
    """Apply a tombstone set to a restored database, before cutover.

    Commits per account and per entry, so an interrupted run leaves a
    consistent database and the marker ``in_progress``; rerunning converges.
    """
    _require_complete_registries()
    await _open_marker(factory, restore_id)
    logger.info(
        "restore_reapply_started",
        extra={"restore_id": restore_id, "build_version": configured_release()},
    )
    tally = _Tally()
    try:
        for account in tombstones.accounts:
            await _reapply_account(factory, account, tally)
        for entry in tombstones.entries:
            await _reapply_entry(factory, entry, tally)
    except Exception as exc:
        logger.warning(
            "restore_reapply_interrupted",
            extra={"restore_id": restore_id, "failure_code": type(exc).__name__},
        )
        raise
    await _close_marker(factory, restore_id, tally)
    receipt = ReapplyReceipt(restore_id=restore_id, **vars(tally))
    logger.info(
        "restore_reapply_complete",
        extra={**vars(tally), "restore_id": restore_id, "build_version": configured_release()},
    )
    return receipt


def _gate_required() -> bool:
    """Read the switch strictly; an unreadable value fails closed."""
    raw = os.getenv(RESTORE_SUPPRESSION_REQUIRED_ENV_VAR, "").strip().lower()
    if raw in _GATE_ON:
        return True
    if raw in _GATE_OFF:
        return False
    msg = (
        f"{RESTORE_SUPPRESSION_REQUIRED_ENV_VAR} must be one of "
        f"{sorted(_GATE_ON | (_GATE_OFF - {''}))}; refusing to serve on an unreadable value"
    )
    raise RestoreNotReappliedError(msg)


async def assert_restore_reapplied(factory: async_sessionmaker[AsyncSession]) -> None:
    """Refuse to serve a restored database whose deletions were not reapplied.

    Off unless ``RESTORE_SUPPRESSION_REQUIRED`` is set, so existing deploys are
    unchanged. When on, ``RESTORE_ID`` must name a restore whose marker is
    ``complete``.
    """
    if not _gate_required():
        return
    restore_id = os.getenv(RESTORE_ID_ENV_VAR, "").strip()
    if not restore_id:
        msg = f"{RESTORE_SUPPRESSION_REQUIRED_ENV_VAR} is on but {RESTORE_ID_ENV_VAR} is not set"
        raise RestoreNotReappliedError(msg)
    async with factory() as session:
        state = (
            await session.execute(
                select(col(RestoreMarker.state)).where(col(RestoreMarker.restore_id) == restore_id)
            )
        ).scalar_one_or_none()
    if state != RestoreState.COMPLETE.value:
        msg = (
            f"{RESTORE_ID_ENV_VAR}={restore_id} has not been reapplied "
            f"(marker state: {state or 'absent'}); run the restore-suppression reapply first"
        )
        raise RestoreNotReappliedError(msg)
