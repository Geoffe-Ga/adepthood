"""The ``habitunlockevent`` migration creates the log and backfills open habits (#3724).

Kept in its own module, like the other single-migration round trips: the fixture
builds the tables the backfill reads as the parent revision leaves the columns
it needs, then stamps that revision.

The backfill rules under test:

* one ``unlocked`` / ``backfill`` event per currently revealed program habit;
* dated at ``auto_revealed_at`` when set, else at the habit's earliest
  completion day with units above zero, else skipped;
* tagged with the pass whose date range holds that day (``NULL`` when none
  does) and the habit's current program number;
* carryover and locked habits get nothing.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, create_engine, inspect, text
from sqlmodel import SQLModel

_BASE_REVISION = "7c3e5a1d9b42"  # pragma: allowlist secret
_REVISION = "9d2b6e4f1a73"  # pragma: allowlist secret
_TABLE = "habitunlockevent"

_PASS_ONE = 10
_PASS_TWO = 11
_UTC = "UTC"
_FAR_EAST_TZ = "Pacific/Kiritimati"


@contextmanager
def _connect(db_url: str) -> Iterator[Connection]:
    """A committing sync connection with real foreign keys."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        with engine.begin() as conn:
            conn.execute(text("PRAGMA foreign_keys=ON"))
            yield conn
    finally:
        engine.dispose()


_BOOTSTRAP = (
    "CREATE TABLE user (id INTEGER PRIMARY KEY, timezone VARCHAR(64) NOT NULL)",
    (
        "CREATE TABLE programpass (id INTEGER PRIMARY KEY,"
        " user_id INTEGER NOT NULL REFERENCES user (id) ON DELETE CASCADE,"
        " pass_number INTEGER NOT NULL, started_on DATE NOT NULL, ended_on DATE)"
    ),
    (
        "CREATE TABLE habit (id INTEGER PRIMARY KEY,"
        " user_id INTEGER NOT NULL REFERENCES user (id) ON DELETE CASCADE,"
        " sort_order INTEGER, revealed BOOLEAN NOT NULL, is_carryover BOOLEAN NOT NULL,"
        " auto_revealed_at DATETIME)"
    ),
    (
        "CREATE TABLE goal (id INTEGER PRIMARY KEY,"
        " habit_id INTEGER NOT NULL REFERENCES habit (id) ON DELETE CASCADE)"
    ),
    (
        "CREATE TABLE goalcompletion (id INTEGER PRIMARY KEY,"
        " goal_id INTEGER NOT NULL REFERENCES goal (id) ON DELETE CASCADE,"
        " user_id INTEGER NOT NULL REFERENCES user (id) ON DELETE CASCADE,"
        " local_day DATE NOT NULL, completed_units FLOAT NOT NULL)"
    ),
)


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database stamped at this migration's parent revision."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'habit_unlock_event.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    with _connect(async_url) as conn:
        for statement in _BOOTSTRAP:
            conn.execute(text(statement))
    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _BASE_REVISION)
    return cfg


def _url(cfg: Config) -> str:
    url = cfg.get_main_option("sqlalchemy.url")
    assert url is not None
    return url


def _account(cfg: Config, user_id: int, tz: str = _UTC) -> None:
    """One account with a closed pass 1 (January-May 2026) and a live pass 2 from June."""
    with _connect(_url(cfg)) as conn:
        conn.execute(
            text("INSERT INTO user (id, timezone) VALUES (:id, :tz)"), {"id": user_id, "tz": tz}
        )
        conn.execute(
            text(
                "INSERT INTO programpass (id, user_id, pass_number, started_on, ended_on)"
                " VALUES (:one, :user, 1, '2026-01-05', '2026-05-31'),"
                " (:two, :user, 2, '2026-06-01', NULL)"
            ),
            {"one": _PASS_ONE + user_id * 100, "two": _PASS_TWO + user_id * 100, "user": user_id},
        )


@dataclass(frozen=True)
class _Habit:
    """One habit row, naming each column a case pins."""

    habit_id: int
    user_id: int = 1
    sort_order: int | None = 0
    revealed: bool = True
    is_carryover: bool = False
    auto_revealed_at: str | None = None
    completions: tuple[tuple[str, float], ...] = ()


def _habit(cfg: Config, habit: _Habit) -> None:
    """Insert ``habit`` and one goal carrying its completions."""
    with _connect(_url(cfg)) as conn:
        conn.execute(
            text(
                "INSERT INTO habit (id, user_id, sort_order, revealed, is_carryover,"
                " auto_revealed_at) VALUES (:id, :user, :sort, :revealed, :carry, :stamp)"
            ),
            {
                "id": habit.habit_id,
                "user": habit.user_id,
                "sort": habit.sort_order,
                "revealed": habit.revealed,
                "carry": habit.is_carryover,
                "stamp": habit.auto_revealed_at,
            },
        )
        conn.execute(
            text("INSERT INTO goal (id, habit_id) VALUES (:id, :id)"), {"id": habit.habit_id}
        )
        for day, units in habit.completions:
            conn.execute(
                text(
                    "INSERT INTO goalcompletion (goal_id, user_id, local_day, completed_units)"
                    " VALUES (:goal, :user, :day, :units)"
                ),
                {"goal": habit.habit_id, "user": habit.user_id, "day": day, "units": units},
            )


