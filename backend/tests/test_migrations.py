"""Static sanity checks on the alembic migration scripts.

BUG-INFRA-022: earlier the downgrade for the timestamptz migration used a
subtly-different ``USING`` expression from the upgrade, which failed on
Postgres.  The real round-trip check runs against a Postgres container in
CI (see ``.github/workflows/backend-ci.yml``).  These tests catch the
cheap-to-detect regressions at unit-test speed so drift is surfaced before
CI wakes up.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

MIGRATIONS_DIR = Path(__file__).parent.parent / "migrations" / "versions"

TIMESTAMPTZ_MIGRATION = MIGRATIONS_DIR / "78b1620cafde_convert_datetime_columns_to_timestamptz.py"

# The two password-recovery migrations from PR #287, in chain order.
_RESET_BASE_REVISION = "b5c6d7e8f9a0"  # pragma: allowlist secret
_RESET_TABLE_REVISION = "c6d7e8f9a0b1"  # pragma: allowlist secret
_RESET_LOOKUP_REVISION = "d7e8f9a0b1c2"  # pragma: allowlist secret

# ritual-01: practice-mode migration and its baseline (the revision just before).
_PRACTICE_MODE_BASE_REVISION = "d7e8f9a0b1c2"  # pragma: allowlist secret
_PRACTICE_MODE_REVISION = "e9f0a1b2c3d4"  # pragma: allowlist secret

# ritual-04: practice-session metadata migration (mode + mode_metadata + …).
_PRACTICE_SESSION_METADATA_BASE_REVISION = "e9f0a1b2c3d4"  # pragma: allowlist secret
_PRACTICE_SESSION_METADATA_REVISION = "f0a1b2c3d4e5"  # pragma: allowlist secret

# grounding-techniques 01: tallied_grounding CHECK-constraint migration.
_TALLIED_GROUNDING_BASE_REVISION = "d2e3f4a5b6c7"  # pragma: allowlist secret
_TALLIED_GROUNDING_REVISION = "a1b2c3d4e5f7"  # pragma: allowlist secret

# grounding-techniques-02: extend ck_practice_mode_valid to include mindful_anchor.
# Chains off the tallied_grounding migration so the two new modes coexist on
# a single linear timeline.
_MINDFUL_ANCHOR_BASE_REVISION = "a1b2c3d4e5f7"  # pragma: allowlist secret
_MINDFUL_ANCHOR_REVISION = "f4a5b6c7d8e9"  # pragma: allowlist secret

# custom-practices-02: extend ck_practice_mode_valid to include card_meditation.
# Chains off the mindful_anchor migration so the three custom-practice modes
# coexist on a single linear timeline.
_CARD_MEDITATION_BASE_REVISION = "f4a5b6c7d8e9"  # pragma: allowlist secret
_CARD_MEDITATION_REVISION = "a2b3c4d5e6f8"  # pragma: allowlist secret

# custom-practices-03: practice share-link token table (issue #348).  Rebased
# onto card_meditation's head so the chain stays linear after the parallel
# work merged.
_PRACTICE_SHARE_LINK_BASE_REVISION = "a2b3c4d5e6f8"  # pragma: allowlist secret
_PRACTICE_SHARE_LINK_REVISION = "f5b6c7d8e9a0"  # pragma: allowlist secret

# custom-practices-01: extend ck_practice_mode_valid to include
# random_interval_bell (issue #346).  Chains off the share-link head so the
# timeline stays linear.
_RANDOM_INTERVAL_BELL_BASE_REVISION = "f5b6c7d8e9a0"  # pragma: allowlist secret
_RANDOM_INTERVAL_BELL_REVISION = "b6c7d8e9a0b1"  # pragma: allowlist secret


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


def _migration_files() -> list[Path]:
    return sorted(p for p in MIGRATIONS_DIR.glob("*.py") if not p.name.startswith("_"))


def _is_trivial_body(body: list[ast.stmt]) -> bool:
    """Return True if a function body is only a docstring (or empty / pass).

    A migration whose ``downgrade`` is just a docstring carries no rollback
    logic — for a real schema migration that's the same class of bug
    BUG-INFRA-022 caught. The exception is no-op merge migrations whose
    ``downgrade`` is intentionally empty (the prior heads remain applied
    after the merge); we whitelist them by filename via ``_is_no_op_merge``.
    """
    if not body:
        return True
    if len(body) == 1:
        only = body[0]
        if isinstance(only, ast.Pass):
            return True
        if (
            isinstance(only, ast.Expr)
            and isinstance(only.value, ast.Constant)
            and isinstance(only.value.value, str)
        ):
            # Sole docstring.
            return True
    # A body containing a docstring + ``pass`` is still trivial.
    return (
        len(body) == 2
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
        and isinstance(body[1], ast.Pass)
    )


def _is_no_op_merge(path: Path) -> bool:
    """Identify a no-op merge migration by Alembic's filename convention.

    ``alembic merge -m '...'`` emits files named ``<rev>_merge_*.py``. Such
    migrations exist solely to unify multiple heads and ship empty
    ``upgrade``/``downgrade`` bodies — that's the intended contract, not a
    placeholder gap.
    """
    return "_merge_" in path.name


def _has_intentional_empty_downgrade_marker(tree: ast.Module) -> bool:
    """Return True if the migration module declares ``ALEMBIC_INTENTIONAL_EMPTY_DOWNGRADE = True``.

    Read-only audit migrations and other no-op data migrations set this
    marker so the round-trip-pattern test recognises the empty downgrade
    as intentional. Writing the assignment explicitly forces a deliberate
    act when authoring such a migration.
    """
    for node in tree.body:
        if not isinstance(node, ast.Assign | ast.AnnAssign):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        for target in targets:
            if (
                isinstance(target, ast.Name)
                and target.id == "ALEMBIC_INTENTIONAL_EMPTY_DOWNGRADE"
                and isinstance(node.value, ast.Constant)
                and node.value.value is True
            ):
                return True
    return False


@pytest.mark.parametrize("migration", _migration_files(), ids=lambda p: p.name)
def test_downgrade_is_non_trivial_unless_no_op_merge(migration: Path) -> None:
    """Codifies the migration round-trip pattern flagged in the ritual-practice grooming.

    Every non-merge migration must have a downgrade body that actually
    rewinds the upgrade. A stub like ``def downgrade(): pass`` or
    ``def downgrade(): \"\"\"TODO\"\"\"`` is rejected here, so a regression
    that ships an unreversible migration fails at unit-test speed instead
    of waiting for the migration-drift CI job (which only catches it via
    Postgres round-trip and only for the branch CI happens to traverse).
    """
    tree = ast.parse(migration.read_text())
    downgrade = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.name == "downgrade"
        ),
        None,
    )
    assert downgrade is not None, f"{migration.name}: no ``downgrade`` function defined"
    trivial = _is_trivial_body(downgrade.body)
    if _is_no_op_merge(migration):
        # Merge migrations MUST be trivial; an op call here would be unexpected.
        assert trivial, (
            f"{migration.name}: merge migrations are expected to have an empty downgrade; "
            "if this one really needs to roll back schema, rename it off the ``_merge_`` "
            "convention so the contract test recognises it as a regular migration."
        )
        return
    if _has_intentional_empty_downgrade_marker(tree):
        # A read-only audit or other no-op data migration that explicitly
        # opts out. The marker assignment is the deliberate "I meant this".
        return
    assert not trivial, (
        f"{migration.name}: downgrade body is empty / docstring-only / ``pass``. "
        "Every non-merge migration must actually reverse its upgrade — this is the "
        "round-trip contract from BUG-INFRA-022 + ritual-practice backlog P1-6. "
        "If this migration is genuinely a no-op (e.g. read-only data audit), add "
        "``ALEMBIC_INTENTIONAL_EMPTY_DOWNGRADE = True`` at module level."
    )


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

    # Phase 1: upgrade to the password-reset chain head -> both migrations
    # applied.  We pin the target instead of using ``head`` because the
    # fixture bootstrap only creates the ``user`` table; later migrations
    # in the chain (e.g. ritual-01's ALTER TABLE practice) would fail
    # against the minimal schema.  The test's stated scope is the two
    # password-reset migrations, so pinning to their head matches intent.
    command.upgrade(cfg, _RESET_LOOKUP_REVISION)
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
    command.upgrade(cfg, _RESET_LOOKUP_REVISION)
    assert _table_exists(db_url, "passwordresettoken")
    assert "password_changed_at" in _columns_of(db_url, "user")
    assert "lookup_key" in _columns_of(db_url, "passwordresettoken")


# -- ritual-01 practice-mode migration round-trip ---------------------------


def _bootstrap_practice_table(sync_url: str) -> None:
    """Pre-create a minimal ``practice`` table for the round-trip fixture.

    Mirrors the columns the application-level migration ``e9f0a1b2c3d4``
    expects to ALTER, without pulling in every preceding migration.  We
    keep the schema deliberately narrow (no FKs, no CHECKs) so the
    bootstrap stays SQLite-friendly and the test exercises only what the
    new migration adds.
    """
    bootstrap_engine = create_engine(sync_url)
    with bootstrap_engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE practice ("
                " id INTEGER PRIMARY KEY,"
                " stage_number INTEGER NOT NULL,"
                " name VARCHAR(255) NOT NULL,"
                " description VARCHAR(2000) NOT NULL DEFAULT '',"
                " instructions VARCHAR(10000) NOT NULL DEFAULT '',"
                " default_duration_minutes FLOAT NOT NULL,"
                " submitted_by_user_id INTEGER,"
                " approved BOOLEAN NOT NULL DEFAULT 1"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO practice (id, stage_number, name, default_duration_minutes)"
                " VALUES (1, 1, 'Sit', 12.5)"
            )
        )
    bootstrap_engine.dispose()


@pytest.fixture
def alembic_sqlite_config_practice_mode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite Alembic config positioned just before ritual-01's migration.

    Parallels :func:`alembic_sqlite_config` but bootstraps the
    ``practice`` table (with one seeded row) and stamps at
    :data:`_PRACTICE_MODE_BASE_REVISION` so the round-trip exercises
    only the new migration.
    """
    db_path = tmp_path / "practice_mode_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_practice_table(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _PRACTICE_MODE_BASE_REVISION)
    return cfg


