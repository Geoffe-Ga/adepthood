"""Log every habit unlock and re-lock as a ``habitunlockevent`` row.

Revision ID: 9d2b6e4f1a73
Revises: 7c3e5a1d9b42
Create Date: 2026-11-17 00:00:00.000000

``Habit.revealed`` is a boolean and ``Habit.auto_revealed_at`` a one-shot
stamp, so a second unlock left no trace (issue #3724). This creates
``habitunlockevent`` -- one row per lock-state change of a program habit,
tagged with its pass and program number -- and backfills the one unlock that
can still be dated for each habit that is open today.

The backfill
------------
One ``unlocked`` / ``backfill`` event per currently revealed non-carryover
habit, dated:

1. at ``auto_revealed_at`` when it is set;
2. otherwise at the start (local midnight) of the habit's earliest
   ``goalcompletion.local_day`` with ``completed_units > 0``;
3. otherwise not at all -- there is no date to give it, so it is skipped.

``local_day`` is the day in the account's zone. ``pass_id`` is the account's
pass whose ``[started_on, ended_on]`` holds that day (``ended_on`` NULL is
open-ended), ``NULL`` when none does. ``program_number`` is the habit's CURRENT
1-based position among the account's non-carryover habits in the habit list's
order (unnumbered first, then ``sort_order``, then ``id``): the number it had at
the real unlock is not recoverable.

Frozen logic
------------
The ordering and dating rules are written out here rather than imported from
``src``, so this revision means the same thing forever.

``downgrade()`` drops the table. Nothing else is written, so nothing a prior
build reads is lost; every event logged since the upgrade is.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9d2b6e4f1a73"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "7c3e5a1d9b42"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "habitunlockevent"
_INDEXES = (
    ("ix_habitunlockevent_user_id", "user_id"),
    ("ix_habitunlockevent_habit_id", "habit_id"),
    ("ix_habitunlockevent_pass_id", "pass_id"),
)
_UNLOCKED = "unlocked"
_BACKFILL = "backfill"

# Fixed literals over this revision's own tables; nothing is interpolated.
_SELECT_HABITS = sa.text(
    "SELECT h.id, h.user_id, h.revealed, h.auto_revealed_at, u.timezone FROM habit h"
    ' JOIN "user" u ON u.id = h.user_id WHERE h.is_carryover = :false'
    " ORDER BY h.user_id, CASE WHEN h.sort_order IS NULL THEN 0 ELSE 1 END,"
    " h.sort_order, h.id"
).bindparams(false=False)
_SELECT_FIRST_COMPLETIONS = sa.text(
    "SELECT g.habit_id, MIN(gc.local_day) FROM goalcompletion gc"
    " JOIN goal g ON g.id = gc.goal_id WHERE gc.completed_units > 0"
    " GROUP BY g.habit_id"
)
_SELECT_PASSES = sa.text(
    "SELECT id, user_id, started_on, ended_on FROM programpass ORDER BY user_id, pass_number"
)


@dataclass(frozen=True)
class _Pass:
    """One recorded pass's day range."""

    pass_id: int
    started_on: date
    ended_on: date | None

    def holds(self, day: date) -> bool:
        """Whether ``day`` falls inside this pass."""
        return self.started_on <= day and (self.ended_on is None or day <= self.ended_on)


def _zone(name: str | None) -> tzinfo:
    """The account's zone, or UTC -- the app's own fallback -- when it cannot be loaded."""
    if not name:
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def _as_date(value: object) -> date:
    """A stored ``DATE`` as a ``date`` (SQLite hands back ISO text)."""
    return value if isinstance(value, date) else date.fromisoformat(str(value))


def _as_instant(value: object) -> datetime:
    """A stored instant as an aware UTC ``datetime`` (naive means UTC)."""
    moment = value if isinstance(value, datetime) else datetime.fromisoformat(str(value))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


def _dated(
    stamp: object, first_completion: object, zone: tzinfo
) -> tuple[datetime, date] | None:
    """``(occurred_at, local_day)`` for one open habit, or ``None`` when it cannot be dated."""
    if stamp is not None:
        moment = _as_instant(stamp)
        return moment, moment.astimezone(zone).date()
    if first_completion is not None:
        day = _as_date(first_completion)
        return datetime.combine(day, time.min, tzinfo=zone).astimezone(UTC), day
    return None


def _passes_by_user(bind: sa.Connection) -> dict[int, list[_Pass]]:
    """Every account's recorded passes."""
    passes: dict[int, list[_Pass]] = {}
    for pass_id, user_id, started_on, ended_on in bind.execute(_SELECT_PASSES).all():
        passes.setdefault(user_id, []).append(
            _Pass(pass_id, _as_date(started_on), None if ended_on is None else _as_date(ended_on))
        )
    return passes


def _pass_holding(passes: list[_Pass], day: date) -> int | None:
    """The latest pass holding ``day``, or ``None`` when none does."""
    holding = [pass_.pass_id for pass_ in passes if pass_.holds(day)]
    return holding[-1] if holding else None


def _backfill_rows(bind: sa.Connection) -> list[dict[str, Any]]:
    """One backfill event per open program habit that can be dated."""
    first_completions = dict(bind.execute(_SELECT_FIRST_COMPLETIONS).all())
    passes = _passes_by_user(bind)
    positions: dict[int, int] = {}
    rows: list[dict[str, Any]] = []
    for habit_id, user_id, revealed, stamp, tz in bind.execute(_SELECT_HABITS).all():
        positions[user_id] = positions.get(user_id, 0) + 1
        dated = _dated(stamp, first_completions.get(habit_id), _zone(tz)) if revealed else None
        if dated is None:
            continue
        occurred_at, local_day = dated
        rows.append(
            {
                "user_id": user_id,
                "habit_id": habit_id,
                "pass_id": _pass_holding(passes.get(user_id, []), local_day),
                "kind": _UNLOCKED,
                "occurred_at": occurred_at,
                "local_day": local_day,
                "program_number": positions[user_id],
                "source": _BACKFILL,
            }
        )
    return rows


def upgrade() -> None:
    """Create ``habitunlockevent`` and backfill one unlock per open program habit."""
    table = op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("habit_id", sa.Integer(), nullable=False),
        sa.Column("pass_id", sa.Integer(), nullable=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("local_day", sa.Date(), nullable=False),
        sa.Column("program_number", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.CheckConstraint(
            "kind IN ('unlocked', 'relocked')", name="ck_habitunlockevent_kind_valid"
        ),
        sa.CheckConstraint(
            "source IN ('manual', 'auto_reveal', 'created_unlocked', 'backfill')",
            name="ck_habitunlockevent_source_valid",
        ),
        sa.CheckConstraint(
            "program_number >= 1", name="ck_habitunlockevent_program_number_positive"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["habit_id"], ["habit.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["pass_id"], ["programpass.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    for name, column in _INDEXES:
        op.create_index(name, _TABLE, [column], unique=False)

    rows = _backfill_rows(op.get_bind())
    if rows:
        op.bulk_insert(table, rows)


def downgrade() -> None:
    """Drop the unlock log; habits and their stamps are untouched."""
    for name, _ in _INDEXES:
        op.drop_index(name, table_name=_TABLE)
    op.drop_table(_TABLE)
