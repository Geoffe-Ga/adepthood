"""Stop a backup restore from resurrecting what users deleted (#3063 AC9-12, #3214).

A backup taken before a deletion still holds the deleted account or the
soft-deleted entry, and the deletion's own record -- the
:class:`~models.account_deletion_audit.AccountDeletionAudit` receipt, the
``deleted_at`` stamp -- lives in the same database, so a restore loses the
record together with the deletion. The deleted account can sign in again.
The same is true of two requests that are not deletions yet: a page the writer
made Intimate comes back Personal, and a deletion still waiting on its vault
(an open :class:`~models.journal_withdrawal_obligation.JournalWithdrawalObligation`)
comes back with no record that the vault copy is owed (#3214).

The procedure this module implements:

1. **Before** the restore, :func:`export_tombstones` reads every such request
   the live database records (the sources declared in
   :data:`domain.retention.TOMBSTONE_SOURCES`) into a content-free
   :class:`TombstoneSet`: ids, instants, a closed state and an opaque vault
   fingerprint -- no email, no content, no content hash. Where that file is
   kept is an owner decision (#3063 AC17).
2. **After** the restore and **before** cutover, :func:`reapply_tombstones`
   re-runs the account-deletion sweep for every resurrected account,
   re-stamps every resurrected entry, re-records every owed withdrawal and
   re-stamps every Intimate tier, then marks the restore complete.

Safety properties:

* It refuses before touching a row while the deletion policy, the retention
  registry or the tombstone registry has a gap.
* It is idempotent: an account already gone is skipped, an entry already
  stamped, an obligation already recorded and a page already Intimate are
  skipped, and a run interrupted midway converges when rerun.
* An account created at or after its tombstone's instant is not the deleted
  account (an id reused after the backup) and is never touched; an entry
  whose owner or stored creation stamp differs from its tombstone's is a new
  page holding a reused id, and is likewise skipped -- for every entry-keyed
  kind. Both are counted as identity mismatches.
* A restore marked complete refuses to be reapplied again: after cutover the
  database's sequences have moved on and an entry id could name a new row.
* It dials nothing outside adepthood: resurrected accounts are swept with
  :meth:`AccountVaultDisposition.unconfigured`, entries are only re-stamped,
  and owed withdrawals are left to the background sweep to finish.

Every log line carries the restore id, counts, the build version and safe
failure codes -- never an email, a user id list, or a word anyone wrote.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import SQLModel, col

from domain.privacy_tier import admits_egress, egress_denied_clause
from domain.retention import retention_gaps, tombstone_gaps
from models.account_deletion_audit import AccountDeletionAudit
from models.journal_entry import VAULT_DESTINATION_WIDTH, JournalClassification, JournalEntry
from models.journal_withdrawal_obligation import (
    OPEN_STATES,
    JournalWithdrawalObligation,
    JournalWithdrawalState,
)
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
from services.journal_withdrawal_obligation import open_obligation, record_obligation

logger = logging.getLogger(__name__)

#: The tombstone file's format version. Bump on any field change.
#: Version 2 added the entry's creation stamp; version 3 added Intimate
#: entries and open withdrawal obligations (#3214). Older files are refused.
TOMBSTONE_FORMAT_VERSION: Final = 3

#: Opt-in startup gate: refuse to serve until this restore was reapplied.
RESTORE_SUPPRESSION_REQUIRED_ENV_VAR: Final = "RESTORE_SUPPRESSION_REQUIRED"
#: The restore id the gate requires a complete marker for.
RESTORE_ID_ENV_VAR: Final = "RESTORE_ID"
_GATE_ON = frozenset({"1", "true"})
_GATE_OFF = frozenset({"", "0", "false"})

_TOP_KEYS = frozenset({"version", "accounts", "entries", "intimate", "obligations"})
_ACCOUNT_KEYS = frozenset({"user_id", "deleted_at"})
_ENTRY_KEYS = frozenset({"entry_id", "user_id", "timestamp", "deleted_at"})
_INTIMATE_KEYS = frozenset({"entry_id", "user_id", "timestamp"})
_OBLIGATION_KEYS = frozenset({"entry_id", "user_id", "timestamp", "state", "destination"})


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

    def to_json(self) -> dict[str, object]:
        """The file form of one account tombstone."""
        return {"user_id": self.user_id, "deleted_at": self.deleted_at.isoformat()}


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

    def to_json(self) -> dict[str, object]:
        """The file form of one entry tombstone."""
        return {
            "entry_id": self.entry_id,
            "user_id": self.user_id,
            "timestamp": self.timestamp.isoformat(),
            "deleted_at": self.deleted_at.isoformat(),
        }


@dataclass(frozen=True)
class IntimateTombstone:
    """A live journal entry its writer made Intimate: which page, and whose.

    Carries the creation stamp for the same identity check as
    :class:`EntryTombstone`; the tier itself is the request, so nothing else is
    needed.
    """

    entry_id: int
    user_id: int
    timestamp: datetime

    def to_json(self) -> dict[str, object]:
        """The file form of one Intimate tombstone."""
        return {
            "entry_id": self.entry_id,
            "user_id": self.user_id,
            "timestamp": self.timestamp.isoformat(),
        }


@dataclass(frozen=True)
class ObligationTombstone:
    """A vault withdrawal still owed for one journal page.

    ``state`` is ``pending_delete`` (the writer asked to delete; the page stays
    live until the vault confirms) or ``unconfirmed`` (erased here; a copy may
    remain). ``destination`` is the opaque fingerprint of the vault the copy
    went to -- the binding only that vault's confirmation may clear -- or
    ``None`` for a copy made before destination binding. ``timestamp`` is the
    page's creation stamp, for the same identity check as :class:`EntryTombstone`.
    """

    entry_id: int
    user_id: int
    timestamp: datetime
    state: JournalWithdrawalState
    destination: str | None

    def to_json(self) -> dict[str, object]:
        """The file form of one obligation tombstone."""
        return {
            "entry_id": self.entry_id,
            "user_id": self.user_id,
            "timestamp": self.timestamp.isoformat(),
            "state": self.state.value,
            "destination": self.destination,
        }


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
    # Without an offset the value names no moment; this module always writes
    # one, so a missing offset means the file did not come from here.
    if parsed.tzinfo is None:
        msg = f"{key} carries no UTC offset"
        raise MalformedTombstoneError(msg)
    return parsed


def _open_state_field(item: Mapping[str, object]) -> JournalWithdrawalState:
    value = item["state"]
    if not isinstance(value, str) or value not in OPEN_STATES:
        msg = f"state must be one of {sorted(OPEN_STATES)}"
        raise MalformedTombstoneError(msg)
    return JournalWithdrawalState(value)


def _destination_field(item: Mapping[str, object]) -> str | None:
    value = item["destination"]
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > VAULT_DESTINATION_WIDTH:
        msg = f"destination must be null or a fingerprint of 1-{VAULT_DESTINATION_WIDTH} characters"
        raise MalformedTombstoneError(msg)
    return value


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


def _intimate_tombstone(item: Mapping[str, object]) -> IntimateTombstone:
    return IntimateTombstone(
        entry_id=_int_field(item, "entry_id"),
        user_id=_int_field(item, "user_id"),
        timestamp=_instant_field(item, "timestamp"),
    )


def _obligation_tombstone(item: Mapping[str, object]) -> ObligationTombstone:
    return ObligationTombstone(
        entry_id=_int_field(item, "entry_id"),
        user_id=_int_field(item, "user_id"),
        timestamp=_instant_field(item, "timestamp"),
        state=_open_state_field(item),
        destination=_destination_field(item),
    )


class _Serializable(Protocol):
    def to_json(self) -> dict[str, object]: ...


def _serialized(tombstones: Iterable[_Serializable]) -> list[dict[str, object]]:
    return [tombstone.to_json() for tombstone in tombstones]


def _accounts(document: Mapping[str, object]) -> tuple[AccountTombstone, ...]:
    return tuple(_account_tombstone(i) for i in _items(document, "accounts", _ACCOUNT_KEYS))


def _entries(document: Mapping[str, object]) -> tuple[EntryTombstone, ...]:
    return tuple(_entry_tombstone(i) for i in _items(document, "entries", _ENTRY_KEYS))


def _intimate(document: Mapping[str, object]) -> tuple[IntimateTombstone, ...]:
    return tuple(_intimate_tombstone(i) for i in _items(document, "intimate", _INTIMATE_KEYS))


def _obligations(document: Mapping[str, object]) -> tuple[ObligationTombstone, ...]:
    items = _items(document, "obligations", _OBLIGATION_KEYS)
    return tuple(_obligation_tombstone(i) for i in items)


@dataclass(frozen=True)
class TombstoneSet:
    """Content-free record of every deletion and withdrawal a restore could undo."""

    accounts: tuple[AccountTombstone, ...]
    entries: tuple[EntryTombstone, ...]
    intimate: tuple[IntimateTombstone, ...] = ()
    obligations: tuple[ObligationTombstone, ...] = ()
    version: int = TOMBSTONE_FORMAT_VERSION

    def to_json(self) -> dict[str, object]:
        """The file form: ids, ISO-8601 instants, a closed state and a fingerprint."""
        return {
            "version": self.version,
            "accounts": _serialized(self.accounts),
            "entries": _serialized(self.entries),
            "intimate": _serialized(self.intimate),
            "obligations": _serialized(self.obligations),
        }

    @classmethod
    def from_json(cls, document: object) -> TombstoneSet:
        """Parse a tombstone file strictly; anything unexpected is refused."""
        checked = _checked_document(document)
        return cls(
            accounts=_accounts(checked),
            entries=_entries(checked),
            intimate=_intimate(checked),
            obligations=_obligations(checked),
        )


@dataclass(frozen=True)
class ReapplyReceipt:
    """What one reapply run did, in counts."""

    restore_id: str
    accounts_reapplied: int
    accounts_absent: int
    entries_reapplied: int
    entries_absent: int
    identity_mismatches: int
    obligations_reapplied: int = 0
    obligations_absent: int = 0
    intimate_reapplied: int = 0
    intimate_absent: int = 0


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


async def _entry_tombstones(session: AsyncSession) -> tuple[EntryTombstone, ...]:
    """Every soft-deleted entry the live database holds.

    None of them belongs to an erased account -- erasure removes an account's
    pages outright -- so none is left to an account tombstone. Filtering by the
    erased ids would hide the deletions of a *new* account that was later
    handed an erased account's id (after a restore rewinds the sequence), and
    the next restore would resurrect them (#3162).
    """
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
    )


async def _intimate_tombstones(session: AsyncSession) -> tuple[IntimateTombstone, ...]:
    """Every live entry whose tier may not leave the boundary (Intimate, by policy).

    Judged by :mod:`domain.privacy_tier`, never an inline comparison: a tier
    the allowlist does not admit is withheld, so it is re-stamped Intimate.

    A soft-deleted Intimate page is already an entry tombstone, which is the
    stricter of the two, so it is not exported again here.
    """
    rows = await session.execute(
        select(col(JournalEntry.id), col(JournalEntry.user_id), col(JournalEntry.timestamp))
        .where(
            egress_denied_clause(col(JournalEntry.classification)),
            col(JournalEntry.deleted_at).is_(None),
        )
        .order_by(col(JournalEntry.id))
    )
    return tuple(
        IntimateTombstone(entry_id=entry_id, user_id=user_id, timestamp=_aware(created))
        for entry_id, user_id, created in rows.all()
    )


async def _obligation_tombstones(session: AsyncSession) -> tuple[ObligationTombstone, ...]:
    """Every open withdrawal obligation, with its page's creation stamp.

    Joined to the page it describes, owner and all, for the identity check. An
    open obligation whose page was already purged is left out: the purge waits
    until no live backup can still hold the page undeleted, and the obligation
    was committed together with that deletion stamp, so every backup a restore
    could use already carries the row itself.
    """
    rows = await session.execute(
        select(
            col(JournalWithdrawalObligation.journal_entry_id),
            col(JournalWithdrawalObligation.user_id),
            col(JournalEntry.timestamp),
            col(JournalWithdrawalObligation.state),
            col(JournalWithdrawalObligation.destination),
        )
        .join(
            JournalEntry,
            (col(JournalEntry.id) == col(JournalWithdrawalObligation.journal_entry_id))
            & (col(JournalEntry.user_id) == col(JournalWithdrawalObligation.user_id)),
        )
        .where(col(JournalWithdrawalObligation.state).in_(OPEN_STATES))
        .order_by(col(JournalWithdrawalObligation.journal_entry_id))
    )
    return tuple(
        ObligationTombstone(
            entry_id=entry_id,
            user_id=user_id,
            timestamp=_aware(created),
            state=JournalWithdrawalState(state),
            destination=destination,
        )
        for entry_id, user_id, created, state, destination in rows.all()
    )


def _require_complete_registries() -> None:
    """Refuse while any registry this procedure trusts has a hole in it."""
    require_total_policy()
    gaps = retention_gaps(SQLModel.metadata) + tombstone_gaps(SQLModel.metadata)
    if gaps:
        msg = "restore suppression refused: " + "; ".join(gaps)
        raise RetentionGapError(msg)


async def export_tombstones(session: AsyncSession) -> TombstoneSet:
    """Read every deletion and owed withdrawal the live database records, content-free.

    An erased account's pages are gone from the live database, so reapplying
    its account sweep removes their restored copies; every soft-deleted page
    still present is exported as an entry tombstone of its own, every live
    Intimate page as an Intimate tombstone, and every open withdrawal
    obligation as an obligation tombstone.
    """
    _require_complete_registries()
    tombstones = TombstoneSet(
        accounts=await _account_tombstones(session),
        entries=await _entry_tombstones(session),
        intimate=await _intimate_tombstones(session),
        obligations=await _obligation_tombstones(session),
    )
    logger.info(
        "restore_tombstones_exported",
        extra={
            "accounts": len(tombstones.accounts),
            "entries": len(tombstones.entries),
            "intimate": len(tombstones.intimate),
            "obligations": len(tombstones.obligations),
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
    obligations_reapplied: int = 0
    obligations_absent: int = 0
    intimate_reapplied: int = 0
    intimate_absent: int = 0


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


def _is_described_page(entry: JournalEntry, *, user_id: int, timestamp: datetime) -> bool:
    """Whether ``entry`` is the very page a tombstone describes: same owner, same creation stamp.

    After a restore the rewound sequence can hand a page's id to a new page,
    which will not share its creation stamp to the microsecond. The one
    residual case is two pages both backdated (``entry_date``) to the same
    calendar day, which share a noon-UTC stamp; the startup gate, which keeps
    the restored app from taking writes before reapply, closes that window.
    ``updated_at`` would not do: any write after the restore (an edit, a
    recovery sweep) moves it, and would leave the described page untouched.
    """
    return entry.user_id == user_id and _aware(entry.timestamp) == timestamp


async def _withdraw_locally(session: AsyncSession, *, user_id: int, entry_id: int) -> None:
    """Take the page out of the corpus and owe every essay offer's withdrawal. Does not commit.

    Any essay offer the restore resurrected becomes an owed, idempotent
    withdrawal again rather than a silent "never offered".
    """
    await withdraw_local_journal_entry(session, user_id=user_id, entry_id=entry_id)
    await mark_entry_retractions_pending(session, user_id=user_id, entry_id=entry_id)


async def _reapply_entry(
    factory: async_sessionmaker[AsyncSession], tombstone: EntryTombstone, tally: _Tally
) -> None:
    """Re-stamp one resurrected entry's soft delete."""
    async with factory() as session:
        entry = await session.get(JournalEntry, tombstone.entry_id)
        if entry is None or entry.deleted_at is not None:
            tally.entries_absent += 1
            return
        if not _is_described_page(entry, user_id=tombstone.user_id, timestamp=tombstone.timestamp):
            tally.identity_mismatches += 1
            return
        await _withdraw_locally(session, user_id=tombstone.user_id, entry_id=tombstone.entry_id)
        # A confirmed delete stamped ``deleted_at`` only after the vault
        # confirmed the remote copy absent (routers.journal.delete_journal_entry),
        # so the restored handle names nothing; clearing it stops a retry
        # dialling for a copy that is already gone. A page erased here with its
        # copy unconfirmed also has an obligation tombstone, which re-records
        # the copy bound to its vault -- the record the sweep works from.
        entry.vault_ref = None
        entry.deleted_at = tombstone.deleted_at
        session.add(entry)
        await session.commit()
        tally.entries_reapplied += 1


async def _already_owed(session: AsyncSession, tombstone: ObligationTombstone) -> bool:
    """Whether the restored database already owes this withdrawal, exactly as recorded."""
    existing = await open_obligation(
        session, user_id=tombstone.user_id, entry_id=tombstone.entry_id
    )
    return (
        existing is not None
        and existing.state == tombstone.state.value
        and existing.destination == tombstone.destination
    )


async def _reapply_obligation(
    factory: async_sessionmaker[AsyncSession], tombstone: ObligationTombstone, tally: _Tally
) -> None:
    """Re-record one owed withdrawal, so the background sweep finishes it.

    The local half of the request is repeated in the same commit, as
    ``begin_deletion`` does it: the corpus copy goes and every essay offer is
    owed. The obligation keeps its recorded vault binding, so only that vault's
    confirmation can clear it.
    """
    async with factory() as session:
        entry = await session.get(JournalEntry, tombstone.entry_id)
        if entry is None:
            tally.obligations_absent += 1
            return
        if not _is_described_page(entry, user_id=tombstone.user_id, timestamp=tombstone.timestamp):
            tally.identity_mismatches += 1
            return
        if await _already_owed(session, tombstone):
            tally.obligations_absent += 1
            return
        await _withdraw_locally(session, user_id=tombstone.user_id, entry_id=tombstone.entry_id)
        await record_obligation(
            session,
            user_id=tombstone.user_id,
            entry_id=tombstone.entry_id,
            state=tombstone.state,
            destination=tombstone.destination,
        )
        await session.commit()
        tally.obligations_reapplied += 1


async def _reapply_intimate(
    factory: async_sessionmaker[AsyncSession], tombstone: IntimateTombstone, tally: _Tally
) -> None:
    """Re-stamp one resurrected page's Intimate tier, with its local withdrawal, in one commit.

    The tier, the corpus withdrawal and the essay retractions share one commit,
    as the Intimate PATCH commits them (#3162): a reapply killed midway leaves
    either nothing done or all of it. The page's vault marker is left held, so
    the background sweep withdraws whatever copy it still names.
    """
    async with factory() as session:
        entry = await session.get(JournalEntry, tombstone.entry_id)
        if entry is None or entry.deleted_at is not None or not admits_egress(entry.classification):
            tally.intimate_absent += 1
            return
        if not _is_described_page(entry, user_id=tombstone.user_id, timestamp=tombstone.timestamp):
            tally.identity_mismatches += 1
            return
        entry.classification = JournalClassification.INTIMATE
        await _withdraw_locally(session, user_id=tombstone.user_id, entry_id=tombstone.entry_id)
        session.add(entry)
        await session.commit()
        tally.intimate_reapplied += 1


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
        marker.obligations_reapplied = tally.obligations_reapplied
        marker.intimate_reapplied = tally.intimate_reapplied
        marker.build_version = configured_release()
        session.add(marker)
        await session.commit()


async def _reapply_all(
    factory: async_sessionmaker[AsyncSession], tombstones: TombstoneSet, tally: _Tally
) -> None:
    """Apply every tombstone, accounts first: an erased account owes nothing else.

    Obligations before Intimate re-stamps is order-safe. Neither step reads what
    the other writes: the obligation step ignores the tier, and the Intimate step
    ignores obligations. The local withdrawal they share is idempotent, so a page
    that has both tombstones ends in the same state whichever runs first.
    """
    for account in tombstones.accounts:
        await _reapply_account(factory, account, tally)
    for entry in tombstones.entries:
        await _reapply_entry(factory, entry, tally)
    for obligation in tombstones.obligations:
        await _reapply_obligation(factory, obligation, tally)
    for intimate in tombstones.intimate:
        await _reapply_intimate(factory, intimate, tally)


async def reapply_tombstones(
    factory: async_sessionmaker[AsyncSession],
    tombstones: TombstoneSet,
    *,
    restore_id: str,
) -> ReapplyReceipt:
    """Apply a tombstone set to a restored database, before cutover.

    Commits per account, per entry, per obligation and per Intimate page, so an
    interrupted run leaves a consistent database and the marker
    ``in_progress``; rerunning converges.
    """
    _require_complete_registries()
    await _open_marker(factory, restore_id)
    logger.info(
        "restore_reapply_started",
        extra={"restore_id": restore_id, "build_version": configured_release()},
    )
    tally = _Tally()
    try:
        await _reapply_all(factory, tombstones, tally)
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