def _practice_row(db_url: str, practice_id: int) -> dict[str, Any]:
    """Fetch a single ``practice`` row as a dict, including mode_config JSON."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            row = (
                conn.execute(
                    text(
                        "SELECT id, default_duration_minutes, mode, mode_config "
                        "FROM practice WHERE id = :id"
                    ),
                    {"id": practice_id},
                )
                .mappings()
                .first()
            )
            assert row is not None
            return dict(row)
    finally:
        engine.dispose()


def test_practice_mode_migration_round_trip_on_sqlite(
    alembic_sqlite_config_practice_mode: Config,
) -> None:
    """Round-trip ``e9f0a1b2c3d4`` end-to-end: upgrade backfills, downgrade drops.

    Asserts the SQLite-portable backfill produces the documented
    ``MeditationTimerConfig`` payload (mode + duration + bell flags) and
    that the downgrade fully reverses the upgrade so a second upgrade is
    idempotent — the same property the password-reset round-trip
    enforces for its chain.
    """
    cfg = alembic_sqlite_config_practice_mode
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade applies the new columns + backfills the seeded row.
    command.upgrade(cfg, _PRACTICE_MODE_REVISION)
    practice_cols = _columns_of(db_url, "practice")
    assert {"mode", "mode_config"}.issubset(practice_cols)

    row = _practice_row(db_url, practice_id=1)
    assert row["mode"] == "meditation_timer"
    # SQLite returns JSON columns as text; parse before asserting on the shape.
    cfg_payload = json.loads(row["mode_config"])
    assert cfg_payload == {
        "mode": "meditation_timer",
        "duration_minutes": 12.5,
        "start_bell": True,
        "halfway_bell": False,
        "end_bell": True,
    }

    # Phase 2: downgrade drops both columns; the original row stays.
    command.downgrade(cfg, _PRACTICE_MODE_BASE_REVISION)
    practice_cols_after = _columns_of(db_url, "practice")
    assert "mode" not in practice_cols_after
    assert "mode_config" not in practice_cols_after

    # Phase 3: re-upgrade — backfill must reproduce the same payload.
    command.upgrade(cfg, _PRACTICE_MODE_REVISION)
    row_after = _practice_row(db_url, practice_id=1)
    assert row_after["mode"] == "meditation_timer"
    assert json.loads(row_after["mode_config"])["duration_minutes"] == 12.5


# -- ritual-04 practice-session metadata migration round-trip ---------------


def _bootstrap_practicesession_table(sync_url: str) -> None:
    """Pre-create a minimal ``practicesession`` table for the round-trip fixture.

    Mirrors the columns the ritual-04 migration ``f0a1b2c3d4e5`` expects
    to ALTER, without pulling in every preceding migration.  One legacy
    row is inserted so the backfill branches can be observed.
    """
    bootstrap_engine = create_engine(sync_url)
    with bootstrap_engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE practicesession ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " user_practice_id INTEGER NOT NULL,"
                " duration_minutes FLOAT NOT NULL,"
                " timestamp DATETIME NOT NULL,"
                " reflection VARCHAR(5000)"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO practicesession"
                " (id, user_id, user_practice_id, duration_minutes, timestamp)"
                " VALUES (1, 1, 1, 7.5, '2026-05-01 12:00:00')"
            )
        )
    bootstrap_engine.dispose()


@pytest.fixture
def alembic_sqlite_config_practice_session_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before ritual-04's migration."""
    db_path = tmp_path / "practice_session_metadata_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_practicesession_table(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _PRACTICE_SESSION_METADATA_BASE_REVISION)
    return cfg


def _practicesession_row(db_url: str, session_id: int) -> dict[str, Any]:
    """Fetch a ``practicesession`` row including ritual-04 columns."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            row = (
                conn.execute(
                    text(
                        "SELECT id, mode, mode_metadata, completed, insight"
                        " FROM practicesession WHERE id = :id"
                    ),
                    {"id": session_id},
                )
                .mappings()
                .first()
            )
            assert row is not None
            return dict(row)
    finally:
        engine.dispose()


def test_practice_session_metadata_migration_round_trip_on_sqlite(
    alembic_sqlite_config_practice_session_metadata: Config,
) -> None:
    """Round-trip ``f0a1b2c3d4e5``: upgrade backfills, downgrade drops, re-upgrade idempotent."""
    cfg = alembic_sqlite_config_practice_session_metadata
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade applies the four new columns and backfills the seeded row.
    command.upgrade(cfg, _PRACTICE_SESSION_METADATA_REVISION)
    cols = _columns_of(db_url, "practicesession")
    assert {"mode", "mode_metadata", "completed", "insight"}.issubset(cols)
    row = _practicesession_row(db_url, session_id=1)
    assert row["mode"] == "meditation_timer"
    assert row["mode_metadata"] is None
    assert bool(row["completed"]) is True
    assert row["insight"] is None

    # Phase 2: downgrade drops the new columns.
    command.downgrade(cfg, _PRACTICE_SESSION_METADATA_BASE_REVISION)
    cols_after = _columns_of(db_url, "practicesession")
    assert {"mode", "mode_metadata", "completed", "insight"}.isdisjoint(cols_after)

    # Phase 3: re-upgrade reproduces the backfill on the same legacy row.
    command.upgrade(cfg, _PRACTICE_SESSION_METADATA_REVISION)
    row_again = _practicesession_row(db_url, session_id=1)
    assert row_again["mode"] == "meditation_timer"
    assert bool(row_again["completed"]) is True


# -- grounding-techniques 01 tallied_grounding CHECK constraint -------------

_ORIGINAL_SEVEN_MODES = (
    "meditation_timer",
    "count_up",
    "metronome",
    "interval_bell",
    "rep_counter",
    "sense_grounding",
    "tarot",
)
_EIGHT_MODES_AFTER_TALLIED = (*_ORIGINAL_SEVEN_MODES, "tallied_grounding")
_NINE_MODES_AFTER_MINDFUL_ANCHOR = (*_EIGHT_MODES_AFTER_TALLIED, "mindful_anchor")
_TEN_MODES_AFTER_CARD_MEDITATION = (*_NINE_MODES_AFTER_MINDFUL_ANCHOR, "card_meditation")


def _bootstrap_practice_with_mode_check(sync_url: str, allowed_modes: tuple[str, ...]) -> None:
    """Pre-create a ``practice`` table whose CHECK pins ``mode`` to ``allowed_modes``.

    Mirrors the schema in place at whichever revision the test stamps to,
    just before that revision's migration runs. Keeping the bootstrap
    SQLite-friendly (no FKs, no extra CHECKs) means the round-trip
    exercises only the migration under test.
    """
    quoted = ", ".join(f"'{m}'" for m in allowed_modes)
    bootstrap_engine = create_engine(sync_url)
    with bootstrap_engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE practice ("
                " id INTEGER PRIMARY KEY,"
                " stage_number INTEGER NOT NULL,"
                " name VARCHAR(255) NOT NULL,"
                " description VARCHAR(2000) NOT NULL DEFAULT '',"
                " instructions VARCHAR(10000) NOT NULL DEFAULT '',"
                " default_duration_minutes FLOAT NOT NULL,"
                " submitted_by_user_id INTEGER,"
                " approved BOOLEAN NOT NULL DEFAULT 1,"
                " mode VARCHAR(32) NOT NULL DEFAULT 'meditation_timer',"
                " mode_config TEXT NOT NULL DEFAULT '{}',"
                f" CONSTRAINT ck_practice_mode_valid CHECK (mode IN ({quoted}))"
                ")"
            )
        )
    bootstrap_engine.dispose()


@pytest.fixture
def alembic_sqlite_config_tallied_grounding(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before grounding-techniques 01's migration."""
    db_path = tmp_path / "tallied_grounding_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_practice_with_mode_check(sync_url, _ORIGINAL_SEVEN_MODES)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _TALLIED_GROUNDING_BASE_REVISION)
    return cfg


