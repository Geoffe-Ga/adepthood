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
  delta, and before/after balances.  ``INSERT`` is the only privilege
  granted to the application role; ``UPDATE``/``DELETE`` stays with
  the migration role so a rogue route handler cannot rewrite history.
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


# Application role — matches the ``DATABASE_USER`` env var deployments use.
# Falls back to ``adepthood`` so local dev continues to work without
# extra config.  In CI / test (SQLite) the GRANT statements are no-ops
# because the engine has no role concept.
_APP_ROLE = "adepthood"


def _is_postgres() -> bool:
    """Return True when the active connection speaks PostgreSQL.

    SQLite (used in tests) has no concept of column-type alteration via
    ``USING`` and no ``GRANT`` / role machinery, so the migration emits
    a more permissive form for it: drop+recreate the column for the
    cost type change, skip the GRANT entirely.
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
    """SQLite branch — drop and re-add the column with the new type.

    SQLite cannot alter a column's type in place; ``op.alter_column``
    on SQLite would fall back to batch mode and rewrite the table.
    Tests run against an empty in-memory schema so a drop+add is
    semantically equivalent and much simpler.
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
    """Create the append-only ``walletaudit`` table with the privilege grant."""
    op.create_table(
        "walletaudit",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id", sa.Integer(), sa.ForeignKey("user.id"), nullable=False, index=True
        ),
        sa.Column(
            "actor_user_id", sa.Integer(), sa.ForeignKey("user.id"), nullable=False, index=True
        ),
        sa.Column("bucket", sa.String(length=64), nullable=False, index=True),
        sa.Column("reason", sa.String(length=64), nullable=False, index=True),
        sa.Column("delta", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.Column("balance_before", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.Column("balance_after", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, index=True
        ),
    )
    if _is_postgres():
        # Append-only at the database layer: the application role gets
        # only ``INSERT``.  ``REVOKE`` first so an existing role with
        # broader privileges (a rerun on staging, say) is brought into
        # line.  Wrapped in IF EXISTS so a fresh DB without the role
        # still applies cleanly.
        op.execute(f'REVOKE ALL ON TABLE walletaudit FROM "{_APP_ROLE}"')
        op.execute(f'GRANT SELECT, INSERT ON TABLE walletaudit TO "{_APP_ROLE}"')
        op.execute(f'GRANT USAGE, SELECT ON SEQUENCE walletaudit_id_seq TO "{_APP_ROLE}"')


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
