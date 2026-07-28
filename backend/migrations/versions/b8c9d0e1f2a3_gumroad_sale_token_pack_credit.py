"""Add the token-pack credit claim columns to gumroadsale.

Revision ID: b8c9d0e1f2a3
Revises: a6b7c8d9e0f1
Create Date: 2026-07-24 00:00:00.000000

Issue #1944: a Gumroad token-pack sale credits the buyer's BotMason
``offering_balance`` exactly once. ``token_pack_credited_at`` is the claim
guard a crediting transaction takes with a single
``UPDATE ... WHERE token_pack_credited_at IS NULL``;
``token_pack_credited_user_id`` records which account received the credits
(``ON DELETE SET NULL`` so the trail outlives the account, matching
``walletaudit.actor_user_id``).

Purely additive. Every pre-existing row lands ``NULL`` on both columns, i.e.
unclaimed — which is correct: no token pack has ever been sold, because this
change is the first consumer of the token-pack product allowlist.

The non-unique functional index on ``lower(email)`` backs the signup-time
sweep, which looks up every waiting sale for a freshly-created account
case-insensitively.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b8c9d0e1f2a3"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a6b7c8d9e0f1"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "gumroadsale"
_CREDITED_AT_COLUMN = "token_pack_credited_at"
_CREDITED_USER_COLUMN = "token_pack_credited_user_id"
_CREDITED_USER_INDEX = "ix_gumroadsale_token_pack_credited_user_id"
_CREDITED_USER_FK = "gumroadsale_token_pack_credited_user_id_fkey"
_LOWER_EMAIL_INDEX = "ix_gumroadsale_lower_email"


def upgrade() -> None:
    """Add both claim columns, the actor FK, and the lower(email) lookup index."""
    # Batch mode keeps this SQLite-safe (table rebuild) while emitting plain
    # ALTERs on Postgres, which is what production runs.
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(
            sa.Column(_CREDITED_AT_COLUMN, sa.DateTime(timezone=True), nullable=True)
        )
        batch_op.add_column(sa.Column(_CREDITED_USER_COLUMN, sa.Integer(), nullable=True))
        batch_op.create_index(_CREDITED_USER_INDEX, [_CREDITED_USER_COLUMN])
        batch_op.create_foreign_key(
            _CREDITED_USER_FK,
            "user",
            [_CREDITED_USER_COLUMN],
            ["id"],
            ondelete="SET NULL",
        )
    op.create_index(_LOWER_EMAIL_INDEX, _TABLE, [sa.text("lower(email)")])


def downgrade() -> None:
    """Drop the lookup index, then the FK, its index, and both columns."""
    op.drop_index(_LOWER_EMAIL_INDEX, table_name=_TABLE)
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_constraint(_CREDITED_USER_FK, type_="foreignkey")
        batch_op.drop_index(_CREDITED_USER_INDEX)
        batch_op.drop_column(_CREDITED_USER_COLUMN)
        batch_op.drop_column(_CREDITED_AT_COLUMN)
