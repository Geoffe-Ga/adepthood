"""add practice.mode + practice.mode_config

Revision ID: e9f0a1b2c3d4
Revises: d7e8f9a0b1c2
Create Date: 2026-05-10 22:00:00.000000

Adds two columns to ``practice``:

* ``mode`` (VARCHAR(32), NOT NULL) — engine discriminator pinned to the
  values exported from :mod:`domain.practice_modes`.  A CHECK constraint
  enforces the same closed set at the database layer.
* ``mode_config`` (JSON, NOT NULL, default ``{}``) — per-mode configuration
  payload (BPM, intervals, prompts, …) validated at the API edge by the
  Pydantic discriminated union in
  :mod:`schemas.practice_mode_config.ModeConfig`.

Backfill strategy: every pre-existing row is assigned
``mode='meditation_timer'`` and a ``MeditationTimerConfig`` derived from
``default_duration_minutes`` so the engine always has something usable.
We add nullable, backfill, then ``ALTER ... SET NOT NULL`` + CHECK so the
migration is safe against populated databases.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e9f0a1b2c3d4"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "d7e8f9a0b1c2"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DEFAULT_MODE = "meditation_timer"
_MODE_CHECK_NAME = "ck_practice_mode_valid"
# Intentionally duplicated from ``domain.practice_modes.ALL_MODES`` — migrations
# must not import application modules so the schema can be replayed on a
# repo state where the model no longer exists.
_ALLOWED_MODES = (
    "meditation_timer",
    "count_up",
    "metronome",
    "interval_bell",
    "rep_counter",
    "sense_grounding",
    "tarot",
)


def _backfill_practice_modes(bind: sa.Connection) -> None:
    """Backfill ``mode`` + ``mode_config`` on every existing ``practice`` row.

    Uses a reflected SQLAlchemy table so the JSON value is serialized
    through the active dialect's bind processor — building the value as
    a Python dict and letting SQLAlchemy adapt it keeps the migration
    portable between Postgres (production) and SQLite (test DB), where
    the json_object / json() built-ins differ.
    """
    practice_t = sa.Table(
        "practice",
        sa.MetaData(),
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("default_duration_minutes", sa.Float),
        sa.Column("mode", sa.String(length=32)),
        sa.Column("mode_config", sa.JSON),
    )
    rows = bind.execute(
        sa.select(practice_t.c.id, practice_t.c.default_duration_minutes).where(
            practice_t.c.mode.is_(None)
        )
    ).all()
    for row in rows:
        bind.execute(
            sa.update(practice_t)
            .where(practice_t.c.id == row.id)
            .values(
                mode=_DEFAULT_MODE,
                mode_config={
                    "mode": _DEFAULT_MODE,
                    "duration_minutes": float(row.default_duration_minutes),
                    "start_bell": True,
                    "halfway_bell": False,
                    "end_bell": True,
                },
            )
        )


def upgrade() -> None:
    """Add the two columns, backfill, then lock down nullability + CHECK."""
    op.add_column(
        "practice",
        sa.Column("mode", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "practice",
        sa.Column(
            "mode_config",
            sa.JSON(),
            nullable=True,
            server_default=sa.text("'{}'"),
        ),
    )

    _backfill_practice_modes(op.get_bind())

    # batch_alter_table groups the SET-NOT-NULL + CHECK so SQLite rebuilds once.
    quoted = ", ".join(f"'{m}'" for m in _ALLOWED_MODES)
    with op.batch_alter_table("practice") as batch_op:
        batch_op.alter_column("mode", existing_type=sa.String(length=32), nullable=False)
        batch_op.alter_column("mode_config", existing_type=sa.JSON(), nullable=False)
        batch_op.create_check_constraint(_MODE_CHECK_NAME, f"mode IN ({quoted})")


def downgrade() -> None:
    """Drop the CHECK and both columns."""
    # Batch mode keeps the downgrade SQLite-compatible (no ALTER CHECK there).
    with op.batch_alter_table("practice") as batch_op:
        batch_op.drop_constraint(_MODE_CHECK_NAME, type_="check")
        batch_op.drop_column("mode_config")
        batch_op.drop_column("mode")
