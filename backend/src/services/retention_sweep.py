"""Every ratified retention period, applied in one nightly run (#3266, #3063 AC18).

The owner ratified a lifetime for every table on 2026-10-13
(``docs/privacy/retention-proposal.md``); this module applies them. Each store
is one :class:`StoreSweep`. Three call the services the admin maintenance
routes already used (energy plans, feedback reports, the soft-deleted journal
purge); the rest delete rows whose own clock has passed the ratified period.

Nothing here restates a period or an exclusion. Each window is the ``days`` of
the store's rule in :data:`domain.retention.RETENTION` (read through
:func:`domain.retention.nightly_rules`), and the states a sweep must never touch
are :data:`domain.retention.NEVER_ELIGIBLE_STATES`. A test holds the stores this
module sweeps equal to the rules that name the nightly sweep.

Each sweep reports three counts and nothing else: rows eligible now, rows it
deleted (zero on a dry run), and rows *blocked* -- held past the period by an
exclusion (an open obligation, an unfinished teardown or restore, a sale still
claimed, a share link whose end was never recorded). No count carries an id.

The entrypoint, its logging and its exit code live in
``backend/scripts/retention_sweep.py``.
"""

from __future__ import annotations

import os
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Final, Protocol, cast

import sqlalchemy as sa
from sqlalchemy import CursorResult
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import SQLModel

from domain.retention import NEVER_ELIGIBLE_STATES, nightly_rules
from services.energy import delete_expired_energy_plans
from services.feedback import delete_expired_feedback_reports
from services.journal_retention import preview_soft_deleted_purge, purge_soft_deleted_entries
from services.restore_suppression import RESTORE_ID_ENV_VAR

#: The registry's name for the soft-deleted journal page rule.
SOFT_DELETED_ENTRIES: Final = "journalentry (soft-deleted)"

#: Errors one store may raise without stopping the others: the database
#: failing, a refused window (``ValueError``) or a purge gap (``RuntimeError``).
STORE_ERRORS: Final = (SQLAlchemyError, OSError, RuntimeError, ValueError)

_MS_PER_SECOND: Final = 1000


@dataclass(frozen=True)
class SweepCounts:
    """What one store's sweep found and did. Integers only, by construction."""

    eligible: int
    deleted: int
    blocked: int


class SweepRun(Protocol):
    """One store's sweep: count at ``now``'s cutoff, and delete unless ``dry_run``."""

    def __call__(
        self, session: AsyncSession, now: datetime, *, dry_run: bool
    ) -> Awaitable[SweepCounts]:
        """Sweep the store."""
        ...


@dataclass(frozen=True)
class StoreSweep:
    """One store: its name, the registry rules it applies, and how."""

    store: str
    covers: tuple[str, ...]
    run: SweepRun


@dataclass(frozen=True)
class StoreOutcome:
    """One store's result in a run: counts, or the failing error's class name."""

    store: str
    duration_ms: int
    counts: SweepCounts | None = None
    error: str | None = None


def _table(name: str) -> sa.Table:
    return SQLModel.metadata.tables[name]


def _days(store: str) -> int:
    """The ratified window of ``store``'s rule; a rule without one is a bug."""
    days = nightly_rules()[store].days
    if days is None:
        msg = f"{store}: the nightly sweep applies a rule with no window"
        raise ValueError(msg)
    return days


def _before(column: sa.ColumnElement[Any], cutoff: datetime) -> ColumnElement[bool]:
    """``column`` is set and earlier than ``cutoff`` -- never NULL, so it negates cleanly."""
    return sa.and_(column.is_not(None), column < cutoff)


def _exempt(table: sa.Table) -> ColumnElement[bool]:
    """Rows in a state the registry says is never eligible."""
    return table.c["state"].in_(sorted(NEVER_ELIGIBLE_STATES[table.name]))


async def _count(session: AsyncSession, table: sa.Table, where: ColumnElement[bool]) -> int:
    statement = sa.select(sa.func.count()).select_from(table).where(where)
    return int((await session.execute(statement)).scalar_one())


Clause = Callable[[sa.Table, datetime], ColumnElement[bool]]


