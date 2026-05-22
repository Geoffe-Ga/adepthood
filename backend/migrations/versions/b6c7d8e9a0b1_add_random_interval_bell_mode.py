"""extend ck_practice_mode_valid to include random_interval_bell

Revision ID: b6c7d8e9a0b1
Revises: f5b6c7d8e9a0
Create Date: 2026-05-21 12:00:00.000000

Adds ``random_interval_bell`` to the closed set of values accepted by
the ``practice.mode`` CHECK constraint. The new value powers a
meditation timer that rings a bell at random offsets between
configurable min/max bounds; its config and per-session metadata shapes
live in
:mod:`schemas.practice_mode_config.RandomIntervalBellConfig` and
:mod:`schemas.practice_session_metadata.RandomIntervalBellMetadata`.

Chains off ``f5b6c7d8e9a0`` (practice share-link) — the current head.
The prior CHECK already lists ten modes, so the upgrade adds the
eleventh and the downgrade narrows back to the same ten. The existing
``interval_bell`` mode is preserved unchanged.

The migration drops and recreates ``ck_practice_mode_valid`` inside a
``batch_alter_table`` block so SQLite (used by the round-trip test
fixture) rebuilds the table once. The downgrade refuses to run if any
rows already carry ``random_interval_bell`` — narrowing the CHECK while
data violates it would either rewrite history or leave the DB in an
inconsistent state, and the operator should resolve the rows first.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b6c7d8e9a0b1"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "f5b6c7d8e9a0"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_MODE_CHECK_NAME = "ck_practice_mode_valid"
_NEW_MODE = "random_interval_bell"

# Intentionally duplicated from ``domain.practice_modes.ALL_MODES`` — migrations
# must not import application modules so the schema replays on a repo state
# where the model no longer matches. The tenth mode (``card_meditation``)
# was added by the migration two revisions back (``a2b3c4d5e6f8``).
_PREVIOUS_MODES = (
    "meditation_timer",
    "count_up",
    "metronome",
    "interval_bell",
    "rep_counter",
    "sense_grounding",
    "tarot",
    "tallied_grounding",
    "mindful_anchor",
    "card_meditation",
)
_EXTENDED_MODES = (*_PREVIOUS_MODES, _NEW_MODE)


def _check_clause(modes: Sequence[str]) -> str:
    quoted = ", ".join(f"'{m}'" for m in modes)
    return f"mode IN ({quoted})"


def upgrade() -> None:
    """Drop and recreate the CHECK constraint with ``random_interval_bell`` allowed."""
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
