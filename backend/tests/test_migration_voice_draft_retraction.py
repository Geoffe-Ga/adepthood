"""Round trip for the Voice Draft withdrawal-obligation migration (#3060)."""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, LargeBinary, String, Text, create_engine, inspect, text
from sqlalchemy.types import JSON
from sqlmodel import SQLModel

from models.voice_draft_retraction import VoiceDraftRetraction

_BASE_REVISION = "d7f9b1c3e5a2"  # pragma: allowlist secret
_REVISION = "e3b5d7f9a1c4"  # pragma: allowlist secret
_TABLE = "voicedraftretraction"

#: The complete, content-free column set. A new column must be added here
#: deliberately, after deciding it carries no prose, URL, credential or hash.
_CONTENT_FREE_COLUMNS = frozenset(
    {
        "id",
        "user_id",
        "journal_entry_id",
        "marginalia_id",
        "state",
        "destination",
        "attempt_count",
        "safe_failure_code",
        "next_attempt_at",
        "created_at",
        "updated_at",
        "confirmed_at",
    }
)
_FORBIDDEN_NAME = re.compile(r"body|essay|title|note|url|key|hash|content|message")

# Legacy fixture rows: (marginalia id, entry id, has essay).
_PERSONAL_ESSAY = 11
_INTIMATE_ESSAY = 12
_DELETED_ESSAY = 13
_NO_ESSAY = 14
_VAULTLESS_ESSAY = 15
_DEPLOYMENT_ESSAY = 16
_DEPLOYMENT_OWNER = 3
_FIXTURE_NOTES = 6


@contextmanager
def _connect(db_url: str) -> Iterator[Connection]:
    """Open a committing synchronous connection for the migration fixture."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        with engine.begin() as connection:
            yield connection
    finally:
        engine.dispose()


def _seed_legacy_schema(connection: Connection) -> None:
    """Create the minimal pre-revision tables the backfill reads."""
    connection.execute(text("CREATE TABLE user (id INTEGER PRIMARY KEY)"))
    connection.execute(
        text(
            "CREATE TABLE journalentry (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, "
            "classification VARCHAR(20) NOT NULL, deleted_at DATETIME)"
        )
    )
    connection.execute(
        text(
            "CREATE TABLE marginalia (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, "
            "journal_entry_id INTEGER NOT NULL, essay TEXT, essay_generated_at DATETIME)"
        )
    )
    connection.execute(
        text("CREATE TABLE uservaultconfig (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL)")
    )
    connection.execute(text("INSERT INTO user (id) VALUES (1), (2), (3)"))
    connection.execute(text("INSERT INTO uservaultconfig (id, user_id) VALUES (1, 1)"))
    connection.execute(
        text(
            "INSERT INTO journalentry (id, user_id, classification, deleted_at) VALUES "
            "(1, 1, 'personal', NULL), (2, 1, 'intimate', NULL), "
            "(3, 1, 'personal', '2026-10-01 00:00:00'), (4, 1, 'personal', NULL), "
            "(5, 2, 'intimate', NULL), (6, 3, 'personal', NULL)"
        )
    )
    connection.execute(
        text(
            "INSERT INTO marginalia (id, user_id, journal_entry_id, essay, essay_generated_at) "
            "VALUES (11, 1, 1, 'ciphertext', '2026-10-01 00:00:00'), "
            "(12, 1, 2, 'ciphertext', '2026-10-01 00:00:00'), "
            "(13, 1, 3, 'ciphertext', '2026-10-01 00:00:00'), "
            "(14, 1, 4, NULL, NULL), "
            "(15, 2, 5, 'ciphertext', '2026-10-01 00:00:00'), "
            "(16, 3, 6, 'ciphertext', '2026-10-01 00:00:00')"
        )
    )


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """Build legacy journal/marginalia tables stamped at the prior migration head."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'voice_draft_retraction.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    monkeypatch.setenv("CREEK_VAULT_URL", "https://deployment-vault.example.com")
    monkeypatch.setenv("CREEK_VAULT_OWNER_USER_ID", str(_DEPLOYMENT_OWNER))
    with _connect(async_url) as connection:
        _seed_legacy_schema(connection)
    config = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    config.config_file_name = None
    config.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    config.set_main_option("sqlalchemy.url", async_url)
    command.stamp(config, _BASE_REVISION)
    return config


