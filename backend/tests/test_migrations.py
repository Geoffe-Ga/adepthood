"""Static sanity checks on the alembic migration scripts.

BUG-INFRA-022: earlier the downgrade for the timestamptz migration used a
subtly-different ``USING`` expression from the upgrade, which failed on
Postgres.  The real round-trip check runs against a Postgres container in
CI (see ``.github/workflows/backend-ci.yml``).  These tests catch the
cheap-to-detect regressions at unit-test speed so drift is surfaced before
CI wakes up.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

MIGRATIONS_DIR = Path(__file__).parent.parent / "migrations" / "versions"

TIMESTAMPTZ_MIGRATION = MIGRATIONS_DIR / "78b1620cafde_convert_datetime_columns_to_timestamptz.py"

# The two password-recovery migrations from PR #287, in chain order.
_RESET_BASE_REVISION = "b5c6d7e8f9a0"  # pragma: allowlist secret
_RESET_TABLE_REVISION = "c6d7e8f9a0b1"  # pragma: allowlist secret
_RESET_LOOKUP_REVISION = "d7e8f9a0b1c2"  # pragma: allowlist secret


def test_timestamptz_migration_exists() -> None:
    """Regression guard: the migration file must stay where Alembic finds it."""
    assert TIMESTAMPTZ_MIGRATION.is_file()


def test_upgrade_and_downgrade_use_same_using_expression() -> None:
    """BUG-INFRA-022: upgrade and downgrade ``USING`` expressions must be structurally identical.

    This ensures ``alembic downgrade -1`` round-trips correctly.
    Specifically, both should produce ``"col" AT TIME ZONE 'UTC'`` -- the
    conversion is symmetric (timestamp to timestamptz in UTC), so the
    expression should be the same for both directions.
    """
    text = TIMESTAMPTZ_MIGRATION.read_text()
    upgrade_section = text.split("def upgrade")[1].split("def downgrade")[0]
    downgrade_section = text.split("def downgrade")[1]

    # The exact f-string literal used in both directions.
    expected_literal = "f'\"{column}\" AT TIME ZONE \\'UTC\\''"
    assert expected_literal in upgrade_section, "upgrade uses a different USING clause"
    assert expected_literal in downgrade_section, (
        "downgrade uses a different USING clause — BUG-INFRA-022 regressed"
    )


@pytest.mark.parametrize("direction", ["upgrade", "downgrade"])
def test_both_directions_exist(direction: str) -> None:
    """Every migration must define both ``upgrade`` and ``downgrade`` functions.

    Without this, any new migration could ship without a rollback path,
    re-introducing the same class of bug BUG-INFRA-022 caught.
    """
    for path in MIGRATIONS_DIR.glob("*.py"):
        if path.name.startswith("_"):
            continue
        body = path.read_text()
        assert f"def {direction}" in body, f"{path.name} missing {direction}()"


@pytest.fixture
def alembic_sqlite_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """Yield an Alembic Config wired to a freshly-created SQLite DB.

    Pre-creates the ``user`` table and stamps the alembic_version row
    at ``b5c6d7e8f9a0`` (the down_revision of the first password-reset
    migration) so the round-trip exercise can apply just our two
    migrations without having to replay every preceding migration --
    several of which use Postgres-only constructs and would not run
    on SQLite anyway.
    """
    db_path = tmp_path / "round_trip.sqlite"
    # Alembic env.py uses async_engine_from_config, so the SQLAlchemy
    # URL needs an async driver.  ``aiosqlite`` is already a transitive
    # dev dep (pulled in by sqlmodel test fixtures).
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    # Bootstrap a minimal ``user`` table -- our migration adds a column to
    # it and a FOREIGN KEY pointing at user.id, so the table must exist.
    # Use the sync driver here because the bootstrap is one-shot DDL.
    bootstrap_engine = create_engine(sync_url)
    with bootstrap_engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
        )
    bootstrap_engine.dispose()

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    # ``alembic.ini`` ships ``[loggers]`` config that, when loaded via
    # ``fileConfig`` inside ``env.py``, calls ``logging.config.fileConfig``
    # with the default ``disable_existing_loggers=True`` -- which silently
    # disables every logger created before the first call.  In a test
    # context that breaks the ``routers.auth`` logger and downstream
    # ``caplog`` assertions in unrelated tests.  Suppressing
    # ``config_file_name`` skips the offending block in env.py without
    # affecting prod (where Alembic is invoked via the CLI, not embedded).
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)

    # Stamp the baseline so ``upgrade`` only walks our two migrations.
    command.stamp(cfg, _RESET_BASE_REVISION)
    return cfg


def _sync_url(async_url: str) -> str:
    """Strip the ``+aiosqlite`` driver suffix for use with sync introspection."""
    return async_url.replace("+aiosqlite", "")


def _columns_of(db_url: str, table: str) -> set[str]:
    engine = create_engine(_sync_url(db_url))
    try:
        return {col["name"] for col in inspect(engine).get_columns(table)}
    finally:
        engine.dispose()


def _table_exists(db_url: str, table: str) -> bool:
    engine = create_engine(_sync_url(db_url))
    try:
        return table in set(inspect(engine).get_table_names())
    finally:
        engine.dispose()


def test_password_reset_migrations_round_trip_on_sqlite(
    alembic_sqlite_config: Config,
) -> None:
    """SPEC operational requirement: ``upgrade -> downgrade -> upgrade`` is clean.

    The prod target is PostgreSQL, but a SQLite round-trip is cheap CI
    insurance against malformed downgrade scripts -- the same family
    of bug BUG-INFRA-022 caught for the timestamptz conversion.

    Drives the chain explicitly:
    1. ``upgrade head`` from the stamped baseline applies both
       password-reset migrations (table + lookup_key).
    2. ``downgrade base`` reverses them in order.
    3. ``upgrade head`` re-applies, proving the cycle is idempotent.
    """
    cfg = alembic_sqlite_config
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade head -> both migrations applied.
    command.upgrade(cfg, "head")
    assert _table_exists(db_url, "passwordresettoken")
    user_cols = _columns_of(db_url, "user")
    assert "password_changed_at" in user_cols
    reset_cols = _columns_of(db_url, "passwordresettoken")
    assert {"token_hash", "lookup_key", "used_at", "cancelled_at"}.issubset(reset_cols)

    # Phase 2: downgrade to the stamped baseline -> both migrations reversed.
    command.downgrade(cfg, _RESET_BASE_REVISION)
    assert not _table_exists(db_url, "passwordresettoken")
    assert "password_changed_at" not in _columns_of(db_url, "user")

    # Phase 3: upgrade again -> the cycle is idempotent (catches downgrade
    # scripts that leave residue and break the second upgrade).
    command.upgrade(cfg, "head")
    assert _table_exists(db_url, "passwordresettoken")
    assert "password_changed_at" in _columns_of(db_url, "user")
    assert "lookup_key" in _columns_of(db_url, "passwordresettoken")
