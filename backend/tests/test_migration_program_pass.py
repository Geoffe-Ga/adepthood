"""The ``programpass`` migration creates the table and backfills one pass per known cycle (#3723).

Kept in its own module, like the other single-migration round trips: the fixture
builds the two tables the backfill reads (``user`` and ``stageprogress``) as the
parent revision leaves the columns it needs, then stamps that revision.

The backfill rules under test:

* one pass per entry in ``past_cycle_anchors`` plus the live one;
* a past pass ends the day before the next pass starts;
* a ``None`` anchor (destroyed before #2894) produces no row, and numbering
  keeps following ``cycle_number``, so it has a gap rather than a guess;
* a user with no ``stageprogress`` row gets no pass at all;
* every day is counted in the account's own zone.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, create_engine, inspect, text
from sqlmodel import SQLModel

from domain.program_pass import PROGRAM_CALENDAR, close_pass
from models.program_pass import PassOrigin, ProgramPass

_BASE_REVISION = "166523efc36e"  # pragma: allowlist secret
_REVISION = "7c3e5a1d9b42"  # pragma: allowlist secret
_TABLE = "programpass"

_INSERT_USER = text("INSERT INTO user (id, timezone) VALUES (:id, :tz)")
_INSERT_PROGRESS = text(
    "INSERT INTO stageprogress"
    " (id, user_id, cycle_number, program_started_at, stage_started_at, past_cycle_anchors)"
    " VALUES (:id, :user_id, :cycle, :program, :stage, :anchors)"
)

# The live anchor most rows below share, as SQLite stores an aware datetime.
_LIVE_ANCHOR = "2026-06-01 00:00:00.000000"
_LIVE_DAY = date(2026, 6, 1)


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


def _bootstrap(db_url: str) -> None:
    """Create ``user`` and ``stageprogress`` with the columns the backfill reads."""
    with _connect(db_url) as conn:
        conn.execute(
            text("CREATE TABLE user (id INTEGER PRIMARY KEY, timezone VARCHAR(64) NOT NULL)")
        )
        conn.execute(
            text(
                "CREATE TABLE stageprogress (id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL UNIQUE REFERENCES user (id) ON DELETE CASCADE,"
                " cycle_number INTEGER NOT NULL,"
                " program_started_at DATETIME,"
                " stage_started_at DATETIME NOT NULL,"
                " past_cycle_anchors JSON)"
            )
        )


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database stamped at this migration's parent revision."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'program_pass.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    _bootstrap(async_url)
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


@dataclass(frozen=True)
class _Progress:
    """One account and its progress row, as the parent revision holds them."""

    user_id: int
    cycle: int
    anchors: list[str | None] | None
    program: str | None = _LIVE_ANCHOR
    stage: str = _LIVE_ANCHOR
    tz: str = "UTC"


def _seed(cfg: Config, progress: _Progress) -> None:
    """Insert ``progress``'s account and its stage-progress row."""
    with _connect(_url(cfg)) as conn:
        conn.execute(_INSERT_USER, {"id": progress.user_id, "tz": progress.tz})
        conn.execute(
            _INSERT_PROGRESS,
            {
                "id": progress.user_id,
                "user_id": progress.user_id,
                "cycle": progress.cycle,
                "program": progress.program,
                "stage": progress.stage,
                "anchors": None if progress.anchors is None else json.dumps(progress.anchors),
            },
        )


_Row = tuple[int, date, date | None, str, int | None, int | None, bool]


