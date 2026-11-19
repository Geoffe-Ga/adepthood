"""Round trip for the ``stageprogress.highest_drip_day`` migration (issue #3744).

The Course holds at the lifetime mark: every stage below it fully open and the
mark's own stage as far as it had dripped. A row already reset below its mark
before this revision never recorded that day, so the backfill holds the mark's
whole stage open; a row still standing on its mark holds nothing, because the
live drip paces it.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, Integer, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import SQLModel

from domain.constants import STAGE_DURATIONS_DAYS
from models.stage_progress import StageProgress

_BASE_REVISION = "a4c8e2f6b1d3"  # pragma: allowlist secret
_REVISION = "b7e1c4d9a2f5"  # pragma: allowlist secret
_TABLE = "stageprogress"
_COLUMN = "highest_drip_day"
# User 1 began again from stage 10; user 2 stands on its stage-4 mark.
_RESET_USER = 1
_ON_MARK_USER = 2
_FINAL_STAGE = 10
_ON_MARK_STAGE = 4


@contextmanager
def _connect(db_url: str) -> Iterator[Connection]:
    """A committing sync connection to ``db_url``."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        with engine.begin() as conn:
            yield conn
    finally:
        engine.dispose()


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database with a reset row and an on-mark row, stamped at the parent."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'highest_drip_day.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    with _connect(async_url) as conn:
        conn.execute(
            text(
                "CREATE TABLE stageprogress (id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL UNIQUE, current_stage INTEGER NOT NULL,"
                " highest_stage_reached INTEGER NOT NULL, cycle_number INTEGER NOT NULL,"
                " stage_started_at DATETIME NOT NULL)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO stageprogress (user_id, current_stage, highest_stage_reached,"
                " cycle_number, stage_started_at) VALUES"
                " (:reset, 1, :final, 2, '2026-09-14T00:00:00+00:00'),"
                " (:on_mark, :stage, :stage, 1, '2026-09-14T00:00:00+00:00')"
            ),
            {
                "reset": _RESET_USER,
                "final": _FINAL_STAGE,
                "on_mark": _ON_MARK_USER,
                "stage": _ON_MARK_STAGE,
            },
        )
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


def _columns(db_url: str) -> set[str]:
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        return {c["name"] for c in inspect(engine).get_columns(_TABLE)}
    finally:
        engine.dispose()


def _held(db_url: str) -> dict[int, int]:
    with _connect(db_url) as conn:
        rows = conn.execute(text("SELECT user_id, highest_drip_day FROM stageprogress"))
        return {int(user): int(day) for user, day in rows}


def test_the_model_declares_a_non_null_integer_defaulting_to_nothing_held() -> None:
    column = SQLModel.metadata.tables[_TABLE].c[_COLUMN]
    assert column.nullable is False
    assert isinstance(column.type, Integer)
    assert StageProgress.model_fields[_COLUMN].default == 0


def test_the_migration_chains_from_the_pending_pass_day(migration_config: Config) -> None:
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    heads = script.get_heads()
    assert len(heads) == 1
    assert _REVISION in {rev.revision for rev in script.iterate_revisions(heads[0], "base")}


def test_upgrade_holds_a_reset_rows_whole_mark_and_nothing_on_the_mark(
    migration_config: Config,
) -> None:
    command.upgrade(migration_config, _REVISION)

    assert _held(_url(migration_config)) == {
        _RESET_USER: STAGE_DURATIONS_DAYS[_FINAL_STAGE - 1],
        _ON_MARK_USER: 0,
    }


def test_upgrade_refuses_a_negative_day(migration_config: Config) -> None:
    command.upgrade(migration_config, _REVISION)

    with pytest.raises(IntegrityError), _connect(_url(migration_config)) as conn:
        conn.execute(text("UPDATE stageprogress SET highest_drip_day = -1"))


def test_downgrade_drops_the_day_and_keeps_the_rows(migration_config: Config) -> None:
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)

    command.downgrade(migration_config, _BASE_REVISION)

    assert _COLUMN not in _columns(db_url)
    with _connect(db_url) as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM stageprogress")).scalar_one() == 2

    command.upgrade(migration_config, _REVISION)
    assert _COLUMN in _columns(db_url)
