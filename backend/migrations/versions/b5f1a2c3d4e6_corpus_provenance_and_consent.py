"""corpus provenance and per-source consent

Revision ID: b5f1a2c3d4e6
Revises: a4c7e91b3d05
Create Date: 2026-08-21 00:00:00.000000

Two changes, shipped together because the writer that makes either of them
matter is the same commit.

``corpusfragment.source_entry_id`` records the journal row a fragment was
derived from. Nullable, because material an import surface brings in from
elsewhere never had one, and every query that filters on it therefore has to
treat NULL as "not that entry" rather than as an unknown. Without the column,
a reflection can retrieve the very entry it is reflecting on as that entry's
own "earlier writing" — unreachable while nothing wrote fragments, reachable
the moment something did. ``ON DELETE CASCADE`` matches
``promotedquote.source_entry_id``, which points at the same table for the same
reason.

``corpusconsentevent`` is one row per decision an account made about one
source, appended and never updated. ADR 0005 Decision 5 requires consent per
source to be an auditable event rather than an implicit state; a boolean column
updated in place would answer "may we?" and destroy "when did they agree?" at
exactly the moment somebody would ask it — the revocation. Current consent is
the newest row for a ``(user_id, source)`` pair, which is what
``ix_corpusconsentevent_user_source_id`` serves: it carries the ordering key as
well as the filter, so the read is one index scan of one row.

``fragments_removed`` is how many fragments a revocation deleted, and zero for
a grant. It is the same kind of evidence ``accountdeletionaudit.row_counts``
is: it proves the purge reached the corpus and says nothing about what was in
it. The row holds no content of any kind.

Both CHECK constraints are generated from the same enums the models generate
theirs from, so the persisted vocabularies cannot drift from the code that
reads them.

``downgrade`` drops the consent table and its index, then the FK, index and
column on ``corpusfragment``.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b5f1a2c3d4e6"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a4c7e91b3d05"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_FRAGMENT_TABLE = "corpusfragment"
_PROVENANCE_COLUMN = "source_entry_id"
_PROVENANCE_INDEX = "ix_corpusfragment_source_entry_id"
_PROVENANCE_FK = "corpusfragment_source_entry_id_fkey"

_CONSENT_TABLE = "corpusconsentevent"
_CONSENT_USER_INDEX = "ix_corpusconsentevent_user_id"
_CONSENT_LOOKUP_INDEX = "ix_corpusconsentevent_user_source_id"

# Matches ``models.corpus_consent``: both columns hold one symbolic token from
# a closed set, never prose.
_SOURCE_WIDTH = 20
_DECISION_WIDTH = 20


def upgrade() -> None:
    """Add the provenance column, then the consent event log."""
    op.add_column(_FRAGMENT_TABLE, sa.Column(_PROVENANCE_COLUMN, sa.Integer(), nullable=True))
    op.create_index(_PROVENANCE_INDEX, _FRAGMENT_TABLE, [_PROVENANCE_COLUMN])
    op.create_foreign_key(
        _PROVENANCE_FK,
        _FRAGMENT_TABLE,
        "journalentry",
        [_PROVENANCE_COLUMN],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_table(
        _CONSENT_TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("source", sqlmodel.sql.sqltypes.AutoString(length=_SOURCE_WIDTH), nullable=False),
        sa.Column(
            "decision", sqlmodel.sql.sqltypes.AutoString(length=_DECISION_WIDTH), nullable=False
        ),
        sa.Column("fragments_removed", sa.Integer(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "source IN ('journal', 'upload', 'import')",
            name="ck_corpusconsentevent_source_valid",
        ),
        sa.CheckConstraint(
            "decision IN ('granted', 'revoked')",
            name="ck_corpusconsentevent_decision_valid",
        ),
        sa.CheckConstraint(
            "fragments_removed >= 0",
            name="ck_corpusconsentevent_fragments_removed_range",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(_CONSENT_USER_INDEX, _CONSENT_TABLE, ["user_id"])
    op.create_index(_CONSENT_LOOKUP_INDEX, _CONSENT_TABLE, ["user_id", "source", "id"])


def downgrade() -> None:
    """Drop the consent log, then the provenance column and its constraints."""
    op.drop_index(_CONSENT_LOOKUP_INDEX, table_name=_CONSENT_TABLE)
    op.drop_index(_CONSENT_USER_INDEX, table_name=_CONSENT_TABLE)
    op.drop_table(_CONSENT_TABLE)
    op.drop_constraint(_PROVENANCE_FK, _FRAGMENT_TABLE, type_="foreignkey")
    op.drop_index(_PROVENANCE_INDEX, table_name=_FRAGMENT_TABLE)
    op.drop_column(_FRAGMENT_TABLE, _PROVENANCE_COLUMN)
