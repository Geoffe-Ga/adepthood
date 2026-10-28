"""Record why a vault pipeline run failed, when the vault says the writer can fix it.

Revision ID: 1e941149a0c9
Revises: 47b290cfd812
Create Date: 2026-10-28

Creek contract 0.26 (Creek-Vault#1877) ends a classification job whose writer
request key was refused by its vendor with ``failure_code:
"request_key_rejected"``. Adepthood keeps that closed token on the run row so a
rejected key stops the pass instead of being re-submitted, and so Settings can
tell the writer to replace the key. The column is content-free: a published
code or ``NULL``, never vendor text. No backfill -- no earlier row knew why.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "1e941149a0c9"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "47b290cfd812"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "vaultpipelinerun"
_CHECK = "ck_vaultpipelinerun_failure_code_valid"


def upgrade() -> None:
    """Add the nullable, CHECK-constrained failure code."""
    op.add_column(
        _TABLE,
        sa.Column("failure_code", sqlmodel.sql.sqltypes.AutoString(length=32), nullable=True),
    )
    op.create_check_constraint(
        _CHECK,
        _TABLE,
        "failure_code IS NULL OR (outcome = 'failed' AND failure_code IN ('request_key_rejected'))",
    )


def downgrade() -> None:
    """Drop the code; the failed rows it annotated stay failed."""
    op.drop_constraint(_CHECK, _TABLE, type_="check")
    op.drop_column(_TABLE, "failure_code")
