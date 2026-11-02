"""Round trip for the ``promotedquote`` source-kind migration (#3656).

Kept in its own module, like the other single-migration round trips, so it needs
only the tables the migration touches or points at, as they stand at its parent
revision. SQLite runs the batch migration by rebuilding ``promotedquote``, so the
round trip also proves the table's existing anchor CHECKs, indexes and foreign
keys come through both directions.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from models.promoted_quote import PromotedQuoteSourceKind

# The chain head this migration was written against, and the migration itself.
_BASE_REVISION = "8c4e2b7d1a95"  # pragma: allowlist secret
_REVISION = "e5c1a8f3b7d2"  # pragma: allowlist secret

_TABLE = "promotedquote"
_NEW_COLUMNS = {"source_kind", "source_content_id", "source_marginalia_id", "source_title"}
_CONTENT_INDEX = "ix_promotedquote_source_content_id"
_MARGINALIA_INDEX = "ix_promotedquote_source_marginalia_id"
_EXISTING_INDEXES = {"ix_promotedquote_source_entry_id", "ix_promotedquote_user_included"}

# The pre-migration quote every test starts with: an entry quote of entry 1.
_EXISTING_QUOTE_ID = 1
_COURSE_QUOTE_ID = 2
_LETTER_QUOTE_ID = 3
_CHAPTER_TITLE = "Survival"

_INSERT_QUOTE = (
    "INSERT INTO promotedquote (id, user_id, source_kind, source_entry_id, source_content_id,"
    " source_marginalia_id, source_title, anchor_start, anchor_end, anchor_text, stale,"
    " created_at, updated_at)"
    " VALUES (:id, 1, :kind, :entry, :content, :marginalia, :title, 0, 4, 'ct-quote', 0,"
    " '2026-11-02 00:00:00', '2026-11-02 00:00:00')"
)


@contextmanager
def _connect(db_url: str, *, foreign_keys: bool = False) -> Iterator[Connection]:
    """A committing sync connection to ``db_url``, optionally enforcing foreign keys."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        with engine.begin() as conn:
            if foreign_keys:
                conn.execute(text("PRAGMA foreign_keys = ON"))
            yield conn
    finally:
        engine.dispose()


def _bootstrap(db_url: str) -> None:
    """Create the tables this migration touches or points at, as they stand at the parent.

    ``promotedquote`` is the table the parent revision left (``stale`` included);
    one user owns one entry, one chapter, one margin note with its letter, and one
    entry quote, so the round trip can prove an existing row survives.
    """
    statements = (
        "CREATE TABLE user (id INTEGER PRIMARY KEY, email VARCHAR(254))",
        (
            "CREATE TABLE journalentry (id INTEGER PRIMARY KEY,"
            " user_id INTEGER NOT NULL REFERENCES user (id) ON DELETE CASCADE,"
            " message TEXT NOT NULL)"
        ),
        "CREATE TABLE stagecontent (id INTEGER PRIMARY KEY, title VARCHAR NOT NULL)",
        (
            "CREATE TABLE marginalia (id INTEGER PRIMARY KEY,"
            " journal_entry_id INTEGER NOT NULL REFERENCES journalentry (id) ON DELETE CASCADE,"
            " user_id INTEGER NOT NULL REFERENCES user (id) ON DELETE CASCADE)"
        ),
        (
            "CREATE TABLE promotedquote (id INTEGER NOT NULL,"
            " user_id INTEGER NOT NULL,"
            " source_entry_id INTEGER NOT NULL,"
            " anchor_start INTEGER NOT NULL,"
            " anchor_end INTEGER NOT NULL,"
            " anchor_text TEXT NOT NULL,"
            " included_in_entry_id INTEGER,"
            " created_at DATETIME NOT NULL,"
            " updated_at DATETIME NOT NULL,"
            " stale BOOLEAN NOT NULL,"
            " PRIMARY KEY (id),"
            " CONSTRAINT ck_promotedquote_anchor_start_nonneg CHECK (anchor_start >= 0),"
            " CONSTRAINT ck_promotedquote_anchor_span_positive CHECK (anchor_end > anchor_start),"
            " FOREIGN KEY (user_id) REFERENCES user (id) ON DELETE CASCADE,"
            " FOREIGN KEY (source_entry_id) REFERENCES journalentry (id) ON DELETE CASCADE,"
            " FOREIGN KEY (included_in_entry_id) REFERENCES journalentry (id) ON DELETE SET NULL)"
        ),
        "CREATE INDEX ix_promotedquote_source_entry_id ON promotedquote (source_entry_id)",
        (
            "CREATE INDEX ix_promotedquote_user_included"
            " ON promotedquote (user_id, included_in_entry_id)"
        ),
        "INSERT INTO user (id, email) VALUES (1, 'reader@example.com')",
        "INSERT INTO journalentry (id, user_id, message) VALUES (1, 1, 'ct-body')",
        "INSERT INTO marginalia (id, journal_entry_id, user_id) VALUES (1, 1, 1)",
    )
    with _connect(db_url) as conn:
        for statement in statements:
            conn.execute(text(statement))
        conn.execute(
            text("INSERT INTO stagecontent (id, title) VALUES (1, :title)"),
            {"title": _CHAPTER_TITLE},
        )
        conn.execute(
            text(
                "INSERT INTO promotedquote (id, user_id, source_entry_id, anchor_start,"
                " anchor_end, anchor_text, created_at, updated_at, stale)"
                " VALUES (:id, 1, 1, 0, 4, 'ct-quote',"
                " '2026-11-01 00:00:00', '2026-11-01 00:00:00', 0)"
            ),
            {"id": _EXISTING_QUOTE_ID},
        )


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database stamped at this migration's parent revision."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'promoted_quote_source_kind.sqlite'}"
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


