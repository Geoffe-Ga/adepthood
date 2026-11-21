"""Keep a vault letter's voice and related pages beside it (#3778).

Revision ID: d94d894e18f8
Revises: c4d8e1f2a7b3
Create Date: 2026-11-20 00:00:00.000000

Creek contract 0.35 reports whether a letter was written in the owner's own
voice, and 0.36 names the praxis, eddies and threads its entry touches. Both
are cached on the margin note beside the letter so a reopened letter still
shows them:

* ``essay_voice`` -- ``owner`` or ``higher_self``, under a NULL-tolerant CHECK
  whose value list is frozen at this revision (never imported from ``src``);
* ``essay_related`` -- the pages as JSON, stored as ``EncryptedString``
  ciphertext (a plain ``TEXT`` column at the schema level, as ``essay`` is).

Purely additive, every column nullable, with **no backfill**: ``NULL`` means
the vault made no claim, which is the only honest value for a letter written
before 0.35. ``downgrade`` drops the CHECK, then the columns, and keeps every
row. Wrapped in ``batch_alter_table`` so the SQLite round trip rebuilds the
table while Postgres emits plain ``ALTER TABLE``.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d94d894e18f8"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c4d8e1f2a7b3"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "marginalia"

# Width and vocabulary, frozen at this revision (mirrored by models.marginalia).
_VOICE_LENGTH = 20
FROZEN_VOICES = ("owner", "higher_self")
_VOICE_CHECK = "ck_marginalia_essay_voice_valid"


def upgrade() -> None:
    """Add the two nullable columns and the voice CHECK."""
    quoted = ", ".join(f"'{voice}'" for voice in FROZEN_VOICES)
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(sa.Column("essay_voice", sa.String(length=_VOICE_LENGTH), nullable=True))
        batch_op.add_column(sa.Column("essay_related", sa.Text(), nullable=True))
        batch_op.create_check_constraint(
            _VOICE_CHECK, f"essay_voice IS NULL OR essay_voice IN ({quoted})"
        )


def downgrade() -> None:
    """Drop the CHECK, then the columns; every note survives."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_constraint(_VOICE_CHECK, type_="check")
        batch_op.drop_column("essay_related")
        batch_op.drop_column("essay_voice")
