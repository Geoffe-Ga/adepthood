"""Add stageprogress.highest_stage_reached lifetime high-water mark.

Revision ID: d3e4f5a6b7c8
Revises: a7b8c9d0e1f2
Create Date: 2026-07-02 00:00:00.000000

Adds ``highest_stage_reached`` to ``stageprogress`` (issue #1177): the highest
stage a user has EVER reached by advancement, monotone and never cleared by
begin-again, so the Return arc stays eligible from any current stage once Blue
was ever passed. ``upgrade`` adds it NOT NULL with a temporary
``server_default='1'`` so existing rows backfill, rewrites each row to the
GREATEST of its ``current_stage``, its historical completed-stage max, and the
final stage when a full prior cycle ran (``cycle_number >= 2`` can only arise via
begin-again, which requires reaching the final stage, so such a row's true
lifetime mark is that stage even after begin-again cleared the history), then
drops the server default (the app owns the default via the model's ``Field`` default,
keeping ``alembic check`` drift-free) and installs a CHECK pinning the value
``>= 1`` — mirroring the model's ``__table_args__``. ``downgrade`` drops the
CHECK and the column.

The backfill runs row-by-row in Python so it stays portable across Postgres
(``completed_stages`` is an integer array) and the SQLite round-trip test
(``completed_stages`` is a JSON text column) without GREATEST/unnest/json_each
dialect gymnastics.
"""

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d3e4f5a6b7c8"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a7b8c9d0e1f2"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_HIGH_WATER_CHECK = "ck_stageprogress_highest_stage_reached_positive"
_HIGH_WATER_CONDITION = "highest_stage_reached >= 1"
# The final stage of a 10-stage cycle. A completed prior cycle (cycle_number >= 2)
# can only exist via begin-again, which requires reaching the final stage, so such
# a row's true lifetime mark is this stage even after begin-again cleared the
# stage history. Inlined (self-contained migration): equals ``domain.constants.TOTAL_STAGES``.
_COMPLETED_CYCLE_STAGE = 10
_SECOND_CYCLE = 2


def _completed_stages(raw: object) -> list[int]:
    """Normalise ``completed_stages`` from either an int array or JSON text.

    Postgres returns the column as a Python list; the SQLite round-trip test
    stores it as JSON text, so a ``str`` is parsed. Empty or null yields none.
    """
    if isinstance(raw, str):
        parsed = json.loads(raw) if raw else []
        return [int(value) for value in parsed]
    if isinstance(raw, list | tuple):
        return [int(value) for value in raw]
    return []


def _resolve_mark(current_stage: int, completed: object, cycle_number: int) -> int:
    """Lifetime high-water mark for one row: the GREATEST of its known reaches."""
    candidates = [current_stage, *_completed_stages(completed)]
    if cycle_number >= _SECOND_CYCLE:
        candidates.append(_COMPLETED_CYCLE_STAGE)
    return max(candidates)


def _backfill(bind: sa.Connection) -> None:
    """Rewrite every row's mark from its current_stage, history, and cycle."""
    rows = (
        bind.execute(
            sa.text(
                "SELECT id, current_stage, completed_stages, cycle_number FROM stageprogress"
            )
        )
        .mappings()
        .all()
    )
    for row in rows:
        mark = _resolve_mark(row["current_stage"], row["completed_stages"], row["cycle_number"])
        bind.execute(
            sa.text("UPDATE stageprogress SET highest_stage_reached = :mark WHERE id = :id"),
            {"mark": mark, "id": row["id"]},
        )


def upgrade() -> None:
    """Add ``highest_stage_reached`` (NOT NULL, backfilled to the lifetime max) + CHECK."""
    # Add with a server_default so the NOT NULL column backfills existing rows,
    # then rewrite each to its true lifetime max before dropping the default.
    op.add_column(
        "stageprogress",
        sa.Column("highest_stage_reached", sa.Integer(), nullable=False, server_default="1"),
    )
    _backfill(op.get_bind())
    # Drop the DB-level server_default (the app owns the default via the model's
    # Field default, keeping ``alembic check`` drift-free) and install the CHECK
    # in a single batch rebuild so SQLite (round-trip test) stays compatible.
    with op.batch_alter_table("stageprogress") as batch_op:
        batch_op.alter_column(
            "highest_stage_reached",
            existing_type=sa.Integer(),
            existing_nullable=False,
            server_default=None,
        )
        batch_op.create_check_constraint(_HIGH_WATER_CHECK, _HIGH_WATER_CONDITION)


def downgrade() -> None:
    """Drop the highest_stage_reached CHECK and column."""
    # Batch mode keeps the downgrade SQLite-compatible (no ALTER/DROP CHECK there).
    with op.batch_alter_table("stageprogress") as batch_op:
        batch_op.drop_constraint(_HIGH_WATER_CHECK, type_="check")
        batch_op.drop_column("highest_stage_reached")
