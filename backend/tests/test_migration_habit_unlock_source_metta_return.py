"""Round trip for widening ``habitunlockevent.source`` to ``metta_return`` (issue #3745).

``source`` is a ``VARCHAR(32)`` guarded by a CHECK, not a database enum. The
model derives that CHECK from :class:`~models.habit_unlock_event.UnlockSource`,
so ``create_all`` and ``alembic check`` both see the new member; the deployed
CHECK, though, was written as a literal by ``9d2b6e4f1a73`` and names only the
four original writers. Without this migration the first Return release a
deployed database is asked to log would fail its INSERT.

The fixture builds the table as the parent revision left it -- the narrow
source CHECK and its two sibling CHECKs -- and stamps that revision, like the
other single-migration round trips.
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

from models.habit_unlock_event import UnlockSource

_BASE_REVISION = "b7e1c4d9a2f5"  # pragma: allowlist secret
_REVISION = "3f7a9c2e5b18"  # pragma: allowlist secret

_TABLE = "habitunlockevent"
_SOURCE_CHECK = "ck_habitunlockevent_source_valid"
_KIND_CHECK = "ck_habitunlockevent_kind_valid"
_NUMBER_CHECK = "ck_habitunlockevent_program_number_positive"
_METTA = "metta_return"
_MANUAL = "manual"

_INSERT = (
    "INSERT INTO habitunlockevent (id, user_id, habit_id, pass_id, kind, occurred_at,"
    " local_day, program_number, source) VALUES (:id, 1, 1, NULL, :kind,"
    " '2026-11-19T09:00:00+00:00', '2026-11-19', :number, :source)"
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
    """Create ``habitunlockevent`` with the CHECKs ``9d2b6e4f1a73`` wrote, and one manual row."""
    with _connect(db_url) as conn:
        conn.execute(
            text(
                "CREATE TABLE habitunlockevent (id INTEGER NOT NULL,"
                " user_id INTEGER NOT NULL, habit_id INTEGER NOT NULL, pass_id INTEGER,"
                " kind VARCHAR(16) NOT NULL, occurred_at DATETIME NOT NULL,"
                " local_day DATE NOT NULL, program_number INTEGER NOT NULL,"
                " source VARCHAR(32) NOT NULL, PRIMARY KEY (id),"
                f" CONSTRAINT {_KIND_CHECK} CHECK (kind IN ('unlocked', 'relocked')),"
                f" CONSTRAINT {_SOURCE_CHECK} CHECK (source IN"
                " ('manual', 'auto_reveal', 'created_unlocked', 'backfill')),"
                f" CONSTRAINT {_NUMBER_CHECK} CHECK (program_number >= 1))"
            )
        )
        conn.execute(text(_INSERT), {"id": 1, "kind": "unlocked", "number": 1, "source": _MANUAL})


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database stamped at this migration's parent revision."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'unlock_source_metta.sqlite'}"
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


def _insert(
    db_url: str, row_id: int, source: str, *, kind: str = "relocked", number: int = 1
) -> None:
    """Insert one row as a non-ORM writer would (raises on a CHECK violation)."""
    with _connect(db_url) as conn:
        conn.execute(
            text(_INSERT), {"id": row_id, "kind": kind, "number": number, "source": source}
        )


def _rows(db_url: str) -> list[tuple[int, str]]:
    """Every row as ``(id, source)``, by id."""
    with _connect(db_url) as conn:
        found = conn.execute(text("SELECT id, source FROM habitunlockevent"))
        return sorted((row[0], row[1]) for row in found)


def _checks(db_url: str) -> set[str]:
    """Every named CHECK the table carries, as the database has it."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        found = inspect(engine).get_check_constraints(_TABLE)
    finally:
        engine.dispose()
    return {str(check["name"]) for check in found if check.get("name")}


def test_the_migration_chains_from_the_pending_pass_day(migration_config: Config) -> None:
    """One linear chain: this revision extends the head it was written against."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    heads = script.get_heads()
    assert len(heads) == 1
    assert _REVISION in {rev.revision for rev in script.iterate_revisions(heads[0], "base")}


@pytest.mark.parametrize("source", list(UnlockSource), ids=str)
def test_upgrade_accepts_every_source_the_model_knows(
    migration_config: Config, source: UnlockSource
) -> None:
    """Every member persists: a source without its migration fails here."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)

    _insert(db_url, 2, source.value)

    assert _rows(db_url) == [(1, _MANUAL), (2, source.value)]
    assert _checks(db_url) >= {_SOURCE_CHECK, _KIND_CHECK, _NUMBER_CHECK}


@pytest.mark.parametrize(
    ("source", "kind", "number"),
    [
        pytest.param("nope", "relocked", 1, id="unknown-source"),
        pytest.param(_METTA, "sideways", 1, id="sibling-kind-check-kept"),
        pytest.param(_METTA, "relocked", 0, id="sibling-number-check-kept"),
    ],
)
def test_upgrade_still_refuses_what_the_checks_forbid(
    migration_config: Config, source: str, kind: str, number: int
) -> None:
    """Widening admits one source; nothing else loosens."""
    command.upgrade(migration_config, _REVISION)

    with pytest.raises(IntegrityError, match="CHECK"):
        _insert(_url(migration_config), 2, source, kind=kind, number=number)


def test_downgrade_drops_the_returns_rows_and_narrows_the_check(migration_config: Config) -> None:
    """A pre-#3745 build never logged a Return flip, so its rows go; every other row stays."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    _insert(db_url, 2, _METTA)

    command.downgrade(migration_config, _BASE_REVISION)

    assert _rows(db_url) == [(1, _MANUAL)]
    assert _checks(db_url) >= {_SOURCE_CHECK, _KIND_CHECK, _NUMBER_CHECK}
    with pytest.raises(IntegrityError, match="CHECK"):
        _insert(db_url, 3, _METTA)


def test_the_round_trip_upgrades_again(migration_config: Config) -> None:
    """Upgrade, downgrade, upgrade: the cycle is repeatable and the source persists again."""
    command.upgrade(migration_config, _REVISION)
    command.downgrade(migration_config, _BASE_REVISION)
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)

    _insert(db_url, 2, _METTA)

    assert _rows(db_url) == [(1, _MANUAL), (2, _METTA)]