def _insert_practice_row(db_url: str, *, mode: str, name: str) -> None:
    """Insert a single practice row with the given mode (raises on CHECK violation)."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO practice (stage_number, name, default_duration_minutes, mode)"
                    " VALUES (:s, :n, :d, :m)"
                ),
                {"s": 1, "n": name, "d": 10.0, "m": mode},
            )
    finally:
        engine.dispose()


def _count_practice_with_mode(db_url: str, mode: str) -> int:
    """Count practice rows carrying a particular mode value."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            count: int = conn.execute(
                text("SELECT count(*) FROM practice WHERE mode = :m"),
                {"m": mode},
            ).scalar_one()
            return count
    finally:
        engine.dispose()


def test_tallied_grounding_migration_round_trip_on_sqlite(
    alembic_sqlite_config_tallied_grounding: Config,
) -> None:
    """Round-trip ``a1b2c3d4e5f7``: upgrade allows the new mode; downgrade reverts the CHECK.

    Acceptance criterion #4 from issue #337: the migration runs cleanly
    on a fresh DB and rolls back on an empty ``practice`` table.
    """
    cfg = alembic_sqlite_config_tallied_grounding
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade — the new CHECK should accept tallied_grounding inserts.
    command.upgrade(cfg, _TALLIED_GROUNDING_REVISION)
    _insert_practice_row(db_url, mode="tallied_grounding", name="Find shapes")
    assert _count_practice_with_mode(db_url, "tallied_grounding") == 1

    # Phase 2: downgrade — refuses to run while a tallied_grounding row exists.
    # The migration's ``downgrade()`` raises a concrete ``RuntimeError`` rather
    # than any random Exception — pinning the class avoids masking unrelated
    # failures.
    with pytest.raises(RuntimeError, match="tallied_grounding"):
        command.downgrade(cfg, _TALLIED_GROUNDING_BASE_REVISION)

    # Phase 3: clear the offending row, then downgrade cleanly.
    sync_engine = create_engine(_sync_url(db_url))
    try:
        with sync_engine.begin() as conn:
            conn.execute(text("DELETE FROM practice WHERE mode = 'tallied_grounding'"))
    finally:
        sync_engine.dispose()
    command.downgrade(cfg, _TALLIED_GROUNDING_BASE_REVISION)

    # Phase 4: the original CHECK is back — inserting tallied_grounding now fails.
    # ``IntegrityError`` is the precise class SQLAlchemy raises on a CHECK
    # constraint violation; using it (rather than the broad ``Exception``)
    # avoids masking unrelated failures whose message happens to mention
    # "CHECK".
    with pytest.raises(IntegrityError):
        _insert_practice_row(db_url, mode="tallied_grounding", name="Should fail")

    # Phase 5: re-upgrade — tallied_grounding inserts succeed again (idempotent cycle).
    command.upgrade(cfg, _TALLIED_GROUNDING_REVISION)
    _insert_practice_row(db_url, mode="tallied_grounding", name="Find colors")
    assert _count_practice_with_mode(db_url, "tallied_grounding") == 1


# -- grounding-techniques-02 mindful_anchor migration round-trip ------------


@pytest.fixture
def alembic_sqlite_config_mindful_anchor(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before ``f4a5b6c7d8e9``.

    The down_revision is the tallied_grounding migration so the
    pre-upgrade CHECK already lists eight modes; bootstrap mirrors that
    state.
    """
    db_path = tmp_path / "mindful_anchor_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_practice_with_mode_check(sync_url, _EIGHT_MODES_AFTER_TALLIED)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _MINDFUL_ANCHOR_BASE_REVISION)
    return cfg


def test_mindful_anchor_migration_round_trip_on_sqlite(
    alembic_sqlite_config_mindful_anchor: Config,
) -> None:
    """Round-trip ``f4a5b6c7d8e9``: upgrade allows ``mindful_anchor``; downgrade reverts.

    Phase 1: upgrade lets a ``mindful_anchor`` row insert succeed
    (proving the CHECK was widened). Phase 2: with that row deleted,
    downgrade narrows the CHECK and rejects future ``mindful_anchor``
    inserts. Phase 3: re-upgrade is idempotent.
    """
    cfg = alembic_sqlite_config_mindful_anchor
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade widens the CHECK.
    command.upgrade(cfg, _MINDFUL_ANCHOR_REVISION)
    _insert_practice_row(db_url, mode="mindful_anchor", name="Touch grass")
    assert _count_practice_with_mode(db_url, "mindful_anchor") == 1

    # Phase 2: clear the new-mode row, then downgrade and prove the CHECK is
    # back in force.
    sync_engine = create_engine(_sync_url(db_url))
    try:
        with sync_engine.begin() as conn:
            conn.execute(text("DELETE FROM practice WHERE mode = 'mindful_anchor'"))
    finally:
        sync_engine.dispose()
    command.downgrade(cfg, _MINDFUL_ANCHOR_BASE_REVISION)
    with pytest.raises(IntegrityError):
        _insert_practice_row(db_url, mode="mindful_anchor", name="Should fail")

    # Phase 3: re-upgrade so the cycle is idempotent.
    command.upgrade(cfg, _MINDFUL_ANCHOR_REVISION)
    _insert_practice_row(db_url, mode="mindful_anchor", name="Mindful eating")
    assert _count_practice_with_mode(db_url, "mindful_anchor") == 1


def test_mindful_anchor_downgrade_refuses_with_existing_rows(
    alembic_sqlite_config_mindful_anchor: Config,
) -> None:
    """The downgrade aborts when ``mindful_anchor`` rows still exist.

    Narrowing the CHECK while data violates it would either rewrite
    history or leave the DB in an inconsistent state. The migration
    refuses to run and the operator clears the rows themselves.
    """
    cfg = alembic_sqlite_config_mindful_anchor
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _MINDFUL_ANCHOR_REVISION)
    _insert_practice_row(db_url, mode="mindful_anchor", name="Stick around")

    with pytest.raises(RuntimeError, match="mindful_anchor"):
        command.downgrade(cfg, _MINDFUL_ANCHOR_BASE_REVISION)


# -- custom-practices-02 card_meditation migration round-trip --------------


@pytest.fixture
def alembic_sqlite_config_card_meditation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before ``a2b3c4d5e6f8``.

    The down_revision is the mindful_anchor migration so the pre-upgrade
    CHECK already lists nine modes; bootstrap mirrors that state.
    """
    db_path = tmp_path / "card_meditation_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_practice_with_mode_check(sync_url, _NINE_MODES_AFTER_MINDFUL_ANCHOR)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _CARD_MEDITATION_BASE_REVISION)
    return cfg


def test_card_meditation_migration_round_trip_on_sqlite(
    alembic_sqlite_config_card_meditation: Config,
) -> None:
    """Round-trip ``a2b3c4d5e6f8``: upgrade allows ``card_meditation``; downgrade reverts.

    Phase 1: upgrade lets a ``card_meditation`` row insert succeed
    (proving the CHECK was widened). Phase 2: with that row deleted,
    downgrade narrows the CHECK and rejects future ``card_meditation``
    inserts. Phase 3: re-upgrade is idempotent.
    """
    cfg = alembic_sqlite_config_card_meditation
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade widens the CHECK.
    command.upgrade(cfg, _CARD_MEDITATION_REVISION)
    _insert_practice_row(db_url, mode="card_meditation", name="RWS daily card")
    assert _count_practice_with_mode(db_url, "card_meditation") == 1

    # Phase 2: clear the new-mode row, then downgrade and prove the CHECK is
    # back in force. ``tarot`` must still insert successfully — the new
    # mode is additive, not a replacement.
    sync_engine = create_engine(_sync_url(db_url))
    try:
        with sync_engine.begin() as conn:
            conn.execute(text("DELETE FROM practice WHERE mode = 'card_meditation'"))
    finally:
        sync_engine.dispose()
    command.downgrade(cfg, _CARD_MEDITATION_BASE_REVISION)
    with pytest.raises(IntegrityError):
        _insert_practice_row(db_url, mode="card_meditation", name="Should fail")
    _insert_practice_row(db_url, mode="tarot", name="Tarot still works")
    assert _count_practice_with_mode(db_url, "tarot") == 1

    # Phase 3: re-upgrade so the cycle is idempotent. The phase-1 row was
    # deleted to enable the downgrade, so only this new row remains.
    command.upgrade(cfg, _CARD_MEDITATION_REVISION)
    _insert_practice_row(db_url, mode="card_meditation", name="Custom phone deck")
    assert _count_practice_with_mode(db_url, "card_meditation") == 1


def test_card_meditation_downgrade_refuses_with_existing_rows(
    alembic_sqlite_config_card_meditation: Config,
) -> None:
    """The downgrade aborts when ``card_meditation`` rows still exist.

    Mirrors the mindful_anchor guard: narrowing the CHECK while data
    violates it would either rewrite history or leave the DB in an
    inconsistent state. The migration refuses to run and the operator
    clears the rows themselves.
    """
    cfg = alembic_sqlite_config_card_meditation
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _CARD_MEDITATION_REVISION)
    _insert_practice_row(db_url, mode="card_meditation", name="Stick around")

    with pytest.raises(RuntimeError, match="card_meditation"):
        command.downgrade(cfg, _CARD_MEDITATION_BASE_REVISION)


