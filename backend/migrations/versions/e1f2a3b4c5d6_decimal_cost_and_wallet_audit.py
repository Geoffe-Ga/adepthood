"""decimal estimated_cost_usd + wallet audit table

Revision ID: e1f2a3b4c5d6
Revises: d1e2f3a4b5c6
Create Date: 2026-04-28 00:00:00.000000

Closes:

* BUG-ADMIN-004 / BUG-BM-008: convert ``llm_usage_log.estimated_cost_usd``
  from ``REAL`` (float) to ``NUMERIC(12, 6)`` so admin aggregates sum
  exactly.  The column also becomes nullable -- the application now
  stores ``NULL`` when the pricing table did not know the model
  (instead of the silent ``0.0`` default that conflated "free" and
  "unrecorded").
* BUG-BM-011: introduce ``walletaudit``, an append-only forensic log
  recording every wallet mutation (spend / grant) with actor, reason,
  delta, and before/after balances.  The append-only invariant is
  enforced at the application layer (``services.wallet`` only ever
  inserts new rows via ``session.add`` -- never UPDATE / DELETE) which
  keeps the migration role-agnostic.  Operators that want a
  defence-in-depth ``REVOKE UPDATE, DELETE`` at the database layer
  should issue the GRANT in their deployment scripts where the
  application role name is known; embedding a hard-coded role here
  breaks CI environments that use a different one.
"""

from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e1f2a3b4c5d6"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "d1e2f3a4b5c6"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _is_postgres() -> bool:
    """Return True when the active connection speaks PostgreSQL.

    SQLite (used in tests) cannot alter a column's type in place, so
    the cost-column branch routes through ``op.batch_alter_table``
    while Postgres uses a single ``ALTER COLUMN ... USING`` statement
    that preserves existing rows.
    """
    bind = op.get_bind()
    return bind.dialect.name == "postgresql"


def _convert_cost_column_postgres() -> None:
    """Re-type ``estimated_cost_usd`` to ``NUMERIC(12, 6)`` and make it nullable.

    The ``USING`` clause coerces existing float rows to numeric before
    the type change so no row is lost.  Done in one statement because a
    drop-and-add round trip would lose the per-row history that admin
    aggregates depend on.
    """
    op.alter_column(
        "llmusagelog",
        "estimated_cost_usd",
        existing_type=sa.Float(),
        type_=sa.Numeric(precision=12, scale=6),
        existing_nullable=False,
        nullable=True,
        postgresql_using="estimated_cost_usd::numeric(12, 6)",
    )


def _convert_cost_column_sqlite() -> None:
    """SQLite branch — re-emit the column with the new type via batch mode.

    SQLite cannot alter a column's type in place; ``op.batch_alter_table``
    rebuilds the table.  Tests run against an empty in-memory schema so
    the rebuild is essentially free.
    """
    with op.batch_alter_table("llmusagelog") as batch_op:
        batch_op.alter_column(
            "estimated_cost_usd",
            existing_type=sa.Float(),
            type_=sa.Numeric(precision=12, scale=6),
            existing_nullable=False,
            nullable=True,
        )


def _create_wallet_audit() -> None:
    """Create the append-only ``walletaudit`` table.

    Append-only is enforced at the application layer; no role-specific
    GRANT lands here so the migration is portable across deployments
    that use different application-role names (CI uses ``aptitude``,
    production uses ``adepthood``).
    """
    op.create_table(
        "walletaudit",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id", sa.Integer(), sa.ForeignKey("user.id"), nullable=False, index=True
        ),
        sa.Column(
            "actor_user_id",
            sa.Integer(),
            sa.ForeignKey("user.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("bucket", sa.String(length=64), nullable=False, index=True),
        sa.Column("reason", sa.String(length=64), nullable=False, index=True),
        sa.Column("delta", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.Column("balance_before", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.Column("balance_after", sa.Numeric(precision=18, scale=6), nullable=False),
        # ``server_default=now()`` so a direct SQL INSERT from an ops
        # script or a future raw-SQL migration cannot fail with a
        # NOT NULL constraint violation — application writes still
        # supply ``datetime.now(UTC)`` via the ORM ``default_factory``,
        # but the database is now belt-and-braces.
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
            index=True,
        ),
    )


def upgrade() -> None:
    """Apply the schema changes."""
    if _is_postgres():
        _convert_cost_column_postgres()
    else:
        _convert_cost_column_sqlite()
    _create_wallet_audit()


def downgrade() -> None:
    """Rollback path: drop the audit table and revert the column type."""
    op.drop_table("walletaudit")
    if _is_postgres():
        op.alter_column(
            "llmusagelog",
            "estimated_cost_usd",
            existing_type=sa.Numeric(precision=12, scale=6),
            type_=sa.Float(),
            existing_nullable=True,
            nullable=False,
            postgresql_using="COALESCE(estimated_cost_usd, 0)::double precision",
        )
    else:
        with op.batch_alter_table("llmusagelog") as batch_op:
            batch_op.alter_column(
                "estimated_cost_usd",
                existing_type=sa.Numeric(precision=12, scale=6),
                type_=sa.Float(),
                existing_nullable=True,
                nullable=False,
            )
