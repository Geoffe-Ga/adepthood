"""add practiceshare link token table

Revision ID: f5b6c7d8e9a0
Revises: a2b3c4d5e6f8
Create Date: 2026-05-17 09:00:00.000000

Adds a new ``practicesharelink`` table backing the practice share-link
feature (issue #348).  Holds one row per outstanding share token:

* ``token`` -- URL-safe base64 string minted with
  ``secrets.token_urlsafe(32)`` (256 bits of entropy).  Unique +
  indexed so the redeem endpoints can resolve a token in a single
  point lookup.
* ``practice_id`` -- FK to ``practice``.  ``ON DELETE CASCADE`` so a
  removed practice drops its outstanding links instead of leaving
  dangling tokens that 410 with a confusing message.
* ``created_by_user_id`` -- FK to ``user`` with ``ON DELETE SET NULL``
  so audit history survives a right-to-be-forgotten purge.
* ``expires_at`` / ``max_uses`` / ``use_count`` / ``revoked_at`` --
  the three soft-kill levers documented at
  :mod:`models.practice_share_link`.

Chains off ``a2b3c4d5e6f8`` (card_meditation) -- rebased onto that head
during the PR #359 update so the chain stays linear after the parallel
custom-practices-02 work merged.

This is a pure additive migration -- no existing rows are touched and
the downgrade path simply drops the table.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f5b6c7d8e9a0"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "a2b3c4d5e6f8"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE_NAME = "practicesharelink"
_TOKEN_INDEX = "ix_practicesharelink_token"
_PRACTICE_INDEX = "ix_practicesharelink_practice_id"
_CREATED_BY_INDEX = "ix_practicesharelink_created_by_user_id"


def upgrade() -> None:
    """Create ``practicesharelink`` plus the three indexes it needs."""
    op.create_table(
        _TABLE_NAME,
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("practice_id", sa.Integer(), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("max_uses", sa.Integer(), nullable=True),
        sa.Column("use_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["practice_id"], ["practice.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["user.id"], ondelete="SET NULL"),
    )
    op.create_index(_TOKEN_INDEX, _TABLE_NAME, ["token"], unique=True)
    op.create_index(_PRACTICE_INDEX, _TABLE_NAME, ["practice_id"])
    op.create_index(_CREATED_BY_INDEX, _TABLE_NAME, ["created_by_user_id"])


def downgrade() -> None:
    """Drop the table and its indexes."""
    op.drop_index(_CREATED_BY_INDEX, table_name=_TABLE_NAME)
    op.drop_index(_PRACTICE_INDEX, table_name=_TABLE_NAME)
    op.drop_index(_TOKEN_INDEX, table_name=_TABLE_NAME)
    op.drop_table(_TABLE_NAME)
