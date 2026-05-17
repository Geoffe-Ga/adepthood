"""extend ck_practice_mode_valid to include mindful_anchor

Revision ID: f4a5b6c7d8e9
Revises: a1b2c3d4e5f7
Create Date: 2026-05-16 12:00:00.000000

Adds ``mindful_anchor`` to the closed set of values accepted by the
``practice.mode`` CHECK constraint. The new value powers single-action
mindful presence practices (Touch Grass, Mindful Eating) whose config
and per-session metadata shapes live in
:mod:`schemas.practice_mode_config.MindfulAnchorConfig` and
:mod:`schemas.practice_session_metadata.MindfulAnchorMetadata`.

Chains off ``a1b2c3d4e5f7`` (tallied_grounding) — the prior CHECK
already lists eight modes, so the upgrade adds the ninth and the
downgrade narrows back to the same eight.

The migration drops and recreates ``ck_practice_mode_valid`` inside a
``batch_alter_table`` block so SQLite (used by the round-trip test
fixture) rebuilds the table once. The downgrade refuses to run if any
rows already carry ``mindful_anchor`` — narrowing the CHECK while data
violates it would either rewrite history or leave the DB in an
inconsistent state, and the operator should resolve the rows first.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f4a5b6c7d8e9"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f7"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_MODE_CHECK_NAME = "ck_practice_mode_valid"
_NEW_MODE = "mindful_anchor"

# Intentionally duplicated from ``domain.practice_modes.ALL_MODES`` — migrations
# must not import application modules so the schema replays on a repo state
# where the model no longer matches. The eighth mode (``tallied_grounding``)
# was added by the down_revision migration ``a1b2c3d4e5f7``.
_PREVIOUS_MODES = (
    "meditation_timer",
    "count_up",
    "metronome",
    "interval_bell",
    "rep_counter",
    "sense_grounding",
    "tarot",
    "tallied_grounding",
)
_EXTENDED_MODES = (*_PREVIOUS_MODES, _NEW_MODE)


def _check_clause(modes: Sequence[str]) -> str:
    quoted = ", ".join(f"'{m}'" for m in modes)
    return f"mode IN ({quoted})"


def upgrade() -> None:
    """Drop and recreate the CHECK constraint with ``mindful_anchor`` allowed."""
    with op.batch_alter_table("practice") as batch_op:
        batch_op.drop_constraint(_MODE_CHECK_NAME, type_="check")
        batch_op.create_check_constraint(_MODE_CHECK_NAME, _check_clause(_EXTENDED_MODES))


def downgrade() -> None:
    """Narrow the CHECK back to the prior set; refuse if rows still use the new mode."""
    bind = op.get_bind()
    offenders = bind.execute(
        sa.text("SELECT COUNT(*) FROM practice WHERE mode = :mode").bindparams(mode=_NEW_MODE)
    ).scalar_one()
    if offenders:
        msg = (
            f"Cannot downgrade: {offenders} practice row(s) carry mode='{_NEW_MODE}'. "
            "Reassign those rows to a supported mode before downgrading."
        )
        raise RuntimeError(msg)
    with op.batch_alter_table("practice") as batch_op:
        batch_op.drop_constraint(_MODE_CHECK_NAME, type_="check")
        batch_op.create_check_constraint(_MODE_CHECK_NAME, _check_clause(_PREVIOUS_MODES))
