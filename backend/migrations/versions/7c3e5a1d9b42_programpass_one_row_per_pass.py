"""Record each pass through the stages as its own ``programpass`` row.

Revision ID: 7c3e5a1d9b42
Revises: 166523efc36e
Create Date: 2026-11-17 00:00:00.000000

Begin-again kept only ``stageprogress.past_cycle_anchors``, a list of start
instants: no end, and no record of how far each pass got (issue #3723). This
creates ``programpass`` -- one row per pass, with its start and end day in the
account's zone, how it began, and the stage and week it reached -- and
backfills it from what ``stageprogress`` already holds.

The backfill
------------
For every ``stageprogress`` row: one pass per entry in ``past_cycle_anchors``
plus the live one from ``program_started_at`` (``stage_started_at`` for a legacy
row without it, exactly as ``resolve_program_anchor`` reads it). Element ``i``
of the anchor list is cycle ``i + 1``'s start, so ``pass_number`` follows
``cycle_number``. A past pass ends the day before the next pass starts and is
measured from its own start. Every row is ``origin = 'backfill'``.

A ``None`` anchor was destroyed before #2894 and is not recoverable, so it
produces NO row and the numbering keeps a gap rather than a guess -- the same
refusal ``a1f7c2b9d604`` documents. A list shorter than ``cycle_number - 1``
(a row that looped before that revision's backfill reached it) is left-padded
with ``None`` the way ``_padded_anchors`` in ``routers/stages.py`` pads it. A
user with no ``stageprogress`` row never began the program and gets no pass.

Frozen logic
------------
The stage schedule and the measuring arithmetic are copied here rather than
imported from ``src``, so this revision means the same thing forever. They
mirror ``domain.constants.STAGE_DURATIONS_DAYS`` and
``domain.program_pass.close_pass`` at the time of writing; the round-trip test
asserts the two agree.

``downgrade()`` drops the table. ``past_cycle_anchors`` is never written here,
so nothing a prior build reads is lost; every pass closed by begin-again since
the upgrade is.
"""

import json
from bisect import bisect_right
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta, tzinfo
from itertools import accumulate
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "7c3e5a1d9b42"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "166523efc36e"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "programpass"
_USER_INDEX = "ix_programpass_user_id"
_BACKFILL = "backfill"

# Frozen at this revision (mirrors domain.constants.STAGE_DURATIONS_DAYS).
_STAGE_DURATIONS_DAYS = (21, 21, 21, 21, 21, 21, 21, 21, 42, 42)
_DAYS_PER_WEEK = 7
_TOTAL_DAYS = sum(_STAGE_DURATIONS_DAYS)
_TOTAL_WEEKS = _TOTAL_DAYS // _DAYS_PER_WEEK
_TOTAL_STAGES = len(_STAGE_DURATIONS_DAYS)
_STAGE_OPENINGS = (0, *accumulate(_STAGE_DURATIONS_DAYS[:-1]))
_ONE_DAY = timedelta(days=1)

# A fixed literal over this revision's own tables; nothing is interpolated.
_SELECT_PROGRESS = sa.text(
    "SELECT sp.user_id, sp.cycle_number, sp.program_started_at, sp.stage_started_at,"
    ' sp.past_cycle_anchors, u.timezone FROM stageprogress sp JOIN "user" u'
    " ON u.id = sp.user_id ORDER BY sp.user_id"
)


def _zone(name: str | None) -> tzinfo:
    """The account's zone, or UTC -- the app's own fallback -- when it cannot be loaded."""
    if not name:
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def _day(value: object, zone: tzinfo) -> date | None:
    """The account-zone day of a stored instant (naive means UTC); ``None`` stays unknown."""
    if value is None:
        return None
    moment = value if isinstance(value, datetime) else datetime.fromisoformat(str(value))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(zone).date()


def _past_anchors(raw: object, cycle_number: int) -> list[object]:
    """One entry per past cycle, left-padded with ``None`` for each destroyed anchor."""
    decoded = json.loads(raw) if isinstance(raw, str) else raw
    retained = list(decoded) if isinstance(decoded, list) else []
    past = max(0, cycle_number - 1)
    padded = [None] * max(0, past - len(retained)) + retained
    return padded[:past]


def _closed(started_on: date, ended_on: date) -> dict[str, Any]:
    """How far a pass got by ``ended_on``, from its own start (frozen ``close_pass``)."""
    elapsed = max(0, (ended_on - started_on).days)
    return {
        "ended_on": ended_on,
        "reached_stage": min(bisect_right(_STAGE_OPENINGS, elapsed), _TOTAL_STAGES),
        "reached_week": min(elapsed // _DAYS_PER_WEEK + 1, _TOTAL_WEEKS),
        "completed": elapsed >= _TOTAL_DAYS - 1,
    }


def _live() -> dict[str, Any]:
    """The live pass: no end and nothing reached yet."""
    return {"ended_on": None, "reached_stage": None, "reached_week": None, "completed": False}


def _passes_for(row: sa.Row[Any]) -> list[dict[str, Any]]:
    """Every pass one ``stageprogress`` row implies, skipping cycles whose start is lost."""
    user_id, cycle_number, program_started_at, stage_started_at, raw_anchors, tz = row
    zone = _zone(tz)
    starts = [_day(anchor, zone) for anchor in _past_anchors(raw_anchors, cycle_number)]
    starts.append(_day(program_started_at or stage_started_at, zone))
    passes: list[dict[str, Any]] = []
    for index, started_on in enumerate(starts):
        following = starts[index + 1] if index + 1 < len(starts) else None
        is_live = index == len(starts) - 1
        if started_on is None or (following is None and not is_live):
            continue
        shape = _live() if following is None else _closed(started_on, following - _ONE_DAY)
        passes.append(
            {
                "user_id": user_id,
                "pass_number": index + 1,
                "started_on": started_on,
                "origin": _BACKFILL,
                **shape,
            }
        )
    return passes


def upgrade() -> None:
    """Create ``programpass`` and backfill one row per known pass."""
    table = op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("pass_number", sa.Integer(), nullable=False),
        sa.Column("started_on", sa.Date(), nullable=False),
        sa.Column("ended_on", sa.Date(), nullable=True),
        sa.Column("origin", sa.String(length=32), nullable=False),
        sa.Column("reached_stage", sa.Integer(), nullable=True),
        sa.Column("reached_week", sa.Integer(), nullable=True),
        sa.Column("completed", sa.Boolean(), nullable=False),
        sa.CheckConstraint("pass_number >= 1", name="ck_programpass_pass_number_positive"),
        sa.CheckConstraint(
            "origin IN ('first_run', 'rescaffold', 'begin_again', 'backfill')",
            name="ck_programpass_origin_valid",
        ),
        sa.CheckConstraint(
            "reached_stage IS NULL OR (reached_stage >= 1 AND reached_stage <= 10)",
            name="ck_programpass_reached_stage_range",
        ),
        sa.CheckConstraint(
            "reached_week IS NULL OR (reached_week >= 1 AND reached_week <= 36)",
            name="ck_programpass_reached_week_range",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "pass_number", name="uq_programpass_user_pass_number"),
    )
    op.create_index(_USER_INDEX, _TABLE, ["user_id"], unique=False)

    rows = op.get_bind().execute(_SELECT_PROGRESS).all()
    passes = [pass_ for row in rows for pass_ in _passes_for(row)]
    if passes:
        op.bulk_insert(table, passes)


def downgrade() -> None:
    """Drop the pass record; ``stageprogress`` and its anchors are untouched."""
    op.drop_index(_USER_INDEX, table_name=_TABLE)
    op.drop_table(_TABLE)