def _passes(cfg: Config, user_id: int) -> list[_Row]:
    """Every backfilled pass for ``user_id`` as plain tuples, by pass number."""
    with _connect(_url(cfg)) as conn:
        rows = conn.execute(
            text(
                "SELECT pass_number, started_on, ended_on, origin, reached_stage,"
                " reached_week, completed FROM programpass WHERE user_id = :user_id"
                " ORDER BY pass_number"
            ),
            {"user_id": user_id},
        ).all()
    return [
        (
            row[0],
            date.fromisoformat(row[1]),
            None if row[2] is None else date.fromisoformat(row[2]),
            row[3],
            row[4],
            row[5],
            bool(row[6]),
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
    """Columns, nullability, the owner index and the per-user uniqueness all agree."""
    command.upgrade(migration_config, _REVISION)

    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        inspector = inspect(engine)
        migrated = {col["name"]: col["nullable"] for col in inspector.get_columns(_TABLE)}
        indexes = {tuple(index["column_names"]) for index in inspector.get_indexes(_TABLE)}
        uniques = {tuple(u["column_names"]) for u in inspector.get_unique_constraints(_TABLE)}
        checks = {str(check["name"]) for check in inspector.get_check_constraints(_TABLE)}
    finally:
        engine.dispose()
    model = SQLModel.metadata.tables[_TABLE]
    assert migrated == {column.name: column.nullable for column in model.columns}
    assert ("user_id",) in indexes
    assert ("user_id", "pass_number") in uniques
    assert checks == {
        str(constraint.name)
        for constraint in model.constraints
        if constraint.__class__.__name__ == "CheckConstraint"
    }


def test_the_issue_example_backfills_two_passes(migration_config: Config) -> None:
    """Cycle 2 with one recorded anchor: a closed pass 1 and a live pass 2."""
    _seed(migration_config, _Progress(1, cycle=2, anchors=["2026-01-05T00:00:00+00:00"]))

    command.upgrade(migration_config, _REVISION)

    assert _passes(migration_config, 1) == [
        (1, date(2026, 1, 5), date(2026, 5, 31), PassOrigin.BACKFILL.value, 7, 21, False),
        (2, _LIVE_DAY, None, PassOrigin.BACKFILL.value, None, None, False),
    ]


def test_a_backfilled_pass_is_measured_exactly_as_close_pass_measures_it(
    migration_config: Config,
) -> None:
    """The frozen migration math and the domain's ``close_pass`` agree, including completion."""
    _seed(
        migration_config,
        _Progress(
            1,
            cycle=3,
            anchors=["2025-01-06T00:00:00+00:00", "2025-03-03T00:00:00+00:00"],
            program="2025-12-01 00:00:00.000000",
        ),
    )

    command.upgrade(migration_config, _REVISION)

    rows = _passes(migration_config, 1)
    for pass_number, started_on, ended_on, *recorded in rows[:2]:
        assert ended_on is not None
        expected = close_pass(
            ProgramPass(
                user_id=1,
                pass_number=pass_number,
                started_on=started_on,
                origin=PassOrigin.BACKFILL,
            ),
            ended_on=ended_on,
            calendar=PROGRAM_CALENDAR,
        )
        assert recorded[1:] == [expected.reached_stage, expected.reached_week, expected.completed]
    # Pass 2 ran 2025-03-03 → 2025-11-30: past the end of stage 10.
    assert rows[1][4:] == (10, 36, True)


def test_a_destroyed_anchor_leaves_a_gap_not_a_guess(migration_config: Config) -> None:
    """``None`` for cycle 1: no pass 1, and pass 2 keeps its cycle's number."""
    _seed(migration_config, _Progress(1, cycle=3, anchors=[None, "2026-01-05T00:00:00+00:00"]))

    command.upgrade(migration_config, _REVISION)

    assert [row[:3] for row in _passes(migration_config, 1)] == [
        (2, date(2026, 1, 5), date(2026, 5, 31)),
        (3, _LIVE_DAY, None),
    ]


def test_a_pass_whose_end_is_unknown_is_not_backfilled(migration_config: Config) -> None:
    """A known start followed by a lost one has no knowable end, so it is skipped too.

    The app never writes that shape -- unknown anchors are only ever left-padded --
    but the backfill refuses to invent an end for it rather than guess one.
    """
    _seed(migration_config, _Progress(1, cycle=3, anchors=["2026-01-05T00:00:00+00:00", None]))

    command.upgrade(migration_config, _REVISION)

    assert [row[:3] for row in _passes(migration_config, 1)] == [(3, _LIVE_DAY, None)]


def test_a_row_that_looped_before_anchors_were_kept_backfills_only_the_live_pass(
    migration_config: Config,
) -> None:
    """A short (or NULL) anchor list is left-padded as unknown, never guessed."""
    _seed(migration_config, _Progress(1, cycle=3, anchors=None))

    command.upgrade(migration_config, _REVISION)

    assert [row[:3] for row in _passes(migration_config, 1)] == [(3, _LIVE_DAY, None)]


def test_a_user_without_stage_progress_gets_no_pass(migration_config: Config) -> None:
    """No progress row means no program begun, so nothing is backfilled for them."""
    with _connect(_url(migration_config)) as conn:
        conn.execute(_INSERT_USER, {"id": 1, "tz": "UTC"})

    command.upgrade(migration_config, _REVISION)

    assert _passes(migration_config, 1) == []


def test_days_are_counted_in_the_account_zone(migration_config: Config) -> None:
    """03:00 UTC on 5 January is still 4 January in Los Angeles."""
    _seed(
        migration_config,
        _Progress(
            1,
            cycle=2,
            anchors=["2026-01-05T03:00:00+00:00"],
            program="2026-06-01 03:00:00.000000",
            tz="America/Los_Angeles",
        ),
    )

    command.upgrade(migration_config, _REVISION)

    assert [row[:3] for row in _passes(migration_config, 1)] == [
        (1, date(2026, 1, 4), date(2026, 5, 30)),
        (2, date(2026, 5, 31), None),
    ]


def test_an_unknown_zone_counts_in_utc(migration_config: Config) -> None:
    """A zone the runtime cannot load falls back to UTC, the app's own default."""
    _seed(migration_config, _Progress(1, cycle=1, anchors=None, tz="Not/AZone"))

    command.upgrade(migration_config, _REVISION)

    assert [row[:3] for row in _passes(migration_config, 1)] == [(1, _LIVE_DAY, None)]


def test_a_legacy_row_without_a_program_anchor_starts_from_its_stage_anchor(
    migration_config: Config,
) -> None:
    """``program_started_at`` NULL falls back to ``stage_started_at``, as the app reads it."""
    _seed(
        migration_config,
        _Progress(
            1,
            cycle=1,
            anchors=None,
            program=None,
            stage="2026-02-02 00:00:00.000000",
        ),
    )

    command.upgrade(migration_config, _REVISION)

    assert [row[:3] for row in _passes(migration_config, 1)] == [(1, date(2026, 2, 2), None)]


def test_downgrade_drops_the_table_and_upgrade_rebuilds_it(migration_config: Config) -> None:
    """The round trip is clean; the progress row (and its anchors) is never touched."""
    _seed(migration_config, _Progress(1, cycle=2, anchors=["2026-01-05T00:00:00+00:00"]))
    command.upgrade(migration_config, _REVISION)

    command.downgrade(migration_config, _BASE_REVISION)

    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        assert _TABLE not in inspect(engine).get_table_names()
    finally:
        engine.dispose()
    with _connect(_url(migration_config)) as conn:
        anchors = conn.execute(text("SELECT past_cycle_anchors FROM stageprogress")).scalar_one()
    assert json.loads(anchors) == ["2026-01-05T00:00:00+00:00"]

    command.upgrade(migration_config, _REVISION)
    assert len(_passes(migration_config, 1)) == 2


def test_deleting_the_account_deletes_its_passes(migration_config: Config) -> None:
    """The migrated foreign key cascades with the account, like every per-user table."""
    _seed(migration_config, _Progress(1, cycle=1, anchors=None))
    _seed(migration_config, _Progress(2, cycle=1, anchors=None))
    command.upgrade(migration_config, _REVISION)

    with _connect(_url(migration_config)) as conn:
        conn.execute(text("DELETE FROM stageprogress WHERE user_id = 1"))
        conn.execute(text("DELETE FROM user WHERE id = 1"))

    assert _passes(migration_config, 1) == []
    assert len(_passes(migration_config, 2)) == 1
