"""align practice duration type and promptresponse unique constraint

Revision ID: a8b9c0d1e2f3
Revises: f6a7b8c9d0e1
Create Date: 2026-04-16 06:30:00.000000

Resolves two pre-existing drifts between the SQLModel definitions and the
applied schema, both surfaced by the new BUG-INFRA-023 ``alembic check`` CI
job:

1. ``practice.default_duration_minutes`` is declared as ``float`` in the
   model but the initial schema migration created it as ``INTEGER``.
   SQLite tests pass because SQLite has dynamic typing, but Postgres
   silently truncates fractional values.  We promote it to ``DOUBLE
   PRECISION`` so the column matches the application contract.

2. ``PromptResponse.__table_args__`` declares
   ``UniqueConstraint("user_id", "week_number", name="uq_promptresponse_user_week")``
   (BUG-JOURNAL-003) but no migration added it to Postgres.  The
   application layer's SELECT-then-INSERT race remained open in
   production.  We add the constraint now; the rare existing duplicates
   are deleted (keeping the lowest-id row) before the constraint is
   created so the migration cannot fail on legacy data.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a8b9c0d1e2f3"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "f6a7b8c9d0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UNIQUE_CONSTRAINT = "uq_promptresponse_user_week"


def upgrade() -> None:
    """Promote duration to FLOAT and add the prompt-response unique constraint."""
    # 1. INTEGER → FLOAT for practice.default_duration_minutes.  USING is a
    #    no-op cast — every existing integer is a valid float.
    op.alter_column(
        "practice",
        "default_duration_minutes",
        type_=sa.Float(),
        existing_type=sa.Integer(),
        existing_nullable=False,
        postgresql_using="default_duration_minutes::double precision",
    )

    # 2. Drop legacy duplicates so the constraint can be created safely.
    #    Keeps the earliest (lowest-id) row per (user_id, week_number) pair
    #    on the assumption that the first response is the real one.
    op.execute(
        'DELETE FROM promptresponse WHERE id NOT IN ('
        "SELECT min(id) FROM promptresponse GROUP BY user_id, week_number"
        ")"
    )

    op.create_unique_constraint(
        _UNIQUE_CONSTRAINT,
        "promptresponse",
        ["user_id", "week_number"],
    )


def downgrade() -> None:
    """Revert column type and drop the unique constraint."""
    op.drop_constraint(_UNIQUE_CONSTRAINT, "promptresponse", type_="unique")
    op.alter_column(
        "practice",
        "default_duration_minutes",
        type_=sa.Integer(),
        existing_type=sa.Float(),
        existing_nullable=False,
        postgresql_using="default_duration_minutes::integer",
    )