def _table_sweep(name: str, eligible: Clause, blocked: Clause | None = None) -> StoreSweep:
    """A sweep that deletes ``name``'s rows matching ``eligible`` at the store's cutoff."""

    async def run(session: AsyncSession, now: datetime, *, dry_run: bool) -> SweepCounts:
        table = _table(name)
        cutoff = now - timedelta(days=_days(name))
        where = eligible(table, cutoff)
        found = await _count(session, table, where)
        held = 0 if blocked is None else await _count(session, table, blocked(table, cutoff))
        if dry_run or not found:
            return SweepCounts(eligible=found, deleted=0, blocked=held)
        result = cast("CursorResult[Any]", await session.execute(sa.delete(table).where(where)))
        await session.commit()
        # A driver that cannot report a row count still deleted what it matched.
        deleted = result.rowcount if result.rowcount >= 0 else found
        return SweepCounts(eligible=found, deleted=deleted, blocked=held)

    return StoreSweep(store=name, covers=(name,), run=run)


def _created_before(column: str) -> Clause:
    """Rows whose ``column`` -- the clock the period counts from -- is past the cutoff."""
    return lambda table, cutoff: _before(table.c[column], cutoff)


def _confirmed_before(table: sa.Table, cutoff: datetime) -> ColumnElement[bool]:
    """A settled row whose confirmation is older than the cutoff."""
    return sa.and_(~_exempt(table), _before(table.c["confirmed_at"], cutoff))


def _held_open_since(column: str) -> Clause:
    """A never-eligible row that has been open longer than the period."""
    return lambda table, cutoff: sa.and_(_exempt(table), _before(table.c[column], cutoff))


# --------------------------------------------------------------------------
# gumroadsale: only an anonymised receipt, and never one still claimed
# --------------------------------------------------------------------------


def _sale_claimed(sale: sa.Table) -> ColumnElement[bool]:
    """A grant or a licence binding still points at the sale."""
    entitlement = _table("entitlement")
    binding = _table("licensebinding")
    return sa.or_(
        sa.exists().where(entitlement.c["source_sale_id"] == sale.c["id"]),
        sa.exists().where(binding.c["gumroad_sale_id"] == sale.c["gumroad_sale_id"]),
    )


def _sale_eligible(sale: sa.Table, cutoff: datetime) -> ColumnElement[bool]:
    """Anonymised before the cutoff, and nothing still claims it."""
    return sa.and_(_before(sale.c["anonymised_at"], cutoff), ~_sale_claimed(sale))


def _sale_blocked(sale: sa.Table, cutoff: datetime) -> ColumnElement[bool]:
    """Anonymised before the cutoff, but a grant or binding still claims it."""
    return sa.and_(_before(sale.c["anonymised_at"], cutoff), _sale_claimed(sale))


# --------------------------------------------------------------------------
# practicesharelink: dead (revoked or expired) for longer than the period
# --------------------------------------------------------------------------


def _link_dead_before(link: sa.Table, cutoff: datetime) -> ColumnElement[bool]:
    """Revoked or expired before the cutoff."""
    return sa.or_(_before(link.c["revoked_at"], cutoff), _before(link.c["expires_at"], cutoff))


def _link_used_up_undated(link: sa.Table, cutoff: datetime) -> ColumnElement[bool]:
    """Used up, but no column records when; held until it expires or is revoked.

    ``created_at`` only bounds the link's age, not its death, so it cannot start
    the clock: a link used up yesterday would go today.
    """
    return sa.and_(
        link.c["max_uses"].is_not(None),
        link.c["use_count"] >= link.c["max_uses"],
        ~_link_dead_before(link, cutoff),
        _before(link.c["created_at"], cutoff),
    )


# --------------------------------------------------------------------------
# restoremarker: complete, and not the restore the startup gate names
# --------------------------------------------------------------------------


def _named_restore(marker: sa.Table) -> ColumnElement[bool]:
    """The marker ``RESTORE_ID`` names, read when the sweep runs."""
    restore_id = os.getenv(RESTORE_ID_ENV_VAR, "").strip()
    return marker.c["restore_id"] == restore_id if restore_id else sa.false()


def _marker_eligible(marker: sa.Table, cutoff: datetime) -> ColumnElement[bool]:
    """A complete marker, not the named one, finished before the cutoff."""
    return sa.and_(
        ~_exempt(marker),
        ~_named_restore(marker),
        _before(marker.c["completed_at"], cutoff),
    )


def _marker_blocked(marker: sa.Table, cutoff: datetime) -> ColumnElement[bool]:
    """An unfinished restore older than the period, or the finished one the gate names."""
    return sa.or_(
        sa.and_(_exempt(marker), _before(marker.c["started_at"], cutoff)),
        sa.and_(
            ~_exempt(marker), _named_restore(marker), _before(marker.c["completed_at"], cutoff)
        ),
    )


# --------------------------------------------------------------------------
# The three sweeps that already had an admin route, called as services
# --------------------------------------------------------------------------