_Row = tuple[int, int | None, str, date, int, str, datetime]


def _events(cfg: Config) -> list[_Row]:
    """Every event as ``(habit, pass, kind, local_day, number, source, occurred_at)``."""
    with _connect(_url(cfg)) as conn:
        rows = conn.execute(
            text(
                "SELECT habit_id, pass_id, kind, local_day, program_number, source,"
                " occurred_at FROM habitunlockevent ORDER BY habit_id"
            )
        ).all()
    return [
        (
            row[0],
            row[1],
            row[2],
            date.fromisoformat(row[3]),
            row[4],
            row[5],
            datetime.fromisoformat(row[6]).replace(tzinfo=UTC),
        )
        for row in rows
    ]


def test_the_migration_chains_from_its_authored_head(migration_config: Config) -> None:
    """One linear chain: this revision extends the head it was written against."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    heads = script.get_heads()
    assert len(heads) == 1
    assert _REVISION in {rev.revision for rev in script.iterate_revisions(heads[0], "base")}


def test_the_migrated_table_matches_the_model(migration_config: Config) -> None:
    """Columns, nullability, indexes and CHECK constraints all agree with the model."""
    command.upgrade(migration_config, _REVISION)

    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        inspector = inspect(engine)
        migrated = {col["name"]: col["nullable"] for col in inspector.get_columns(_TABLE)}
        indexes = {tuple(index["column_names"]) for index in inspector.get_indexes(_TABLE)}
        checks = {str(check["name"]) for check in inspector.get_check_constraints(_TABLE)}
        cascades = {
            key["referred_table"]: key["options"].get("ondelete")
            for key in inspector.get_foreign_keys(_TABLE)
        }
    finally:
        engine.dispose()
    model = SQLModel.metadata.tables[_TABLE]
    assert migrated == {column.name: column.nullable for column in model.columns}
    assert {("user_id",), ("habit_id",), ("pass_id",)} <= indexes
    assert checks == {
        str(constraint.name)
        for constraint in model.constraints
        if constraint.__class__.__name__ == "CheckConstraint"
    }
    assert cascades == {"user": "CASCADE", "habit": "CASCADE", "programpass": "CASCADE"}


def test_a_stamped_habit_is_dated_at_its_stamp(migration_config: Config) -> None:
    """``auto_revealed_at`` is the date, and the instant, of the backfilled unlock."""
    _account(migration_config, 1)
    _habit(
        migration_config,
        _Habit(1, auto_revealed_at="2026-06-22 09:00:00.000000", completions=(("2026-02-01", 1),)),
    )

    command.upgrade(migration_config, _REVISION)

    assert _events(migration_config) == [
        (
            1,
            _PASS_TWO + 100,
            "unlocked",
            date(2026, 6, 22),
            1,
            "backfill",
            datetime(2026, 6, 22, 9, tzinfo=UTC),
        )
    ]


def test_an_unstamped_habit_is_dated_at_its_first_real_completion(
    migration_config: Config,
) -> None:
    """The earliest day with units above zero; a zero-unit day before it does not count."""
    _account(migration_config, 1)
    _habit(
        migration_config,
        _Habit(1, completions=(("2026-03-01", 0), ("2026-03-04", 2), ("2026-04-10", 1))),
    )

    command.upgrade(migration_config, _REVISION)

    (row,) = _events(migration_config)
    assert row[:6] == (1, _PASS_ONE + 100, "unlocked", date(2026, 3, 4), 1, "backfill")
    assert row[6] == datetime(2026, 3, 4, tzinfo=UTC)


def test_a_habit_with_neither_is_skipped(migration_config: Config) -> None:
    """No stamp and no real completion: no date to guess, so no row."""
    _account(migration_config, 1)
    _habit(migration_config, _Habit(1, completions=(("2026-03-01", 0),)))

    command.upgrade(migration_config, _REVISION)

    assert _events(migration_config) == []


def test_locked_and_carryover_habits_get_nothing_and_do_not_count(
    migration_config: Config,
) -> None:
    """Only open program habits are backfilled; a carryover never shifts the number.

    A locked program habit still holds its place in the program, so the open
    habit after it is number 2.
    """
    _account(migration_config, 1)
    stamp = "2026-06-22 09:00:00.000000"
    _habit(migration_config, _Habit(1, sort_order=0, is_carryover=True, auto_revealed_at=stamp))
    _habit(migration_config, _Habit(2, sort_order=1, revealed=False, auto_revealed_at=stamp))
    _habit(migration_config, _Habit(3, sort_order=2, auto_revealed_at=stamp))

    command.upgrade(migration_config, _REVISION)

    assert [(row[0], row[4]) for row in _events(migration_config)] == [(3, 2)]


def test_unnumbered_habits_come_first_then_slot_then_id(migration_config: Config) -> None:
    """The program number follows the habit list's own order."""
    _account(migration_config, 1)
    stamp = "2026-06-22 09:00:00.000000"
    _habit(migration_config, _Habit(1, sort_order=4, auto_revealed_at=stamp))
    _habit(migration_config, _Habit(2, sort_order=None, auto_revealed_at=stamp))
    _habit(migration_config, _Habit(3, sort_order=4, auto_revealed_at=stamp))

    command.upgrade(migration_config, _REVISION)

    assert [(row[0], row[4]) for row in _events(migration_config)] == [(1, 2), (2, 1), (3, 3)]


