"""Round trip for widening ``vaultpipelinerun.failure_code`` to Creek 0.29's ``busy`` (#3710).

``failure_code`` is a ``VARCHAR(32)`` guarded by a CHECK, not a database enum.
The model derives that CHECK from :class:`~domain.creek_vault.VaultJobFailureCode`,
so ``create_all`` and ``alembic check`` both see the new member; the deployed
CHECK, though, was written as a literal by ``1e941149a0c9`` and names only
``request_key_rejected``. Without this migration the first busy row a deployed
database is asked to keep would fail its INSERT.

Kept in its own module, like the other single-migration round trips: SQLite
cannot replay the chain from empty (``1e941149a0c9`` itself adds its CHECK
outside a batch), so the fixture builds the table as the parent revision left
it -- the narrow CHECK and a sibling one -- and stamps that revision.
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

from domain.creek_vault import VaultJobFailureCode

# The chain head this migration was written against, and the migration itself.
_BASE_REVISION = "01d044846694"  # pragma: allowlist secret
_REVISION = "166523efc36e"  # pragma: allowlist secret

_TABLE = "vaultpipelinerun"
_CHECK = "ck_vaultpipelinerun_failure_code_valid"
_OUTCOME_CHECK = "ck_vaultpipelinerun_outcome_valid"
_BUSY = "busy"
_REJECTED = "request_key_rejected"
_FAILED = "failed"

_INSERT = "INSERT INTO vaultpipelinerun (id, outcome, failure_code) VALUES (:id, :outcome, :code)"


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
    """Create ``vaultpipelinerun`` as the parent revision leaves the columns this CHECK reads.

    The narrow CHECK is the literal ``1e941149a0c9`` wrote; the outcome CHECK is
    a sibling the SQLite batch rebuild must carry through both directions. One
    refused-key row exists already, so the round trip proves it survives.
    """
    with _connect(db_url) as conn:
        conn.execute(
            text(
                "CREATE TABLE vaultpipelinerun (id INTEGER NOT NULL,"
                " outcome VARCHAR(20) NOT NULL,"
                " failure_code VARCHAR(32),"
                " PRIMARY KEY (id),"
                f" CONSTRAINT {_OUTCOME_CHECK} CHECK (outcome IN"
                " ('completed', 'incomplete', 'failed', 'attempted', 'ambiguous', 'queued')),"
                f" CONSTRAINT {_CHECK} CHECK (failure_code IS NULL OR"
                " (outcome = 'failed' AND failure_code IN ('request_key_rejected'))))"
            )
        )
        conn.execute(text(_INSERT), {"id": 1, "outcome": _FAILED, "code": _REJECTED})


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database stamped at this migration's parent revision."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'vault_pipeline_run_busy.sqlite'}"
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


def _insert(db_url: str, row_id: int, outcome: str, code: str | None) -> None:
    """Insert one row as a non-ORM writer would (raises on a CHECK violation)."""
    with _connect(db_url) as conn:
        conn.execute(text(_INSERT), {"id": row_id, "outcome": outcome, "code": code})


def _rows(db_url: str) -> list[tuple[int, str, str | None]]:
    """Every row as ``(id, outcome, failure_code)``, by id."""
    with _connect(db_url) as conn:
        found = conn.execute(text("SELECT id, outcome, failure_code FROM vaultpipelinerun"))
        return sorted((row[0], row[1], row[2]) for row in found)


def _checks(db_url: str) -> set[str]:
    """Every named CHECK the table carries, as the database has it."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        found = inspect(engine).get_check_constraints(_TABLE)
    finally:
        engine.dispose()
    return {str(check["name"]) for check in found if check.get("name")}


def test_the_migration_chains_from_its_authored_head(migration_config: Config) -> None:
    """One linear chain: this revision extends the head it was written against."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    heads = script.get_heads()
    assert len(heads) == 1
    assert _REVISION in {rev.revision for rev in script.iterate_revisions(heads[0], "base")}


@pytest.mark.parametrize("code", list(VaultJobFailureCode), ids=str)
def test_upgrade_accepts_a_failed_row_naming_every_published_code(
    migration_config: Config, code: VaultJobFailureCode
) -> None:
    """Every member the model knows persists: a code without its migration fails here."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)

    _insert(db_url, 2, _FAILED, code.value)

    assert _rows(db_url) == [(1, _FAILED, _REJECTED), (2, _FAILED, code.value)]
    assert _checks(db_url) >= {_CHECK, _OUTCOME_CHECK}


@pytest.mark.parametrize(
    ("outcome", "code"),
    [
        pytest.param(_FAILED, "nope", id="unpublished-code"),
        pytest.param("attempted", _BUSY, id="busy-on-a-run-still-in-flight"),
        pytest.param("ambiguous", _BUSY, id="busy-on-an-ambiguous-run"),
        pytest.param("unheard_of", None, id="sibling-outcome-check-kept"),
    ],
)
def test_upgrade_still_refuses_what_the_check_forbids(
    migration_config: Config, outcome: str, code: str | None
) -> None:
    """Widening admits one code on failed rows only; nothing else loosens."""
    command.upgrade(migration_config, _REVISION)

    with pytest.raises(IntegrityError, match="CHECK"):
        _insert(_url(migration_config), 2, outcome, code)


def test_downgrade_forgets_busy_and_keeps_the_run_failed(migration_config: Config) -> None:
    """A busy row reads as a pre-0.29 build would have recorded it: failed, no reason."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    _insert(db_url, 2, _FAILED, _BUSY)

    command.downgrade(migration_config, _BASE_REVISION)

    assert _rows(db_url) == [(1, _FAILED, _REJECTED), (2, _FAILED, None)]
    assert _checks(db_url) >= {_CHECK, _OUTCOME_CHECK}
    with pytest.raises(IntegrityError, match="CHECK"):
        _insert(db_url, 3, _FAILED, _BUSY)


def test_the_round_trip_upgrades_again(migration_config: Config) -> None:
    """Upgrade, downgrade, upgrade: the cycle is repeatable and busy persists again."""
    command.upgrade(migration_config, _REVISION)
    command.downgrade(migration_config, _BASE_REVISION)
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)

    _insert(db_url, 2, _FAILED, _BUSY)

    assert _rows(db_url) == [(1, _FAILED, _REJECTED), (2, _FAILED, _BUSY)]
