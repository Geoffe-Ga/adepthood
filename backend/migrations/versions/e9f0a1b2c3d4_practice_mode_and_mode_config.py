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
_ALLOWED_MODES = (
    "meditation_timer",
    "count_up",
    "metronome",
    "interval_bell",
    "rep_counter",
    "sense_grounding",
    "tarot",
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

    # Backfill every existing row.  The JSON literal embeds
    # ``default_duration_minutes`` so the engine has a usable countdown
    # from day one.  CAST keeps SQLite happy (its JSON1 ext accepts text).
    op.execute(
        sa.text(
            """
            UPDATE practice
            SET
              mode = :mode,
              mode_config = json_object(
                'mode', :mode,
                'duration_minutes', default_duration_minutes,
                'start_bell', json('true'),
                'halfway_bell', json('false'),
                'end_bell', json('true')
              )
            WHERE mode IS NULL
            """
        ).bindparams(mode=_DEFAULT_MODE)
    )

    op.alter_column("practice", "mode", existing_type=sa.String(length=32), nullable=False)
    op.alter_column("practice", "mode_config", existing_type=sa.JSON(), nullable=False)

    quoted = ", ".join(f"'{m}'" for m in _ALLOWED_MODES)
    op.create_check_constraint(_MODE_CHECK_NAME, "practice", f"mode IN ({quoted})")


def downgrade() -> None:
    """Drop the CHECK and both columns."""
    op.drop_constraint(_MODE_CHECK_NAME, "practice", type_="check")
    op.drop_column("practice", "mode_config")
    op.drop_column("practice", "mode")
