"""add feedbackreport table for private beta feedback intake

Revision ID: b4d2e7a9c1f3
Revises: a1f7c2b9d604
Create Date: 2026-09-17 00:00:00.000000

One table holding a tester's own words about the beta plus a seven-field
allowlisted diagnostic envelope. Purely additive: nothing existing is altered.

The idempotency key lives in this table rather than in a companion one -- the
deduplicated object *is* the report -- behind a partial UNIQUE index on
``(user_id, idem_key)`` that only constrains non-NULL keys, so unkeyed
submissions each get their own row. Same shape as ``energyplan``.

The downgrade **refuses while rows exist**. Dropping this table destroys prose
somebody wrote and cannot be rolled forward from anywhere, so an operator who
means it has to say so by clearing the table first. That is a deliberate
departure from the purely-additive downgrades elsewhere in this directory,
where the dropped object is derived data.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b4d2e7a9c1f3"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "a1f7c2b9d604"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "feedbackreport"

# The value sets, sorted, exactly as ``models.feedback._enum_check`` renders
# them. Sorted so the DDL is order-stable and ``alembic --autogenerate`` sees no
# difference between this file and the model.
_CATEGORIES = ("broken", "confusing", "idea", "praise")
_IMPACTS = ("blocked", "can_continue", "cosmetic", "not_applicable")
_PLATFORMS = ("android", "ios", "web")
_VIEWPORT_CLASSES = ("compact", "expanded", "regular")


def _enum_check(column: str, values: "Sequence[str]") -> sa.CheckConstraint:
    """``col IN ('a', 'b')``, the shape the account seeder reads permitted values from."""
    quoted = ", ".join(f"'{value}'" for value in values)
    return sa.CheckConstraint(f"{column} IN ({quoted})", name=f"ck_feedbackreport_{column}_valid")


def upgrade() -> None:
    """Create the ``feedbackreport`` table, its CHECKs and its three indexes."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("public_id", sa.String(length=11), nullable=False),
        sa.Column("category", sa.String(length=20), nullable=False),
        sa.Column("impact", sa.String(length=20), nullable=False),
        sa.Column("platform", sa.String(length=20), nullable=False),
        sa.Column("viewport_class", sa.String(length=20), nullable=False),
        # Prose columns are ``EncryptedString``, which decorates ``Text``.
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("intent", sa.Text(), nullable=True),
        sa.Column("expected", sa.Text(), nullable=True),
        sa.Column("actual", sa.Text(), nullable=True),
        sa.Column("screen", sa.String(length=64), nullable=False),
        sa.Column("control", sa.String(length=64), nullable=True),
        sa.Column("app_build", sa.String(length=32), nullable=False),
        sa.Column("locale", sa.String(length=16), nullable=True),
        sa.Column("correlation_id", sa.String(length=36), nullable=True),
        sa.Column("idem_key", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        _enum_check("category", _CATEGORIES),
        _enum_check("impact", _IMPACTS),
        _enum_check("platform", _PLATFORMS),
        _enum_check("viewport_class", _VIEWPORT_CLASSES),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_feedbackreport_user_id", _TABLE, ["user_id"])
    op.create_index("ix_feedbackreport_public_id", _TABLE, ["public_id"], unique=True)
    # Deduplicate keyed submissions per (account, key); NULL keys are
    # unconstrained so unkeyed reports each get their own row.
    op.create_index(
        "ix_feedbackreport_user_idem_key",
        _TABLE,
        ["user_id", "idem_key"],
        unique=True,
        postgresql_where=sa.text("idem_key IS NOT NULL"),
        sqlite_where=sa.text("idem_key IS NOT NULL"),
    )


def downgrade() -> None:
    """Drop the table — but refuse while it still holds anybody's reports."""
    bind = op.get_bind()
    existing = bind.execute(sa.text(f"SELECT COUNT(*) FROM {_TABLE}")).scalar_one()
    if existing:
        msg = (
            f"Cannot downgrade: {existing} feedbackreport row(s) still exist and "
            "dropping the table would destroy prose the reporters wrote, with no "
            "way to roll it forward. Export or delete those reports first."
        )
        raise RuntimeError(msg)
    op.drop_index("ix_feedbackreport_user_idem_key", table_name=_TABLE)
    op.drop_index("ix_feedbackreport_public_id", table_name=_TABLE)
    op.drop_index("ix_feedbackreport_user_id", table_name=_TABLE)
    op.drop_table(_TABLE)