# -- custom-practices-03 practice share-link table round-trip ----------------


def _bootstrap_practice_share_link_baseline(sync_url: str) -> None:
    """Bootstrap the minimal schema required by the share-link migration.

    The migration adds ``practicesharelink`` with FKs to ``practice`` and
    ``user``; SQLite needs both parent tables present (FK enforcement is
    off by default, but ``op.create_table`` still validates the column
    references).  Mirrors the bootstrap style used by the password-reset
    and practice-mode round-trip tests so a future schema change to
    either parent surfaces as a deliberate bump of this fixture.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
        )
        conn.execute(
            text(
                "CREATE TABLE practice ("
                " id INTEGER PRIMARY KEY,"
                " stage_number INTEGER NOT NULL,"
                " name VARCHAR(255) NOT NULL,"
                " description VARCHAR(2000) NOT NULL DEFAULT '',"
                " instructions VARCHAR(10000) NOT NULL DEFAULT '',"
                " default_duration_minutes FLOAT NOT NULL,"
                " submitted_by_user_id INTEGER,"
                " approved BOOLEAN NOT NULL DEFAULT 1,"
                " mode VARCHAR(32) NOT NULL DEFAULT 'meditation_timer',"
                " mode_config TEXT NOT NULL DEFAULT '{}'"
                ")"
            )
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_practice_share_link(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before ``f5b6c7d8e9a0``."""
    db_path = tmp_path / "share_link_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_practice_share_link_baseline(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _PRACTICE_SHARE_LINK_BASE_REVISION)
    return cfg


def test_practice_share_link_migration_round_trip_on_sqlite(
    alembic_sqlite_config_practice_share_link: Config,
) -> None:
    """Round-trip ``f5b6c7d8e9a0``: upgrade creates the table; downgrade drops it.

    Phase 1: upgrade installs ``practicesharelink`` with the expected
    columns and unique index on ``token``.  Phase 2: downgrade removes
    the table cleanly.  Phase 3: re-upgrade is idempotent.
    """
    cfg = alembic_sqlite_config_practice_share_link
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade.
    command.upgrade(cfg, _PRACTICE_SHARE_LINK_REVISION)
    assert _table_exists(db_url, "practicesharelink")
    cols = _columns_of(db_url, "practicesharelink")
    expected = {
        "id",
        "token",
        "practice_id",
        "created_by_user_id",
        "created_at",
        "expires_at",
        "max_uses",
        "use_count",
        "revoked_at",
    }
    assert expected.issubset(cols)

    # Phase 2: downgrade drops the table.
    command.downgrade(cfg, _PRACTICE_SHARE_LINK_BASE_REVISION)
    assert not _table_exists(db_url, "practicesharelink")

    # Phase 3: re-upgrade is idempotent.
    command.upgrade(cfg, _PRACTICE_SHARE_LINK_REVISION)
    assert _table_exists(db_url, "practicesharelink")


# -- custom-practices-01 random_interval_bell migration round-trip ----------


@pytest.fixture
def alembic_sqlite_config_random_interval_bell(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before ``b6c7d8e9a0b1``.

    The down_revision is the share-link migration so the pre-upgrade
    CHECK already lists ten modes; bootstrap mirrors that state.
    """
    db_path = tmp_path / "random_interval_bell_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_practice_with_mode_check(sync_url, _TEN_MODES_AFTER_CARD_MEDITATION)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _RANDOM_INTERVAL_BELL_BASE_REVISION)
    return cfg


def test_random_interval_bell_migration_round_trip_on_sqlite(
    alembic_sqlite_config_random_interval_bell: Config,
) -> None:
    """Round-trip ``b6c7d8e9a0b1``: upgrade allows the new mode; downgrade reverts.

    Phase 1: upgrade lets a ``random_interval_bell`` row insert succeed
    (proving the CHECK was widened). Phase 2: with that row deleted,
    downgrade narrows the CHECK and rejects future inserts while leaving
    ``interval_bell`` untouched. Phase 3: re-upgrade is idempotent.
    """
    cfg = alembic_sqlite_config_random_interval_bell
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade widens the CHECK.
    command.upgrade(cfg, _RANDOM_INTERVAL_BELL_REVISION)
    _insert_practice_row(db_url, mode="random_interval_bell", name="Random bell")
    assert _count_practice_with_mode(db_url, "random_interval_bell") == 1

    # Phase 2: clear the new-mode row, then downgrade and prove the CHECK is
    # back in force. ``interval_bell`` must still insert successfully — the
    # new mode is additive, not a replacement.
    sync_engine = create_engine(_sync_url(db_url))
    try:
        with sync_engine.begin() as conn:
            conn.execute(text("DELETE FROM practice WHERE mode = 'random_interval_bell'"))
    finally:
        sync_engine.dispose()
    command.downgrade(cfg, _RANDOM_INTERVAL_BELL_BASE_REVISION)
    with pytest.raises(IntegrityError):
        _insert_practice_row(db_url, mode="random_interval_bell", name="Should fail")
    _insert_practice_row(db_url, mode="interval_bell", name="Interval bell still works")
    assert _count_practice_with_mode(db_url, "interval_bell") == 1

    # Phase 3: re-upgrade so the cycle is idempotent.
    command.upgrade(cfg, _RANDOM_INTERVAL_BELL_REVISION)
    _insert_practice_row(db_url, mode="random_interval_bell", name="Random bell again")
    assert _count_practice_with_mode(db_url, "random_interval_bell") == 1


def test_random_interval_bell_downgrade_refuses_with_existing_rows(
    alembic_sqlite_config_random_interval_bell: Config,
) -> None:
    """The downgrade aborts when ``random_interval_bell`` rows still exist.

    Mirrors the card_meditation guard: narrowing the CHECK while data
    violates it would either rewrite history or leave the DB in an
    inconsistent state. The migration refuses to run and the operator
    clears the rows themselves.
    """
    cfg = alembic_sqlite_config_random_interval_bell
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _RANDOM_INTERVAL_BELL_REVISION)
    _insert_practice_row(db_url, mode="random_interval_bell", name="Stick around")

    with pytest.raises(RuntimeError, match="random_interval_bell"):
        command.downgrade(cfg, _RANDOM_INTERVAL_BELL_BASE_REVISION)


# -- issue #894 journal_classification_tier migration round-trip ------------

# These revision IDs are intentional placeholders that the implementer will
# replace with the real IDs when writing the migration.  Until then the test
# fails with ``CommandError`` (unknown revision) — which is the correct RED
# failure mode: it forces the implementer to write the migration first.
_JOURNAL_CLASSIFICATION_BASE_REVISION = "c5d6e7f8a9b0"  # pragma: allowlist secret
# The implementer must set this to the real revision ID of the migration they
# author for issue #894.
_JOURNAL_CLASSIFICATION_REVISION = "d8e9f0a1b2c3"  # pragma: allowlist secret


def _bootstrap_journalentry_table(sync_url: str) -> None:
    """Pre-create a minimal ``journalentry`` table for the round-trip fixture.

    Mirrors the schema in place just before the classification-tier migration,
    without pulling in every preceding migration.  One existing row is seeded
    so the upgrade backfill can be observed.
    """
    bootstrap_engine = create_engine(sync_url)
    with bootstrap_engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE journalentry ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " sender VARCHAR(10) NOT NULL,"
                " message TEXT NOT NULL,"
                " tag VARCHAR(50) NOT NULL DEFAULT 'freeform',"
                " status VARCHAR(20) NOT NULL DEFAULT 'draft',"
                " title VARCHAR(200),"
                " deleted_at DATETIME,"
                " updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"
                " timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO journalentry (id, user_id, sender, message)"
                " VALUES (1, 1, 'user', 'Pre-migration entry.')"
            )
        )
    bootstrap_engine.dispose()


@pytest.fixture
def alembic_sqlite_config_journal_classification(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite Alembic config positioned just before the #894 migration.

    Bootstraps a minimal ``journalentry`` table with one legacy row (no
    ``classification`` column) and stamps the DB at the head revision just
    before the new migration, so the round-trip exercises only the
    classification-tier migration.
    """
    db_path = tmp_path / "journal_classification_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_journalentry_table(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _JOURNAL_CLASSIFICATION_BASE_REVISION)
    return cfg


def _journalentry_row(db_url: str, entry_id: int) -> dict[str, Any]:
    """Fetch a single ``journalentry`` row as a dict."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            row = (
                conn.execute(
                    text("SELECT id, classification FROM journalentry WHERE id = :id"),
                    {"id": entry_id},
                )
                .mappings()
                .first()
            )
            assert row is not None
            return dict(row)
    finally:
        engine.dispose()


def test_journal_classification_migration_round_trip_on_sqlite(
    alembic_sqlite_config_journal_classification: Config,
) -> None:
    """Round-trip the #894 migration: upgrade adds column + backfills; downgrade drops it.

    Phase 1: upgrade adds ``classification`` NOT NULL DEFAULT 'personal' and
    backfills the pre-existing legacy row to 'personal'.
    Phase 2: downgrade removes the column.
    Phase 3: re-upgrade is idempotent — the backfill re-runs cleanly.

    This test will fail until the implementer authors the migration and sets
    ``_JOURNAL_CLASSIFICATION_REVISION`` to its real revision ID.
    """
    cfg = alembic_sqlite_config_journal_classification
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade adds the classification column and backfills the legacy row.
    command.upgrade(cfg, _JOURNAL_CLASSIFICATION_REVISION)
    cols = _columns_of(db_url, "journalentry")
    assert "classification" in cols

    row = _journalentry_row(db_url, entry_id=1)
    assert row["classification"] == "personal", (
        "Upgrade must backfill pre-existing rows to 'personal' (the default tier)."
    )

    # Phase 2: downgrade removes the classification column.
    command.downgrade(cfg, _JOURNAL_CLASSIFICATION_BASE_REVISION)
    cols_after = _columns_of(db_url, "journalentry")
    assert "classification" not in cols_after

    # Phase 3: re-upgrade — backfill must reproduce the same value (idempotent).
    command.upgrade(cfg, _JOURNAL_CLASSIFICATION_REVISION)
    row_after = _journalentry_row(db_url, entry_id=1)
    assert row_after["classification"] == "personal"


# -- depth-prefs-01 user_depth_preferences table migration round-trip -------

# Revision anchors for the user_depth_preferences migration round-trip.
_USER_DEPTH_PREFS_BASE_REVISION = "d8e9f0a1b2c3"  # pragma: allowlist secret
_USER_DEPTH_PREFS_REVISION = "e2f3a4b5c6d8"  # pragma: allowlist secret

# stageprogress-01: add cycle_number column (NOT NULL, server_default=1, CHECK >= 1).
_STAGEPROGRESS_CYCLE_BASE_REVISION = "e2f3a4b5c6d8"  # pragma: allowlist secret
# The implementer must replace this with the real revision ID they author.
_STAGEPROGRESS_CYCLE_REVISION = "f2a3b4c5d6e8"  # pragma: allowlist secret


def _bootstrap_user_table_for_depth_prefs(sync_url: str) -> None:
    """Pre-create a minimal ``user`` table with two seeded rows.

    Mirrors the schema the depth-prefs migration expects to find at
    ``d8e9f0a1b2c3``.  Two rows are seeded so the backfill can be
    verified for more than one user.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
        )
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'alice@example.com')"))
        conn.execute(text("INSERT INTO user (id, email) VALUES (2, 'bob@example.com')"))
    engine.dispose()


