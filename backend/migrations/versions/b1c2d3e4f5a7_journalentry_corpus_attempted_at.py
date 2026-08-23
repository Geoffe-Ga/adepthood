"""Add journalentry.corpus_attempted_at, so a stuck sweep can move past itself.

Revision ID: b1c2d3e4f5a7
Revises: d7e8f9a0b1c3
Create Date: 2026-08-22 00:00:00.000000

The consent backfill offers an account's un-ontologized entries to the corpus
writer newest first. An entry the classifier recognises nothing in stays
pending on purpose -- writing with no position on the ontology is not corpus
material -- but with nothing recording that it had already been offered, the
newest-first queue never moved: an account whose most recent entries were short
or ambiguous had every later grant re-select exactly those, pay a provider call
for each, and never reach the older history the backfill exists to reach.

This column is what lets the queue advance. It records when the sweep last
offered a row, not whether anything came of it, and the sweep orders on it --
never-offered first, then least-recently-offered. Ordering rather than
excluding is deliberate: an entry dropped from the candidate set once it had
been tried would turn a single provider outage into a permanent hole in
somebody's corpus.

Nullable with no server default, and NULL is the load-bearing value: every row
written before this migration has genuinely never been offered, so it reads
true rather than being backfilled to a convenient lie, and those rows sort to
the front of the first sweep exactly as they should.

No index. The sweep reads one account's journal, runs once per consent
decision rather than per request, and already narrows on the indexed
``user_id`` before ordering; an index here would be paid for on every journal
*write* -- the hot path -- to speed up a query that is not.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b1c2d3e4f5a7"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "d7e8f9a0b1c3"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE_NAME = "journalentry"
_COLUMN_NAME = "corpus_attempted_at"


def upgrade() -> None:
    """Add the nullable attempt marker."""
    op.add_column(
        _TABLE_NAME,
        sa.Column(_COLUMN_NAME, sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    """Drop the attempt marker; the sweep falls back to newest-first."""
    op.drop_column(_TABLE_NAME, _COLUMN_NAME)
