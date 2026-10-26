"""Per-log provenance survives independently of the daily aggregate."""

from datetime import UTC, date

from sqlalchemy import String, TypeDecorator
from sqlmodel import SQLModel

from models.goal_log_event import GoalLogEvent, GoalLogSource


def test_goal_log_event_schema_is_registered() -> None:
    """The standard metadata fixture creates the event table and read index."""
    assert "goallogevent" in SQLModel.metadata.tables
    table = SQLModel.metadata.tables["goallogevent"]
    assert {tuple(column.name for column in index.columns) for index in table.indexes} == {
        ("goal_id", "user_id", "timestamp"),
    }
    source_type = table.c.source.type
    assert isinstance(source_type, TypeDecorator)
    assert isinstance(source_type.impl, String)
    assert source_type.impl.length == 32
    for name in ("goal_id", "user_id"):
        assert {key.ondelete for key in table.c[name].foreign_keys} == {"CASCADE"}


def test_new_event_has_an_aware_server_timestamp() -> None:
    """Local-day provenance and the actual logging instant stay independent."""
    event = GoalLogEvent(
        goal_id=1,
        user_id=1,
        local_day=date(2026, 10, 24),
        delta_units=-3,
        source=GoalLogSource.MANUAL,
    )
    assert event.timestamp.tzinfo == UTC
    assert event.via_timer is False