def _depth_prefs_rows(db_url: str) -> list[dict[str, Any]]:
    """Return all rows from ``userdepthpreferences`` as a list of dicts."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            rows = (
                conn.execute(
                    text(
                        "SELECT user_id, enable_habits, enable_practices,"
                        " enable_course, enable_sangha"
                        " FROM userdepthpreferences ORDER BY user_id"
                    )
                )
                .mappings()
                .all()
            )
            return [dict(r) for r in rows]
    finally:
        engine.dispose()


@pytest.fixture
def alembic_sqlite_config_user_depth_prefs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite Alembic config positioned just before the depth-prefs migration.

    Bootstraps a minimal ``user`` table with two pre-existing rows so the
    backfill step can be verified for multiple users, then stamps the DB at
    ``d8e9f0a1b2c3`` (the current chain head before this migration).
    """
    db_path = tmp_path / "user_depth_prefs_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_user_table_for_depth_prefs(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _USER_DEPTH_PREFS_BASE_REVISION)
    return cfg


def test_user_depth_prefs_migration_round_trip_on_sqlite(
    alembic_sqlite_config_user_depth_prefs: Config,
) -> None:
    """Round-trip the depth-prefs migration: upgrade creates table + backfills; downgrade drops.

    Phase 1: upgrade creates ``userdepthpreferences`` and backfills both
    pre-existing user rows with all-True flags.
    Phase 2: downgrade drops the table.
    Phase 3: re-upgrade is idempotent — the backfill reproduces the same rows.
    """
    cfg = alembic_sqlite_config_user_depth_prefs
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade creates the table and backfills pre-existing users.
    command.upgrade(cfg, _USER_DEPTH_PREFS_REVISION)
    assert _table_exists(db_url, "userdepthpreferences")
    cols = _columns_of(db_url, "userdepthpreferences")
    assert {
        "id",
        "user_id",
        "enable_habits",
        "enable_practices",
        "enable_course",
        "enable_sangha",
    }.issubset(cols)

    rows = _depth_prefs_rows(db_url)
    assert len(rows) == 2, "Both pre-existing users must be backfilled."
    for row in rows:
        assert bool(row["enable_habits"]) is True
        assert bool(row["enable_practices"]) is True
        assert bool(row["enable_course"]) is True
        assert bool(row["enable_sangha"]) is True

    # Phase 2: downgrade drops the table entirely.
    command.downgrade(cfg, _USER_DEPTH_PREFS_BASE_REVISION)
    assert not _table_exists(db_url, "userdepthpreferences")

    # Phase 3: re-upgrade reproduces the same backfill (idempotent cycle).
    command.upgrade(cfg, _USER_DEPTH_PREFS_REVISION)
    assert _table_exists(db_url, "userdepthpreferences")
    rows_again = _depth_prefs_rows(db_url)
    assert len(rows_again) == 2
    for row in rows_again:
        assert bool(row["enable_habits"]) is True
        assert bool(row["enable_sangha"]) is True


# -- stageprogress-01 cycle_number column migration round-trip ----------------


def _bootstrap_stageprogress_table(sync_url: str) -> None:
    """Pre-create a minimal ``stageprogress`` table with one legacy row.

    Mirrors the schema in place just before the cycle_number migration runs.
    One existing row is seeded without cycle_number so the upgrade backfill
    can be observed. The user FK is created as a standalone table; SQLite
    FK enforcement is off by default so referential integrity is not the
    concern here.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
        )
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'legacy@example.com')"))
        conn.execute(
            text(
                "CREATE TABLE stageprogress ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL UNIQUE,"
                " current_stage INTEGER NOT NULL,"
                " completed_stages TEXT NOT NULL DEFAULT '[]',"
                " stage_started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"
                " program_started_at DATETIME"
                ")"
            )
        )
        conn.execute(
            text("INSERT INTO stageprogress (id, user_id, current_stage) VALUES (1, 1, 1)")
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_stageprogress_cycle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite Alembic config positioned just before the cycle_number migration.

    Bootstraps a minimal ``stageprogress`` table with one legacy row (no
    ``cycle_number`` column) and stamps the DB at ``e2f3a4b5c6d8`` (the
    current chain head before this migration) so the round-trip exercises
    only the new migration.
    """
    db_path = tmp_path / "stageprogress_cycle_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_stageprogress_table(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _STAGEPROGRESS_CYCLE_BASE_REVISION)
    return cfg


