"""Every soft-delete column is a restore-suppression tombstone source, or says why not.

Restoring a backup older than a deletion brings the deleted rows back, and the
tombstones that recorded the deletion come back *without* it (#3063 AC9-10).
Restore suppression works only if every place a deletion is recorded is
exported before the restore. A new ``deleted_at`` column nobody added to the
export would be a deletion a restore silently undoes, so the registry is total
over the schema: each such column is a source, or exempt with a reason.

An Intimate reclassification and an open withdrawal obligation are requests a
restore would forget in the same way, so they are sources too (#3214).
"""

from __future__ import annotations

import pytest
from sqlalchemy import Column, DateTime, MetaData
from sqlmodel import SQLModel

from domain import retention
from domain.retention import (
    TOMBSTONE_EXEMPT,
    TOMBSTONE_SOURCES,
    TombstoneKind,
    TombstoneSource,
    tombstone_gaps,
)


def test_every_soft_delete_column_is_a_tombstone_source_or_exempt() -> None:
    """The live schema has no unaccounted deletion stamp."""
    assert tombstone_gaps(SQLModel.metadata) == ()


def test_sources_are_every_request_a_restore_could_forget() -> None:
    """Erasure, soft delete, Intimate tier and owed withdrawal, with content-free columns only."""
    expected = {
        TombstoneKind.ACCOUNT: TombstoneSource("accountdeletionaudit", ("user_id",)),
        TombstoneKind.ENTRY: TombstoneSource("journalentry", ("id", "user_id", "timestamp")),
        TombstoneKind.INTIMATE: TombstoneSource(
            "journalentry", ("id", "user_id", "timestamp"), stamp="classification"
        ),
        TombstoneKind.OBLIGATION: TombstoneSource(
            "journalwithdrawalobligation",
            ("journal_entry_id", "user_id", "destination"),
            stamp="state",
        ),
    }
    assert dict(TOMBSTONE_SOURCES) == expected
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


def test_a_missing_obligation_table_is_a_gap() -> None:
    """Without the obligation table its source names columns that are not there."""
    copied = MetaData()
    for name, table in SQLModel.metadata.tables.items():
        if name != "journalwithdrawalobligation":
            table.to_metadata(copied)
    gaps = " ".join(tombstone_gaps(copied))
    assert "journalwithdrawalobligation.state is declared for tombstones" in gaps


def test_a_kind_without_a_source_is_a_gap(monkeypatch: pytest.MonkeyPatch) -> None:
    """A request kind the export has no source for is named, not silently skipped."""
    sources = {k: v for k, v in TOMBSTONE_SOURCES.items() if k is not TombstoneKind.INTIMATE}
    monkeypatch.setattr(retention, "TOMBSTONE_SOURCES", sources)
    assert tombstone_gaps(SQLModel.metadata) == ("tombstone kind intimate has no source",)
