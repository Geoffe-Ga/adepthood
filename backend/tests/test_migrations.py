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
import logging
from collections.abc import Iterator
from configparser import RawConfigParser
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from typing import Any, NamedTuple, cast

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from domain.constants import DAYS_PER_WEEK
from domain.reflection_hierarchy import ReflectionLevel, scope_weeks
from services import journal_encryption

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


def _revision_script_files() -> list[Path]:
    """Return every file Alembic will load as a revision script.

    Deliberately wider than ``_migration_files``: Alembic reads *every* ``.py``
    in the versions directory, leading underscore included, so a uniqueness
    check that skipped those would leave a collision hiding in the one shape
    the rest of this module ignores.
    """
    return sorted(MIGRATIONS_DIR.glob("*.py"))


def _declared_revision_id(migration: Path) -> str | None:
    """Return the ``revision`` identifier a script declares, or ``None``.

    The ids are parsed out of the source with ``ast`` rather than imported.
    Importing 80 migration modules to read one string each is slow, and a
    migration module is not inert — importing it runs whatever its authors put
    at module scope.
    """
    for node in ast.parse(migration.read_text()).body:
        if isinstance(node, ast.Assign):
            targets: list[ast.expr] = list(node.targets)
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
        else:
            continue
        for target in targets:
            if (
                isinstance(target, ast.Name)
                and target.id == "revision"
                and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str)
            ):
                return node.value.value
    return None


def test_every_revision_script_declares_a_revision_id() -> None:
    """Keeps the uniqueness check below from passing over nothing.

    ``_declared_revision_id`` is a parser, and a parser that quietly stops
    matching turns the collision test into a check on an empty collection —
    green, and blind. Asserting that every script yields an id makes that
    failure loud here instead of silent there.
    """
    scripts = _revision_script_files()

    assert scripts, f"no revision scripts found under {MIGRATIONS_DIR}"

    undeclared = [path.name for path in scripts if _declared_revision_id(path) is None]

    assert undeclared == [], (
        "these files under migrations/versions declare no ``revision`` id, so Alembic "
        f"cannot load them as revision scripts: {undeclared}"
    )


def test_revision_ids_are_unique() -> None:
    """A reused revision id must fail here, not months later on someone's fresh database.

    Alembic only *warns* about this (``UserWarning: Revision <id> is present
    more than once``) inside an otherwise-green run, so the collision that
    prompted this test was caught by a human happening to read the warnings.
    What it actually costs is a second head: ``alembic upgrade head`` then
    refuses to run for whoever next builds a database from scratch, far from
    the change that caused it.
    """
    by_id: dict[str, list[str]] = {}
    for path in _revision_script_files():
        revision_id = _declared_revision_id(path)
        if revision_id is not None:
            by_id.setdefault(revision_id, []).append(path.name)

    collisions = {revision_id: files for revision_id, files in by_id.items() if len(files) > 1}
    named = "; ".join(
        f"{revision_id} -> {sorted(files)}" for revision_id, files in collisions.items()
    )

    assert collisions == {}, (
        "duplicate Alembic revision ids (each id must name exactly one script; give the "
        f"newer migration a fresh id and re-point anything chained to it): {named}"
    )


def test_the_script_directory_resolves_to_a_single_head() -> None:
    """Two heads are what a duplicate id (or an unmerged branch) actually produces.

    This asks Alembic itself rather than the file contents, so it also catches
    the sibling causes an id check cannot see — two migrations chained off the
    same parent, or a branch merged without a merge migration. It needs no
    database: the head set is derived from the scripts on disk.
    """
    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    heads = ScriptDirectory.from_config(cfg).get_heads()

    assert len(heads) == 1, (
        f"expected exactly one Alembic head, found {len(heads)}: {sorted(heads)} — "
        "`alembic upgrade head` fails on a fresh database in this state; merge the "
        "branches (`alembic merge`) or fix the duplicate revision id that split them"
    )


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


def _check_constraints_of(db_url: str, table: str) -> set[str]:
    """Every named CHECK constraint the table carries, as the database has it."""
    engine = create_engine(_sync_url(db_url))
    try:
        found = inspect(engine).get_check_constraints(table)
        return {str(constraint["name"]) for constraint in found if constraint.get("name")}
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


# -- useruiflags table migration round-trip -----------------------------------

# down_revision is a9b0c1d2e3f4 (the promotedquote.stale migration, current head).
_USER_UI_FLAGS_BASE_REVISION = "a9b0c1d2e3f4"  # pragma: allowlist secret
_USER_UI_FLAGS_REVISION = "b4c5d6e7f8a1"  # pragma: allowlist secret


def _bootstrap_user_table_for_ui_flags(sync_url: str) -> None:
    """Pre-create a minimal ``user`` table with two seeded rows.

    Mirrors the schema the ui-flags migration expects to find at
    ``a9b0c1d2e3f4``. Two rows are seeded to prove the migration performs
    no backfill even though existing users are present.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
        )
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'alice@example.com')"))
        conn.execute(text("INSERT INTO user (id, email) VALUES (2, 'bob@example.com')"))
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_user_ui_flags(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite Alembic config positioned just before the ui-flags migration.

    Bootstraps a minimal ``user`` table with two pre-existing rows and stamps
    the DB at ``a9b0c1d2e3f4`` (the current chain head before this migration)
    so the round-trip exercises only the new migration.
    """
    db_path = tmp_path / "user_ui_flags_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_user_table_for_ui_flags(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _USER_UI_FLAGS_BASE_REVISION)
    return cfg


def _ui_flags_row_count(db_url: str) -> int:
    """Return the number of rows in ``useruiflags``."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            count: int = conn.execute(text("SELECT count(*) FROM useruiflags")).scalar_one()
            return count
    finally:
        engine.dispose()


def _insert_ui_flags_row_with_defaults(db_url: str, user_id: int) -> None:
    """Insert a ``useruiflags`` row naming only ``user_id`` (raises on constraint violation)."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.begin() as conn:
            conn.execute(
                text("INSERT INTO useruiflags (user_id) VALUES (:u)"),
                {"u": user_id},
            )
    finally:
        engine.dispose()


def _ui_flags_row(db_url: str, user_id: int) -> dict[str, Any]:
    """Fetch a single ``useruiflags`` row by ``user_id``."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            row = (
                conn.execute(
                    text(
                        "SELECT user_id, has_seen_welcome, energy_scaffolding_archived"
                        " FROM useruiflags WHERE user_id = :u"
                    ),
                    {"u": user_id},
                )
                .mappings()
                .first()
            )
            assert row is not None
            return dict(row)
    finally:
        engine.dispose()


def test_user_ui_flags_migration_round_trip_on_sqlite(
    alembic_sqlite_config_user_ui_flags: Config,
) -> None:
    """Round-trip the ui-flags migration: upgrade creates an empty table; downgrade drops it.

    Phase 1: upgrade creates ``useruiflags`` with zero rows despite two
    pre-existing users -- the no-backfill design provisions rows only on
    first GET, not via migration.
    Phase 2: an insert naming only ``user_id`` proves both flag columns are
    NOT NULL with a DB-level default of false.
    Phase 3: a second insert for the same ``user_id`` violates the unique
    constraint on that column.
    Phase 4: downgrade drops the table entirely.
    Phase 5: re-upgrade is idempotent -- the table is recreated empty.
    """
    cfg = alembic_sqlite_config_user_ui_flags
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade creates the table with zero rows (no backfill).
    command.upgrade(cfg, _USER_UI_FLAGS_REVISION)
    assert _table_exists(db_url, "useruiflags")
    cols = _columns_of(db_url, "useruiflags")
    assert {
        "id",
        "user_id",
        "has_seen_welcome",
        "energy_scaffolding_archived",
    }.issubset(cols)
    assert _ui_flags_row_count(db_url) == 0, (
        "Existing users must not be backfilled; rows are provisioned on first GET."
    )

    # Phase 2: an insert naming only user_id proves both flags are NOT NULL
    # with a DB-level default of false.
    _insert_ui_flags_row_with_defaults(db_url, user_id=1)
    row = _ui_flags_row(db_url, user_id=1)
    assert bool(row["has_seen_welcome"]) is False
    assert bool(row["energy_scaffolding_archived"]) is False

    # Phase 3: user_id carries a unique constraint -- a second row for the
    # same user is rejected.
    with pytest.raises(IntegrityError):
        _insert_ui_flags_row_with_defaults(db_url, user_id=1)

    # Phase 4: downgrade drops the table entirely.
    command.downgrade(cfg, _USER_UI_FLAGS_BASE_REVISION)
    assert not _table_exists(db_url, "useruiflags")

    # Phase 5: re-upgrade reproduces the empty table (idempotent cycle).
    command.upgrade(cfg, _USER_UI_FLAGS_REVISION)
    assert _table_exists(db_url, "useruiflags")
    assert _ui_flags_row_count(db_url) == 0


# -- course-content seeder-race dedupe + unique indexes ----------------------

# down_revision is b4c5d6e7f8a1 (the useruiflags migration, current head).
_COURSE_DEDUPE_BASE_REVISION = "b4c5d6e7f8a1"  # pragma: allowlist secret
_COURSE_DEDUPE_REVISION = "e8f9a0b1c2d3"  # pragma: allowlist secret


def _bootstrap_course_tables(sync_url: str) -> None:
    """Pre-create minimal course tables mirroring the pre-migration schema."""
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE coursestage ("
                " id INTEGER PRIMARY KEY,"
                " stage_number INTEGER NOT NULL,"
                " title VARCHAR NOT NULL)"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE stagecontent ("
                " id INTEGER PRIMARY KEY,"
                " course_stage_id INTEGER NOT NULL REFERENCES coursestage (id),"
                " title VARCHAR NOT NULL,"
                " content_type VARCHAR NOT NULL,"
                " release_day INTEGER NOT NULL,"
                " url VARCHAR NOT NULL)"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE contentcompletion ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " content_id INTEGER NOT NULL REFERENCES stagecontent (id),"
                " CONSTRAINT uq_contentcompletion_user_content"
                "  UNIQUE (user_id, content_id))"
            )
        )
    engine.dispose()


def _seed_race_duplicates(sync_url: str) -> None:
    """Replay the two-worker boot race: every stage duplicated, content split.

    Mirrors the corruption observed when two uvicorn workers seed a fresh
    database concurrently: stage 1 exists twice (ids 1 and 11); the first id
    owns no content, the second owns two copies of the same chapter.  One
    user read the keeper's copy AND the dupe's copy (the collision case the
    completion re-point must survive), another read only the dupe's copy
    (the plain re-point case).
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO coursestage (id, stage_number, title) VALUES"
                " (1, 1, 'Survival'), (11, 1, 'Survival'),"
                " (2, 2, 'Magick'), (12, 2, 'Magick')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO stagecontent"
                " (id, course_stage_id, title, content_type, release_day, url) VALUES"
                " (101, 11, 'What is Beige?', 'chapter', 0, 'content://s01-c01'),"
                " (102, 11, 'What is Beige?', 'chapter', 0, 'content://s01-c01'),"
                " (103, 11, 'Why Beige Matters', 'chapter', 1, 'content://s01-c02'),"
                " (104, 12, 'What is Purple?', 'chapter', 0, 'content://s02-c01')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO contentcompletion (id, user_id, content_id) VALUES"
                " (1, 1, 101), (2, 1, 102),"  # collision: same user read both copies
                " (3, 2, 102)"  # plain re-point: only the dupe copy read
            )
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_course_dedupe(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """Alembic config over a SQLite DB seeded with race-duplicated course rows."""
    db_path = tmp_path / "course_dedupe_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_course_tables(sync_url)
    _seed_race_duplicates(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _COURSE_DEDUPE_BASE_REVISION)
    return cfg


def _rows(db_url: str, sql: str) -> list[tuple[Any, ...]]:
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            return [tuple(row) for row in conn.execute(text(sql)).all()]
    finally:
        engine.dispose()


def test_course_dedupe_migration_round_trip_on_sqlite(
    alembic_sqlite_config_course_dedupe: Config,
) -> None:
    """The dedupe migration heals race-duplicated course rows and locks the door.

    Phase 1 (upgrade): duplicate CourseStage rows collapse onto the lowest id
    per stage_number, StageContent re-points onto the keeper stage, duplicate
    ``content://`` rows collapse onto the lowest id, ContentCompletion
    re-points without violating its (user_id, content_id) uniqueness, and the
    two unique indexes reject fresh duplicates.
    Phase 2 (downgrade): the indexes drop (dedupe is deliberately one-way).
    Phase 3: re-upgrade on the already-clean DB is a no-op that succeeds.
    """
    cfg = alembic_sqlite_config_course_dedupe
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _COURSE_DEDUPE_REVISION)

    # One CourseStage per stage_number, keeper = lowest id.
    stages = _rows(db_url, "SELECT id, stage_number FROM coursestage ORDER BY stage_number")
    assert stages == [(1, 1), (2, 2)]

    # Content re-pointed onto the keeper stages and deduped by content ref.
    contents = _rows(
        db_url,
        "SELECT id, course_stage_id, url FROM stagecontent ORDER BY id",
    )
    assert contents == [
        (101, 1, "content://s01-c01"),
        (103, 1, "content://s01-c02"),
        (104, 2, "content://s02-c01"),
    ]

    # Read-marks survive: user 1's collision collapsed to one row on the
    # keeper; user 2's mark re-pointed onto the keeper.
    completions = _rows(
        db_url,
        "SELECT user_id, content_id FROM contentcompletion ORDER BY user_id",
    )
    assert completions == [(1, 101), (2, 101)]

    # The unique indexes are installed and enforce.
    assert "ix_coursestage_stage_number_unique" in _index_names(db_url, "coursestage")
    assert "ix_stagecontent_stage_content_ref_unique" in _index_names(db_url, "stagecontent")
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.begin() as conn, pytest.raises(IntegrityError):
            conn.execute(text("INSERT INTO coursestage (stage_number, title) VALUES (1, 'dupe')"))
        with engine.begin() as conn, pytest.raises(IntegrityError):
            conn.execute(
                text(
                    "INSERT INTO stagecontent"
                    " (course_stage_id, title, content_type, release_day, url)"
                    " VALUES (1, 'dupe', 'chapter', 0, 'content://s01-c01')"
                )
            )
    finally:
        engine.dispose()

    # Phase 2: downgrade drops the indexes (rows stay deduped by design).
    command.downgrade(cfg, _COURSE_DEDUPE_BASE_REVISION)
    assert "ix_coursestage_stage_number_unique" not in _index_names(db_url, "coursestage")
    assert "ix_stagecontent_stage_content_ref_unique" not in _index_names(db_url, "stagecontent")

    # Phase 3: re-upgrade on the clean DB succeeds (dedupe CTEs match nothing).
    command.upgrade(cfg, _COURSE_DEDUPE_REVISION)
    assert "ix_coursestage_stage_number_unique" in _index_names(db_url, "coursestage")


