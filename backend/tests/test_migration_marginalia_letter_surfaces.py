"""Round trip for the ``marginalia`` letter voice and related-pages migration (#3778).

Kept in its own module, like the other single-migration round trips, so it
needs only a minimal ``marginalia`` table at its parent revision.
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

_BASE_REVISION = "c4d8e1f2a7b3"  # pragma: allowlist secret
_REVISION = "d94d894e18f8"  # pragma: allowlist secret
_TABLE = "marginalia"
_NEW_COLUMNS = {"essay_voice", "essay_related"}
_EXISTING_ROW = ("ct-anchor", "ct-note", "ct-essay")


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
    """A SQLite database with one note, stamped at this migration's parent."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'marginalia_letter_surfaces.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    with _connect(async_url) as conn:
        conn.execute(
            text(
                "CREATE TABLE marginalia (id INTEGER PRIMARY KEY, anchor_text TEXT NOT NULL,"
                " note TEXT NOT NULL, essay TEXT)"
            )
        )
        conn.execute(
            text("INSERT INTO marginalia (id, anchor_text, note, essay) VALUES (1, :a, :n, :e)"),
            dict(zip(("a", "n", "e"), _EXISTING_ROW, strict=True)),
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


def _columns(db_url: str) -> dict[str, bool]:
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        return {c["name"]: bool(c["nullable"]) for c in inspect(engine).get_columns(_TABLE)}
    finally:
        engine.dispose()


def test_the_migration_chains_from_the_previous_head(migration_config: Config) -> None:
    """One linear chain: this revision sits directly on the head it was written against."""
    revision = ScriptDirectory.from_config(migration_config).get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION


def test_upgrade_adds_two_nullable_columns_without_a_backfill(migration_config: Config) -> None:
    """A letter written before 0.35 makes no voice claim and names no pages."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)

    columns = _columns(db_url)
    assert set(columns) >= _NEW_COLUMNS
    assert all(columns[name] for name in _NEW_COLUMNS)
    with _connect(db_url) as conn:
        stored = conn.execute(text("SELECT essay_voice, essay_related FROM marginalia")).one()
    assert tuple(stored) == (None, None)


def test_upgrade_admits_only_the_published_voices(migration_config: Config) -> None:
    """``owner`` and ``higher_self`` are stored; anything else is refused by the CHECK."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    with _connect(db_url) as conn:
        for voice in ("owner", "higher_self"):
            conn.execute(text("UPDATE marginalia SET essay_voice = :v"), {"v": voice})
    with pytest.raises(IntegrityError, match="CHECK"), _connect(db_url) as conn:
        conn.execute(text("UPDATE marginalia SET essay_voice = 'a_third_voice'"))


def test_downgrade_drops_the_columns_and_keeps_the_note(migration_config: Config) -> None:
    """Down removes only what up added; the note's own columns are intact."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    with _connect(db_url) as conn:
        conn.execute(text("UPDATE marginalia SET essay_voice = 'owner', essay_related = 'x'"))

    command.downgrade(migration_config, _BASE_REVISION)

    assert not _NEW_COLUMNS & set(_columns(db_url))
    with _connect(db_url) as conn:
        stored = conn.execute(text("SELECT anchor_text, note, essay FROM marginalia")).one()
    assert tuple(stored) == _EXISTING_ROW
