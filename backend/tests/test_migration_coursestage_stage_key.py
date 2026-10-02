"""Round trip for the ``coursestage`` stage-key + provenance migration (#2665).

``CourseStage`` becomes the canonical stage-correspondence table: it gains a
stable colour-slug ``stage_key`` (unique, NOT NULL) and nullable provenance
columns naming the artifact the seeder reconciled each row from. Existing rows
are backfilled from ``stage_number`` in place — no row is inserted, deleted or
renumbered, and the ``stagecontent`` foreign key into the table survives the
SQLite batch rebuild.
"""

from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from domain.stage_keys import STAGE_KEYS

_BASE_REVISION = "c4e6a8b0d2f1"  # pragma: allowlist secret
_REVISION = "d7f9b1c3e5a2"  # pragma: allowlist secret
_MIGRATION_FILE = (
    Path(__file__).parent.parent
    / "migrations"
    / "versions"
    / "d7f9b1c3e5a2_coursestage_stage_key_provenance.py"
)
_TABLE = "coursestage"
_KEY_INDEX = "ix_coursestage_stage_key_unique"
_NUMBER_INDEX = "ix_coursestage_stage_number_unique"
_PROVENANCE_COLUMNS = (
    "source_repo",
    "source_sha",
    "source_path",
    "source_sha256",
    "artifact_schema_version",
    "reconciled_at",
)
_NEW_COLUMNS = ("stage_key", *_PROVENANCE_COLUMNS)
#: Ten real Stages plus one legacy out-of-range row the backfill must not drop.
_OUT_OF_RANGE_STAGE = 11
_LEGACY_STAGE_NUMBERS = (*range(1, len(STAGE_KEYS) + 1), _OUT_OF_RANGE_STAGE)
_STAGE_WITH_CONTENT = 4
_CONTENT_ROW_ID = 1


@contextmanager
def _connect(db_url: str) -> Iterator[Connection]:
    """A committing sync connection to ``db_url``."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        with engine.begin() as conn:
            yield conn
    finally:
        engine.dispose()


def _create_legacy_schema(conn: Connection) -> None:
    """The pre-revision ``coursestage`` and a ``stagecontent`` row pointing into it."""
    conn.execute(
        text(
            "CREATE TABLE coursestage (id INTEGER PRIMARY KEY, title VARCHAR NOT NULL,"
            " subtitle VARCHAR NOT NULL, stage_number INTEGER NOT NULL,"
            " overview_url VARCHAR NOT NULL, category VARCHAR NOT NULL,"
            " aspect VARCHAR NOT NULL, spiral_dynamics_color VARCHAR NOT NULL,"
            " growing_up_stage VARCHAR NOT NULL, divine_gender_polarity VARCHAR NOT NULL,"
            " relationship_to_free_will VARCHAR NOT NULL,"
            " free_will_description VARCHAR NOT NULL)"
        )
    )
    conn.execute(text(f"CREATE UNIQUE INDEX {_NUMBER_INDEX} ON coursestage (stage_number)"))
    conn.execute(
        text(
            "CREATE TABLE stagecontent (id INTEGER PRIMARY KEY,"
            " course_stage_id INTEGER NOT NULL REFERENCES coursestage (id),"
            " title VARCHAR NOT NULL)"
        )
    )
    for number in _LEGACY_STAGE_NUMBERS:
        conn.execute(
            text(
                "INSERT INTO coursestage (id, title, subtitle, stage_number, overview_url,"
                " category, aspect, spiral_dynamics_color, growing_up_stage,"
                " divine_gender_polarity, relationship_to_free_will, free_will_description)"
                " VALUES (:id, :title, 's', :n, '', 'c', 'a', 'x', 'g', 'd', 'r', 'f')"
            ),
            # Ids deliberately differ from stage numbers so a backfill keyed
            # by id instead of stage_number would be caught.
            {"id": 100 + number, "title": f"Stage {number}", "n": number},
        )
    conn.execute(
        text("INSERT INTO stagecontent (id, course_stage_id, title) VALUES (:id, :fk, 'ch')"),
        {"id": _CONTENT_ROW_ID, "fk": 100 + _STAGE_WITH_CONTENT},
    )


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database holding eleven legacy stage rows, stamped at the parent."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'stage_key.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    with _connect(async_url) as conn:
        _create_legacy_schema(conn)
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


def _columns_and_indexes(db_url: str) -> tuple[dict[str, dict[str, object]], set[str]]:
    """The table's columns by name and its index names."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        inspector = inspect(engine)
        columns = {c["name"]: dict(c) for c in inspector.get_columns(_TABLE)}
        indexes = {str(i["name"]) for i in inspector.get_indexes(_TABLE)}
    finally:
        engine.dispose()
    return columns, indexes