# -- backdated journal entry ordering migration round-trip ------------------

# down_revision is e8f9a0b1c2d3 (the course-dedupe migration, current head).
_BACKDATED_ENTRY_BASE_REVISION = "e8f9a0b1c2d3"  # pragma: allowlist secret
_BACKDATED_ENTRY_REVISION = "f8a9b0c1d2e3"  # pragma: allowlist secret


def _bootstrap_backdated_entry_baseline(sync_url: str) -> None:
    """Pre-create minimal ``user`` and ``journalentry`` tables for the round-trip fixture.

    Mirrors the shape just before the backdated-entry-ordering migration.
    Only the columns the new composite index touches (user_id, timestamp, id)
    are required, so the bootstrap stays narrow rather than replaying the
    whole preceding chain.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
        )
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'backdate@example.com')"))
        conn.execute(
            text(
                "CREATE TABLE journalentry ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " sender VARCHAR(10) NOT NULL,"
                " message TEXT NOT NULL,"
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
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_backdated_entry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before ``f8a9b0c1d2e3``.

    Bootstraps minimal ``user`` and ``journalentry`` tables and stamps the DB
    at ``e8f9a0b1c2d3`` (the chain head before this migration) so the
    round-trip exercises only the new migration.
    """
    db_path = tmp_path / "backdated_entry_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_backdated_entry_baseline(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _BACKDATED_ENTRY_BASE_REVISION)
    return cfg


def test_backdated_entry_migration_round_trip_on_sqlite(
    alembic_sqlite_config_backdated_entry: Config,
) -> None:
    """Round-trip ``f8a9b0c1d2e3``: upgrade installs the composite ordering index.

    Phase 1: upgrade adds ``ix_journalentry_user_timestamp_id`` on
    ``(user_id, timestamp, id)`` -- the index the timestamp-DESC/id-DESC list
    ordering relies on.
    Phase 2: downgrade drops it.
    Phase 3: re-upgrade is idempotent.
    """
    cfg = alembic_sqlite_config_backdated_entry
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade installs the composite index.
    command.upgrade(cfg, _BACKDATED_ENTRY_REVISION)
    assert "ix_journalentry_user_timestamp_id" in _index_names(db_url, "journalentry")

    # Phase 2: downgrade removes it.
    command.downgrade(cfg, _BACKDATED_ENTRY_BASE_REVISION)
    assert "ix_journalentry_user_timestamp_id" not in _index_names(db_url, "journalentry")

    # Phase 3: re-upgrade is idempotent.
    command.upgrade(cfg, _BACKDATED_ENTRY_REVISION)
    assert "ix_journalentry_user_timestamp_id" in _index_names(db_url, "journalentry")


# -- Creek Vault write-path vault_ref / vault_tags migration round-trip -----
#
# ``alembic check`` itself only runs against a live Postgres database in the
# ``backend-ci.yml`` migration-drift job (see DEPLOYMENT.md); there is no local
# SQLite-backed unit test for it anywhere in this file. The column-presence
# round-trip below is this suite's equivalent drift guard for the new columns,
# matching every other migration section here.

# down_revision is f8a9b0c1d2e3 (the backdated-entry-ordering migration, current head).
_CREEK_VAULT_WRITE_BASE_REVISION = "f8a9b0c1d2e3"  # pragma: allowlist secret
# The implementer must set this to the real revision ID of the migration they
# author for the Creek Vault write path.
_CREEK_VAULT_WRITE_REVISION = "c7d8e9f0a1b3"  # pragma: allowlist secret


def _bootstrap_creek_vault_write_baseline(sync_url: str) -> None:
    """Pre-create minimal ``user`` and ``journalentry`` tables for the round-trip fixture.

    Mirrors the shape just before the vault-write columns migration. Only the
    columns unrelated to the new ``vault_ref`` / ``vault_tags`` pair are needed,
    so the bootstrap stays narrow rather than replaying the whole preceding chain.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
        )
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'vault@example.com')"))
        conn.execute(
            text(
                "CREATE TABLE journalentry ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " sender VARCHAR(10) NOT NULL,"
                " message TEXT NOT NULL,"
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
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_creek_vault_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before the vault-write columns migration."""
    db_path = tmp_path / "creek_vault_write_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_creek_vault_write_baseline(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _CREEK_VAULT_WRITE_BASE_REVISION)
    return cfg


def _journalentry_ids(db_url: str) -> list[int]:
    """Return every ``journalentry.id`` present, to prove a migration preserves rows."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("SELECT id FROM journalentry")).fetchall()
            return [row[0] for row in rows]
    finally:
        engine.dispose()


def test_creek_vault_write_migration_adds_and_drops_columns(
    alembic_sqlite_config_creek_vault_write: Config,
) -> None:
    """The vault-write migration adds nullable vault_ref/vault_tags; downgrade drops them.

    This test fails with an Alembic ``CommandError`` (unknown revision) until the
    implementer authors the migration and sets ``_CREEK_VAULT_WRITE_REVISION`` to
    its real revision ID -- the correct RED failure mode for a not-yet-written
    migration, matching the placeholder-revision pattern used elsewhere in this
    file for other not-yet-authored migrations.
    """
    cfg = alembic_sqlite_config_creek_vault_write
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade adds both nullable columns; the pre-existing row survives.
    command.upgrade(cfg, _CREEK_VAULT_WRITE_REVISION)
    cols = _columns_of(db_url, "journalentry")
    assert {"vault_ref", "vault_tags"}.issubset(cols)
    assert _journalentry_ids(db_url) == [1]

    # Phase 2: downgrade removes both columns.
    command.downgrade(cfg, _CREEK_VAULT_WRITE_BASE_REVISION)
    cols_after = _columns_of(db_url, "journalentry")
    assert {"vault_ref", "vault_tags"}.isdisjoint(cols_after)

    # Phase 3: re-upgrade is idempotent.
    command.upgrade(cfg, _CREEK_VAULT_WRITE_REVISION)
    cols_again = _columns_of(db_url, "journalentry")
    assert {"vault_ref", "vault_tags"}.issubset(cols_again)


# -- negative-laps 01 habit.is_carryover column round-trip ------------------

# Revision anchors for the ``habit.is_carryover`` migration round-trip. The
# base is the current single head; the implementer sets the second anchor to
# the real revision ID of the migration they author.
_HABIT_CARRYOVER_BASE_REVISION = "d9e0f1a2b3c4"  # pragma: allowlist secret
_HABIT_CARRYOVER_REVISION = "c2d3e4f5a6b7"  # pragma: allowlist secret


def _bootstrap_habit_table(sync_url: str) -> None:
    """Pre-create a minimal ``habit`` table for the round-trip fixture.

    Mirrors the schema in place just before the ``is_carryover`` migration,
    without pulling in every preceding migration. One legacy row is seeded so
    the additive column's backfill-to-default can be observed.
    """
    bootstrap_engine = create_engine(sync_url)
    with bootstrap_engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE habit ("
                " id INTEGER PRIMARY KEY,"
                " name VARCHAR(255) NOT NULL,"
                " icon VARCHAR(100) NOT NULL,"
                " start_date DATE NOT NULL,"
                " energy_cost INTEGER NOT NULL,"
                " energy_return INTEGER NOT NULL,"
                " user_id INTEGER NOT NULL,"
                " milestone_notifications BOOLEAN NOT NULL DEFAULT 0,"
                " sort_order INTEGER,"
                " stage VARCHAR(100) NOT NULL DEFAULT '',"
                " streak INTEGER NOT NULL DEFAULT 0,"
                " revealed BOOLEAN NOT NULL DEFAULT 0"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO habit"
                " (id, name, icon, start_date, energy_cost, energy_return, user_id)"
                " VALUES (1, 'Legacy', '*', '2024-01-01', 1, 2, 1)"
            )
        )
    bootstrap_engine.dispose()


@pytest.fixture
def alembic_sqlite_config_habit_carryover(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before the ``is_carryover`` migration."""
    db_path = tmp_path / "habit_carryover_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_habit_table(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _HABIT_CARRYOVER_BASE_REVISION)
    return cfg


def _habit_row(db_url: str, habit_id: int) -> dict[str, Any]:
    """Fetch a single ``habit`` row including the ``is_carryover`` column."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            row = (
                conn.execute(
                    text("SELECT id, is_carryover FROM habit WHERE id = :id"),
                    {"id": habit_id},
                )
                .mappings()
                .first()
            )
            assert row is not None
            return dict(row)
    finally:
        engine.dispose()


def test_habit_carryover_migration_round_trip_on_sqlite(
    alembic_sqlite_config_habit_carryover: Config,
) -> None:
    """Round-trip ``is_carryover``: upgrade adds the column defaulting False; downgrade drops it.

    Phase 1: upgrade adds ``is_carryover`` NOT NULL and the pre-existing legacy
    row reads back ``False`` (the program-habit default).
    Phase 2: downgrade removes the column.
    Phase 3: re-upgrade is idempotent.
    """
    cfg = alembic_sqlite_config_habit_carryover
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade adds the column; the legacy row defaults to a program habit.
    command.upgrade(cfg, _HABIT_CARRYOVER_REVISION)
    assert "is_carryover" in _columns_of(db_url, "habit")
    assert bool(_habit_row(db_url, habit_id=1)["is_carryover"]) is False

    # Phase 2: downgrade removes the column.
    command.downgrade(cfg, _HABIT_CARRYOVER_BASE_REVISION)
    assert "is_carryover" not in _columns_of(db_url, "habit")

    # Phase 3: re-upgrade reproduces the additive column (idempotent cycle).
    command.upgrade(cfg, _HABIT_CARRYOVER_REVISION)
    assert "is_carryover" in _columns_of(db_url, "habit")
    assert bool(_habit_row(db_url, habit_id=1)["is_carryover"]) is False


# -- cross-tenant reference quarantine + detach -----------------------------
#
# Two body-parameter authorisation holes (``PUT /goals/{id}`` accepting a
# ``goal_group_id`` it never authorised, and ``POST /journal/`` accepting an
# unauthorised ``user_practice_id`` / ``practice_session_id``) let a caller
# file their own row against another tenant's object.  Both write paths are
# now guarded, but rows forged before the guards landed are still in the
# database.  This migration finds them, records them, and detaches them --
# it never deletes a user's row.

# The base is the current single head; the second anchor is the revision ID
# of the remediation migration the implementer authors.
_CROSS_TENANT_BASE_REVISION = "b0c1d2e3f4a5"  # pragma: allowlist secret
_CROSS_TENANT_REVISION = "c1d2e3f4a5b7"  # pragma: allowlist secret

# Forensic side-table: one row per reference the migration detaches, so every
# nulled link stays reconstructible by hand afterwards.
_QUARANTINE_TABLE = "_quarantine_cross_tenant_reference"

# ``detected_at`` is deliberately absent from the projection -- it is a
# wall-clock stamp no assertion can pin -- but naming the other seven columns
# in declaration order pins both their names and their order.
_QUARANTINE_PROJECTION = (
    "SELECT source_table, source_row_id, source_column, planted_value,"
    " owner_user_id, referenced_owner_user_id, reason"
    " FROM _quarantine_cross_tenant_reference"
)

_QUARANTINE_COLUMNS = {
    "source_table",
    "source_row_id",
    "source_column",
    "planted_value",
    "owner_user_id",
    "referenced_owner_user_id",
    "reason",
    "detected_at",
}

# An id no seeded row uses, so the reference genuinely resolves to nothing.
# The seed statements below spell it literally rather than interpolating it,
# because building SQL by string formatting is exactly the pattern the lint
# rules (rightly) refuse; keep the two in step by hand.
_MISSING_REFERENCE_ID = 999_999

# Every planted reference, as ``(source_table, source_row_id, source_column,
# planted_value, owner_user_id, referenced_owner_user_id, reason)``.  Owner
# ids come from the *referencing* row's owner (habit.user_id for a goal,
# journalentry.user_id for an entry); ``referenced_owner_user_id`` is NULL
# when the target is ownerless or absent.
_EXPECTED_QUARANTINE_ROWS: list[tuple[Any, ...]] = [
    ("goal", 3, "goal_group_id", 2, 1, 2, "foreign_owner"),
    ("goal", 4, "goal_group_id", 3, 2, None, "shared_template"),
    ("goal", 5, "goal_group_id", _MISSING_REFERENCE_ID, 1, None, "dangling"),
    ("journalentry", 2, "user_practice_id", 2, 1, 2, "foreign_owner"),
    ("journalentry", 3, "practice_session_id", 2, 1, 2, "foreign_owner"),
    ("journalentry", 4, "user_practice_id", _MISSING_REFERENCE_ID, 1, None, "dangling"),
]

# Post-remediation link state.  Goal 1 and journal entry 1 are the legitimate
# controls: their references point at objects their own owner owns, so they
# must survive untouched while every neighbouring forged link goes NULL.
_EXPECTED_GOAL_LINKS: list[tuple[Any, ...]] = [
    (1, 1),
    (2, None),
    (3, None),
    (4, None),
    (5, None),
]
_EXPECTED_JOURNAL_LINKS: list[tuple[Any, ...]] = [
    (1, 1, 1),
    (2, None, None),
    (3, None, None),
    (4, None, None),
    (5, None, None),
]


def _bootstrap_cross_tenant_tables(sync_url: str) -> None:
    """Pre-create the minimal tables the cross-tenant remediation touches.

    Only the columns the migration reads or writes are declared.  The
    foreign keys are omitted on purpose: SQLite would not enforce them here
    anyway, and their absence is what lets the fixture seed a genuinely
    dangling reference for the ``dangling`` classification branch.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text('CREATE TABLE "user" ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)')
        )
        conn.execute(
            text(
                "CREATE TABLE habit ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " name VARCHAR(255) NOT NULL)"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE goalgroup ("
                " id INTEGER PRIMARY KEY,"
                " name VARCHAR(255) NOT NULL,"
                " user_id INTEGER,"
                " shared_template BOOLEAN NOT NULL DEFAULT 0)"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE goal ("
                " id INTEGER PRIMARY KEY,"
                " habit_id INTEGER NOT NULL,"
                " title VARCHAR(255) NOT NULL,"
                " goal_group_id INTEGER)"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE userpractice ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " practice_id INTEGER NOT NULL,"
                " stage_number INTEGER NOT NULL,"
                " start_date DATE NOT NULL)"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE practicesession ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " user_practice_id INTEGER NOT NULL,"
                " duration_minutes FLOAT NOT NULL)"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE journalentry ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " sender VARCHAR(10) NOT NULL,"
                " message TEXT NOT NULL,"
                " user_practice_id INTEGER,"
                " practice_session_id INTEGER)"
            )
        )
    engine.dispose()


