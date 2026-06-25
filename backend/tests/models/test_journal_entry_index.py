"""Index coverage for the :class:`JournalEntry` chat read path.

``load_recent_conversation`` filters on ``(user_id, sender, deleted_at)`` and
orders by ``id DESC``; without a covering composite index every chat turn
scans the user's full journal history (audit §5.3). This pins the index onto
the model metadata so the migration and model cannot drift, while retaining
the original single-column ``deleted_at`` index.
"""

from __future__ import annotations

from models.journal_entry import JournalEntry

_TABLE_NAME = "journalentry"
_COMPOSITE_INDEX_COLUMNS = ("user_id", "sender", "deleted_at")
_DELETED_AT_INDEX_COLUMNS = ("deleted_at",)


def _index_column_tuples() -> set[tuple[str, ...]]:
    table = JournalEntry.metadata.tables[_TABLE_NAME]
    return {tuple(column.name for column in index.columns) for index in table.indexes}


def test_journal_entry_has_composite_chat_read_index() -> None:
    """A composite ``(user_id, sender, deleted_at)`` index backs the chat read."""
    assert _COMPOSITE_INDEX_COLUMNS in _index_column_tuples()


def test_journal_entry_retains_deleted_at_index() -> None:
    """The original soft-delete ``deleted_at`` index is not removed."""
    assert _DELETED_AT_INDEX_COLUMNS in _index_column_tuples()
