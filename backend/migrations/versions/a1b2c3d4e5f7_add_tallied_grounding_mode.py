"""add tallied_grounding to practice.mode CHECK constraint

Revision ID: a1b2c3d4e5f7
Revises: d2e3f4a5b6c7
Create Date: 2026-05-16 12:00:00.000000

ritual / grounding-techniques 01:

The original CHECK constraint introduced by ``e9f0a1b2c3d4`` pins
``practice.mode`` to the seven launch-time modes. Adding
``tallied_grounding`` to :data:`domain.practice_modes.ALL_MODES` is
necessary but not sufficient — the database-level CHECK still rejects
inserts and updates carrying the new value. This migration drops the
existing CHECK and recreates it listing all eight modes.

``downgrade()`` refuses to run if any ``practice`` row already carries
``mode='tallied_grounding'``: silently rewriting it would either lose
data (set it to ``meditation_timer``) or fail the recreated CHECK
constraint at the next insert. Operators forced to roll back must
either delete or remap the offending rows first.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1b2c3d4e5f7"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "d2e3f4a5b6c7"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_MODE_CHECK_NAME = "ck_practice_mode_valid"
_NEW_MODE = "tallied_grounding"

# Intentionally duplicated from ``domain.practice_modes.ALL_MODES`` —
# migrations must not import application modules so the schema can be
# replayed on a repo state where the model no longer exists.
_ALLOWED_MODES_AFTER_UPGRADE = (
    "meditation_timer",
    "count_up",
    "metronome",
    "interval_bell",
    "rep_counter",
    "sense_grounding",
    "tarot",
    "tallied_grounding",
)

_ALLOWED_MODES_BEFORE_UPGRADE = tuple(
    m for m in _ALLOWED_MODES_AFTER_UPGRADE if m != _NEW_MODE
)


def _recreate_check(allowed_modes: tuple[str, ...]) -> None:
    """Drop the existing CHECK and recreate it pinning ``mode`` to ``allowed_modes``.

    batch_alter_table groups the drop + create so SQLite (used by the
    round-trip migration tests) can rebuild the table once instead of
    twice. Postgres processes the two ops in-place.
    """
    quoted = ", ".join(f"'{m}'" for m in allowed_modes)
    with op.batch_alter_table("practice") as batch_op:
        batch_op.drop_constraint(_MODE_CHECK_NAME, type_="check")
        batch_op.create_check_constraint(_MODE_CHECK_NAME, f"mode IN ({quoted})")


def upgrade() -> None:
    """Recreate the CHECK constraint listing ``tallied_grounding`` as a valid mode."""
    _recreate_check(_ALLOWED_MODES_AFTER_UPGRADE)


def downgrade() -> None:
    """Recreate the original 7-mode CHECK, refusing if ``tallied_grounding`` rows exist.

    Silently rewriting them would lose data; failing the recreated
    constraint mid-migration would leave the schema in a half-applied
    state. Surface the conflict so an operator decides.
    """
    bind = op.get_bind()
    practice_t = sa.Table(
        "practice",
        sa.MetaData(),
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("mode", sa.String(length=32)),
    )
    offending = bind.execute(
        sa.select(sa.func.count())
        .select_from(practice_t)
        .where(practice_t.c.mode == _NEW_MODE)
    ).scalar_one()
    if offending:
        msg = (
            f"Cannot downgrade: {offending} practice row(s) still use "
            f"mode={_NEW_MODE!r}. Delete or remap them before rolling back."
        )
        raise RuntimeError(msg)
    _recreate_check(_ALLOWED_MODES_BEFORE_UPGRADE)
