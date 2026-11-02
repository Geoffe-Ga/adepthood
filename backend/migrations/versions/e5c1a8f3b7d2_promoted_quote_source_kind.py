"""A promoted quote can come from an entry, a Course chapter, or a Resonance Letter (#3656).

Revision ID: e5c1a8f3b7d2
Revises: 8c4e2b7d1a95
Create Date: 2026-11-02 00:00:00.000000

Generalizes ``promotedquote`` from "always a journal entry" to one of three
source kinds, recorded in a new discriminator column:

* ``source_kind`` -- ``VARCHAR(16) NOT NULL DEFAULT 'entry'``. The server
  default backfills every existing row as an entry quote, which is what each one
  is, and stays in place so a non-ORM writer that names no kind writes an entry
  quote.
* ``source_entry_id`` becomes nullable; its foreign key keeps ``ON DELETE
  CASCADE``.
* ``source_content_id`` -- nullable, indexed FK to ``stagecontent.id``, ``ON
  DELETE SET NULL``: a published chapter being re-pinned never erases a quote a
  writer gathered from it.
* ``source_marginalia_id`` -- nullable, indexed FK to ``marginalia.id``, ``ON
  DELETE CASCADE``: a letter quote goes with the margin note it was lifted from,
  as an entry quote goes with its entry.
* ``source_title`` -- nullable ``VARCHAR(200)`` plaintext, a snapshot of a Course
  chapter's published title so the quote still names its chapter after a prune.

Three CHECKs keep the pairing honest for any writer: the kind is one of the
three; each kind carries its own link and no other (a Course quote's own link
may be NULL once its chapter was pruned); and the plaintext title exists only on
a Course quote, so it can never hold the writer's own (encrypted) entry title.
The CHECK SQL and names are frozen literals here rather than imported from
``src``, so this revision means the same thing forever; they are identical to
the model's ``__table_args__`` (pinned by ``tests/test_promoted_quote_model.py``)
so ``alembic check`` sees no drift.

``downgrade`` DELETES every Course and letter quote before restoring
``source_entry_id NOT NULL``: those rows have no source entry to point at, so
there is no shape of the old table that can hold them. Entry quotes survive with
every field they had. Everything runs inside ``batch_alter_table`` so the SQLite
round trip rebuilds the table while Postgres emits plain ``ALTER TABLE``.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e5c1a8f3b7d2"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "8c4e2b7d1a95"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "promotedquote"

# Widths, frozen at this revision (mirrored by models.promoted_quote).
_KIND_LENGTH = 16
_TITLE_LENGTH = 200

#: The source kinds as of this revision, in the model enum's order.
FROZEN_SOURCE_KINDS = ("entry", "course", "letter")
_ENTRY_KIND = "entry"

_CONTENT_FK = "fk_promotedquote_source_content_id_stagecontent"
_MARGINALIA_FK = "fk_promotedquote_source_marginalia_id_marginalia"
_CONTENT_INDEX = "ix_promotedquote_source_content_id"
_MARGINALIA_INDEX = "ix_promotedquote_source_marginalia_id"

_KIND_CHECK = "ck_promotedquote_source_kind_valid"
_SOURCE_CHECK = "ck_promotedquote_source_matches_kind"
_TITLE_CHECK = "ck_promotedquote_source_title_course_only"

KIND_CONDITION = "source_kind IN ('entry', 'course', 'letter')"
SOURCE_CONDITION = (
    "(source_kind = 'entry' AND source_entry_id IS NOT NULL"
    " AND source_content_id IS NULL AND source_marginalia_id IS NULL)"
    " OR (source_kind = 'course' AND source_entry_id IS NULL"
    " AND source_marginalia_id IS NULL)"
    " OR (source_kind = 'letter' AND source_marginalia_id IS NOT NULL"
    " AND source_entry_id IS NULL AND source_content_id IS NULL)"
)
TITLE_CONDITION = "source_title IS NULL OR source_kind = 'course'"

_CHECKS = (
    (_KIND_CHECK, KIND_CONDITION),
    (_SOURCE_CHECK, SOURCE_CONDITION),
    (_TITLE_CHECK, TITLE_CONDITION),
)
_LINKS = (
    ("source_content_id", _CONTENT_FK, _CONTENT_INDEX, "stagecontent", "SET NULL"),
    ("source_marginalia_id", _MARGINALIA_FK, _MARGINALIA_INDEX, "marginalia", "CASCADE"),
)


def upgrade() -> None:
    """Add the discriminator, the two new source links and the title snapshot, then the CHECKs."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(
            sa.Column(
                "source_kind",
                sa.String(length=_KIND_LENGTH),
                nullable=False,
                server_default=_ENTRY_KIND,
            )
        )
        for column, _fk, _index, _parent, _ondelete in _LINKS:
            batch_op.add_column(sa.Column(column, sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("source_title", sa.String(length=_TITLE_LENGTH)))
        batch_op.alter_column("source_entry_id", existing_type=sa.Integer(), nullable=True)
        for column, fk, index, parent, ondelete in _LINKS:
            batch_op.create_foreign_key(fk, parent, [column], ["id"], ondelete=ondelete)
            batch_op.create_index(index, [column])
        for name, condition in _CHECKS:
            batch_op.create_check_constraint(name, condition)


def downgrade() -> None:
    """Delete every Course and letter quote, then restore the entry-only table.

    The delete is the irreversible part: a quote with no source entry has no
    place in a table whose ``source_entry_id`` is NOT NULL. Entry quotes keep
    every field they had.
    """
    op.execute(
        sa.text("DELETE FROM promotedquote WHERE source_kind <> :entry").bindparams(
            entry=_ENTRY_KIND
        )
    )
    with op.batch_alter_table(_TABLE) as batch_op:
        for name, _condition in reversed(_CHECKS):
            batch_op.drop_constraint(name, type_="check")
        for column, fk, index, _parent, _ondelete in reversed(_LINKS):
            batch_op.drop_index(index)
            batch_op.drop_constraint(fk, type_="foreignkey")
            batch_op.drop_column(column)
        batch_op.alter_column("source_entry_id", existing_type=sa.Integer(), nullable=False)
        batch_op.drop_column("source_title")
        batch_op.drop_column("source_kind")
