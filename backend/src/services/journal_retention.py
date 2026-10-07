"""Operator-invoked purge of soft-deleted journal entries (#3063 AC13).

A deleted page is soft-deleted (BUG-JOURNAL-007): hidden from every read path,
but kept -- together with its encrypted margin notes, promoted passages and
completion suggestions -- until the account is erased. This module is the
operator's lever for ending that sooner: it hard-deletes entries soft-deleted
more than ``older_than_days`` ago.

What happens to the rows that point at a purged entry is not hand-listed here.
It is read off the schema by :func:`domain.retention.entry_dependants` (a
cascade deletes, ``SET NULL`` and the stated overrides null), so a new
reference is a refusal until somebody decides it, never a silently dangling or
silently cascaded row. The statements are issued explicitly, deepest
dependants first, so SQLite and Postgres reach the same result.

An entry with an unsettled obligation (:data:`domain.retention.ENTRY_PURGE_BLOCKERS`
-- an essay whose remote withdrawal is not confirmed) is skipped and counted:
purging it would cascade away the only record that a withdrawal is owed.

**The window has a floor: the longest backup lifetime.** A purge removes the
entry's only tombstone (its ``deleted_at`` stamp), so restore suppression can
no longer re-delete it. That is safe only when no backup still alive holds the
entry *undeleted*. A backup alive at purge time was taken at most
:data:`~domain.retention_stores.LONGEST_BACKUP_RETENTION_DAYS` ago; an entry
soft-deleted more than that long ago was therefore already stamped deleted in
every such backup, and restoring any of them brings it back hidden. The
argument rests on the backup retention the inventory states (pinned to
DEPLOYMENT.md by a drift test): keeping a backup longer than that, or raising
it without raising the constant, breaks it. Below the floor the purge refuses.

There is no schedule and no default window: when, and how old beyond the
floor, are owner decisions (#3063 AC15, AC18). Logs carry counts only.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final, cast

import sqlalchemy as sa
from sqlalchemy import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import SQLModel

from domain.retention import (
    ENTRY_PURGE_BLOCKERS,
    ENTRY_TABLE,
    EntryDependant,
    PurgeAction,
    entry_dependant_gaps,
    entry_dependants,
)
from domain.retention_stores import LONGEST_BACKUP_RETENTION_DAYS

logger = logging.getLogger(__name__)

#: The shortest window the purge accepts (see the module docstring).
PURGE_MIN_RETENTION_DAYS: Final = LONGEST_BACKUP_RETENTION_DAYS

#: Entries purged per transaction, so one sweep never holds a long write lock.
PURGE_BATCH_SIZE: Final = 200


class EntryPurgeGapError(RuntimeError):
    """A reference into an entry has no stated purge action; nothing was purged."""


@dataclass(frozen=True)
class EntryPurgeResult:
    """What one purge did, in counts."""

    deleted: int
    blocked: int


def _table(name: str) -> sa.Table:
    return SQLModel.metadata.tables[name]


def _unsettled(entry_id: sa.ColumnElement[Any]) -> list[ColumnElement[bool]]:
    """``EXISTS`` clauses that are true while ``entry_id`` has an unsettled obligation."""
    clauses: list[ColumnElement[bool]] = []
    for name, blocker in ENTRY_PURGE_BLOCKERS.items():
        table = _table(name)
        clauses.append(
            sa.exists().where(
                table.c[blocker.entry_column] == entry_id,
                table.c[blocker.state_column].not_in(blocker.cleared_states),
            )
        )
    return clauses


def _expired(cutoff: datetime) -> ColumnElement[bool]:
    entries = _table(ENTRY_TABLE)
    return sa.and_(entries.c["deleted_at"].is_not(None), entries.c["deleted_at"] < cutoff)


async def _count_blocked(session: AsyncSession, cutoff: datetime) -> int:
    entries = _table(ENTRY_TABLE)
    blocked = _unsettled(entries.c["id"])
    if not blocked:
        return 0
    result = await session.execute(
        sa.select(sa.func.count()).select_from(entries).where(_expired(cutoff), sa.or_(*blocked))
    )
    return int(result.scalar_one())


async def _next_batch(session: AsyncSession, cutoff: datetime) -> list[int]:
    entries = _table(ENTRY_TABLE)
    statement = sa.select(entries.c["id"]).where(_expired(cutoff))
    for clause in _unsettled(entries.c["id"]):
        statement = statement.where(~clause)
    result = await session.execute(statement.order_by(entries.c["id"]).limit(PURGE_BATCH_SIZE))
    return [int(entry_id) for entry_id in result.scalars()]


def _targets(dependant: EntryDependant, entry_ids: Sequence[int]) -> Select[Any] | Sequence[int]:
    """The values of ``dependant.referenced_column`` that the purge reaches."""
    if dependant.parent is None:
        return entry_ids
    parent = _table(dependant.parent.table)
    return sa.select(parent.c[dependant.referenced_column]).where(
        parent.c[dependant.parent.column].in_(_targets(dependant.parent, entry_ids))
    )


def _depth(dependant: EntryDependant) -> int:
    return 0 if dependant.parent is None else 1 + _depth(dependant.parent)


async def _apply(
    session: AsyncSession, dependant: EntryDependant, entry_ids: Sequence[int]
) -> None:
    table = _table(dependant.table)
    where = table.c[dependant.column].in_(_targets(dependant, entry_ids))
    if dependant.action is PurgeAction.DELETE:
        await session.execute(sa.delete(table).where(where))
    else:
        await session.execute(sa.update(table).where(where).values({dependant.column: None}))


async def _purge_batch(
    session: AsyncSession, dependants: Sequence[EntryDependant], entry_ids: Sequence[int]
) -> int:
    for dependant in sorted(dependants, key=_depth, reverse=True):
        await _apply(session, dependant, entry_ids)
    entries = _table(ENTRY_TABLE)
    result = cast(
        "CursorResult[Any]",
        await session.execute(sa.delete(entries).where(entries.c["id"].in_(entry_ids))),
    )
    await session.commit()
    # A driver that cannot report a row count still deleted exactly this batch.
    return result.rowcount if result.rowcount >= 0 else len(entry_ids)


async def purge_soft_deleted_entries(
    session: AsyncSession, *, older_than_days: int
) -> EntryPurgeResult:
    """Hard-delete entries soft-deleted more than ``older_than_days`` ago.

    Refuses a window shorter than the longest backup retention (see the
    module docstring) and refuses outright while any reference into an entry lacks a stated
    action. Commits per batch; returns counts only.
    """
    if older_than_days < PURGE_MIN_RETENTION_DAYS:
        msg = (
            f"older_than_days must be at least {PURGE_MIN_RETENTION_DAYS}, the longest "
            "backup retention; a shorter window could purge an entry a live backup "
            "still holds undeleted"
        )
        raise ValueError(msg)
    gaps = entry_dependant_gaps(SQLModel.metadata)
    if gaps:
        msg = "journal entry purge refused: " + "; ".join(gaps)
        raise EntryPurgeGapError(msg)
    cutoff = datetime.now(UTC) - timedelta(days=older_than_days)
    dependants = entry_dependants(SQLModel.metadata)
    blocked = await _count_blocked(session, cutoff)
    deleted = 0
    while batch := await _next_batch(session, cutoff):
        deleted += await _purge_batch(session, dependants, batch)
    return EntryPurgeResult(deleted=deleted, blocked=blocked)
