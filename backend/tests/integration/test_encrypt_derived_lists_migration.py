"""The encrypt-derived-lists migration round-trips on a real Postgres (#3332).

``e8a3c5f7b9d2`` retypes ``corpusfragment.embedding`` (``double precision[]``)
and ``journalentry.vault_tags`` (``json``) to encrypted ``text``. Its SQLite
test cannot reach the ``USING`` expressions, because ``_retype`` is a no-op
there, and ``test_schema_provenance`` only sees the state after ``upgrade
head``. This drives the revision itself on the production dialect: native rows
written at the parent, encrypted by the upgrade, restored to their original
types and exact values by the downgrade, and encrypted again on the way back
to head.

Revisions are named explicitly, never ``head-1``: later migrations may sit on
top of ``e8a3c5f7b9d2``.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from cryptography.fernet import Fernet
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from services import journal_encryption as je

pytestmark = pytest.mark.integration

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_ALEMBIC_INI = _BACKEND_ROOT / "alembic.ini"
_MIGRATIONS = _BACKEND_ROOT / "migrations"
_DATABASE_URL_ENV = "DATABASE_URL"

_PARENT_REVISION = "c4e6a8b0d2f4"  # pragma: allowlist secret
_REVISION = "e8a3c5f7b9d2"  # pragma: allowlist secret
_MARKER = "enc::v1::"
_TEST_EMAIL = "derived-lists-3332@example.test"

#: Embedding seeds by row label. The multi-value one serializes with ``", "``
#: separators and an exponent, the shapes the bracket-to-brace swap must survive.
_EMBEDDINGS: dict[str, list[float] | None] = {
    "multi": [0.125, -0.5, 3e-07, 1.0],
    "empty": [],
    "null": None,
}
#: Vault-tag seeds by row label, as the JSON text the ``json`` column holds.
#: Compact separators: ``json`` keeps its input byte for byte while ``jsonb``
#: would respace it, so a lossy restore cannot pass by normalizing.
_VAULT_TAGS: dict[str, str | None] = {
    "multi": json.dumps(["F5", "phase:withdrawal"], separators=(",", ":")),
    "empty": "[]",
    "null": None,
}
#: ``(table, column)`` -> the Postgres type the parent revision declares.
_ORIGINAL_TYPES = {
    ("corpusfragment", "embedding"): ("ARRAY", "_float8"),
    ("journalentry", "vault_tags"): ("json", "json"),
}
#: This test's rows, keyed by seed label. ``::text`` reads the ``json`` column
#: as stored and is a no-op once the column is ``text``.
_EMBEDDINGS_SQL = (
    "SELECT f.content, f.embedding FROM corpusfragment AS f"
    ' JOIN "user" AS u ON u.id = f.user_id WHERE u.email = :email'
)
_VAULT_TAGS_TEXT_SQL = (
    "SELECT j.message, j.vault_tags::text FROM journalentry AS j"
    ' JOIN "user" AS u ON u.id = j.user_id WHERE u.email = :email'
)


def _config(url: str) -> Config:
    """Return an Alembic config bound to the isolated integration database."""
    config = Config(str(_ALEMBIC_INI))
    config.config_file_name = None
    config.set_main_option("script_location", str(_MIGRATIONS))
    config.set_main_option("sqlalchemy.url", url)
    return config


async def _run(
    url: str, statement: str, params: dict[str, object] | None = None
) -> list[tuple[object, ...]]:
    """Run one committed statement against ``url``; return any rows it selects."""
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as connection:
            result = await connection.execute(text(statement), params or {})
            return [tuple(row) for row in result.all()] if result.returns_rows else []
    finally:
        await engine.dispose()


def _sql(
    url: str, statement: str, params: dict[str, object] | None = None
) -> list[tuple[object, ...]]:
    """Synchronous wrapper: alembic owns ``asyncio.run``, so the test stays sync."""
    return asyncio.run(_run(url, statement, params))


def _column_types(url: str) -> dict[tuple[str, str], tuple[str, str]]:
    """The live ``(data_type, udt_name)`` of each migrated column."""
    rows = _sql(
        url,
        "SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns"
        " WHERE table_schema = 'public' AND (table_name, column_name) IN"
        " (('corpusfragment', 'embedding'), ('journalentry', 'vault_tags'))",
    )
    return {(str(t), str(c)): (str(d), str(u)) for t, c, d, u in rows}


def _seed_at_parent(url: str) -> None:
    """Write one user and a row per seed label in the parent revision's native types."""
    _sql(
        url,
        'INSERT INTO "user" (email, password_hash, offering_balance, created_at,'
        " monthly_reset_date, monthly_messages_used)"
        " VALUES (:email, 'x', 0, now(), now(), 0)",
        {"email": _TEST_EMAIL},
    )
    for label, embedding in _EMBEDDINGS.items():
        _sql(
            url,
            "INSERT INTO corpusfragment (user_id, created_at, overall_confidence,"
            " frequency_weights, content, tier, source, embedding)"
            " SELECT id, now(), 0.5, '{}', :label, 'personal', 'upload', :embedding"
            ' FROM "user" WHERE email = :email',
            {"label": label, "embedding": embedding, "email": _TEST_EMAIL},
        )
    for label, tags in _VAULT_TAGS.items():
        _sql(
            url,
            "INSERT INTO journalentry (user_id, timestamp, updated_at, message, sender,"
            " tag, status, classification, vault_tags)"
            " SELECT id, now(), now(), :label, 'user', 'freeform', 'complete', 'personal',"
            ' CAST(:tags AS json) FROM "user" WHERE email = :email',
            {"label": label, "tags": tags, "email": _TEST_EMAIL},
        )


