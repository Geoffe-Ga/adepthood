"""Store each managed vault's own MCP resource, the agent-token audience (R3-1).

Revision ID: 5d3c8a1f9b27
Revises: 1e941149a0c9
Create Date: 2026-10-31

Creek-Vault#2002 gives a managed allocation its own MCP resource,
``https://<edge>/a/<slug>/mcp``, and reports it in authenticated ``agent_mcp``
discovery (its ``/v1`` handoff has no field for it). Adepthood adopts it into
``uservaultconfig.agent_mcp_resource`` and mints agent tokens for that audience
instead of the shared edge's ``/mcp`` (adepthood#3584).

The index is unique: no two accounts may ever hold one audience, which is what
stops a vault advertising another account's resource from adopting it. ``NULL``
(every existing row) means the vault is still served at the shared edge, so no
backfill: a vault is adopted the first time its discovery reports its own
resource, and grants bound to the shared edge then fail the exchange/refresh
re-check and reconnect. The downgrade drops the column, returning every managed
account to the shared-edge audience.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "5d3c8a1f9b27"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "1e941149a0c9"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "uservaultconfig"
_COLUMN = "agent_mcp_resource"
_INDEX = "ix_uservaultconfig_agent_mcp_resource"
# Matches ``models.user_vault_config.VAULT_URL_MAX_LENGTH``.
_URL_WIDTH = 2048


def upgrade() -> None:
    """Add the nullable resource and the index that keeps it one account's."""
    op.add_column(
        _TABLE,
        sa.Column(_COLUMN, sqlmodel.sql.sqltypes.AutoString(length=_URL_WIDTH), nullable=True),
    )
    op.create_index(_INDEX, _TABLE, [_COLUMN], unique=True)


def downgrade() -> None:
    """Drop the index, then the column; every account returns to the shared edge."""
    op.drop_index(_INDEX, table_name=_TABLE)
    op.drop_column(_TABLE, _COLUMN)
