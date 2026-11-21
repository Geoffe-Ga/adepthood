"""Round trip for ``e6a1d3b9c5f2``: ``vaultbulkimportrun`` and the ``bulk_import`` trigger (#3773).

The three trigger columns are ``VARCHAR(20)`` guarded by CHECKs written as
literals by earlier revisions, so without this migration the first bulk pass a
deployed database is asked to record would fail its INSERT. The fixture builds
the two pipeline tables as the parent revision leaves the columns these CHECKs
read, and stamps that revision, like the other single-migration round trips.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from models.vault_pipeline_run import PIPELINE_TRIGGERS
from services.creek_vault_pipeline import VaultPipelineTrigger

_BASE_REVISION = "3f7a9c2e5b18"  # pragma: allowlist secret
_REVISION = "e6a1d3b9c5f2"  # pragma: allowlist secret

_BULK = "bulk_import"
_DOCUMENT = "document_import"
_JOURNAL = "journal_write"
_RUN_INSERT = (
    "INSERT INTO vaultpipelinerun (id, trigger, follow_up_trigger) VALUES (:id, :trigger, :follow)"
)
_FOLLOW_UP_INSERT = "INSERT INTO vaultpipelinefollowup (id, trigger) VALUES (:id, :trigger)"
_BULK_RUN_INSERT = (
    "INSERT INTO vaultbulkimportrun (id, user_id, batch_id, landed, state, started_at)"
    " VALUES (:id, 1, :batch, 1, 'queued', '2026-11-20T09:00:00+00:00')"
)


@contextmanager
def _connect(db_url: str) -> Iterator[Connection]:
    """A committing sync connection to ``db_url``."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        with engine.begin() as conn:
            yield conn
    finally:
        engine.dispose()


def _bootstrap(db_url: str) -> None:
    """Create the pipeline tables' trigger columns with the narrow CHECKs, and one row each."""
    with _connect(db_url) as conn:
        conn.execute(text('CREATE TABLE "user" (id INTEGER NOT NULL, PRIMARY KEY (id))'))
        conn.execute(text('INSERT INTO "user" (id) VALUES (1)'))
        conn.execute(
            text(
                "CREATE TABLE vaultpipelinerun (id INTEGER NOT NULL,"
                " trigger VARCHAR(20), follow_up_trigger VARCHAR(20), PRIMARY KEY (id),"
                " CONSTRAINT ck_vaultpipelinerun_trigger_valid CHECK (trigger IS NULL OR"
                " trigger IN ('journal_write', 'document_import')),"
                " CONSTRAINT ck_vaultpipelinerun_follow_up_trigger_valid CHECK"
                " (follow_up_trigger IS NULL OR follow_up_trigger IN"
                " ('journal_write', 'document_import')))"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE vaultpipelinefollowup (id INTEGER NOT NULL,"
                " trigger VARCHAR(20) NOT NULL, PRIMARY KEY (id),"
                " CONSTRAINT ck_vaultpipelinefollowup_trigger_valid CHECK"
                " (trigger IN ('journal_write', 'document_import')))"
            )
        )
        conn.execute(text(_RUN_INSERT), {"id": 1, "trigger": _JOURNAL, "follow": None})


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database stamped at this migration's parent revision."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'bulk_import_run.sqlite'}"
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


def _execute(db_url: str, statement: str, params: dict[str, object]) -> None:
    """Run one write as a non-ORM writer would (raises on a CHECK violation)."""
    with _connect(db_url) as conn:
        conn.execute(text(statement), params)


def _triggers(db_url: str) -> list[tuple[int, str | None, str | None]]:
    """Every pipeline row as ``(id, trigger, follow_up_trigger)``."""
    with _connect(db_url) as conn:
        found = conn.execute(text("SELECT id, trigger, follow_up_trigger FROM vaultpipelinerun"))
        return sorted((row[0], row[1], row[2]) for row in found)


def _tables(db_url: str) -> set[str]:
    """Every table the database has."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        return set(inspect(engine).get_table_names())
    finally:
        engine.dispose()


def test_the_migration_chains_from_its_authored_head(migration_config: Config) -> None:
    """One linear chain: this revision extends the head it was written against."""
    revision = ScriptDirectory.from_config(migration_config).get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION


def test_the_stored_vocabulary_matches_the_trigger_enum() -> None:
    """The model's frozen trigger list is exactly the enum the pipeline records."""
    assert set(PIPELINE_TRIGGERS) == {trigger.value for trigger in VaultPipelineTrigger}


def test_upgrade_admits_bulk_import_on_all_three_columns(migration_config: Config) -> None:
    """A bulk pass, a bulk follow-up and a bulk intent all persist after the upgrade."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)

    _execute(db_url, _RUN_INSERT, {"id": 2, "trigger": _BULK, "follow": _BULK})
    _execute(db_url, _FOLLOW_UP_INSERT, {"id": 1, "trigger": _BULK})
    _execute(db_url, _BULK_RUN_INSERT, {"id": 1, "batch": "a" * 32})

    assert _triggers(db_url) == [(1, _JOURNAL, None), (2, _BULK, _BULK)]


@pytest.mark.parametrize(
    ("statement", "params"),
    [
        pytest.param(_RUN_INSERT, {"id": 2, "trigger": "unheard_of", "follow": None}, id="trigger"),
        pytest.param(_RUN_INSERT, {"id": 2, "trigger": None, "follow": "nope"}, id="follow-up"),
        pytest.param(_FOLLOW_UP_INSERT, {"id": 1, "trigger": "nope"}, id="intent"),
    ],
)
def test_upgrade_still_refuses_an_unknown_trigger(
    migration_config: Config, statement: str, params: dict[str, object]
) -> None:
    """Widening admits one word; nothing else loosens."""
    command.upgrade(migration_config, _REVISION)

    with pytest.raises(IntegrityError, match="CHECK"):
        _execute(_url(migration_config), statement, params)


def test_a_batch_is_recorded_once_per_account(migration_config: Config) -> None:
    """The batch uniqueness the press's idempotence rests on is the database's."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    _execute(db_url, _BULK_RUN_INSERT, {"id": 1, "batch": "a" * 32})

    with pytest.raises(IntegrityError, match="UNIQUE"):
        _execute(db_url, _BULK_RUN_INSERT, {"id": 2, "batch": "a" * 32})


def test_downgrade_rescopes_bulk_stamps_and_drops_the_run_table(migration_config: Config) -> None:
    """A bulk stamp reads as the whole-ladder scope an older build knows, and the CHECK narrows."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    _execute(db_url, _RUN_INSERT, {"id": 2, "trigger": _BULK, "follow": _BULK})
    _execute(db_url, _FOLLOW_UP_INSERT, {"id": 1, "trigger": _BULK})

    command.downgrade(migration_config, _BASE_REVISION)

    assert _triggers(db_url) == [(1, _JOURNAL, None), (2, _DOCUMENT, _DOCUMENT)]
    assert "vaultbulkimportrun" not in _tables(db_url)
    with pytest.raises(IntegrityError, match="CHECK"):
        _execute(db_url, _RUN_INSERT, {"id": 3, "trigger": _BULK, "follow": None})


def test_the_round_trip_upgrades_again(migration_config: Config) -> None:
    """Upgrade, downgrade, upgrade: the cycle is repeatable."""
    command.upgrade(migration_config, _REVISION)
    command.downgrade(migration_config, _BASE_REVISION)
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)

    _execute(db_url, _RUN_INSERT, {"id": 2, "trigger": _BULK, "follow": None})

    assert "vaultbulkimportrun" in _tables(db_url)
