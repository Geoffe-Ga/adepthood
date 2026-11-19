"""Hold how far the Course had dripped at the lifetime mark on ``stageprogress``.

Revision ID: b7e1c4d9a2f5
Revises: a4c8e2f6b1d3
Create Date: 2026-11-19 00:00:00.000000

Course access now holds at the highest stage a person has reached, through
begin-again, a rescaffold and a first-cycle re-pick (issue #3744): every stage
below ``highest_stage_reached`` stays fully open, and the mark itself stays open
as far as it had dripped. ``highest_drip_day`` is that day.

``upgrade`` adds it NOT NULL with a temporary ``server_default='0'`` and
backfills:

- a row whose record stands below its mark (it has already been reset) gets the
  mark stage's full length, because how far that stage had dripped was never
  recorded and the Course must not take back reading the person had;
- a row standing on its mark keeps 0, since the live drip still paces it.

It then drops the server default (the model owns the default, keeping
``alembic check`` drift-free) and installs a CHECK pinning the value ``>= 0``,
mirroring the model's ``__table_args__``. ``downgrade`` drops both.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7e1c4d9a2f5"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a4c8e2f6b1d3"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "stageprogress"
_COLUMN = "highest_drip_day"
_CHECK = "ck_stageprogress_highest_drip_day_non_negative"
_CONDITION = "highest_drip_day >= 0"
# Days each stage lasts, in stage order. Inlined so the migration stays
# self-contained: equals ``domain.constants.STAGE_DURATIONS_DAYS``.
_STAGE_DURATIONS_DAYS = (21, 21, 21, 21, 21, 21, 21, 21, 42, 42)


def _stage_length(stage_number: int) -> int:
    """Days ``stage_number`` lasts, clamped to the ten stages."""
    index = min(max(stage_number, 1), len(_STAGE_DURATIONS_DAYS)) - 1
    return _STAGE_DURATIONS_DAYS[index]


def _backfill(bind: sa.Connection) -> None:
    """Hold the mark's whole stage open on every row already reset below it."""
    rows = (
        bind.execute(
            sa.text(
                "SELECT id, highest_stage_reached FROM stageprogress"
                " WHERE current_stage < highest_stage_reached"
            )
        )
        .mappings()
        .all()
    )
    for row in rows:
        bind.execute(
            sa.text("UPDATE stageprogress SET highest_drip_day = :day WHERE id = :id"),
            {"day": _stage_length(row["highest_stage_reached"]), "id": row["id"]},
        )


def upgrade() -> None:
    """Add ``highest_drip_day`` (NOT NULL, backfilled) and its CHECK."""
    op.add_column(
        _TABLE,
        sa.Column(_COLUMN, sa.Integer(), nullable=False, server_default="0"),
    )
    _backfill(op.get_bind())
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.alter_column(
            _COLUMN, existing_type=sa.Integer(), existing_nullable=False, server_default=None
        )
        batch_op.create_check_constraint(_CHECK, _CONDITION)


def downgrade() -> None:
    """Drop the CHECK and the column; the Course then holds stages, not days."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_constraint(_CHECK, type_="check")
        batch_op.drop_column(_COLUMN)
