"""Round trip for the ``stageprogress.pending_pass_starts_on`` migration (issue #3725).

A pass opened for a future day is held on the progress row until that day. The
column is additive and nullable: every row written before this revision has no
pass pending.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, Date, create_engine, inspect, text
from sqlmodel import SQLModel

from models.stage_progress import StageProgress

_BASE_REVISION = "9d2b6e4f1a73"  # pragma: allowlist secret
_REVISION = "a4c8e2f6b1d3"  # pragma: allowlist secret
_TABLE = "stageprogress"
_COLUMN = "pending_pass_starts_on"


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
    """A SQLite database holding one legacy progress row, stamped at the parent revision."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'pending_pass.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    with _connect(async_url) as conn:
        conn.execute(
            text(
                "CREATE TABLE stageprogress (id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL UNIQUE, current_stage INTEGER NOT NULL,"
                " cycle_number INTEGER NOT NULL, stage_started_at DATETIME NOT NULL,"
                " program_started_at DATETIME)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO stageprogress (user_id, current_stage, cycle_number,"
                " stage_started_at) VALUES (1, 3, 1, '2026-09-14T00:00:00+00:00')"
            )
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


def test_the_model_declares_a_nullable_date() -> None:
    """A calendar day in the account's zone, absent while nothing is pending."""
    column = SQLModel.metadata.tables[_TABLE].c[_COLUMN]
    assert column.nullable is True
    assert isinstance(column.type, Date)
    assert StageProgress.model_fields[_COLUMN].default is None


def test_the_migration_chains_from_the_unlock_log(migration_config: Config) -> None:
    """This revision keeps its authored parent on the single linear chain."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    heads = script.get_heads()
    assert len(heads) == 1
    assert _REVISION in {rev.revision for rev in script.iterate_revisions(heads[0], "base")}


def test_upgrade_adds_the_day_and_leaves_existing_rows_with_nothing_pending(
    migration_config: Config,
) -> None:
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)

    assert _COLUMN in _columns(db_url)
    with _connect(db_url) as conn:
        row = conn.execute(text("SELECT pending_pass_starts_on, current_stage FROM stageprogress"))
        assert tuple(row.one()) == (None, 3)


def test_downgrade_drops_the_day_and_keeps_the_row(migration_config: Config) -> None:
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    with _connect(db_url) as conn:
        conn.execute(text("UPDATE stageprogress SET pending_pass_starts_on = '2026-12-01'"))

    command.downgrade(migration_config, _BASE_REVISION)

    assert _COLUMN not in _columns(db_url)
    with _connect(db_url) as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM stageprogress")).scalar_one() == 1
