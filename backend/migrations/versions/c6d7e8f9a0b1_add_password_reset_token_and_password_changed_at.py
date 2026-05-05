"""add passwordresettoken table and user.password_changed_at

Revision ID: c6d7e8f9a0b1
Revises: b5c6d7e8f9a0
Create Date: 2026-05-02 00:00:00.000000

Two related changes shipped together because they form a single
"password recovery" feature surface:

1. ``passwordresettoken`` -- single-use, time-limited credential-recovery
   token storage.  Plaintext tokens are never persisted; the column
   ``token_hash`` carries a bcrypt digest of the value emailed to the
   user.  ``used_at`` / ``cancelled_at`` give the row a state machine
   so an attacker cannot replay a confirmed or cancelled link.

2. ``user.password_changed_at`` -- the SPEC R7 option a "log out
   everywhere" lever.  ``_decode_token_payload`` rejects any JWT whose
   ``iat`` predates this timestamp, so a successful reset implicitly
   revokes every outstanding session in one column update.  Picked
   over the bulk ``RevokedToken`` insert (option b) because it is one
   write, scales to any session fan-out, and survives token claims we
   never persisted on the issuance path.

Reversible.  ``password_changed_at`` is nullable so existing rows keep
working without backfill -- a ``NULL`` value disables the iat gate.
The ``passwordresettoken`` table is dropped cleanly on downgrade.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c6d7e8f9a0b1"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "b5c6d7e8f9a0"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create ``passwordresettoken`` and add ``user.password_changed_at``."""
    op.create_table(
        "passwordresettoken",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(length=128), nullable=False),
        sa.Column("requested_ip", sa.String(length=64), nullable=False),
        sa.Column("requested_user_agent", sa.String(length=256), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_passwordresettoken_user_id",
        "passwordresettoken",
        ["user_id"],
    )
    op.create_index(
        "ix_passwordresettoken_expires_at",
        "passwordresettoken",
        ["expires_at"],
    )
    op.add_column(
        "user",
        sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    """Drop ``user.password_changed_at`` and the ``passwordresettoken`` table."""
    op.drop_column("user", "password_changed_at")
    op.drop_index("ix_passwordresettoken_expires_at", table_name="passwordresettoken")
    op.drop_index("ix_passwordresettoken_user_id", table_name="passwordresettoken")
    op.drop_table("passwordresettoken")
