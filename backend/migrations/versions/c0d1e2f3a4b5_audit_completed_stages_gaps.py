"""audit legacy completed_stages gaps

Revision ID: c0d1e2f3a4b5
Revises: b9c0d1e2f3a4
Create Date: 2026-04-20 00:00:00.000000

One-shot *read-only* data audit that logs every ``stageprogress`` row whose
``completed_stages`` set is not exactly ``{1..current_stage-1}``.  Rows like
``completed_stages=[1, 3]`` with ``current_stage=4`` (stage 2 missing) can
slip through if the chain-validation invariant (next commit) is ever relaxed
by an admin tool, data import, or a bug.

The migration deliberately does **not** auto-repair: silently mutating user
progression would hide the defect and could forfeit completion credit the
user is actually owed.  Instead, operators use the new
``GET /admin/stage-progress/gaps`` endpoint to inspect the flagged rows and
``POST /admin/stage-progress/{user_id}/repair`` to rewrite a single row
explicitly.  This migration makes those admin calls safe to run against a
legacy database by surfacing every candidate in the alembic log.
"""

import logging
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c0d1e2f3a4b5"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "b9c0d1e2f3a4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_logger = logging.getLogger("alembic.runtime.migration")


def _coerce_completed(raw: object) -> list[int]:
    """Normalize the driver representation of ``completed_stages`` to ``list[int]``."""
    if raw is None:
        return []
    # Postgres ARRAY(Integer) round-trips as a list already; the tuple branch
    # is a defensive fallback for drivers that return a non-list sequence.
    if isinstance(raw, (list, tuple)):
        try:
            return [int(x) for x in raw]
        except (TypeError, ValueError):
            return []
    return []


def upgrade() -> None:
    """Scan ``stageprogress`` rows and log every non-contiguous row."""
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT user_id, current_stage, completed_stages FROM stageprogress")
    ).fetchall()

    flagged = 0
    for row in rows:
        current_stage = int(row.current_stage)
        completed = set(_coerce_completed(row.completed_stages))
        expected = set(range(1, current_stage))
        if completed == expected:
            continue
        flagged += 1
        _logger.warning(
            "stage_progress_gap: user_id=%s current_stage=%s completed=%s "
            "missing=%s extra=%s",
            row.user_id,
            current_stage,
            sorted(completed),
            sorted(expected - completed),
            sorted(completed - expected),
        )

    if flagged:
        _logger.warning(
            "stage_progress_audit: %d row(s) flagged. Repair via "
            "POST /admin/stage-progress/{user_id}/repair.",
            flagged,
        )
    else:
        _logger.info("stage_progress_audit: no rows flagged")


def downgrade() -> None:
    """Read-only audit; nothing to revert."""