def _own_rows(url: str, statement: str) -> dict[object, object]:
    """``label -> value`` for this test's rows only; other lane tests may commit their own."""
    return {row[0]: row[1] for row in _sql(url, statement, {"email": _TEST_EMAIL})}


def _native_values(url: str) -> tuple[dict[object, object], dict[object, object]]:
    """Embeddings as float lists and vault tags as their stored JSON text, by label."""
    return _own_rows(url, _EMBEDDINGS_SQL), _own_rows(url, _VAULT_TAGS_TEXT_SQL)


def _assert_encrypted(url: str) -> None:
    """Both columns are ``text``; non-NULL values are ciphertext of the seeded lists."""
    assert set(_column_types(url).values()) == {("text", "text")}
    embeddings = _own_rows(url, _EMBEDDINGS_SQL)
    tags = _own_rows(url, _VAULT_TAGS_TEXT_SQL)
    for stored, seeds in ((embeddings, _EMBEDDINGS), (tags, _VAULT_TAGS)):
        assert stored.keys() == seeds.keys()
        for label, seed in seeds.items():
            value = stored[label]
            if seed is None:
                assert value is None, f"{label} NULL did not stay NULL"
                continue
            assert isinstance(value, str)
            assert value.startswith(_MARKER), f"{label} was left in the clear"
            expected = json.loads(seed) if isinstance(seed, str) else seed
            assert json.loads(je.decrypt(value)) == expected


@pytest.fixture
def migrated_url(pg_database_url: str, monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """The lane database with a real key configured, always returned to head and emptied."""
    monkeypatch.setenv(_DATABASE_URL_ENV, pg_database_url)
    for name in je.PRODUCTION_SIGNAL_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(je.KEYS_ENV_VAR, Fernet.generate_key().decode())
    je.reset_cache()
    try:
        yield pg_database_url
    finally:
        command.upgrade(_config(pg_database_url), "head")
        # The user's foreign keys cascade to both seeded tables.
        _sql(pg_database_url, 'DELETE FROM "user" WHERE email = :email', {"email": _TEST_EMAIL})
        monkeypatch.undo()
        je.reset_cache()


def test_downgrade_restores_native_lists_exactly_on_postgres(migrated_url: str) -> None:
    """Up encrypts both lists; down restores ``double precision[]`` / ``json`` verbatim."""
    config = _config(migrated_url)
    command.downgrade(config, _PARENT_REVISION)
    assert _column_types(migrated_url) == _ORIGINAL_TYPES
    _seed_at_parent(migrated_url)
    seeded = _native_values(migrated_url)
    assert seeded == (_EMBEDDINGS, _VAULT_TAGS)

    command.upgrade(config, _REVISION)
    _assert_encrypted(migrated_url)

    command.downgrade(config, _PARENT_REVISION)
    assert _column_types(migrated_url) == _ORIGINAL_TYPES
    assert _native_values(migrated_url) == seeded

    command.upgrade(config, "head")
    _assert_encrypted(migrated_url)