def _shape(db_url: str) -> tuple[dict[str, Any], set[str], list[Any]]:
    """``promotedquote``'s columns by name, its index names, and its foreign keys."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        inspector = inspect(engine)
        columns = {column["name"]: column for column in inspector.get_columns(_TABLE)}
        indexes = {str(index["name"]) for index in inspector.get_indexes(_TABLE)}
        foreign_keys = list(inspector.get_foreign_keys(_TABLE))
    finally:
        engine.dispose()
    return columns, indexes, foreign_keys


def _ondelete(foreign_keys: list[Any], column: str) -> tuple[str, str | None]:
    """The table and ``ondelete`` of the single foreign key on ``column``."""
    matches = [fk for fk in foreign_keys if fk["constrained_columns"] == [column]]
    assert len(matches) == 1, matches
    return matches[0]["referred_table"], matches[0]["options"].get("ondelete")


def _insert(db_url: str, quote_id: int, kind: str, **links: object) -> None:
    """Insert one quote of ``kind`` with the named source links (others NULL)."""
    values = {"entry": None, "content": None, "marginalia": None, "title": None, **links}
    with _connect(db_url) as conn:
        conn.execute(text(_INSERT_QUOTE), {"id": quote_id, "kind": kind, **values})


def _quotes(db_url: str) -> list[tuple[Any, ...]]:
    """Every quote as ``(id, source_kind, entry, content, marginalia, title)``, by id."""
    with _connect(db_url) as conn:
        rows = conn.execute(
            text(
                "SELECT id, source_kind, source_entry_id, source_content_id,"
                " source_marginalia_id, source_title FROM promotedquote ORDER BY id"
            )
        )
        return [tuple(row) for row in rows]


def test_the_migration_chains_from_its_authored_head(migration_config: Config) -> None:
    """One linear chain: this revision extends the head it was written against."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    heads = script.get_heads()
    assert len(heads) == 1
    assert _REVISION in {rev.revision for rev in script.iterate_revisions(heads[0], "base")}


def test_upgrade_makes_every_existing_quote_an_entry_quote(migration_config: Config) -> None:
    """The existing row becomes ``entry`` with no other link; nothing else moves."""
    command.upgrade(migration_config, _REVISION)

    assert _quotes(_url(migration_config)) == [(_EXISTING_QUOTE_ID, "entry", 1, None, None, None)]


def test_upgrade_adds_the_nullable_indexed_source_links(migration_config: Config) -> None:
    """Kind is NOT NULL; the entry link loosens; each new link is indexed with its ondelete."""
    command.upgrade(migration_config, _REVISION)

    columns, indexes, foreign_keys = _shape(_url(migration_config))
    assert set(columns) >= _NEW_COLUMNS
    assert columns["source_kind"]["nullable"] is False
    for nullable in ("source_entry_id", "source_content_id", "source_marginalia_id"):
        assert columns[nullable]["nullable"] is True, nullable
    assert columns["source_title"]["nullable"] is True
    assert indexes >= {_CONTENT_INDEX, _MARGINALIA_INDEX, *_EXISTING_INDEXES}
    assert _ondelete(foreign_keys, "source_entry_id") == ("journalentry", "CASCADE")
    assert _ondelete(foreign_keys, "source_content_id") == ("stagecontent", "SET NULL")
    assert _ondelete(foreign_keys, "source_marginalia_id") == ("marginalia", "CASCADE")
    assert _ondelete(foreign_keys, "included_in_entry_id") == ("journalentry", "SET NULL")