def _seed_cross_tenant_fixtures(sync_url: str) -> None:
    """Seed every violation shape alongside a legitimate control for each.

    User 1 is the attacker in the goal/journal cases and the victim in the
    goal-group case; user 2 owns the objects that were written into.  Goals 1
    and 2 and journal entries 1 and 5 are the controls -- same-owner or NULL
    references that must come through the migration unchanged.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text(
                'INSERT INTO "user" (id, email) VALUES'
                " (1, 'owner@example.com'), (2, 'other@example.com')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO habit (id, user_id, name) VALUES"
                " (1, 1, 'Owner Habit'), (2, 2, 'Other Habit')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO goalgroup (id, name, user_id, shared_template) VALUES"
                " (1, 'Owner Group', 1, 0),"
                " (2, 'Other Private Group', 2, 0),"
                " (3, 'Community Template', NULL, 1)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO goal (id, habit_id, title, goal_group_id) VALUES"
                " (1, 1, 'Filed under its own owner group', 1),"
                " (2, 1, 'Filed under no group at all', NULL),"
                " (3, 1, 'Planted into the other tenant private group', 2),"
                " (4, 2, 'Parked in an ownerless shared template', 3),"
                " (5, 1, 'Points at a group that does not exist', 999999)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO userpractice"
                " (id, user_id, practice_id, stage_number, start_date) VALUES"
                " (1, 1, 1, 1, '2024-01-01'), (2, 2, 1, 1, '2024-01-01')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO practicesession"
                " (id, user_id, user_practice_id, duration_minutes) VALUES"
                " (1, 1, 1, 10.0), (2, 2, 2, 10.0)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO journalentry"
                " (id, user_id, sender, message, user_practice_id, practice_session_id) VALUES"
                " (1, 1, 'user', 'Own practice and own session.', 1, 1),"
                " (2, 1, 'user', 'Planted onto the other tenant practice.', 2, NULL),"
                " (3, 1, 'user', 'Planted onto the other tenant session.', NULL, 2),"
                " (4, 1, 'user', 'Points at a practice that does not exist.', 999999, NULL),"
                " (5, 1, 'user', 'Carries no practice link at all.', NULL, NULL)"
            )
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_cross_tenant(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config seeded with forged cross-tenant references."""
    db_path = tmp_path / "cross_tenant_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_cross_tenant_tables(sync_url)
    _seed_cross_tenant_fixtures(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _CROSS_TENANT_BASE_REVISION)
    return cfg


def _quarantine_rows(db_url: str) -> list[tuple[Any, ...]]:
    """Return every quarantine row in declaration order, sorted deterministically.

    ``(source_table, source_row_id, source_column)`` identifies a quarantined
    reference uniquely, so sorting on it never has to compare the nullable
    owner columns.
    """
    return sorted(
        _rows(db_url, _QUARANTINE_PROJECTION),
        key=lambda row: (str(row[0]), int(row[1]), str(row[2])),
    )


def _goal_group_links(db_url: str) -> list[tuple[Any, ...]]:
    """Return ``(id, goal_group_id)`` for every goal, ordered by id."""
    return _rows(db_url, "SELECT id, goal_group_id FROM goal ORDER BY id")


def _journal_practice_links(db_url: str) -> list[tuple[Any, ...]]:
    """Return ``(id, user_practice_id, practice_session_id)`` per entry, ordered by id."""
    return _rows(
        db_url,
        "SELECT id, user_practice_id, practice_session_id FROM journalentry ORDER BY id",
    )


def test_cross_tenant_quarantine_migration_detaches_and_records_on_sqlite(
    alembic_sqlite_config_cross_tenant: Config,
) -> None:
    """Upgrade detaches every forged reference and records it, deleting nothing.

    Each planted reference is nulled in place, each legitimate reference is
    left alone, no ``goal`` or ``journalentry`` row disappears, and the
    quarantine table holds exactly one correctly-classified row per detached
    reference -- ``dangling`` when the target is absent, ``shared_template``
    when it is ownerless, ``foreign_owner`` when it belongs to someone else.
    """
    cfg = alembic_sqlite_config_cross_tenant
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _CROSS_TENANT_REVISION)

    assert _goal_group_links(db_url) == _EXPECTED_GOAL_LINKS
    assert _journal_practice_links(db_url) == _EXPECTED_JOURNAL_LINKS

    # Remediation is detach-only: not one row is deleted.
    assert _ids_from_query(db_url, "SELECT id FROM goal ORDER BY id") == [1, 2, 3, 4, 5]
    assert _ids_from_query(db_url, "SELECT id FROM journalentry ORDER BY id") == [1, 2, 3, 4, 5]

    assert _table_exists(db_url, _QUARANTINE_TABLE)
    assert _columns_of(db_url, _QUARANTINE_TABLE) == _QUARANTINE_COLUMNS
    assert _quarantine_rows(db_url) == _EXPECTED_QUARANTINE_ROWS


def test_cross_tenant_quarantine_migration_leaves_same_owner_references_intact_on_sqlite(
    alembic_sqlite_config_cross_tenant: Config,
) -> None:
    """A reference to an object its own owner owns is never quarantined.

    The migration runs over a table that also holds forged references, so
    this pins that the predicate discriminates by owner rather than sweeping
    every non-null reference in the table.
    """
    cfg = alembic_sqlite_config_cross_tenant
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _CROSS_TENANT_REVISION)

    assert _rows(db_url, "SELECT goal_group_id FROM goal WHERE id = 1") == [(1,)]
    assert _rows(
        db_url,
        "SELECT user_practice_id, practice_session_id FROM journalentry WHERE id = 1",
    ) == [(1, 1)]

    quarantined = {(row[0], row[1]) for row in _quarantine_rows(db_url)}
    assert ("goal", 1) not in quarantined
    assert ("journalentry", 1) not in quarantined
    assert ("goal", 2) not in quarantined, "a NULL reference is not a cross-tenant reference"
    assert ("journalentry", 5) not in quarantined


def test_cross_tenant_quarantine_migration_is_idempotent_on_sqlite(
    alembic_sqlite_config_cross_tenant: Config,
) -> None:
    """Downgrade is deliberately one-way and re-upgrade adds no duplicate rows.

    Phase 1 upgrades and snapshots the quarantine.  Phase 2 downgrades to the
    base revision: the forensic record and the detached NULLs both survive,
    because re-planting a reference into another tenant's object would
    re-open the very hole the migration closed.  Phase 3 re-upgrades onto the
    already-clean database and finds nothing new to quarantine.
    """
    cfg = alembic_sqlite_config_cross_tenant
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _CROSS_TENANT_REVISION)
    snapshot = _quarantine_rows(db_url)
    assert snapshot == _EXPECTED_QUARANTINE_ROWS

    # Phase 2: the downgrade neither drops the evidence nor re-plants a link.
    command.downgrade(cfg, _CROSS_TENANT_BASE_REVISION)
    assert _table_exists(db_url, _QUARANTINE_TABLE)
    assert _quarantine_rows(db_url) == snapshot
    assert _goal_group_links(db_url) == _EXPECTED_GOAL_LINKS
    assert _journal_practice_links(db_url) == _EXPECTED_JOURNAL_LINKS

    # Phase 3: re-upgrade is a no-op -- nothing violates the invariant now.
    command.upgrade(cfg, _CROSS_TENANT_REVISION)
    assert _quarantine_rows(db_url) == snapshot
    assert _goal_group_links(db_url) == _EXPECTED_GOAL_LINKS
    assert _journal_practice_links(db_url) == _EXPECTED_JOURNAL_LINKS


# -- d4e5f6a7b8ca: encrypt every remaining journal-text column ---------------

_JOURNAL_TEXT_BASE_REVISION = "c3d4e5f6a7b9"  # pragma: allowlist secret
_JOURNAL_TEXT_REVISION = "d4e5f6a7b8ca"  # pragma: allowlist secret

# The marker real ciphertext carries, spelled out so the round-trip pins the
# on-disk format rather than trusting the helper that produced it.
_CIPHERTEXT_MARKER = "enc::v1::"

# The plaintext seeded before the upgrade, per ``table.column``. Every value is
# recognisable prose, so a mangled downgrade cannot pass as a near-miss.
_SEEDED_JOURNAL_TEXT: dict[str, str] = {
    "journalentry.title": "What I could not say out loud",
    "marginalia.anchor_text": "the willow bending without breaking",
    "marginalia.note": "A recurring image of yielding strength.",
    "marginalia.essay": "The willow is this entry's whole argument, in one plant.",
    "completionsuggestion.label": "I walked the long way home",
    "completionsuggestion.anchor_text": "I walked the long way home",
    "promptresponse.response": "The week I stopped pretending it was fine.",
}


def _bootstrap_journal_text_tables(sync_url: str) -> None:
    """Pre-create the four tables the encryption migration rewrites.

    Each carries one row with plaintext in every target column, plus a second
    row leaving the nullable columns NULL, so both branches of the transform are
    observed. FKs are omitted deliberately: the migration touches only these
    columns, and SQLite does not enforce them anyway.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE journalentry ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " sender VARCHAR(10) NOT NULL,"
                " message TEXT NOT NULL,"
                " title VARCHAR(200)"
                ")"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE marginalia ("
                " id INTEGER PRIMARY KEY,"
                " journal_entry_id INTEGER NOT NULL,"
                " user_id INTEGER NOT NULL,"
                " kind VARCHAR(20) NOT NULL,"
                " anchor_start INTEGER NOT NULL,"
                " anchor_end INTEGER NOT NULL,"
                " anchor_text VARCHAR(280) NOT NULL,"
                " note VARCHAR(600) NOT NULL,"
                " essay VARCHAR(10000)"
                ")"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE completionsuggestion ("
                " id INTEGER PRIMARY KEY,"
                " journal_entry_id INTEGER NOT NULL,"
                " user_id INTEGER NOT NULL,"
                " target_type VARCHAR(20) NOT NULL,"
                " label VARCHAR(255) NOT NULL,"
                " anchor_start INTEGER NOT NULL,"
                " anchor_end INTEGER NOT NULL,"
                " anchor_text VARCHAR(280) NOT NULL"
                ")"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE promptresponse ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " week_number INTEGER NOT NULL,"
                " question VARCHAR(1000) NOT NULL,"
                " response VARCHAR(10000) NOT NULL"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO journalentry (id, user_id, sender, message, title)"
                " VALUES (1, 1, 'user', 'a page of thoughts', :title)"
            ),
            {"title": _SEEDED_JOURNAL_TEXT["journalentry.title"]},
        )
        conn.execute(
            text(
                "INSERT INTO promptresponse (id, user_id, week_number, question, response)"
                " VALUES (1, 1, 1, 'What is alive in you this week?', :response)"
            ),
            {"response": _SEEDED_JOURNAL_TEXT["promptresponse.response"]},
        )
        conn.execute(
            text(
                "INSERT INTO journalentry (id, user_id, sender, message, title)"
                " VALUES (2, 1, 'user', 'an untitled page', NULL)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO marginalia"
                " (id, journal_entry_id, user_id, kind, anchor_start, anchor_end,"
                "  anchor_text, note, essay)"
                " VALUES (1, 1, 1, 'symbol', 11, 45, :anchor, :note, :essay)"
            ),
            {
                "anchor": _SEEDED_JOURNAL_TEXT["marginalia.anchor_text"],
                "note": _SEEDED_JOURNAL_TEXT["marginalia.note"],
                "essay": _SEEDED_JOURNAL_TEXT["marginalia.essay"],
            },
        )
        conn.execute(
            text(
                "INSERT INTO marginalia"
                " (id, journal_entry_id, user_id, kind, anchor_start, anchor_end,"
                "  anchor_text, note, essay)"
                " VALUES (2, 1, 1, 'theme', 0, 6, :anchor, :note, NULL)"
            ),
            {
                "anchor": _SEEDED_JOURNAL_TEXT["marginalia.anchor_text"],
                "note": _SEEDED_JOURNAL_TEXT["marginalia.note"],
            },
        )
        conn.execute(
            text(
                "INSERT INTO completionsuggestion"
                " (id, journal_entry_id, user_id, target_type, label,"
                "  anchor_start, anchor_end, anchor_text)"
                " VALUES (1, 1, 1, 'habit', :label, 0, 26, :anchor)"
            ),
            {
                "label": _SEEDED_JOURNAL_TEXT["completionsuggestion.label"],
                "anchor": _SEEDED_JOURNAL_TEXT["completionsuggestion.anchor_text"],
            },
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_journal_text(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[Config]:
    """Stamped SQLite config just before ``d4e5f6a7b8ca``, with a real key set.

    A key must be configured or the encrypt/decrypt helpers are passthroughs and
    the round-trip would prove nothing. The registry is process-cached, so it is
    reset on both sides of the test.
    """
    db_path = tmp_path / "journal_text_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    monkeypatch.setenv(journal_encryption.KEYS_ENV_VAR, Fernet.generate_key().decode())
    journal_encryption.reset_cache()

    _bootstrap_journal_text_tables(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _JOURNAL_TEXT_BASE_REVISION)
    yield cfg
    journal_encryption.reset_cache()


def _stored_journal_text(db_url: str) -> dict[str, str]:
    """Read every migrated column of the seeded rows with raw SQL, no ORM."""
    engine = create_engine(_sync_url(db_url))
    queries = {
        "journalentry.title": "SELECT title FROM journalentry WHERE id = 1",
        "marginalia.anchor_text": "SELECT anchor_text FROM marginalia WHERE id = 1",
        "marginalia.note": "SELECT note FROM marginalia WHERE id = 1",
        "marginalia.essay": "SELECT essay FROM marginalia WHERE id = 1",
        "completionsuggestion.label": "SELECT label FROM completionsuggestion WHERE id = 1",
        "completionsuggestion.anchor_text": (
            "SELECT anchor_text FROM completionsuggestion WHERE id = 1"
        ),
        "promptresponse.response": "SELECT response FROM promptresponse WHERE id = 1",
    }
    try:
        with engine.connect() as conn:
            return {name: conn.execute(text(sql)).scalar_one() for name, sql in queries.items()}
    finally:
        engine.dispose()


def _nullable_journal_text_nulls(db_url: str) -> list[Any]:
    """The nullable migrated columns of the rows that left them NULL."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            return [
                conn.execute(text("SELECT title FROM journalentry WHERE id = 2")).scalar_one(),
                conn.execute(text("SELECT essay FROM marginalia WHERE id = 2")).scalar_one(),
            ]
    finally:
        engine.dispose()


