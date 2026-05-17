"""extend ck_practice_mode_valid to include card_meditation

Revision ID: a2b3c4d5e6f8
Revises: f4a5b6c7d8e9
Create Date: 2026-05-17 12:00:00.000000

Adds ``card_meditation`` to the closed set of values accepted by the
``practice.mode`` CHECK constraint. The new value powers deck-agnostic
card meditation (RWS, Thoth, Marseille, oracle, user-curated photo
decks) whose config and per-session metadata shapes live in
:mod:`schemas.practice_mode_config.CardMeditationConfig` and
:mod:`schemas.practice_session_metadata.CardMeditationMetadata`.

Chains off ``f4a5b6c7d8e9`` (mindful_anchor) — the prior CHECK already
lists nine modes, so the upgrade adds the tenth and the downgrade
narrows back to the same nine. The existing ``tarot`` mode is
preserved unchanged for backward compatibility.

The migration drops and recreates ``ck_practice_mode_valid`` inside a
``batch_alter_table`` block so SQLite (used by the round-trip test
fixture) rebuilds the table once. The downgrade refuses to run if any
rows already carry ``card_meditation`` — narrowing the CHECK while data
violates it would either rewrite history or leave the DB in an
inconsistent state, and the operator should resolve the rows first.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a2b3c4d5e6f8"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "f4a5b6c7d8e9"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_MODE_CHECK_NAME = "ck_practice_mode_valid"
_NEW_MODE = "card_meditation"

# Intentionally duplicated from ``domain.practice_modes.ALL_MODES`` — migrations
# must not import application modules so the schema replays on a repo state
# where the model no longer matches. The ninth mode (``mindful_anchor``)
# was added by the down_revision migration ``f4a5b6c7d8e9``.
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
)
_EXTENDED_MODES = (*_PREVIOUS_MODES, _NEW_MODE)


def _check_clause(modes: Sequence[str]) -> str:
    quoted = ", ".join(f"'{m}'" for m in modes)
    return f"mode IN ({quoted})"


def upgrade() -> None:
    """Drop and recreate the CHECK constraint with ``card_meditation`` allowed."""
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