def _url(config: Config) -> str:
    value = config.get_main_option("sqlalchemy.url")
    assert value is not None
    return value


def test_retraction_migration_chains_from_its_authored_head(migration_config: Config) -> None:
    """The revision extends the exact head it was authored against, and is the only head."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    assert script.get_heads() == [_REVISION]


def test_backfill_treats_every_existing_essay_as_possibly_mirrored(
    migration_config: Config,
) -> None:
    """Personal → intent, Intimate → pending, soft-deleted → confirmed, no essay → no row.

    Only accounts that had a vault at migration time -- a stored connection, or
    the deployment vault's bound owner -- could have mirrored an essay. An
    account with neither owes nothing, so it gets no row: a row there could
    never confirm (the local fallback confirms nothing) and would block
    deleting that writer's own pages.
    """
    command.upgrade(migration_config, _REVISION)
    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        with engine.connect() as connection:
            rows = connection.execute(
                text(
                    "SELECT marginalia_id, journal_entry_id, state, attempt_count, "
                    "destination, confirmed_at IS NOT NULL FROM voicedraftretraction"
                )
            ).all()
    finally:
        engine.dispose()
    by_note = {row[0]: tuple(row[1:]) for row in rows}
    assert by_note == {
        _PERSONAL_ESSAY: (1, "mirror_intent", 0, None, False),
        _INTIMATE_ESSAY: (2, "pending", 0, None, False),
        _DELETED_ESSAY: (3, "confirmed", 0, None, True),
        _DEPLOYMENT_ESSAY: (6, "mirror_intent", 0, None, False),
    }
    assert _NO_ESSAY not in by_note
    assert _VAULTLESS_ESSAY not in by_note


def test_upgrade_adds_a_nullable_journal_destination(migration_config: Config) -> None:
    """Existing entries become unbound (NULL destination) rather than failing the deploy."""
    command.upgrade(migration_config, _REVISION)
    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        columns = {c["name"]: c for c in inspect(engine).get_columns("journalentry")}
    finally:
        engine.dispose()
    assert columns["vault_destination"]["nullable"] is True


def test_obligation_columns_are_content_free(migration_config: Config) -> None:
    """Migration and model agree on an allowlisted set with no prose-capable column."""
    command.upgrade(migration_config, _REVISION)
    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        migrated = {c["name"]: c["type"] for c in inspect(engine).get_columns(_TABLE)}
    finally:
        engine.dispose()
    model_columns = {
        column.name: column.type
        for column in SQLModel.metadata.tables[VoiceDraftRetraction.__tablename__].columns
    }
    assert set(migrated) == set(model_columns) == _CONTENT_FREE_COLUMNS
    for name, column_type in model_columns.items():
        assert not isinstance(column_type, Text | JSON | LargeBinary), name
        assert not _FORBIDDEN_NAME.search(name), name
        if isinstance(column_type, String):
            assert column_type.length is not None, name


def test_downgrade_drops_the_obligations_and_keeps_the_journal(
    migration_config: Config,
) -> None:
    """Downgrade removes the table and column; every entry and note survives."""
    command.upgrade(migration_config, _REVISION)
    command.downgrade(migration_config, _BASE_REVISION)
    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        tables = set(inspect(engine).get_table_names())
        entry_columns = {c["name"] for c in inspect(engine).get_columns("journalentry")}
        with engine.connect() as connection:
            notes = connection.execute(text("SELECT COUNT(*) FROM marginalia")).scalar_one()
    finally:
        engine.dispose()
    assert _TABLE not in tables
    assert "vault_destination" not in entry_columns
    assert notes == _FIXTURE_NOTES