def test_upgrade_accepts_a_course_and_a_letter_quote(migration_config: Config) -> None:
    """The two new kinds persist with their own links, and a pruned chapter's NULL link."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)

    _insert(db_url, _COURSE_QUOTE_ID, "course", content=1, title=_CHAPTER_TITLE)
    _insert(db_url, _LETTER_QUOTE_ID, "letter", marginalia=1)
    _insert(db_url, 4, "course", title=_CHAPTER_TITLE)

    kinds = [row[1] for row in _quotes(db_url)]
    assert kinds == ["entry", "course", "letter", "course"]


@pytest.mark.parametrize(
    ("kind", "links"),
    [
        pytest.param("vault", {"entry": 1}, id="unknown-kind"),
        pytest.param("entry", {}, id="entry-without-entry"),
        pytest.param("entry", {"entry": 1, "content": 1}, id="entry-with-chapter"),
        pytest.param("entry", {"entry": 1, "title": "x"}, id="entry-with-title"),
        pytest.param("course", {"content": 1, "marginalia": 1}, id="course-with-letter"),
        pytest.param("course", {"content": 1, "entry": 1}, id="course-with-entry"),
        pytest.param("letter", {}, id="letter-without-letter"),
        pytest.param("letter", {"marginalia": 1, "entry": 1}, id="letter-with-entry"),
        pytest.param("letter", {"marginalia": 1, "title": "x"}, id="letter-with-title"),
    ],
)
def test_upgrade_refuses_a_quote_whose_links_contradict_its_kind(
    migration_config: Config, kind: str, links: dict[str, object]
) -> None:
    """The migrated CHECKs hold for a non-ORM writer too."""
    command.upgrade(migration_config, _REVISION)

    with pytest.raises(IntegrityError, match="CHECK"):
        _insert(_url(migration_config), 9, kind, **links)


def test_upgrade_keeps_the_anchor_checks_through_the_rebuild(migration_config: Config) -> None:
    """SQLite rebuilds the table; the pre-existing anchor CHECKs come through it."""
    command.upgrade(migration_config, _REVISION)

    with (
        pytest.raises(IntegrityError, match="CHECK"),
        _connect(_url(migration_config)) as conn,
    ):
        conn.execute(text("UPDATE promotedquote SET anchor_end = anchor_start"))


def test_migrated_links_cascade_a_letter_and_detach_a_chapter(migration_config: Config) -> None:
    """With foreign keys enforced: a deleted note takes its letter quote; a chapter only unlinks."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    _insert(db_url, _COURSE_QUOTE_ID, "course", content=1, title=_CHAPTER_TITLE)
    _insert(db_url, _LETTER_QUOTE_ID, "letter", marginalia=1)

    with _connect(db_url, foreign_keys=True) as conn:
        conn.execute(text("DELETE FROM marginalia WHERE id = 1"))
        conn.execute(text("DELETE FROM stagecontent WHERE id = 1"))

    assert _quotes(db_url) == [
        (_EXISTING_QUOTE_ID, "entry", 1, None, None, None),
        (_COURSE_QUOTE_ID, "course", None, None, None, _CHAPTER_TITLE),
    ]


def test_downgrade_deletes_the_new_kinds_and_restores_the_entry_link(
    migration_config: Config,
) -> None:
    """Down drops course and letter quotes (they have no entry to point at), keeps entry ones."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    _insert(db_url, _COURSE_QUOTE_ID, "course", content=1, title=_CHAPTER_TITLE)
    _insert(db_url, _LETTER_QUOTE_ID, "letter", marginalia=1)

    command.downgrade(migration_config, _BASE_REVISION)

    columns, indexes, _ = _shape(db_url)
    assert not _NEW_COLUMNS & set(columns)
    assert columns["source_entry_id"]["nullable"] is False
    assert not {_CONTENT_INDEX, _MARGINALIA_INDEX} & indexes
    assert indexes >= _EXISTING_INDEXES
    with _connect(db_url) as conn:
        remaining = conn.execute(text("SELECT id, source_entry_id FROM promotedquote")).all()
    assert [tuple(row) for row in remaining] == [(_EXISTING_QUOTE_ID, 1)]


def test_re_upgrade_after_downgrade_is_clean(migration_config: Config) -> None:
    """Up, down, up again: the surviving entry quote is an entry quote once more."""
    command.upgrade(migration_config, _REVISION)
    command.downgrade(migration_config, _BASE_REVISION)
    command.upgrade(migration_config, _REVISION)

    assert _quotes(_url(migration_config)) == [(_EXISTING_QUOTE_ID, "entry", 1, None, None, None)]


def test_the_migration_freezes_todays_kinds(migration_config: Config) -> None:
    """The kind list the migration inlines is the enum's, in the enum's order."""
    revision = ScriptDirectory.from_config(migration_config).get_revision(_REVISION)
    assert revision is not None
    frozen = revision.module.FROZEN_SOURCE_KINDS
    assert frozen == tuple(kind.value for kind in PromotedQuoteSourceKind)