async def _energy_plans(session: AsyncSession, now: datetime, *, dry_run: bool) -> SweepCounts:
    """Energy plans past the week, through the admin route's own service."""
    days = _days("energyplan")
    plans = _table("energyplan")
    found = await _count(session, plans, _before(plans.c["created_at"], now - timedelta(days=days)))
    if dry_run:
        return SweepCounts(eligible=found, deleted=0, blocked=0)
    deleted = await delete_expired_energy_plans(session, older_than_days=days)
    return SweepCounts(eligible=found, deleted=deleted, blocked=0)


async def _feedback_reports(session: AsyncSession, now: datetime, *, dry_run: bool) -> SweepCounts:
    """Reports past the window, with their notes and triage, through the route's service."""
    days = _days("feedbackreport")
    reports = _table("feedbackreport")
    found = await _count(
        session, reports, _before(reports.c["created_at"], now - timedelta(days=days))
    )
    if dry_run:
        return SweepCounts(eligible=found, deleted=0, blocked=0)
    deleted = await delete_expired_feedback_reports(session, older_than_days=days)
    return SweepCounts(eligible=found, deleted=deleted, blocked=0)


async def _soft_deleted_entries(
    session: AsyncSession, now: datetime, *, dry_run: bool
) -> SweepCounts:
    """The journal purge reads its own clock; ``now`` only matters to the other stores."""
    del now
    days = _days(SOFT_DELETED_ENTRIES)
    preview = await preview_soft_deleted_purge(session, older_than_days=days)
    if dry_run:
        return SweepCounts(eligible=preview.deleted, deleted=0, blocked=preview.blocked)
    result = await purge_soft_deleted_entries(session, older_than_days=days)
    return SweepCounts(eligible=preview.deleted, deleted=result.deleted, blocked=result.blocked)


#: Every store, in the order a run sweeps them.
SWEEPS: Final[tuple[StoreSweep, ...]] = (
    StoreSweep(store="energyplan", covers=("energyplan",), run=_energy_plans),
    StoreSweep(
        store="feedbackreport",
        covers=("feedbackreport", "feedbacknote", "feedbacktriageevent"),
        run=_feedback_reports,
    ),
    StoreSweep(
        store=SOFT_DELETED_ENTRIES, covers=(SOFT_DELETED_ENTRIES,), run=_soft_deleted_entries
    ),
    _table_sweep("journalwithdrawalobligation", _confirmed_before, _held_open_since("created_at")),
    _table_sweep("voicedraftretraction", _confirmed_before, _held_open_since("created_at")),
    _table_sweep("accountdeletionaudit", _created_before("deleted_at")),
    _table_sweep("gumroadsale", _sale_eligible, _sale_blocked),
    _table_sweep("loginattempt", _created_before("created_at")),
    _table_sweep("llmusagelog", _created_before("timestamp")),
    _table_sweep("revokedtoken", _created_before("expires_at")),
    _table_sweep("practicesharelink", _link_dead_before, _link_used_up_undated),
    _table_sweep("vaultteardownreceipt", _confirmed_before, _held_open_since("requested_at")),
    _table_sweep("restoremarker", _marker_eligible, _marker_blocked),
)

_BY_STORE: Final[Mapping[str, StoreSweep]] = {sweep.store: sweep for sweep in SWEEPS}


def sweep_for(store: str) -> StoreSweep:
    """The sweep for ``store``; ``KeyError`` for a store nothing sweeps."""
    return _BY_STORE[store]


SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


def _elapsed_ms(started: float) -> int:
    return round((time.monotonic() - started) * _MS_PER_SECOND)


async def _sweep_one(
    factory: SessionFactory, sweep: StoreSweep, now: datetime, *, dry_run: bool
) -> StoreOutcome:
    """Run one store in its own session; a failure is rolled back and reported by class."""
    started = time.monotonic()
    async with factory() as session:
        try:
            counts = await sweep.run(session, now, dry_run=dry_run)
        except STORE_ERRORS as exc:
            await session.rollback()
            return StoreOutcome(
                store=sweep.store, duration_ms=_elapsed_ms(started), error=type(exc).__name__
            )
    return StoreOutcome(store=sweep.store, duration_ms=_elapsed_ms(started), counts=counts)


async def run_sweeps(
    factory: SessionFactory,
    *,
    now: datetime,
    dry_run: bool,
    sweeps: Sequence[StoreSweep] = SWEEPS,
) -> list[StoreOutcome]:
    """Sweep every store in turn. One store failing never stops the next."""
    return [await _sweep_one(factory, sweep, now, dry_run=dry_run) for sweep in sweeps]