def _stageprogress_row(db_url: str, row_id: int) -> dict[str, Any]:
    """Fetch a ``stageprogress`` row including the new cycle_number column."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            row = (
                conn.execute(
                    text(
                        "SELECT id, current_stage, cycle_number FROM stageprogress WHERE id = :id"
                    ),
                    {"id": row_id},
                )
                .mappings()
                .first()
            )
            assert row is not None
            return dict(row)
    finally:
        engine.dispose()


def test_stageprogress_cycle_migration_round_trip_on_sqlite(
    alembic_sqlite_config_stageprogress_cycle: Config,
) -> None:
    """Round-trip the cycle_number migration: upgrade adds column + backfills; downgrade drops it.

    Phase 1: upgrade adds ``cycle_number`` NOT NULL and backfills the
    pre-existing legacy row to 1.
    Phase 2: downgrade removes the column.
    Phase 3: re-upgrade is idempotent — the backfill re-runs cleanly.

    This test fails until the implementer authors the migration and sets
    ``_STAGEPROGRESS_CYCLE_REVISION`` to its real revision ID.
    """
    cfg = alembic_sqlite_config_stageprogress_cycle
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade adds the column and backfills the legacy row.
    command.upgrade(cfg, _STAGEPROGRESS_CYCLE_REVISION)
    cols = _columns_of(db_url, "stageprogress")
    assert "cycle_number" in cols

    row = _stageprogress_row(db_url, row_id=1)
    assert row["cycle_number"] == 1, "Upgrade must backfill pre-existing rows to 1."

    # Phase 2: downgrade drops the cycle_number column.
    command.downgrade(cfg, _STAGEPROGRESS_CYCLE_BASE_REVISION)
    cols_after = _columns_of(db_url, "stageprogress")
    assert "cycle_number" not in cols_after

    # Phase 3: re-upgrade — backfill must reproduce the same value.
    command.upgrade(cfg, _STAGEPROGRESS_CYCLE_REVISION)
    row_after = _stageprogress_row(db_url, row_id=1)
    assert row_after["cycle_number"] == 1


# -- high-water-01 highest_stage_reached column migration round-trip ---------

# Revision anchors for the highest_stage_reached migration round-trip.
# down_revision is a7b8c9d0e1f2 (the current chain head at authoring time).
_HIGH_WATER_BASE_REVISION = "a7b8c9d0e1f2"  # pragma: allowlist secret
# The implementer must replace this with the real revision ID they author.
_HIGH_WATER_REVISION = "d3e4f5a6b7c8"  # pragma: allowlist secret


def _bootstrap_stageprogress_high_water(sync_url: str) -> None:
    """Pre-create a ``stageprogress`` table matching the schema at head, seeded with four rows.

    Each row exercises a different branch of the
    ``GREATEST(current_stage, max(completed_stages), cycle-case)`` backfill:

    - Row 1 (current_stage=3, completed_stages=[1, 2], cycle_number=1):
      plain mid-cycle row, ``current_stage`` wins -> 3.
    - Row 2 (current_stage=2, completed_stages=[1..6], cycle_number=1): the
      completed_stages array-max (6) wins over ``current_stage`` -> 6.
    - Row 3 (current_stage=1, completed_stages=[], cycle_number=2): a completed
      prior cycle reached the final stage, so it backfills to TOTAL_STAGES -> 10.
    - Row 4 (current_stage=1, completed_stages=[], cycle_number=1): nothing
      to inherit, floors at ``current_stage`` -> 1.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
        )
        # One user per stageprogress row: stageprogress.user_id is UNIQUE.
        for uid in (1, 2, 3, 4):
            conn.execute(
                text("INSERT INTO user (id, email) VALUES (:id, :email)"),
                {"id": uid, "email": f"highwater{uid}@example.com"},
            )
        conn.execute(
            text(
                "CREATE TABLE stageprogress ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL UNIQUE,"
                " current_stage INTEGER NOT NULL,"
                " completed_stages TEXT NOT NULL DEFAULT '[]',"
                " stage_started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"
                " program_started_at DATETIME,"
                " cycle_number INTEGER NOT NULL DEFAULT 1"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO stageprogress"
                " (id, user_id, current_stage, completed_stages, cycle_number)"
                " VALUES (1, 1, 3, '[1, 2]', 1)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO stageprogress"
                " (id, user_id, current_stage, completed_stages, cycle_number)"
                " VALUES (2, 2, 2, '[1, 2, 3, 4, 5, 6]', 1)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO stageprogress"
                " (id, user_id, current_stage, completed_stages, cycle_number)"
                " VALUES (3, 3, 1, '[]', 2)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO stageprogress"
                " (id, user_id, current_stage, completed_stages, cycle_number)"
                " VALUES (4, 4, 1, '[]', 1)"
            )
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_stageprogress_high_water(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite Alembic config positioned just before the high-water migration.

    Bootstraps the head-shape ``stageprogress`` table with four seeded rows
    (see :func:`_bootstrap_stageprogress_high_water`) and stamps the DB at
    ``a7b8c9d0e1f2`` so the round-trip exercises only the new migration.
    """
    db_path = tmp_path / "stageprogress_high_water_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_stageprogress_high_water(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _HIGH_WATER_BASE_REVISION)
    return cfg


def _stageprogress_high_water_row(db_url: str, row_id: int) -> dict[str, Any]:
    """Fetch a ``stageprogress`` row including the new highest_stage_reached column."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            row = (
                conn.execute(
                    text(
                        "SELECT id, current_stage, cycle_number, highest_stage_reached"
                        " FROM stageprogress WHERE id = :id"
                    ),
                    {"id": row_id},
                )
                .mappings()
                .first()
            )
            assert row is not None
            return dict(row)
    finally:
        engine.dispose()


def _assert_backfilled_rows(db_url: str) -> None:
    """Assert all four seeded rows backfilled per the GREATEST(...) branches."""
    row_1 = _stageprogress_high_water_row(db_url, row_id=1)
    assert row_1["highest_stage_reached"] == 3
    row_2 = _stageprogress_high_water_row(db_url, row_id=2)
    assert row_2["highest_stage_reached"] == 6
    row_3 = _stageprogress_high_water_row(db_url, row_id=3)
    assert row_3["highest_stage_reached"] == 10
    row_4 = _stageprogress_high_water_row(db_url, row_id=4)
    assert row_4["highest_stage_reached"] == 1


def test_high_water_migration_round_trip_on_sqlite(
    alembic_sqlite_config_stageprogress_high_water: Config,
) -> None:
    """Round-trip the highest_stage_reached migration: backfill, downgrade, re-upgrade.

    Phase 1: upgrade adds ``highest_stage_reached`` NOT NULL and backfills
    each seeded row via ``GREATEST(current_stage, max(completed_stages),
    cycle-case)``: row 1's ``current_stage`` (3) wins; row 2's
    completed_stages array-max (6) wins over its lower current_stage (2);
    row 3's completed prior cycle reached the final stage, so it backfills to
    TOTAL_STAGES (10); row 4 has nothing to inherit and floors at its own
    ``current_stage`` (1).
    Phase 2: downgrade removes the column.
    Phase 3: re-upgrade reproduces the same backfill.

    This test fails until the implementer authors the migration and sets
    ``_HIGH_WATER_REVISION`` to its real revision ID.
    """
    cfg = alembic_sqlite_config_stageprogress_high_water
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade adds the column and backfills the four seeded rows.
    command.upgrade(cfg, _HIGH_WATER_REVISION)
    cols = _columns_of(db_url, "stageprogress")
    assert "highest_stage_reached" in cols
    _assert_backfilled_rows(db_url)

    # Phase 2: downgrade drops the highest_stage_reached column.
    command.downgrade(cfg, _HIGH_WATER_BASE_REVISION)
    cols_after = _columns_of(db_url, "stageprogress")
    assert "highest_stage_reached" not in cols_after

    # Phase 3: re-upgrade — backfill must reproduce the same values.
    command.upgrade(cfg, _HIGH_WATER_REVISION)
    _assert_backfilled_rows(db_url)


# -- invitation-signal-01 invitationsignal table migration round-trip ---------

# Revision anchors for the invitation_signal migration round-trip.
# down_revision is f2a3b4c5d6e8 (the stageprogress cycle_number migration).
_INVITATION_SIGNAL_BASE_REVISION = "f2a3b4c5d6e8"  # pragma: allowlist secret
_INVITATION_SIGNAL_REVISION = "b3c4d5e6f7a8"  # pragma: allowlist secret


def _bootstrap_invitation_signal_baseline(sync_url: str) -> None:
    """Bootstrap a minimal ``user`` table required by the invitation_signal migration.

    The migration creates ``invitationsignal`` with a FK to ``user.id``
    (ondelete CASCADE); SQLite needs the parent table present even with FK
    enforcement off.  One user row is inserted so unique-index enforcement
    can be exercised inside the round-trip test.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
        )
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'inv@example.com')"))
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_invitation_signal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite Alembic config positioned just before the invitation_signal migration.

    Bootstraps a minimal ``user`` table and stamps the DB at
    ``f2a3b4c5d6e8`` (the chain head before this migration) so the
    round-trip exercises only the new migration.
    """
    db_path = tmp_path / "invitation_signal_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_invitation_signal_baseline(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _INVITATION_SIGNAL_BASE_REVISION)
    return cfg


def _insert_invitation_signal_row(
    db_url: str,
    *,
    user_id: int,
    target_type: str,
    target_id: int | None,
    kind: str,
) -> None:
    """Insert a single invitationsignal row (raises on constraint violation)."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO invitationsignal"
                    " (user_id, target_type, target_id, kind, created_at)"
                    " VALUES (:u, :tt, :tid, :k, '2026-06-01T00:00:00+00:00')"
                ),
                {"u": user_id, "tt": target_type, "tid": target_id, "k": kind},
            )
    finally:
        engine.dispose()


def test_invitation_signal_migration_round_trip_on_sqlite(
    alembic_sqlite_config_invitation_signal: Config,
) -> None:
    """Round-trip the invitation_signal migration: upgrade creates table; downgrade drops it.

    Phase 1: upgrade installs ``invitationsignal`` with the expected columns
    and both partial unique indexes, and the null-target_id partial index
    enforces uniqueness (insert a duplicate → IntegrityError).
    Phase 2: downgrade removes the table cleanly.
    Phase 3: re-upgrade is idempotent.
    """
    cfg = alembic_sqlite_config_invitation_signal
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade creates the table.
    command.upgrade(cfg, _INVITATION_SIGNAL_REVISION)
    assert _table_exists(db_url, "invitationsignal")
    cols = _columns_of(db_url, "invitationsignal")
    expected_cols = {
        "id",
        "user_id",
        "target_type",
        "target_id",
        "kind",
        "created_at",
        "dismissed_at",
    }
    assert expected_cols.issubset(cols)

    # The null-target_id partial index must enforce uniqueness.
    _insert_invitation_signal_row(
        db_url, user_id=1, target_type="habit", target_id=None, kind="readiness"
    )
    with pytest.raises(IntegrityError):
        _insert_invitation_signal_row(
            db_url, user_id=1, target_type="habit", target_id=None, kind="readiness"
        )

    # Phase 2: downgrade drops the table.
    command.downgrade(cfg, _INVITATION_SIGNAL_BASE_REVISION)
    assert not _table_exists(db_url, "invitationsignal")

    # Phase 3: re-upgrade is idempotent.
    command.upgrade(cfg, _INVITATION_SIGNAL_REVISION)
    assert _table_exists(db_url, "invitationsignal")


# -- chord-journaling-01 primary_aspect / secondary_aspect migration round-trip ---

# Revision anchors for the chord-journaling migration round-trip.
# down_revision is c9d0e1f2a3b4 (the metta_return_arc migration, current head).
_CHORD_BASE_REVISION = "c9d0e1f2a3b4"  # pragma: allowlist secret
_CHORD_REVISION = "a5b6c7d8e9f0"  # pragma: allowlist secret


def _bootstrap_journalentry_table_for_chord(sync_url: str) -> None:
    """Pre-create a minimal journalentry table without the chord columns."""
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE journalentry ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " sender VARCHAR(10) NOT NULL,"
                " message TEXT NOT NULL,"
                " tag VARCHAR(50) NOT NULL DEFAULT 'freeform',"
                " status VARCHAR(20) NOT NULL DEFAULT 'draft',"
                " title VARCHAR(200),"
                " classification VARCHAR(20) NOT NULL DEFAULT 'personal',"
                " deleted_at DATETIME,"
                " updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"
                " timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO journalentry (id, user_id, sender, message)"
                " VALUES (1, 1, 'user', 'Pre-chord entry.')"
            )
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_journal_chord(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite Alembic config positioned just before the chord migration.

    Bootstraps a minimal journalentry table (no chord columns) with one
    pre-existing row, then stamps the DB at c9d0e1f2a3b4 (the chain head
    before this migration) so the round-trip exercises only the new migration.
    """
    db_path = tmp_path / "journal_chord_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_journalentry_table_for_chord(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _CHORD_BASE_REVISION)
    return cfg


def test_journal_chord_migration_round_trip_on_sqlite(
    alembic_sqlite_config_journal_chord: Config,
) -> None:
    """Round-trip the chord migration: upgrade adds both columns; downgrade drops them.

    Phase 1: upgrade adds primary_aspect and secondary_aspect (both nullable).
    Phase 2: downgrade removes both columns.
    Phase 3: re-upgrade is idempotent.
    """
    cfg = alembic_sqlite_config_journal_chord
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade adds both chord columns.
    command.upgrade(cfg, _CHORD_REVISION)
    cols = _columns_of(db_url, "journalentry")
    assert "primary_aspect" in cols
    assert "secondary_aspect" in cols

    # Phase 2: downgrade removes both columns.
    command.downgrade(cfg, _CHORD_BASE_REVISION)
    cols_after = _columns_of(db_url, "journalentry")
    assert "primary_aspect" not in cols_after
    assert "secondary_aspect" not in cols_after

    # Phase 3: re-upgrade is idempotent.
    command.upgrade(cfg, _CHORD_REVISION)
    cols_final = _columns_of(db_url, "journalentry")
    assert "primary_aspect" in cols_final
    assert "secondary_aspect" in cols_final


# -- habit.revealed column migration round-trip ------------------------------

# down_revision is d3e4f5a6b7c8 (the highest_stage_reached migration, the
# current chain head at authoring time).
_HABIT_REVEALED_BASE_REVISION = "d3e4f5a6b7c8"  # pragma: allowlist secret
# The implementer must replace this with the real revision ID they author.
_HABIT_REVEALED_REVISION = "e6f7a8b9c0d2"  # pragma: allowlist secret


def _bootstrap_habit_revealed_baseline(sync_url: str) -> None:
    """Pre-create a minimal ``habit`` table (no ``revealed`` column) with two seeded rows.

    Mirrors the schema in place just before the revealed-column migration,
    without pulling in every preceding migration. Two pre-existing rows let
    the "upgrade backfills every existing row to True" assertion cover more
    than a single row.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
        )
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'revealed@example.com')"))
        conn.execute(
            text(
                "CREATE TABLE habit ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " name VARCHAR(255) NOT NULL,"
                " icon VARCHAR(100) NOT NULL,"
                " start_date DATE NOT NULL,"
                " energy_cost INTEGER NOT NULL,"
                " energy_return INTEGER NOT NULL,"
                " stage VARCHAR(100) NOT NULL DEFAULT '',"
                " streak INTEGER NOT NULL DEFAULT 0"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO habit"
                " (id, user_id, name, icon, start_date, energy_cost, energy_return)"
                " VALUES (1, 1, 'Existing Habit', 'leaf', '2025-01-01', 1, 2)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO habit"
                " (id, user_id, name, icon, start_date, energy_cost, energy_return)"
                " VALUES (2, 1, 'Second Habit', 'drop', '2025-02-01', 1, 2)"
            )
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_habit_revealed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before the habit.revealed migration."""
    db_path = tmp_path / "habit_revealed_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_habit_revealed_baseline(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _HABIT_REVEALED_BASE_REVISION)
    return cfg


def _habit_revealed_row(db_url: str, habit_id: int) -> dict[str, Any]:
    """Fetch a ``habit`` row including the new ``revealed`` column."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            row = (
                conn.execute(
                    text("SELECT id, revealed FROM habit WHERE id = :id"),
                    {"id": habit_id},
                )
                .mappings()
                .first()
            )
            assert row is not None
            return dict(row)
    finally:
        engine.dispose()


def test_habit_revealed_migration_round_trip_on_sqlite(
    alembic_sqlite_config_habit_revealed: Config,
) -> None:
    """Round-trip the habit.revealed migration: upgrade adds + backfills; downgrade drops.

    Phase 1: upgrade adds ``revealed`` NOT NULL and backfills every EXISTING
    row to ``true`` -- accounts that pre-date the locked-by-default model keep
    their habits unlocked; only NEW/seeded habits created after this migration
    start locked (that default lives in the model/schema, not this backfill).
    Phase 2: downgrade drops the column.
    Phase 3: re-upgrade reproduces the same backfill (idempotent).

    This test fails until the implementer authors the migration and sets
    ``_HABIT_REVEALED_REVISION`` to its real revision ID.
    """
    cfg = alembic_sqlite_config_habit_revealed
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade adds the column and backfills both seeded rows to True.
    command.upgrade(cfg, _HABIT_REVEALED_REVISION)
    cols = _columns_of(db_url, "habit")
    assert "revealed" in cols
    row_1 = _habit_revealed_row(db_url, habit_id=1)
    assert bool(row_1["revealed"]) is True
    row_2 = _habit_revealed_row(db_url, habit_id=2)
    assert bool(row_2["revealed"]) is True

    # Phase 2: downgrade drops the revealed column.
    command.downgrade(cfg, _HABIT_REVEALED_BASE_REVISION)
    cols_after = _columns_of(db_url, "habit")
    assert "revealed" not in cols_after

    # Phase 3: re-upgrade -- backfill must reproduce the same values.
    command.upgrade(cfg, _HABIT_REVEALED_REVISION)
    row_1_again = _habit_revealed_row(db_url, habit_id=1)
    assert bool(row_1_again["revealed"]) is True


# -- goalcompletion.local_day column migration round-trip --------------------

_LOCAL_DAY_BASE_REVISION = "e6f7a8b9c0d2"  # pragma: allowlist secret
_LOCAL_DAY_REVISION = "f7a8b9c0d1e3"  # pragma: allowlist secret


def _bootstrap_local_day_baseline(sync_url: str) -> None:
    """Pre-create a minimal ``goalcompletion`` table (no ``local_day``) with two seeded rows.

    Rows sit on two distinct calendar days so both the new local-day unique
    index and the restored UTC-day index remain satisfiable across the
    round-trip.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE user ( id INTEGER PRIMARY KEY, timezone VARCHAR(64))"))
        conn.execute(text("INSERT INTO user (id, timezone) VALUES (1, 'UTC')"))
        conn.execute(
            text(
                "CREATE TABLE goalcompletion ("
                " id INTEGER PRIMARY KEY,"
                " goal_id INTEGER NOT NULL,"
                " user_id INTEGER NOT NULL,"
                " timestamp DATETIME NOT NULL,"
                " completed_units FLOAT NOT NULL,"
                " via_timer BOOLEAN NOT NULL DEFAULT 0"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO goalcompletion"
                " (id, goal_id, user_id, timestamp, completed_units)"
                " VALUES (1, 1, 1, '2025-03-01 10:00:00', 10.0)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO goalcompletion"
                " (id, goal_id, user_id, timestamp, completed_units)"
                " VALUES (2, 1, 1, '2025-03-02 10:00:00', 10.0)"
            )
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_local_day(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before the local_day migration."""
    db_path = tmp_path / "local_day_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_local_day_baseline(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _LOCAL_DAY_BASE_REVISION)
    return cfg


def _local_day_of(db_url: str, completion_id: int) -> dict[str, Any]:
    """Fetch the ``id`` + ``local_day`` of one goalcompletion row."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            row = (
                conn.execute(
                    text("SELECT id, local_day FROM goalcompletion WHERE id = :id"),
                    {"id": completion_id},
                )
                .mappings()
                .first()
            )
            assert row is not None
            return dict(row)
    finally:
        engine.dispose()


def test_local_day_migration_round_trip_on_sqlite(
    alembic_sqlite_config_local_day: Config,
) -> None:
    """Round-trip the local_day migration: upgrade adds + backfills; downgrade drops.

    Upgrade adds ``local_day`` and backfills it from ``date(timestamp)`` on
    SQLite; downgrade drops the column; re-upgrade reproduces the backfill.
    """
    cfg = alembic_sqlite_config_local_day
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _LOCAL_DAY_REVISION)
    cols = _columns_of(db_url, "goalcompletion")
    assert "local_day" in cols
    assert str(_local_day_of(db_url, completion_id=1)["local_day"]) == "2025-03-01"
    assert str(_local_day_of(db_url, completion_id=2)["local_day"]) == "2025-03-02"

    command.downgrade(cfg, _LOCAL_DAY_BASE_REVISION)
    cols_after = _columns_of(db_url, "goalcompletion")
    assert "local_day" not in cols_after

    command.upgrade(cfg, _LOCAL_DAY_REVISION)
    assert str(_local_day_of(db_url, completion_id=1)["local_day"]) == "2025-03-01"


def _bootstrap_local_day_collision_baseline(sync_url: str) -> None:
    """Seed two rows that share a calendar day so backfill makes them collide.

    Both rows bucket to ``2025-03-01`` under ``date(timestamp)``, so the new
    ``(goal_id, user_id, local_day)`` unique index cannot be created until the
    dedup step archives one of them.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE user ( id INTEGER PRIMARY KEY, timezone VARCHAR(64))"))
        conn.execute(text("INSERT INTO user (id, timezone) VALUES (1, 'UTC')"))
        conn.execute(
            text(
                "CREATE TABLE goalcompletion ("
                " id INTEGER PRIMARY KEY,"
                " goal_id INTEGER NOT NULL,"
                " user_id INTEGER NOT NULL,"
                " timestamp DATETIME NOT NULL,"
                " completed_units FLOAT NOT NULL,"
                " via_timer BOOLEAN NOT NULL DEFAULT 0"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO goalcompletion"
                " (id, goal_id, user_id, timestamp, completed_units)"
                " VALUES (1, 1, 1, '2025-03-01 08:00:00', 10.0)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO goalcompletion"
                " (id, goal_id, user_id, timestamp, completed_units)"
                " VALUES (2, 1, 1, '2025-03-01 20:00:00', 5.0)"
            )
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_local_day_collision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config seeded with a same-local-day collision pair."""
    db_path = tmp_path / "local_day_collision_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_local_day_collision_baseline(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _LOCAL_DAY_BASE_REVISION)
    return cfg


def _ids_from_query(db_url: str, query: str) -> list[int]:
    """Return the sorted ``id`` values yielded by a literal SELECT ``query``."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            rows = conn.execute(text(query)).scalars().all()
            return [int(value) for value in rows]
    finally:
        engine.dispose()


def test_local_day_migration_archives_same_day_duplicate_on_sqlite(
    alembic_sqlite_config_local_day_collision: Config,
) -> None:
    """A same-local-day collision keeps the min-id row and archives the loser, never dropping it.

    This exercises the data-safety-critical dedup branch: the higher-id row must
    move into ``_duplicates_goalcompletion`` (recoverable) rather than vanish,
    and the surviving completion row must be the first-logged (lowest id).
    """
    cfg = alembic_sqlite_config_local_day_collision
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _LOCAL_DAY_REVISION)

    assert _ids_from_query(db_url, "SELECT id FROM goalcompletion ORDER BY id") == [1]
    assert _table_exists(db_url, "_duplicates_goalcompletion")
    assert _ids_from_query(db_url, "SELECT id FROM _duplicates_goalcompletion ORDER BY id") == [2]


# -- hierarchical reflection scope + promotedquote migration round-trip ------

# down_revision is f7a8b9c0d1e3 (the goalcompletion local_day migration, current head).
_HIER_REFLECTION_BASE_REVISION = "f7a8b9c0d1e3"  # pragma: allowlist secret
_HIER_REFLECTION_REVISION = "c4f7a2b8d9e1"  # pragma: allowlist secret


def _index_names(db_url: str, table: str) -> set[str]:
    """Return the set of index names installed on ``table``."""
    engine = create_engine(_sync_url(db_url))
    try:
        return {ix["name"] for ix in inspect(engine).get_indexes(table) if ix["name"] is not None}
    finally:
        engine.dispose()


def _bootstrap_hier_reflection_baseline(sync_url: str) -> None:
    """Bootstrap minimal ``user`` and ``journalentry`` tables for the round-trip fixture.

    Mirrors the shape just before the hierarchical-reflection migration,
    without pulling in every preceding migration.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
        )
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'hier@example.com')"))
        conn.execute(
            text(
                "CREATE TABLE journalentry ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " sender VARCHAR(10) NOT NULL,"
                " message TEXT NOT NULL,"
                " tag VARCHAR(50) NOT NULL DEFAULT 'freeform',"
                " status VARCHAR(20) NOT NULL DEFAULT 'draft',"
                " title VARCHAR(200),"
                " deleted_at DATETIME,"
                " updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"
                " timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO journalentry (id, user_id, sender, message)"
                " VALUES (1, 1, 'user', 'Pre-hierarchical-reflection entry.')"
            )
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_hier_reflection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite Alembic config positioned just before the hierarchical-reflection migration.

    Bootstraps minimal ``user`` and ``journalentry`` tables and stamps the DB
    at ``f7a8b9c0d1e3`` (the chain head before this migration) so the
    round-trip exercises only the new migration.
    """
    db_path = tmp_path / "hier_reflection_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_hier_reflection_baseline(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _HIER_REFLECTION_BASE_REVISION)
    return cfg


def test_hier_reflection_migration_round_trip_on_sqlite(
    alembic_sqlite_config_hier_reflection: Config,
) -> None:
    """Round-trip the hierarchical-reflection migration.

    Phase 1: upgrade adds journalentry.reflection_level / reflection_scope_key,
    creates the promotedquote table with the expected columns, and installs
    the partial unique index on (user_id, reflection_scope_key).
    Phase 2: downgrade removes the columns, the index, and the table.
    Phase 3: re-upgrade is idempotent.
    """
    cfg = alembic_sqlite_config_hier_reflection
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade adds the journalentry columns and the promotedquote table.
    command.upgrade(cfg, _HIER_REFLECTION_REVISION)
    journal_cols = _columns_of(db_url, "journalentry")
    assert "reflection_level" in journal_cols
    assert "reflection_scope_key" in journal_cols

    assert _table_exists(db_url, "promotedquote")
    quote_cols = _columns_of(db_url, "promotedquote")
    expected_quote_cols = {
        "id",
        "user_id",
        "source_entry_id",
        "anchor_start",
        "anchor_end",
        "anchor_text",
        "included_in_entry_id",
        "created_at",
        "updated_at",
    }
    assert expected_quote_cols.issubset(quote_cols)

    assert "ix_journalentry_user_reflection_scope" in _index_names(db_url, "journalentry")

    # Phase 2: downgrade removes the columns, index, and table.
    command.downgrade(cfg, _HIER_REFLECTION_BASE_REVISION)
    journal_cols_after = _columns_of(db_url, "journalentry")
    assert "reflection_level" not in journal_cols_after
    assert "reflection_scope_key" not in journal_cols_after
    assert not _table_exists(db_url, "promotedquote")

    # Phase 3: re-upgrade is idempotent.
    command.upgrade(cfg, _HIER_REFLECTION_REVISION)
    journal_cols_final = _columns_of(db_url, "journalentry")
    assert "reflection_level" in journal_cols_final
    assert "reflection_scope_key" in journal_cols_final
    assert _table_exists(db_url, "promotedquote")