def test_journal_text_encryption_migration_round_trips_on_real_rows(
    alembic_sqlite_config_journal_text: Config,
) -> None:
    """Round-trip ``d4e5f6a7b8ca`` on seeded data, not on an empty table.

    Phase 1: upgrade rewrites every seeded plaintext into marked ciphertext that
    decrypts back to exactly what was written.
    Phase 2: downgrade restores the plaintext verbatim -- the property that makes
    the rollback survivable. A downgrade that left the ciphertext in place, or
    truncated it into the restored ``String`` bound, fails here.
    Phase 3: re-upgrade is idempotent and does not double-encrypt.
    """
    cfg = alembic_sqlite_config_journal_text
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade encrypts every seeded row in place.
    command.upgrade(cfg, _JOURNAL_TEXT_REVISION)
    encrypted = _stored_journal_text(db_url)
    for name, plaintext in _SEEDED_JOURNAL_TEXT.items():
        stored = encrypted[name]
        assert stored.startswith(_CIPHERTEXT_MARKER), f"{name} was left in the clear"
        assert plaintext not in stored, f"{name} still leaks its plaintext"
        assert journal_encryption.decrypt(stored) == plaintext
    assert _nullable_journal_text_nulls(db_url) == [None, None]

    # Phase 2: downgrade returns the plaintext, not mangled ciphertext.
    command.downgrade(cfg, _JOURNAL_TEXT_BASE_REVISION)
    assert _stored_journal_text(db_url) == _SEEDED_JOURNAL_TEXT
    assert _nullable_journal_text_nulls(db_url) == [None, None]

    # Phase 3: re-upgrade encrypts once more, decrypting to the same plaintext
    # (a double-encrypted value would decrypt to a marked token, not prose).
    command.upgrade(cfg, _JOURNAL_TEXT_REVISION)
    re_encrypted = _stored_journal_text(db_url)
    for name, plaintext in _SEEDED_JOURNAL_TEXT.items():
        assert journal_encryption.decrypt(re_encrypted[name]) == plaintext


def test_journal_text_encryption_migration_is_a_no_op_without_a_key(
    alembic_sqlite_config_journal_text: Config,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """On an un-keyed environment the rows are untouched, not blanked or marked.

    Key presence is the switch, so a laptop or a CI run with no key must come
    through the migration with its text exactly as it was -- the property that
    lets this migration ship ahead of the key.
    """
    cfg = alembic_sqlite_config_journal_text
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    monkeypatch.delenv(journal_encryption.KEYS_ENV_VAR, raising=False)
    journal_encryption.reset_cache()

    command.upgrade(cfg, _JOURNAL_TEXT_REVISION)
    assert _stored_journal_text(db_url) == _SEEDED_JOURNAL_TEXT

    command.downgrade(cfg, _JOURNAL_TEXT_BASE_REVISION)
    assert _stored_journal_text(db_url) == _SEEDED_JOURNAL_TEXT


# -- a6b7c8d9e0f2: encrypt the prose written in a practice session -----------

_SESSION_PROSE_BASE_REVISION = "b5f1a2c3d4e6"  # pragma: allowlist secret
_SESSION_PROSE_REVISION = "a6b7c8d9e0f2"  # pragma: allowlist secret

# The plaintext seeded before the upgrade, per ``table.column``. Recognisable
# prose, so a mangled downgrade cannot pass itself off as a near-miss, and long
# enough that a ciphertext truncated back into the old ``VARCHAR`` bound would
# come back short rather than come back wrong.
_SEEDED_SESSION_PROSE: dict[str, str] = {
    "practicesession.reflection": (
        "Twenty minutes in, the grief I had been outrunning sat down beside me."
    ),
    "practicesession.insight": "It is not the silence I am afraid of, it is what it keeps saying.",
}

# Read back with raw SQL, never the ORM: an ``EncryptedString`` round-trip is
# identical whether or not the bytes underneath were ever encrypted.
_SESSION_PROSE_READS: dict[str, str] = {
    "practicesession.reflection": "SELECT reflection FROM practicesession WHERE id = 1",
    "practicesession.insight": "SELECT insight FROM practicesession WHERE id = 1",
}


def _bootstrap_practice_session_table(sync_url: str) -> None:
    """Pre-create ``practicesession`` with the bounded columns the migration widens.

    Two rows: one with prose in both columns, one logged without any, so both
    branches of the transform are observed. FKs are omitted deliberately -- the
    migration touches only these two columns, and SQLite does not enforce them.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE practicesession ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " user_practice_id INTEGER NOT NULL,"
                " duration_minutes FLOAT NOT NULL,"
                " timestamp DATETIME NOT NULL,"
                " reflection VARCHAR(5000),"
                " mode VARCHAR(32) NOT NULL,"
                " completed BOOLEAN NOT NULL,"
                " insight VARCHAR(2000)"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO practicesession"
                " (id, user_id, user_practice_id, duration_minutes, timestamp,"
                "  reflection, mode, completed, insight)"
                " VALUES (1, 1, 1, 20.0, '2025-01-01 08:00:00',"
                "  :reflection, 'meditation_timer', 1, :insight)"
            ),
            {
                "reflection": _SEEDED_SESSION_PROSE["practicesession.reflection"],
                "insight": _SEEDED_SESSION_PROSE["practicesession.insight"],
            },
        )
        conn.execute(
            text(
                "INSERT INTO practicesession"
                " (id, user_id, user_practice_id, duration_minutes, timestamp,"
                "  reflection, mode, completed, insight)"
                " VALUES (2, 1, 1, 20.0, '2025-01-02 08:00:00',"
                "  NULL, 'meditation_timer', 1, NULL)"
            )
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_session_prose(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[Config]:
    """Stamped SQLite config just before ``a6b7c8d9e0f2``, with a real key set.

    A key must be configured or the encrypt/decrypt helpers are passthroughs and
    the round-trip would prove nothing. The registry is process-cached, so it is
    reset on both sides of the test.
    """
    db_path = tmp_path / "session_prose_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    monkeypatch.setenv(journal_encryption.KEYS_ENV_VAR, Fernet.generate_key().decode())
    journal_encryption.reset_cache()

    _bootstrap_practice_session_table(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _SESSION_PROSE_BASE_REVISION)
    yield cfg
    journal_encryption.reset_cache()


def _stored_session_prose(db_url: str) -> dict[str, str]:
    """Read both migrated columns of the seeded row with raw SQL, no ORM."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            return {
                name: conn.execute(text(sql)).scalar_one()
                for name, sql in _SESSION_PROSE_READS.items()
            }
    finally:
        engine.dispose()


