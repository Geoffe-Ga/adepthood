"""Let the unlock log record a Metta Return arc's release and recommit.

Revision ID: 3f7a9c2e5b18
Revises: a4c8e2f6b1d3
Create Date: 2026-11-19 00:00:00.000000

A Return arc releases a habit (re-locking it) and re-commits to it (unlocking
it again). Both flip ``Habit.revealed``, and from issue #3745 each flip is
logged like every other lock change, under a new ``metta_return`` source.

``source`` is a ``VARCHAR(32)`` guarded by a CHECK, not a database enum, so
nothing but that CHECK needs to move. ``9d2b6e4f1a73`` wrote it as a literal
naming the four original writers; this revision drops and recreates it with
``metta_return`` added, inside ``batch_alter_table`` so SQLite rebuilds the
table once. The literals are frozen here rather than imported from ``src``, so
this revision means the same thing forever; they match the model's derived
CHECK.

``downgrade`` deletes every ``metta_return`` row before narrowing the CHECK
back. A pre-#3745 build never logged a Return flip, so the log it reads is the
one it would have written; the habits' ``revealed`` flags are untouched.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "3f7a9c2e5b18"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a4c8e2f6b1d3"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "habitunlockevent"
_CHECK = "ck_habitunlockevent_source_valid"
_METTA_RETURN = "metta_return"

# Frozen at this revision (mirrors models.habit_unlock_event.UnlockSource).
_PREVIOUS_SOURCES = ("manual", "auto_reveal", "created_unlocked", "backfill")
_WIDENED_SOURCES = (*_PREVIOUS_SOURCES, _METTA_RETURN)


def _check_clause(sources: Sequence[str]) -> str:
    """The CHECK body admitting exactly ``sources``."""
    return "source IN ({})".format(", ".join(f"'{source}'" for source in sources))


def _replace_check(sources: Sequence[str]) -> None:
    """Drop and recreate the source CHECK over ``sources``."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_constraint(_CHECK, type_="check")
        batch_op.create_check_constraint(_CHECK, _check_clause(sources))


def upgrade() -> None:
    """Admit ``metta_return`` as a writer of the unlock log."""
    _replace_check(_WIDENED_SOURCES)


def downgrade() -> None:
    """Forget every Return-written row, then narrow the CHECK."""
    op.execute(
        sa.text("DELETE FROM habitunlockevent WHERE source = :source").bindparams(
            source=_METTA_RETURN
        )
    )
    _replace_check(_PREVIOUS_SOURCES)
