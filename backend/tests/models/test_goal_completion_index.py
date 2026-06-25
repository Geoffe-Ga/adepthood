"""Index coverage for the high-write :class:`GoalCompletion` table.

Streak/stats reads filter on ``goal_id`` / ``user_id`` and sort by
``timestamp``; without a covering composite index every such query
full-scans and sorts this hottest-write table (audit §5.3). This pins the
index onto the model metadata so the migration and model cannot drift.
"""

from __future__ import annotations

from models.goal_completion import GoalCompletion

_EXPECTED_INDEX_COLUMNS = ("goal_id", "user_id", "timestamp")
_TABLE_NAME = "goalcompletion"


def test_goal_completion_has_composite_read_index() -> None:
    """A composite ``(goal_id, user_id, timestamp)`` index backs hot reads."""
    table = GoalCompletion.metadata.tables[_TABLE_NAME]
    index_column_tuples = {
        tuple(column.name for column in index.columns) for index in table.indexes
    }
    assert _EXPECTED_INDEX_COLUMNS in index_column_tuples