def _load_migration() -> ModuleType:
    """Import the revision module by path (versions/ is not a package)."""
    spec = importlib.util.spec_from_file_location("stage_key_migration", _MIGRATION_FILE)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_revision_chains_from_the_generation_key_head(migration_config: Config) -> None:
    """One linear chain: this revision sits on the head it was written against."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    assert len(script.get_heads()) == 1


def test_the_migration_freezes_the_stage_keys_literally() -> None:
    """The migration keeps its own copy of the keys, equal to the app's today."""
    assert _load_migration().FROZEN_STAGE_KEYS == STAGE_KEYS


def test_upgrade_backfills_each_key_from_stage_number_in_place(
    migration_config: Config,
) -> None:
    """Every row keeps its id and gains its colour slug; nothing is inserted."""
    command.upgrade(migration_config, _REVISION)

    with _connect(_url(migration_config)) as conn:
        rows = conn.execute(
            text("SELECT id, stage_number, stage_key FROM coursestage ORDER BY stage_number")
        ).all()
    assert [tuple(r) for r in rows] == [
        (100 + number, number, key)
        for number, key in zip(
            _LEGACY_STAGE_NUMBERS, (*STAGE_KEYS, f"stage-{_OUT_OF_RANGE_STAGE}"), strict=True
        )
    ]


def test_upgrade_adds_a_unique_not_null_key_and_null_provenance(
    migration_config: Config,
) -> None:
    """The key is constrained; the provenance columns start empty."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)

    columns, indexes = _columns_and_indexes(db_url)
    assert columns["stage_key"]["nullable"] is False
    for name in _PROVENANCE_COLUMNS:
        assert columns[name]["nullable"] is True, name
    assert {_KEY_INDEX, _NUMBER_INDEX} <= indexes

    with _connect(db_url) as conn:
        provenance = conn.execute(
            text(
                "SELECT source_repo, source_sha, source_path, source_sha256,"
                " artifact_schema_version, reconciled_at FROM coursestage"
            )
        ).all()
    assert all(value is None for row in provenance for value in row)


def test_upgrade_enforces_key_uniqueness(migration_config: Config) -> None:
    """A second row claiming a taken key is refused by the new index."""
    command.upgrade(migration_config, _REVISION)

    with pytest.raises(IntegrityError), _connect(_url(migration_config)) as conn:
        conn.execute(text("UPDATE coursestage SET stage_key = 'blue' WHERE stage_number = 5"))


def test_upgrade_keeps_the_stagecontent_foreign_key(migration_config: Config) -> None:
    """The batch rebuild does not orphan content pointing at a stage row."""
    command.upgrade(migration_config, _REVISION)

    with _connect(_url(migration_config)) as conn:
        joined = conn.execute(
            text(
                "SELECT cs.stage_key FROM stagecontent sc"
                " JOIN coursestage cs ON cs.id = sc.course_stage_id WHERE sc.id = :id"
            ),
            {"id": _CONTENT_ROW_ID},
        ).scalar_one()
    assert joined == STAGE_KEYS[_STAGE_WITH_CONTENT - 1]


def test_downgrade_drops_the_columns_and_index_and_keeps_the_rows(
    migration_config: Config,
) -> None:
    """Down removes what up added; every stage row and its title survive."""
    command.upgrade(migration_config, _REVISION)
    command.downgrade(migration_config, _BASE_REVISION)
    db_url = _url(migration_config)

    columns, indexes = _columns_and_indexes(db_url)
    assert not set(_NEW_COLUMNS) & set(columns)
    assert _KEY_INDEX not in indexes
    assert _NUMBER_INDEX in indexes
    with _connect(db_url) as conn:
        rows = conn.execute(text("SELECT id, title FROM coursestage ORDER BY stage_number")).all()
    assert [tuple(r) for r in rows] == [
        (100 + number, f"Stage {number}") for number in _LEGACY_STAGE_NUMBERS
    ]
