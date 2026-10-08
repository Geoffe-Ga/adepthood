"""Every soft-delete column is a restore-suppression tombstone source, or says why not.

Restoring a backup older than a deletion brings the deleted rows back, and the
tombstones that recorded the deletion come back *without* it (#3063 AC9-10).
Restore suppression works only if every place a deletion is recorded is
exported before the restore. A new ``deleted_at`` column nobody added to the
export would be a deletion a restore silently undoes, so the registry is total
over the schema: each such column is a source, or exempt with a reason.
"""

from __future__ import annotations

from sqlalchemy import Column, DateTime, MetaData
from sqlmodel import SQLModel

from domain.retention import TOMBSTONE_EXEMPT, TOMBSTONE_SOURCES, tombstone_gaps


def test_every_soft_delete_column_is_a_tombstone_source_or_exempt() -> None:
    """The live schema has no unaccounted deletion stamp."""
    assert tombstone_gaps(SQLModel.metadata) == ()


def test_sources_are_the_entry_and_the_account() -> None:
    """The two deletions a restore can undo, with content-free columns only."""
    assert set(TOMBSTONE_SOURCES) == {"journalentry", "accountdeletionaudit"}
    assert TOMBSTONE_SOURCES["journalentry"].columns == ("id", "user_id", "deleted_at")
    assert TOMBSTONE_SOURCES["accountdeletionaudit"].columns == ("user_id", "deleted_at")
    assert "user.deleted_at" in TOMBSTONE_EXEMPT


def test_a_new_deleted_at_column_is_a_gap() -> None:
    """Adding a soft-delete column to a copied table produces a named gap."""
    copied = MetaData()
    for table in SQLModel.metadata.tables.values():
        table.to_metadata(copied)
    copied.tables["habit"].append_column(Column("deleted_at", DateTime(timezone=True)))
    gaps = tombstone_gaps(copied)
    assert len(gaps) == 1
    assert "habit.deleted_at" in gaps[0]


def test_a_source_naming_a_missing_column_is_a_gap() -> None:
    """A source or exemption describing a column that no longer exists is stale."""
    copied = MetaData()
    for name, table in SQLModel.metadata.tables.items():
        if name != "user":
            table.to_metadata(copied)
    assert any("user.deleted_at" in gap for gap in tombstone_gaps(copied))
