"""Let a failed vault pipeline run record Creek 0.29's ``busy`` reason.

Revision ID: 166523efc36e
Revises: 01d044846694
Create Date: 2026-11-08 00:00:00.000000

Creek contract 0.29 (Creek-Vault#2090) adds ``busy`` to the job failure-code
vocabulary: a durable pass that could not take the vault content-mutation lock
within its bounded wait. Adepthood retries it with backoff and records it only
when the bounded retry is spent on a run that is not ambiguous.

``failure_code`` is a ``VARCHAR(32)`` guarded by a CHECK, not a database enum,
so nothing but that CHECK needs to move. ``1e941149a0c9`` wrote it as a literal
naming only ``request_key_rejected``; this revision drops and recreates it with
``busy`` added, inside ``batch_alter_table`` so SQLite rebuilds the table once.
The literals are frozen here rather than imported from ``src``, so this
revision means the same thing forever; they match the model's derived CHECK.

``downgrade`` clears every ``busy`` reason before narrowing the CHECK back. The
rows stay ``failed`` with no reason -- exactly what a pre-0.29 build records for
the same failure, which it was served as ``null`` -- so nothing is refused.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "166523efc36e"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "01d044846694"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "vaultpipelinerun"
_CHECK = "ck_vaultpipelinerun_failure_code_valid"
_BUSY = "busy"

# Frozen at this revision (mirrors domain.creek_vault.VaultJobFailureCode).
_PREVIOUS_CODES = ("request_key_rejected",)
_WIDENED_CODES = (*_PREVIOUS_CODES, _BUSY)


def _check_clause(codes: Sequence[str]) -> str:
    """The CHECK body admitting ``codes`` on a failed row, and no code elsewhere."""
    quoted = ", ".join(f"'{code}'" for code in codes)
    return f"failure_code IS NULL OR (outcome = 'failed' AND failure_code IN ({quoted}))"


def _replace_check(codes: Sequence[str]) -> None:
    """Drop and recreate the failure-code CHECK over ``codes``."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_constraint(_CHECK, type_="check")
        batch_op.create_check_constraint(_CHECK, _check_clause(codes))


def upgrade() -> None:
    """Admit ``busy`` as a failed run's recorded reason."""
    _replace_check(_WIDENED_CODES)


def downgrade() -> None:
    """Forget every ``busy`` reason (the runs stay failed), then narrow the CHECK."""
    op.execute(
        sa.text(
            "UPDATE vaultpipelinerun SET failure_code = NULL WHERE failure_code = :code"
        ).bindparams(code=_BUSY)
    )
    _replace_check(_PREVIOUS_CODES)