def _session_prose_nulls(db_url: str) -> list[Any]:
    """Both migrated columns of the session logged without anything written."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            return [
                conn.execute(
                    text("SELECT reflection FROM practicesession WHERE id = 2")
                ).scalar_one(),
                conn.execute(text("SELECT insight FROM practicesession WHERE id = 2")).scalar_one(),
            ]
    finally:
        engine.dispose()


def test_session_prose_encryption_migration_round_trips_on_real_rows(
    alembic_sqlite_config_session_prose: Config,
) -> None:
    """Round-trip ``a6b7c8d9e0f2`` on a seeded row, not on an empty table.

    Phase 1: upgrade rewrites the seeded plaintext into marked ciphertext that
    decrypts back to exactly what was written.
    Phase 2: downgrade restores the plaintext verbatim -- the property that makes
    the rollback survivable. A downgrade that left the ciphertext sitting in a
    plaintext column would be data loss dressed as a rollback, and fails here.
    Phase 3: re-upgrade is idempotent and does not double-encrypt.
    """
    cfg = alembic_sqlite_config_session_prose
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade encrypts the seeded row in place.
    command.upgrade(cfg, _SESSION_PROSE_REVISION)
    encrypted = _stored_session_prose(db_url)
    for name, plaintext in _SEEDED_SESSION_PROSE.items():
        stored = encrypted[name]
        assert stored.startswith(_CIPHERTEXT_MARKER), f"{name} was left in the clear"
        assert plaintext not in stored, f"{name} still leaks its plaintext"
        assert journal_encryption.decrypt(stored) == plaintext
    assert _session_prose_nulls(db_url) == [None, None]

    # Phase 2: downgrade returns the plaintext, not mangled ciphertext.
    command.downgrade(cfg, _SESSION_PROSE_BASE_REVISION)
    assert _stored_session_prose(db_url) == _SEEDED_SESSION_PROSE
    assert _session_prose_nulls(db_url) == [None, None]

    # Phase 3: re-upgrade encrypts once more, decrypting to the same plaintext
    # (a double-encrypted value would decrypt to a marked token, not prose).
    command.upgrade(cfg, _SESSION_PROSE_REVISION)
    re_encrypted = _stored_session_prose(db_url)
    for name, plaintext in _SEEDED_SESSION_PROSE.items():
        assert journal_encryption.decrypt(re_encrypted[name]) == plaintext


def test_session_prose_encryption_migration_is_a_no_op_without_a_key(
    alembic_sqlite_config_session_prose: Config,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """On an un-keyed environment the rows are untouched, not blanked or marked.

    Key presence is the switch, so a laptop or a CI run with no key must come
    through the migration with its text exactly as it was -- the property that
    lets this migration ship ahead of the key.
    """
    cfg = alembic_sqlite_config_session_prose
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    monkeypatch.delenv(journal_encryption.KEYS_ENV_VAR, raising=False)
    journal_encryption.reset_cache()

    command.upgrade(cfg, _SESSION_PROSE_REVISION)
    assert _stored_session_prose(db_url) == _SEEDED_SESSION_PROSE

    command.downgrade(cfg, _SESSION_PROSE_BASE_REVISION)
    assert _stored_session_prose(db_url) == _SEEDED_SESSION_PROSE


# -- 4e1a9c72bd60: the sweep log arrives and the grant's own count leaves ----

# The consent event carried ``fragments_added``, one number per decision, while
# a repeated yes runs the sweep again without appending a decision. The sweep
# log is the table that can hold one row per sweep; this migration adds it and
# retires the column it replaces.
_CORPUS_SWEEP_BASE_REVISION = "b1c2d3e4f5a7"  # pragma: allowlist secret
_CORPUS_SWEEP_REVISION = "4e1a9c72bd60"  # pragma: allowlist secret

# The CHECK that made the retired count a count. The downgrade has to bring it
# back with the column: a restore that returns the column alone would leave the
# consent log accepting a negative number of fragments.
_CONSENT_ADDED_CHECK = "ck_corpusconsentevent_fragments_added_range"

# Every column ``corpussweep`` is expected to carry, and no others.
_CORPUS_SWEEP_COLUMNS = {
    "id",
    "user_id",
    "consent_event_id",
    "entries_considered",
    "fragments_added",
    "entries_remaining",
    "swept_at",
}


def _bootstrap_corpus_consent_baseline(sync_url: str) -> None:
    """Pre-create ``user`` and ``corpusconsentevent`` as they stand at the baseline.

    The consent table is reproduced with its CHECK constraints because the
    migration has to remove one of them, and a table rebuilt from a definition
    that never had it would prove nothing about the migration that does. One
    decision row is seeded so the sweep log's foreign key has something real to
    name.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
        )
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'alice@example.com')"))
        conn.execute(
            text(
                "CREATE TABLE corpusconsentevent ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL REFERENCES user (id) ON DELETE CASCADE,"
                " source VARCHAR(20) NOT NULL,"
                " decision VARCHAR(20) NOT NULL,"
                " fragments_removed INTEGER NOT NULL,"
                " fragments_added INTEGER NOT NULL,"
                " recorded_at DATETIME NOT NULL,"
                " CONSTRAINT ck_corpusconsentevent_source_valid"
                "  CHECK (source IN ('journal', 'upload', 'import')),"
                " CONSTRAINT ck_corpusconsentevent_decision_valid"
                "  CHECK (decision IN ('granted', 'revoked')),"
                " CONSTRAINT ck_corpusconsentevent_fragments_removed_range"
                "  CHECK (fragments_removed >= 0),"
                " CONSTRAINT ck_corpusconsentevent_fragments_added_range"
                "  CHECK (fragments_added >= 0)"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO corpusconsentevent"
                " (id, user_id, source, decision, fragments_removed, fragments_added, recorded_at)"
                " VALUES (1, 1, 'journal', 'granted', 0, 0, CURRENT_TIMESTAMP)"
            )
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_corpus_sweep(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before ``4e1a9c72bd60``."""
    db_path = tmp_path / "corpus_sweep_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_corpus_consent_baseline(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _CORPUS_SWEEP_BASE_REVISION)
    return cfg


def test_corpus_sweep_migration_round_trips_on_sqlite(
    alembic_sqlite_config_corpus_sweep: Config,
) -> None:
    """Round-trip ``4e1a9c72bd60``: the sweep log arrives, the grant's count leaves.

    Phase 1: upgrade creates ``corpussweep`` with exactly its seven columns and
    drops ``corpusconsentevent.fragments_added``, whose one meaning the new
    table now carries per sweep rather than per decision.
    Phase 2: downgrade drops the table and puts the column and its CHECK back,
    so a deploy that has to go back finds the column shaped as it was -- its
    values zeroed rather than restored, which the migration says plainly.
    Phase 3: re-upgrade is idempotent.
    """
    cfg = alembic_sqlite_config_corpus_sweep
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade adds the sweep log and retires the column it replaces.
    command.upgrade(cfg, _CORPUS_SWEEP_REVISION)
    assert _table_exists(db_url, "corpussweep")
    assert _columns_of(db_url, "corpussweep") == _CORPUS_SWEEP_COLUMNS
    assert "fragments_added" not in _columns_of(db_url, "corpusconsentevent")

    # Phase 2: downgrade restores exactly what the upgrade changed -- the
    # column and the CHECK that made it a count, not the column alone.
    command.downgrade(cfg, _CORPUS_SWEEP_BASE_REVISION)
    assert not _table_exists(db_url, "corpussweep")
    assert "fragments_added" in _columns_of(db_url, "corpusconsentevent")
    assert _CONSENT_ADDED_CHECK in _check_constraints_of(db_url, "corpusconsentevent")

    # Phase 3: re-upgrade is idempotent.
    command.upgrade(cfg, _CORPUS_SWEEP_REVISION)
    assert _table_exists(db_url, "corpussweep")
    assert "fragments_added" not in _columns_of(db_url, "corpusconsentevent")


# -- habit.auto_revealed_at one-shot marker -------------------------------

_HABIT_AUTO_REVEAL_BASE_REVISION = "e9a4c6d8f0b2"  # pragma: allowlist secret
_HABIT_AUTO_REVEAL_REVISION = "f2c7a1d9e4b6"  # pragma: allowlist secret


def _bootstrap_habit_auto_reveal_baseline(sync_url: str) -> None:
    """Create the current habit shape without the new one-shot marker."""
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE habit ( id INTEGER PRIMARY KEY, revealed BOOLEAN NOT NULL DEFAULT 0)"
            )
        )
        conn.execute(text("INSERT INTO habit (id, revealed) VALUES (1, 0), (2, 1)"))
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_habit_auto_reveal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config immediately before the marker migration."""
    db_path = tmp_path / "habit_auto_reveal_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    _bootstrap_habit_auto_reveal_baseline(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _HABIT_AUTO_REVEAL_BASE_REVISION)
    return cfg


def _habit_auto_reveal_rows(db_url: str) -> list[tuple[int, Any, Any]]:
    """Return both baseline rows without involving the ORM model."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            return list(
                conn.execute(
                    text("SELECT id, revealed, auto_revealed_at FROM habit ORDER BY id")
                ).tuples()
            )
    finally:
        engine.dispose()


def test_habit_auto_reveal_marker_migration_round_trips_on_sqlite(
    alembic_sqlite_config_habit_auto_reveal: Config,
) -> None:
    """The nullable marker arrives without consuming any existing invitation."""
    cfg = alembic_sqlite_config_habit_auto_reveal
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _HABIT_AUTO_REVEAL_REVISION)
    assert _habit_auto_reveal_rows(db_url) == [(1, 0, None), (2, 1, None)]

    command.downgrade(cfg, _HABIT_AUTO_REVEAL_BASE_REVISION)
    assert "auto_revealed_at" not in _columns_of(db_url, "habit")

    command.upgrade(cfg, _HABIT_AUTO_REVEAL_REVISION)
    assert _habit_auto_reveal_rows(db_url) == [(1, 0, None), (2, 1, None)]


# -- licensebinding: one Gumroad sale, one active account (ADR 0008) ---------

_LICENSE_BINDING_BASE_REVISION = "f2c7a1d9e4b6"  # pragma: allowlist secret
_LICENSE_BINDING_REVISION = "a9b8c7d6e5f4"  # pragma: allowlist secret
_LICENSE_BINDING_TABLE = "licensebinding"
_LICENSE_BINDING_COLUMNS = {"id", "user_id", "gumroad_sale_id", "product_id", "created_at"}
_LICENSE_BINDING_UNIQUE = "uq_licensebinding_gumroad_sale_id"
_LICENSE_BINDING_USER_INDEX = "ix_licensebinding_user_id"


def _unique_constraint_names(db_url: str, table: str) -> set[str]:
    """Return the named UNIQUE constraints installed on ``table``."""
    engine = create_engine(_sync_url(db_url))
    try:
        return {
            constraint["name"]
            for constraint in inspect(engine).get_unique_constraints(table)
            if constraint["name"] is not None
        }
    finally:
        engine.dispose()


@pytest.fixture
def alembic_sqlite_config_license_binding(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config immediately before the license-binding migration.

    Only ``user`` is bootstrapped: the new table's single foreign key points
    at it, and nothing else in the migration touches an existing table.
    """
    db_path = tmp_path / "license_binding_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    _bootstrap_user_table_for_depth_prefs(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _LICENSE_BINDING_BASE_REVISION)
    return cfg


def test_license_binding_migration_round_trip_on_sqlite(
    alembic_sqlite_config_license_binding: Config,
) -> None:
    """The binding table, its user index and its sale-id UNIQUE arrive and leave together."""
    cfg = alembic_sqlite_config_license_binding
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _LICENSE_BINDING_REVISION)
    assert _table_exists(db_url, _LICENSE_BINDING_TABLE)
    assert _columns_of(db_url, _LICENSE_BINDING_TABLE) == _LICENSE_BINDING_COLUMNS
    assert _LICENSE_BINDING_UNIQUE in _unique_constraint_names(db_url, _LICENSE_BINDING_TABLE)
    assert _LICENSE_BINDING_USER_INDEX in _index_names(db_url, _LICENSE_BINDING_TABLE)

    command.downgrade(cfg, _LICENSE_BINDING_BASE_REVISION)
    assert not _table_exists(db_url, _LICENSE_BINDING_TABLE)

    command.upgrade(cfg, _LICENSE_BINDING_REVISION)
    assert _table_exists(db_url, _LICENSE_BINDING_TABLE)
    assert _LICENSE_BINDING_UNIQUE in _unique_constraint_names(db_url, _LICENSE_BINDING_TABLE)


# -- corpusinvitationstate table migration round-trip ----------------------------

# down_revision is a9b8c7d6e5f4 (the licence-binding migration from #1987, which
# landed on main while this branch was open and is now the head this one sits on).
_CORPUS_INVITATION_BASE_REVISION = "a9b8c7d6e5f4"  # pragma: allowlist secret
_CORPUS_INVITATION_REVISION = "c4d5e6f7a8b9"  # pragma: allowlist secret
_CORPUS_INVITATION_TABLE = "corpusinvitationstate"


@pytest.fixture
def alembic_sqlite_config_corpus_invitation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite Alembic config positioned just before the invitation migration.

    Reuses the two-user bootstrap from the ui-flags round-trip: the point is
    the same, that existing accounts are *not* backfilled with a row.
    """
    db_path = tmp_path / "corpus_invitation_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_user_table_for_ui_flags(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _CORPUS_INVITATION_BASE_REVISION)
    return cfg


def _execute_on(db_url: str, statement: str, params: dict[str, Any]) -> None:
    """Run one write against the round-trip database and commit it."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.begin() as conn:
            conn.execute(text(statement), params)
    finally:
        engine.dispose()


def _corpus_invitation_row(db_url: str, user_id: int) -> dict[str, Any]:
    """Fetch one ``corpusinvitationstate`` row by owner."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            row = (
                conn.execute(
                    text(
                        "SELECT completed_passes, passes_at_dismissal, dismissed_at,"
                        " do_not_ask_again FROM corpusinvitationstate WHERE user_id = :u"
                    ),
                    {"u": user_id},
                )
                .mappings()
                .first()
            )
            assert row is not None
            return dict(row)
    finally:
        engine.dispose()


def test_corpus_invitation_migration_round_trip_on_sqlite(
    alembic_sqlite_config_corpus_invitation: Config,
) -> None:
    """Round-trip the invitation-state migration.

    Phase 1: upgrade creates the table empty despite two existing users.
    Phase 2: a row naming only ``user_id`` is a complete quiet state -- both
    counters zero, never dismissed, still askable -- proving the server defaults.
    Phase 3: a second row for the same account is refused by the unique index,
    and a negative counter is refused by its CHECK.
    Phase 4: downgrade drops the table; Phase 5: re-upgrade recreates it empty.
    """
    cfg = alembic_sqlite_config_corpus_invitation
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _CORPUS_INVITATION_REVISION)
    assert _table_exists(db_url, _CORPUS_INVITATION_TABLE)
    assert {
        "id",
        "user_id",
        "completed_passes",
        "passes_at_dismissal",
        "dismissed_at",
        "do_not_ask_again",
    } <= _columns_of(db_url, _CORPUS_INVITATION_TABLE)
    engine = create_engine(_sync_url(db_url))
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM corpusinvitationstate")).scalar_one() == 0
    engine.dispose()

    _execute_on(db_url, "INSERT INTO corpusinvitationstate (user_id) VALUES (:u)", {"u": 1})
    row = _corpus_invitation_row(db_url, user_id=1)
    assert row["completed_passes"] == 0
    assert row["passes_at_dismissal"] == 0
    assert row["dismissed_at"] is None
    assert bool(row["do_not_ask_again"]) is False

    with pytest.raises(IntegrityError):
        _execute_on(db_url, "INSERT INTO corpusinvitationstate (user_id) VALUES (:u)", {"u": 1})
    with pytest.raises(IntegrityError):
        _execute_on(
            db_url,
            "INSERT INTO corpusinvitationstate (user_id, completed_passes) VALUES (:u, -1)",
            {"u": 2},
        )

    command.downgrade(cfg, _CORPUS_INVITATION_BASE_REVISION)
    assert not _table_exists(db_url, _CORPUS_INVITATION_TABLE)

    command.upgrade(cfg, _CORPUS_INVITATION_REVISION)
    assert _table_exists(db_url, _CORPUS_INVITATION_TABLE)


# -- d4e7c9a1b830: completionsuggestion facts (amount + day) -----------------

_SUGGESTION_FACTS_BASE_REVISION = "c5d9e1f3a7b2"  # pragma: allowlist secret
_SUGGESTION_FACTS_REVISION = "d4e7c9a1b830"  # pragma: allowlist secret
_SUGGESTION_TABLE = "completionsuggestion"

# The two encrypted columns are rewritten wholesale by the batch table-rebuild
# the CHECKs require, so the round-trip reads the stored bytes back rather than
# trusting that the column still exists.
_SUGGESTION_LABEL_CIPHERTEXT = "enc::v1::Z0FBQUFBQm1sYWJlbA=="
_SUGGESTION_ANCHOR_CIPHERTEXT = "enc::v1::Z0FBQUFBQm1hbmNob3I="


def _bootstrap_completion_suggestion_baseline(sync_url: str) -> None:
    """Create ``completionsuggestion`` as it stands just before the facts revision.

    FKs are omitted deliberately (SQLite does not enforce them here and the
    migration touches none of them); every CHECK the row must satisfy is kept,
    because the batch rebuild re-applies them and a dropped one would pass
    unnoticed.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE completionsuggestion ("
                " id INTEGER PRIMARY KEY,"
                " journal_entry_id INTEGER NOT NULL,"
                " user_id INTEGER NOT NULL,"
                " target_type VARCHAR(20) NOT NULL,"
                " goal_id INTEGER,"
                " user_practice_id INTEGER,"
                " label VARCHAR NOT NULL,"
                " anchor_start INTEGER NOT NULL,"
                " anchor_end INTEGER NOT NULL,"
                " anchor_text VARCHAR NOT NULL,"
                " status VARCHAR(20) NOT NULL,"
                " accepted_at DATETIME,"
                " created_at DATETIME NOT NULL,"
                " updated_at DATETIME NOT NULL,"
                " CONSTRAINT ck_completion_suggestion_target_type_valid"
                "  CHECK (target_type IN ('habit', 'practice')),"
                " CONSTRAINT ck_completion_suggestion_status_valid"
                "  CHECK (status IN ('pending', 'accepted', 'dismissed')),"
                " CONSTRAINT ck_completion_suggestion_anchor_start_nonneg"
                "  CHECK (anchor_start >= 0),"
                " CONSTRAINT ck_completion_suggestion_anchor_span_positive"
                "  CHECK (anchor_end > anchor_start),"
                " CONSTRAINT ck_completion_suggestion_target_fk_matches"
                "  CHECK ((target_type = 'habit' AND goal_id IS NOT NULL"
                "          AND user_practice_id IS NULL)"
                "     OR (target_type = 'practice' AND user_practice_id IS NOT NULL"
                "          AND goal_id IS NULL))"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO completionsuggestion"
                " (id, journal_entry_id, user_id, target_type, goal_id, label,"
                "  anchor_start, anchor_end, anchor_text, status, created_at, updated_at)"
                " VALUES (1, 1, 1, 'habit', 1, :label, 0, 22, :anchor, 'pending',"
                "         '2026-09-01 00:00:00', '2026-09-01 00:00:00')"
            ),
            {"label": _SUGGESTION_LABEL_CIPHERTEXT, "anchor": _SUGGESTION_ANCHOR_CIPHERTEXT},
        )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_suggestion_facts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before the suggestion-facts migration."""
    db_path = tmp_path / "suggestion_facts_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_completion_suggestion_baseline(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _SUGGESTION_FACTS_BASE_REVISION)
    return cfg


def _suggestion_row(db_url: str, suggestion_id: int) -> dict[str, Any]:
    """Fetch one ``completionsuggestion`` row, ciphertext columns included."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            row = (
                conn.execute(
                    text(
                        "SELECT id, label, anchor_text, completed_units, completed_on"
                        " FROM completionsuggestion WHERE id = :id"
                    ),
                    {"id": suggestion_id},
                )
                .mappings()
                .first()
            )
            assert row is not None
            return dict(row)
    finally:
        engine.dispose()


