"""Add the authidentity table for social sign-in account links.

Revision ID: e6f7a8b9c0d1
Revises: d5e6f7a8b9c0
Create Date: 2026-07-28 00:00:00.000000

Issue #1948: Google sign-in is a second authentication path into an account,
so the link between a provider subject and an Adepthood user needs its own
table with its own integrity rules.

Purely additive: creates ``authidentity`` — one row per
``(provider, subject)`` pair, cascade-deleted with its owning user, carrying
the provider address that authorised the link. The unique constraint on
``(provider, subject)`` is the load-bearing one: without it a race could fork
a single Google account across two Adepthood accounts. The CHECK mirrors
``models.auth_identity.AuthProvider`` so the accepted provider set cannot
drift from the enum. ``downgrade`` drops the index then the table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e6f7a8b9c0d1"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "d5e6f7a8b9c0"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "authidentity"
_USER_ID_INDEX = "ix_authidentity_user_id"

# Mirror ``models.auth_identity``'s column bounds.
_PROVIDER_MAX = 16
_SUBJECT_MAX = 255
_EMAIL_MAX = 254


def upgrade() -> None:
    """Create the authidentity table, its provider CHECK, and the user index."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(length=_PROVIDER_MAX), nullable=False),
        sa.Column("subject", sa.String(length=_SUBJECT_MAX), nullable=False),
        sa.Column("email_at_link_time", sa.String(length=_EMAIL_MAX), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "provider IN ('google', 'apple')",
            name="ck_authidentity_provider_valid",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider", "subject", name="uq_authidentity_provider_subject"),
    )
    op.create_index(op.f(_USER_ID_INDEX), _TABLE, ["user_id"])


def downgrade() -> None:
    """Drop the authidentity index then the table."""
    op.drop_index(op.f(_USER_ID_INDEX), table_name=_TABLE)
    op.drop_table(_TABLE)