def test_a_day_outside_every_pass_leaves_the_pass_unknown(migration_config: Config) -> None:
    """Before pass 1 began there is no pass to tag, so ``pass_id`` stays NULL."""
    _account(migration_config, 1)
    _habit(migration_config, _Habit(1, completions=(("2025-12-01", 1),)))

    command.upgrade(migration_config, _REVISION)

    (row,) = _events(migration_config)
    assert row[1] is None


def test_the_stamp_is_dated_in_the_account_zone(migration_config: Config) -> None:
    """11:00 UTC on 31 May is already 1 June in Kiritimati, so it falls in pass 2."""
    _account(migration_config, 1, tz=_FAR_EAST_TZ)
    _habit(migration_config, _Habit(1, auto_revealed_at="2026-05-31 11:00:00.000000"))

    command.upgrade(migration_config, _REVISION)

    (row,) = _events(migration_config)
    assert row[1] == _PASS_TWO + 100
    assert row[3] == date(2026, 6, 1)


def test_a_completion_day_starts_at_local_midnight(migration_config: Config) -> None:
    """A day-only date becomes the instant that day began where the person lives."""
    _account(migration_config, 1, tz=_FAR_EAST_TZ)
    _habit(migration_config, _Habit(1, completions=(("2026-03-04", 1),)))

    command.upgrade(migration_config, _REVISION)

    (row,) = _events(migration_config)
    local_midnight = datetime(2026, 3, 4, tzinfo=ZoneInfo(_FAR_EAST_TZ))
    assert row[6] == local_midnight.astimezone(UTC)


def test_each_account_is_backfilled_against_its_own_passes(migration_config: Config) -> None:
    """Passes and positions never cross accounts."""
    _account(migration_config, 1)
    _account(migration_config, 2)
    stamp = "2026-06-22 09:00:00.000000"
    _habit(migration_config, _Habit(1, user_id=1, sort_order=0, auto_revealed_at=stamp))
    _habit(migration_config, _Habit(2, user_id=2, sort_order=5, auto_revealed_at=stamp))

    command.upgrade(migration_config, _REVISION)

    assert [(row[0], row[1], row[4]) for row in _events(migration_config)] == [
        (1, _PASS_TWO + 100, 1),
        (2, _PASS_TWO + 200, 1),
    ]


def test_downgrade_drops_the_table_and_upgrade_rebuilds_it(migration_config: Config) -> None:
    """The round trip is clean and leaves every habit untouched."""
    _account(migration_config, 1)
    _habit(migration_config, _Habit(1, auto_revealed_at="2026-06-22 09:00:00.000000"))
    command.upgrade(migration_config, _REVISION)

    command.downgrade(migration_config, _BASE_REVISION)

    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        assert _TABLE not in inspect(engine).get_table_names()
    finally:
        engine.dispose()
    command.upgrade(migration_config, _REVISION)
    assert len(_events(migration_config)) == 1


def test_deleting_a_habit_deletes_its_events(migration_config: Config) -> None:
    """The migrated foreign key cascades with the habit."""
    _account(migration_config, 1)
    stamp = "2026-06-22 09:00:00.000000"
    _habit(migration_config, _Habit(1, sort_order=0, auto_revealed_at=stamp))
    _habit(migration_config, _Habit(2, sort_order=1, auto_revealed_at=stamp))
    command.upgrade(migration_config, _REVISION)

    with _connect(_url(migration_config)) as conn:
        conn.execute(text("DELETE FROM habit WHERE id = 1"))

    assert [row[0] for row in _events(migration_config)] == [2]


@pytest.mark.parametrize(
    "tz", [pytest.param("Not/AZone", id="unknown"), pytest.param("", id="empty")]
)
def test_a_zone_the_runtime_cannot_load_counts_in_utc(migration_config: Config, tz: str) -> None:
    """An unknown or empty zone falls back to UTC, the app's own default.

    23:30 UTC on 31 May is still 31 May in UTC, so the unlock lands in pass 1.
    """
    _account(migration_config, 1, tz=tz)
    _habit(migration_config, _Habit(1, auto_revealed_at="2026-05-31 23:30:00.000000"))
    _habit(migration_config, _Habit(2, sort_order=1, completions=(("2026-03-04", 1),)))

    command.upgrade(migration_config, _REVISION)

    stamped, completed = _events(migration_config)
    assert stamped[1:4] == (_PASS_ONE + 100, "unlocked", date(2026, 5, 31))
    assert completed[6] == datetime(2026, 3, 4, tzinfo=UTC)