def test_completion_suggestion_facts_migration_round_trip_on_sqlite(
    alembic_sqlite_config_suggestion_facts: Config,
) -> None:
    """Round-trip the facts migration: columns, live CHECK, ciphertext, downgrade.

    The CHECKs force a batch table-rebuild, which copies every row through a
    new table -- so the two ``EncryptedString`` columns are read back by value
    rather than merely confirmed to exist.
    """
    cfg = alembic_sqlite_config_suggestion_facts
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _SUGGESTION_FACTS_REVISION)
    cols = _columns_of(db_url, _SUGGESTION_TABLE)
    assert {"completed_units", "completed_on"} <= cols
    assert {
        "ck_completion_suggestion_completed_units_positive",
        "ck_completion_suggestion_facts_habit_only",
    } <= _check_constraints_of(db_url, _SUGGESTION_TABLE)

    # The pre-existing row survived the rebuild with its ciphertext intact and
    # both new columns NULL -- the shipped behaviour for a factless suggestion.
    survivor = _suggestion_row(db_url, suggestion_id=1)
    assert survivor["label"] == _SUGGESTION_LABEL_CIPHERTEXT
    assert survivor["anchor_text"] == _SUGGESTION_ANCHOR_CIPHERTEXT
    assert survivor["completed_units"] is None
    assert survivor["completed_on"] is None

    _execute_on(
        db_url,
        "UPDATE completionsuggestion SET completed_units = 64.0,"
        " completed_on = '2026-09-11' WHERE id = 1",
        {},
    )
    written = _suggestion_row(db_url, suggestion_id=1)
    assert written["completed_units"] == 64.0
    assert str(written["completed_on"]) == "2026-09-11"

    # Both CHECKs bite in the database, not only in the ORM. Asserting the
    # names above proves only that something with those names exists; a CHECK
    # whose predicate was dropped in the rebuild would pass that and nothing
    # else in this suite would notice.
    with pytest.raises(IntegrityError):
        _execute_on(db_url, "UPDATE completionsuggestion SET completed_units = 0 WHERE id = 1", {})
    with pytest.raises(IntegrityError):
        _execute_on(db_url, "UPDATE completionsuggestion SET completed_units = -1 WHERE id = 1", {})
    _execute_on(
        db_url,
        "INSERT INTO completionsuggestion"
        " (id, journal_entry_id, user_id, target_type, user_practice_id, label,"
        "  anchor_start, anchor_end, anchor_text, status, created_at, updated_at)"
        " VALUES (2, 1, 1, 'practice', 1, :label, 0, 4, :anchor, 'pending',"
        "         '2026-09-01 00:00:00', '2026-09-01 00:00:00')",
        {"label": _SUGGESTION_LABEL_CIPHERTEXT, "anchor": _SUGGESTION_ANCHOR_CIPHERTEXT},
    )
    # Statements spelled out rather than built from a loop variable: a literal
    # is what the CHECK is being asked about, and it keeps the SQL out of an
    # f-string.
    with pytest.raises(IntegrityError):
        _execute_on(
            db_url,
            "UPDATE completionsuggestion SET completed_on = '2026-09-11' WHERE id = 2",
            {},
        )
    with pytest.raises(IntegrityError):
        _execute_on(db_url, "UPDATE completionsuggestion SET completed_units = 5 WHERE id = 2", {})

    command.downgrade(cfg, _SUGGESTION_FACTS_BASE_REVISION)
    cols_after = _columns_of(db_url, _SUGGESTION_TABLE)
    assert "completed_units" not in cols_after
    assert "completed_on" not in cols_after
    assert _suggestion_row_label(db_url, suggestion_id=1) == _SUGGESTION_LABEL_CIPHERTEXT

    command.upgrade(cfg, _SUGGESTION_FACTS_REVISION)
    assert {"completed_units", "completed_on"} <= _columns_of(db_url, _SUGGESTION_TABLE)


def _suggestion_row_label(db_url: str, suggestion_id: int) -> str:
    """Fetch only the ciphertext label (valid on both sides of the migration)."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            value = conn.execute(
                text("SELECT label FROM completionsuggestion WHERE id = :id"),
                {"id": suggestion_id},
            ).scalar_one()
            return str(value)
    finally:
        engine.dispose()


# -- #2894 stageprogress.past_cycle_anchors migration round-trip --------------

# Revision anchors for the past-cycle-anchors migration round-trip.
_PAST_CYCLE_ANCHORS_BASE_REVISION = "d4e7c9a1b830"  # pragma: allowlist secret
_PAST_CYCLE_ANCHORS_REVISION = "a1f7c2b9d604"  # pragma: allowlist secret
_PAST_CYCLE_ANCHORS_COLUMN = "past_cycle_anchors"

# The date the seeded habits start on. The ORIGINAL program_started_at backfill
# (18c9d0e1f2a3) reconstructed anchors from MIN(habit.start_date); this
# migration deliberately refuses to, and these rows exist so that refusal is
# provable rather than vacuous — a backfill that guessed would write this date.
_REFUSED_GUESS_DATE = "2024-01-15"


def _bootstrap_past_cycle_anchors(sync_url: str) -> None:
    """Pre-create head-shaped ``user`` / ``stageprogress`` / ``habit`` tables, seeded.

    Three stageprogress rows, one per branch of the backfill: a row still on its
    first cycle (nothing was ever destroyed), a row on cycle 2 (one anchor gone),
    and a row on cycle 3 (two gone). Each has a habit whose ``start_date`` is the
    value the old ``MIN(habit.start_date)`` reconstruction would have used, so a
    backfill that guessed instead of recording unknown is caught by assertion
    rather than by review.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
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
                " cycle_number INTEGER NOT NULL DEFAULT 1,"
                " highest_stage_reached INTEGER NOT NULL DEFAULT 1"
                ")"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE habit ( id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,"
                " start_date DATE NOT NULL)"
            )
        )
        for uid, cycle in ((1, 1), (2, 2), (3, 3)):
            conn.execute(
                text("INSERT INTO user (id, email) VALUES (:id, :email)"),
                {"id": uid, "email": f"anchors{uid}@example.com"},
            )
            conn.execute(
                text(
                    "INSERT INTO stageprogress"
                    " (id, user_id, current_stage, completed_stages, cycle_number)"
                    " VALUES (:id, :uid, 1, '[]', :cycle)"
                ),
                {"id": uid, "uid": uid, "cycle": cycle},
            )
            conn.execute(
                text("INSERT INTO habit (id, user_id, start_date) VALUES (:id, :uid, :start_date)"),
                {"id": uid, "uid": uid, "start_date": _REFUSED_GUESS_DATE},
            )
    engine.dispose()


@pytest.fixture
def alembic_sqlite_config_past_cycle_anchors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite Alembic config positioned just before the #2894 migration."""
    db_path = tmp_path / "past_cycle_anchors_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_past_cycle_anchors(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _PAST_CYCLE_ANCHORS_BASE_REVISION)
    return cfg


def _past_cycle_anchors_of(db_url: str, row_id: int) -> list[str | None] | None:
    """Return one row's decoded ``past_cycle_anchors`` value (NULL stays None)."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            raw = conn.execute(
                text("SELECT past_cycle_anchors FROM stageprogress WHERE id = :id"),
                {"id": row_id},
            ).scalar_one()
    finally:
        engine.dispose()
    if raw is None:
        return None
    decoded = json.loads(raw)
    assert isinstance(decoded, list)
    return cast("list[str | None]", decoded)


def _assert_anchors_recorded_as_unknown(db_url: str) -> None:
    """Every destroyed anchor is recorded as unknown — counted, never guessed."""
    # Still on cycle 1: nothing was ever left behind, so there is nothing to record.
    assert _past_cycle_anchors_of(db_url, 1) is None
    # Looped once: exactly one anchor was destroyed.
    assert _past_cycle_anchors_of(db_url, 2) == [None]
    # Looped twice: two were.
    assert _past_cycle_anchors_of(db_url, 3) == [None, None]
    # And nothing resembling the MIN(habit.start_date) reconstruction was written.
    for row_id in (1, 2, 3):
        recorded = _past_cycle_anchors_of(db_url, row_id) or []
        assert all(value is None for value in recorded)
        assert not any(_REFUSED_GUESS_DATE in str(value) for value in recorded)


def test_stageprogress_past_cycle_anchors_round_trip_on_sqlite(
    alembic_sqlite_config_past_cycle_anchors: Config,
) -> None:
    """Round-trip the #2894 anchors column: add, backfill-as-unknown, drop, re-add.

    The backfill records the NUMBER of anchors ``begin-again`` destroyed and
    refuses to reconstruct any of them. ``MIN(habit.start_date)`` — the source
    the original ``program_started_at`` backfill used, and still available here
    because habits survive begin-again — would return a plausible-looking WRONG
    date and re-create the wrong-period defect of #2886 under a new name.
    """
    cfg = alembic_sqlite_config_past_cycle_anchors
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    # Phase 1: upgrade adds the nullable column and records the unknowns.
    command.upgrade(cfg, _PAST_CYCLE_ANCHORS_REVISION)
    assert _PAST_CYCLE_ANCHORS_COLUMN in _columns_of(db_url, "stageprogress")
    _assert_anchors_recorded_as_unknown(db_url)

    # Phase 2: downgrade drops the column and leaves every other one untouched.
    command.downgrade(cfg, _PAST_CYCLE_ANCHORS_BASE_REVISION)
    cols_after = _columns_of(db_url, "stageprogress")
    assert _PAST_CYCLE_ANCHORS_COLUMN not in cols_after
    assert {"id", "user_id", "current_stage", "cycle_number", "highest_stage_reached"} <= cols_after
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            surviving = [
                (int(row[0]), int(row[1]))
                for row in conn.execute(
                    text("SELECT id, cycle_number FROM stageprogress ORDER BY id")
                ).all()
            ]
    finally:
        engine.dispose()
    assert surviving == [(1, 1), (2, 2), (3, 3)]

    # Phase 3: re-upgrade reproduces the same record of what cannot be recovered.
    command.upgrade(cfg, _PAST_CYCLE_ANCHORS_REVISION)
    _assert_anchors_recorded_as_unknown(db_url)


# -- #2897 feedbackreport migration round-trip -----------------------------

_FEEDBACK_BASE_REVISION = "a1f7c2b9d604"  # pragma: allowlist secret
_FEEDBACK_REVISION = "b4d2e7a9c1f3"  # pragma: allowlist secret

_FEEDBACK_INSERT = (
    "INSERT INTO feedbackreport ("
    " user_id, public_id, category, impact, platform, viewport_class,"
    " summary, screen, app_build, created_at"
    ") VALUES (1, :public_id, :category, 'blocked', 'ios', 'compact',"
    " 'A report.', 'journal.shelf', '1.4.2', CURRENT_TIMESTAMP)"
)


def _bootstrap_user_table(sync_url: str) -> None:
    """Pre-create the one table ``feedbackreport``'s foreign key points at.

    Running the whole chain is not an option on SQLite -- ``habit`` carries an
    ARRAY column no SQLite dialect can render -- so the fixture stamps at the
    parent revision and exercises this migration alone, which is also what makes
    the round-trip a statement about *this* migration rather than about the
    hundred before it.
    """
    bootstrap_engine = create_engine(sync_url)
    with bootstrap_engine.begin() as conn:
        conn.execute(text("CREATE TABLE user (id INTEGER PRIMARY KEY, email VARCHAR(255))"))
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'beta@example.com')"))
    bootstrap_engine.dispose()


def _insert_feedback_row(db_url: str, *, public_id: str, category: str = "broken") -> None:
    """Insert one report through raw SQL, so the CHECKs are what is under test."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.begin() as conn:
            conn.execute(text(_FEEDBACK_INSERT).bindparams(public_id=public_id, category=category))
    finally:
        engine.dispose()


def _delete_feedback_rows(db_url: str) -> None:
    """Clear the table so the refusing downgrade is allowed to proceed."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM feedbackreport"))
    finally:
        engine.dispose()


@pytest.fixture
def alembic_sqlite_config_feedback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite config positioned just before the feedbackreport migration."""
    db_path = tmp_path / "feedback_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_user_table(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _FEEDBACK_BASE_REVISION)
    return cfg


def test_feedback_reports_migration_round_trip_on_sqlite(
    alembic_sqlite_config_feedback: Config,
) -> None:
    """Upgrade creates a usable table; downgrade removes it; re-upgrade is idempotent."""
    cfg = alembic_sqlite_config_feedback
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _FEEDBACK_REVISION)
    _insert_feedback_row(db_url, public_id="FB-23456789")
    assert {
        "id",
        "user_id",
        "public_id",
        "category",
        "impact",
        "platform",
        "viewport_class",
        "summary",
        "intent",
        "expected",
        "actual",
        "screen",
        "control",
        "app_build",
        "locale",
        "correlation_id",
        "idem_key",
        "created_at",
    } == _columns_of(db_url, "feedbackreport")

    _delete_feedback_rows(db_url)
    command.downgrade(cfg, _FEEDBACK_BASE_REVISION)
    engine = create_engine(_sync_url(db_url))
    try:
        assert "feedbackreport" not in inspect(engine).get_table_names()
    finally:
        engine.dispose()

    command.upgrade(cfg, _FEEDBACK_REVISION)
    _insert_feedback_row(db_url, public_id="FB-34567892")


def test_feedback_reports_enum_checks_reject_a_value_outside_the_set(
    alembic_sqlite_config_feedback: Config,
) -> None:
    """The CHECKs the migration installs are live, not decorative.

    A value outside the enum is what the column CHECK exists to stop; without
    this the migration could ship the constraint misspelled and nothing would
    notice until a bad row was already stored.
    """
    cfg = alembic_sqlite_config_feedback
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None
    command.upgrade(cfg, _FEEDBACK_REVISION)

    with pytest.raises(IntegrityError):
        _insert_feedback_row(db_url, public_id="FB-45678923", category="rant")


def test_feedback_reports_check_text_pins_the_sorted_member_order(
    alembic_sqlite_config_feedback: Config,
) -> None:
    """The DDL the migration writes matches the model's sorted rendering.

    Sorted members are what keep ``alembic --autogenerate`` from reporting a
    spurious diff between this table and ``models.feedback``; an unsorted
    rewrite on either side would drift silently until a CI drift job caught it.
    """
    cfg = alembic_sqlite_config_feedback
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None
    command.upgrade(cfg, _FEEDBACK_REVISION)

    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            ddl = conn.execute(
                text("SELECT sql FROM sqlite_master WHERE name = 'feedbackreport'")
            ).scalar_one()
    finally:
        engine.dispose()

    assert "category IN ('broken', 'confusing', 'idea', 'praise')" in ddl
    assert "impact IN ('blocked', 'can_continue', 'cosmetic', 'not_applicable')" in ddl
    assert "platform IN ('android', 'ios', 'web')" in ddl
    assert "viewport_class IN ('compact', 'expanded', 'regular')" in ddl


def test_feedback_reports_downgrade_refuses_with_existing_rows(
    alembic_sqlite_config_feedback: Config,
) -> None:
    """The downgrade aborts while reports exist, rather than destroying prose.

    Dropping this table erases sentences somebody wrote that exist nowhere else,
    and no re-upgrade can bring them back. An operator who means it clears the
    table first; the migration will not make that decision on their behalf.
    """
    cfg = alembic_sqlite_config_feedback
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    command.upgrade(cfg, _FEEDBACK_REVISION)
    _insert_feedback_row(db_url, public_id="FB-56789234")

    with pytest.raises(RuntimeError, match="feedbackreport"):
        command.downgrade(cfg, _FEEDBACK_BASE_REVISION)


# -- review-cadence scope-key vocabulary migration ----------------------------

_CADENCE_BASE_REVISION = "b4d2e7a9c1f3"  # pragma: allowlist secret
_CADENCE_REVISION = "e3a9d1c4b6f2"  # pragma: allowlist secret

# The complete image of the retired grammar under the migration's table. Every
# key that can exist at ``b4d2e7a9c1f3`` is covered: ``prog``, ``p1``..``p5``
# and ``t1``..``t2`` are rewritten, ``w1``..``w36`` and ``s1``..``s10`` are not.
# Both halves are exercised below, which is what makes "the mapping is total"
# an assertion rather than a claim.
_CADENCE_EXPECTED_MAPPING = {
    "prog": ("course", "course"),
    "p1": ("s2", "stage"),
    "p2": ("s4", "stage"),
    "p3": ("s6", "stage"),
    "p4": ("s8", "stage"),
    "p5": ("s10", "stage"),
    "t1": ("x2", "section"),
    "t2": ("x3", "section"),
}
_CADENCE_RETIRED_LEVELS = {
    "prog": "program",
    "p1": "component",
    "p2": "component",
    "p3": "component",
    "p4": "component",
    "p5": "component",
    "t1": "tier",
    "t2": "tier",
}


def _bootstrap_cadence_baseline(sync_url: str) -> None:
    """Bootstrap ``user`` and a scoped ``journalentry`` as of ``c4f7a2b8d9e1``.

    Mirrors the shape the review-cadence migration expects to find: both
    reflection columns, both CHECKs (the level list as it stood, and the paired
    guard), and the partial unique index whose recreation is the migration's own
    collision proof.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE user ( id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)")
        )
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'cadence@example.com')"))
        conn.execute(text("INSERT INTO user (id, email) VALUES (2, 'other@example.com')"))
        conn.execute(
            text(
                "CREATE TABLE journalentry ("
                " id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL,"
                " sender VARCHAR(10) NOT NULL,"
                " message TEXT NOT NULL,"
                " tag VARCHAR(50) NOT NULL DEFAULT 'freeform',"
                " status VARCHAR(20) NOT NULL DEFAULT 'finished',"
                " title VARCHAR(200),"
                " deleted_at DATETIME,"
                " updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"
                " timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"
                " reflection_level VARCHAR(20),"
                " reflection_scope_key VARCHAR(30),"
                " CONSTRAINT ck_journalentry_reflection_level_valid CHECK ("
                " reflection_level IS NULL OR reflection_level IN"
                " ('week', 'stage', 'component', 'tier', 'program')),"
                " CONSTRAINT ck_journalentry_reflection_scope_paired CHECK ("
                " (reflection_level IS NULL) = (reflection_scope_key IS NULL))"
                ")"
            )
        )
        conn.execute(
            text(
                "CREATE UNIQUE INDEX ix_journalentry_user_reflection_scope"
                " ON journalentry (user_id, reflection_scope_key)"
                " WHERE reflection_scope_key IS NOT NULL AND deleted_at IS NULL"
            )
        )
    engine.dispose()


class _Scope(NamedTuple):
    """One entry's ``(reflection_scope_key, reflection_level)`` pair.

    Kept together because the paired CHECK requires them to be set or unset
    together — separating them into two arguments invites a caller to set one.
    """

    key: str | None
    level: str | None


def _seed_scoped_entry(
    db_url: str,
    entry_id: int,
    scope: _Scope,
    *,
    user_id: int = 1,
    deleted: bool = False,
) -> None:
    """Insert one journal entry carrying (or not carrying) a reflection scope."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO journalentry"
                    " (id, user_id, sender, message, reflection_scope_key,"
                    "  reflection_level, deleted_at)"
                    " VALUES (:id, :user_id, 'user', :message, :key, :level, :deleted_at)"
                ),
                {
                    "id": entry_id,
                    "user_id": user_id,
                    "message": f"Entry {entry_id}.",
                    "key": scope.key,
                    "level": scope.level,
                    "deleted_at": "2026-01-01 00:00:00" if deleted else None,
                },
            )
    finally:
        engine.dispose()


def _scopes_by_id(db_url: str) -> dict[int, tuple[str | None, str | None, bool]]:
    """Every journal entry's (scope key, level, is-soft-deleted), keyed by id."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text(
                    "SELECT id, reflection_scope_key, reflection_level, deleted_at"
                    " FROM journalentry ORDER BY id"
                )
            ).all()
    finally:
        engine.dispose()
    return {row[0]: (row[1], row[2], row[3] is not None) for row in rows}


def _scope_index_ddl(db_url: str) -> str:
    """The stored DDL of the partial unique scope index, for predicate assertions."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            return cast(
                "str",
                conn.execute(
                    text(
                        "SELECT sql FROM sqlite_master"
                        " WHERE name = 'ix_journalentry_user_reflection_scope'"
                    )
                ).scalar_one(),
            )
    finally:
        engine.dispose()


@pytest.fixture
def alembic_sqlite_config_cadence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Config:
    """Stamped SQLite Alembic config positioned just before the review-cadence migration."""
    db_path = tmp_path / "review_cadence_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)

    _bootstrap_cadence_baseline(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _CADENCE_BASE_REVISION)
    return cfg


def test_review_cadence_scope_key_migration_round_trip_on_sqlite(
    alembic_sqlite_config_cadence: Config,
) -> None:
    """Two colliding-under-the-issue's-table reviews for ONE user both survive.

    ``c1:p2`` (program day 84) and ``c1:t1`` (day 126) are both reachable from
    the calendar for the same user. Under the issue's own mapping they would
    both become ``c1:x2`` and the rewrite would abort on the partial unique
    index. Under the same-closing-day table they become ``c1:s4`` and ``c1:x2``
    and both keep their scope. Seeding them for ONE user is what makes this
    test able to see a non-injective mapping at all: two users, or two cycles,
    and the index would never be reached.
    """
    cfg = alembic_sqlite_config_cadence
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    _seed_scoped_entry(db_url, 1, _Scope("c1:p2", "component"))
    _seed_scoped_entry(db_url, 2, _Scope("c1:t1", "tier"))
    _seed_scoped_entry(db_url, 3, _Scope("c1:w14", "week"))
    _seed_scoped_entry(db_url, 4, _Scope(None, None))

    command.upgrade(cfg, _CADENCE_REVISION)

    assert _scopes_by_id(db_url) == {
        1: ("c1:s4", "stage", False),
        2: ("c1:x2", "section", False),
        3: ("c1:w14", "week", False),
        4: (None, None, False),
    }

    ddl = _scope_index_ddl(db_url)
    assert "UNIQUE" in ddl.upper()
    assert "reflection_scope_key IS NOT NULL AND deleted_at IS NULL" in ddl

    command.downgrade(cfg, _CADENCE_BASE_REVISION)
    assert _scopes_by_id(db_url)[2] == ("c1:x2", "component", False)

    command.upgrade(cfg, _CADENCE_REVISION)
    assert _scopes_by_id(db_url) == {
        1: ("c1:s4", "stage", False),
        2: ("c1:x2", "section", False),
        3: ("c1:w14", "week", False),
        4: (None, None, False),
    }


def test_review_cadence_migration_maps_every_key_the_old_grammar_admitted(
    alembic_sqlite_config_cadence: Config,
) -> None:
    """The mapping is TOTAL, and no entry is lost.

    One row per retired token (spread across two users and two cycles so none
    of them can collide) plus every ``w`` and ``s`` token, and a soft-deleted
    row for good measure. After the upgrade every seeded id is still present,
    every retired key has moved to its documented target with a derived level,
    and every ``w``/``s`` key is byte-identical -- which the begin-again anchor
    reconstruction in ``a1f7c2b9d604`` depends on.
    """
    cfg = alembic_sqlite_config_cadence
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    expected: dict[int, tuple[str | None, str | None, bool]] = {}
    entry_id = 0
    for token, (new_token, new_level) in _CADENCE_EXPECTED_MAPPING.items():
        entry_id += 1
        _seed_scoped_entry(db_url, entry_id, _Scope(f"c1:{token}", _CADENCE_RETIRED_LEVELS[token]))
        expected[entry_id] = (f"c1:{new_token}", new_level, False)
    # The same retired token in a SECOND cycle rewrites independently and cannot
    # collide with the first: only the part after the ':' is touched.
    entry_id += 1
    _seed_scoped_entry(db_url, entry_id, _Scope("c2:p2", "component"))
    expected[entry_id] = ("c2:s4", "stage", False)
    # A soft-deleted retired row is rewritten too -- the replacement CHECK
    # applies to it -- and it is NOT deleted.
    entry_id += 1
    _seed_scoped_entry(db_url, entry_id, _Scope("c3:p1", "component"), deleted=True)
    expected[entry_id] = ("c3:s2", "stage", True)
    for week in range(1, 37):
        entry_id += 1
        _seed_scoped_entry(db_url, entry_id, _Scope(f"c1:w{week}", "week"), user_id=2)
        expected[entry_id] = (f"c1:w{week}", "week", False)
    for stage in range(1, 11):
        entry_id += 1
        _seed_scoped_entry(db_url, entry_id, _Scope(f"c2:s{stage}", "stage"), user_id=2)
        expected[entry_id] = (f"c2:s{stage}", "stage", False)

    command.upgrade(cfg, _CADENCE_REVISION)

    actual = _scopes_by_id(db_url)
    assert set(actual) == set(expected), "a migrated entry disappeared"
    assert actual == expected
    assert None not in {key for key, _level, _deleted in actual.values()}


def test_review_cadence_migration_demotes_a_collision_instead_of_deleting_it(
    alembic_sqlite_config_cadence: Config,
) -> None:
    """A hand-written key already holding a target is kept; the loser is demoted.

    Demotion means BOTH columns NULL, set together so the paired CHECK is never
    transiently violated. The row itself survives untouched -- no delete, no
    soft-delete, and no suffixed key (a suffix would survive to the client,
    which would then ask for sources with it and take a 422).
    """
    cfg = alembic_sqlite_config_cadence
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    _seed_scoped_entry(db_url, 1, _Scope("c1:p1", "component"))
    _seed_scoped_entry(db_url, 2, _Scope("c1:s2", "stage"))

    command.upgrade(cfg, _CADENCE_REVISION)

    assert _scopes_by_id(db_url) == {
        1: (None, None, False),
        2: ("c1:s2", "stage", False),
    }


def test_review_cadence_migration_check_lists_exactly_the_new_levels(
    alembic_sqlite_config_cadence: Config,
) -> None:
    """After the upgrade a ``section`` row inserts and a ``component`` row does not.

    Asserted by WRITING rows, not by reading DDL: a migration that forgot to
    replace the CHECK still presents every column and index this suite
    otherwise looks at, and would fail only on the first real ``section``
    insert in production.
    """
    cfg = alembic_sqlite_config_cadence
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None
    command.upgrade(cfg, _CADENCE_REVISION)

    _seed_scoped_entry(db_url, 10, _Scope("c1:x1", "section"))
    _seed_scoped_entry(db_url, 11, _Scope("c1:course", "course"))

    for retired in ("component", "tier", "program"):
        with pytest.raises(IntegrityError, match="ck_journalentry_reflection_level_valid"):
            _seed_scoped_entry(db_url, 99, _Scope("c1:q9", retired))


# -- review-cadence: the mapping's own invariants, and totality over stored keys --

# The week span each RETIRED token covered, as the previous release's
# ``_LEVEL_SPECS`` laid it out.  Written here rather than derived because the
# retired vocabulary exists nowhere in the live code any more -- that is the
# whole point of #2866.  Deriving the NEW side from the shipped schedule is
# what makes the invariant assertion below a property check rather than a
# second copy of the migration's table.
_CADENCE_RETIRED_SPANS = {
    "p1": range(1, 7),
    "p2": range(7, 13),
    "p3": range(13, 19),
    "p4": range(19, 25),
    "p5": range(25, 37),
    "t1": range(1, 19),
    "t2": range(19, 37),
    "prog": range(1, 37),
}

# ``t2 -> x3`` is the single documented departure from same-closing-day: the
# day-252 target (``course``) is claimed by ``prog``, so ``t2`` narrows to the
# section that OPENS on its own opening week.  Named here so the invariant test
# below reports it as a declared exception instead of silently tolerating it.
_CADENCE_CLOSING_DAY_EXCEPTIONS = frozenset({"t2"})


def _cadence_migration_module() -> ModuleType:
    """The review-cadence migration module, loaded through Alembic's own loader.

    Read directly so the assertions below name the migration's real table
    rather than a copy of it: a test that restates ``_RETIRED_TOKENS`` can only
    report that two literals disagree, never that the mapping is wrong.
    """
    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    return ScriptDirectory.from_config(cfg).get_revision(_CADENCE_REVISION).module


def _alembic_ini_log_format() -> str:
    """The log format string PRODUCTION runs under, read from ``alembic.ini``.

    ``migrations/env.py`` calls ``fileConfig(config.config_file_name)`` and the
    container's CMD is ``python -m alembic upgrade head``, so this is the only
    formatter an operator ever sees.  Read with a RAW parser: the format string
    is full of ``%(...)s`` tokens that ConfigParser would otherwise try to
    interpolate.
    """
    parser = RawConfigParser()
    parser.read(Path(__file__).parent.parent / "alembic.ini")
    return parser.get("formatter_generic", "format")


@contextmanager
def _rendered_migration_log() -> Iterator[list[str]]:
    """Capture the migration logger's records AS THE PRODUCTION FORMATTER RENDERS THEM.

    The cadence fixture sets ``cfg.config_file_name = None`` so ``env.py`` never
    calls ``fileConfig`` -- loading the real logging config would reconfigure
    every logger in the pytest worker.  That is also why a ``caplog`` assertion
    here would be vacuous: ``caplog`` renders with its own format and reports
    ``record.__dict__``, so fields passed through ``extra={...}`` look present
    when the operator's console shows a bare message.  Attaching alembic.ini's
    own formatter to a capturing handler asks the only question that matters --
    what does the operator actually read?
    """
    logger = logging.getLogger("alembic.runtime.migration")
    rendered: list[str] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            rendered.append(self.format(record))

    handler = _Capture()
    handler.setFormatter(logging.Formatter(_alembic_ini_log_format()))
    handler.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    previous = logger.level
    logger.setLevel(logging.DEBUG)
    try:
        yield rendered
    finally:
        logger.setLevel(previous)
        logger.removeHandler(handler)


def _quarantined_demotions(db_url: str) -> list[tuple[Any, ...]]:
    """Every archived demotion, as ``(entry_id, user_id, old_key, old_level, reason)``."""
    engine = create_engine(_sync_url(db_url))
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text(
                    "SELECT entry_id, user_id, old_key, old_level, attempted_key, reason"
                    " FROM _quarantine_reflection_scope_demotion ORDER BY entry_id"
                )
            ).all()
    finally:
        engine.dispose()
    return [tuple(row) for row in rows]


def test_review_cadence_mapping_is_injective() -> None:
    """No two retired tokens share a target.

    Injectivity is the property that lets the rewrite be collision-free by
    construction.  It is asserted directly here because the demotion rule
    ABSORBS a non-injective table -- it NULLs the loser and exits 0 -- so no
    end-to-end run can be relied on to surface one.
    """
    retired = _cadence_migration_module()._RETIRED_TOKENS  # noqa: SLF001
    collisions = {
        target: sorted(token for token, mapped in retired.items() if mapped == target)
        for target in set(retired.values())
        if sum(1 for mapped in retired.values() if mapped == target) > 1
    }
    assert collisions == {}, f"the mapping is not injective: {collisions}"


def test_review_cadence_mapping_keeps_each_review_on_its_own_closing_day() -> None:
    """Each retired key becomes the key that closes on the SAME program day.

    Derived, not restated: the retired span comes from the previous release's
    level table and the target's span from the SHIPPED schedule via
    ``scope_weeks``, so a mapping edit that re-dates a review fails here with
    the invariant named -- where a second copy of the table could only report
    that two literals disagree.

    The second half of the argument is asserted too: a target must NARROW the
    retired span, never widen it.  Because source resolution short-circuits on
    a node's own review, a widened review would stand in forever for weeks its
    writer never reflected on.
    """
    module = _cadence_migration_module()
    for token, target in module._RETIRED_TOKENS.items():  # noqa: SLF001
        retired_weeks = _CADENCE_RETIRED_SPANS[token]
        level = ReflectionLevel(module._level_for_token(target))  # noqa: SLF001
        target_weeks = scope_weeks(level, f"c1:{target}")

        assert set(target_weeks) <= set(retired_weeks), (
            f"{token} -> {target} WIDENS weeks {list(retired_weeks)} to {list(target_weeks)};"
            " a widened review stands in for material nobody reflected on"
        )
        if token in _CADENCE_CLOSING_DAY_EXCEPTIONS:
            assert max(target_weeks) < max(retired_weeks), (
                f"{token} -> {target} is declared a closing-day exception but does not"
                " actually close earlier; remove it from the exception list"
            )
            continue
        assert max(target_weeks) * DAYS_PER_WEEK == max(retired_weeks) * DAYS_PER_WEEK, (
            f"{token} closed on program day {max(retired_weeks) * DAYS_PER_WEEK} but"
            f" {target} closes on day {max(target_weeks) * DAYS_PER_WEEK}"
        )


def test_review_cadence_level_for_token_refuses_an_unknown_token_by_name() -> None:
    """A token no level spells raises ``ValueError`` naming it, never ``KeyError``.

    The migration is the deploy-time entry point: a bare ``KeyError: 'p'``
    aborts ``alembic upgrade`` for every user while naming neither the row nor
    the key.  The empty token is pinned too -- ``token[:1]`` rather than
    ``token[0]`` is what keeps it a ValueError instead of an IndexError.
    """
    level_for_token = _cadence_migration_module()._level_for_token  # noqa: SLF001
    for unknown in ("p1", "q7", ""):
        with pytest.raises(ValueError, match=r"token"):
            level_for_token(unknown)


def test_review_cadence_migration_maps_every_key_the_old_write_path_accepted(
    alembic_sqlite_config_cadence: Config,
) -> None:
    r"""A non-ASCII-digit key -- ``POST /journal`` returned 201 for these -- migrates.

    The previous release's grammar was ``^c(\\d+):(prog|w\\d+|s\\d+|p\\d+|t\\d+)$``
    and Python's ``\\d`` is Unicode-aware, so a key whose index is a FULLWIDTH
    or ARABIC-INDIC digit parsed to an in-range component, passed the bounds
    check and was PERSISTED by an
    ordinary authenticated request.  The migration must not abort the whole
    deploy on a row the shipped API itself wrote: it canonicalises the spelling
    and maps it like any other.  A trailing newline -- which ``$`` admits --
    canonicalises the same way.
    """
    cfg = alembic_sqlite_config_cadence
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    _seed_scoped_entry(db_url, 1, _Scope("c1:p\uff11", "component"))
    _seed_scoped_entry(db_url, 2, _Scope("c1:t\u0662", "tier"))
    _seed_scoped_entry(db_url, 3, _Scope("c1:w14\n", "week"))
    _seed_scoped_entry(db_url, 4, _Scope("c\uff11:prog", "program"), user_id=2)

    command.upgrade(cfg, _CADENCE_REVISION)

    assert _scopes_by_id(db_url) == {
        1: ("c1:s2", "stage", False),
        2: ("c1:x3", "section", False),
        3: ("c1:w14", "week", False),
        4: ("c1:course", "course", False),
    }
    assert _quarantined_demotions(db_url) == []


def test_review_cadence_migration_demotes_a_key_it_cannot_map_instead_of_aborting(
    alembic_sqlite_config_cadence: Config,
) -> None:
    """A key outside every grammar demotes that ONE row; the deploy still lands.

    Neither shape is reachable through the API -- both need a hand-edited row
    -- but a migration that aborts the release for every user over one of them,
    naming neither the row nor the key, is a worse answer than demoting it and
    saying so.  The row itself survives: no delete, no soft-delete.
    """
    cfg = alembic_sqlite_config_cadence
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    _seed_scoped_entry(db_url, 1, _Scope("c1:zz", "week"))
    _seed_scoped_entry(db_url, 2, _Scope("c1:w99", "week"))
    _seed_scoped_entry(db_url, 3, _Scope("c1:w14", "week"))

    command.upgrade(cfg, _CADENCE_REVISION)

    assert _scopes_by_id(db_url) == {
        1: (None, None, False),
        2: (None, None, False),
        3: ("c1:w14", "week", False),
    }
    assert _quarantined_demotions(db_url) == [
        (1, 1, "c1:zz", "week", None, "unmappable_key"),
        (2, 1, "c1:w99", "week", None, "unmappable_key"),
    ]


def test_review_cadence_demotion_is_legible_under_the_configured_alembic_formatter(
    alembic_sqlite_config_cadence: Config,
) -> None:
    """The operator can name the demoted row from the console alone.

    ``alembic.ini``'s ``formatter_generic`` renders ``%(message)s`` and nothing
    else, so every field passed through ``extra={...}`` is DROPPED -- five
    demotions printed five identical ``reflection_scope_demoted`` lines and the
    old keys then existed nowhere, the row having been NULLed.  Demotion is
    never reversed by ``downgrade()``, so the log line and the quarantine
    archive are the only records there will ever be.
    """
    cfg = alembic_sqlite_config_cadence
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    _seed_scoped_entry(db_url, 1, _Scope("c1:p1", "component"), user_id=2)
    _seed_scoped_entry(db_url, 2, _Scope("c1:s2", "stage"), user_id=2)

    with _rendered_migration_log() as rendered:
        command.upgrade(cfg, _CADENCE_REVISION)

    demotions = [line for line in rendered if "reflection_scope_demoted" in line]
    assert len(demotions) == 1
    for field in ("entry_id=1", "user_id=2", "old_key=c1:p1", "old_level=component"):
        assert field in demotions[0], f"{field!r} missing from the operator's line: {demotions[0]}"

    assert _quarantined_demotions(db_url) == [(1, 2, "c1:p1", "component", "c1:s2", "target_taken")]
    assert _scopes_by_id(db_url) == {1: (None, None, False), 2: ("c1:s2", "stage", False)}


def test_review_cadence_rewrite_lines_name_the_row_they_moved(
    alembic_sqlite_config_cadence: Config,
) -> None:
    """A successful rewrite prints its entry id and both keys, not a bare message."""
    cfg = alembic_sqlite_config_cadence
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    _seed_scoped_entry(db_url, 7, _Scope("c1:p2", "component"))

    with _rendered_migration_log() as rendered:
        command.upgrade(cfg, _CADENCE_REVISION)

    moved = [line for line in rendered if "reflection_scope_key_migrated" in line]
    assert len(moved) == 1
    for field in ("entry_id=7", "old_key=c1:p2", "new_key=c1:s4", "new_level=stage"):
        assert field in moved[0], f"{field!r} missing from the operator's line: {moved[0]}"


def test_review_cadence_downgrade_coarsens_every_level_the_mapping_produces(
    alembic_sqlite_config_cadence: Config,
) -> None:
    """Every level in the mapping's image survives a downgrade to the old CHECK.

    Seeds are DERIVED from the migration's own table, so a level added to the
    image later is downgraded by construction rather than by remembering to
    extend this test.  The arm that matters most is ``course -> program``:
    ``prog`` is the one retired token the old calendar actually made due, and
    dropping that arm turns the emergency rollback into an ``IntegrityError``
    from ``batch_alter_table``'s copy against the restored CHECK.
    """
    cfg = alembic_sqlite_config_cadence
    db_url = cfg.get_main_option("sqlalchemy.url")
    assert db_url is not None

    module = _cadence_migration_module()
    retired = module._RETIRED_TOKENS  # noqa: SLF001
    coarsened = dict(module._LEVEL_DOWNGRADES)  # noqa: SLF001
    # One row per DISTINCT target level, each in its own cycle so none of them
    # can collide with another on the way through.
    seeds: dict[str, str] = {}
    for token, target in retired.items():
        seeds.setdefault(module._level_for_token(target), token)  # noqa: SLF001
    expected_after_downgrade: dict[int, tuple[str | None, str | None, bool]] = {}
    for entry_id, (new_level, token) in enumerate(sorted(seeds.items()), start=1):
        _seed_scoped_entry(
            db_url, entry_id, _Scope(f"c{entry_id}:{token}", _CADENCE_RETIRED_LEVELS[token])
        )
        expected_after_downgrade[entry_id] = (
            f"c{entry_id}:{retired[token]}",
            coarsened.get(new_level, new_level),
            False,
        )

    command.upgrade(cfg, _CADENCE_REVISION)
    command.downgrade(cfg, _CADENCE_BASE_REVISION)

    assert _scopes_by_id(db_url) == expected_after_downgrade
