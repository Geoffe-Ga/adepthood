"""Round trip for ``e8a3c5f7b9d2``: the embedding and vault tags move to ciphertext (#3263).

Both columns held a list in the clear. The migration moves every stored value
through the ``EncryptedString`` codec as the JSON of its list, and back again
on downgrade. Read back with raw SQL, never the ORM: an ORM round trip looks
the same whether or not the bytes underneath were ever encrypted.

SQLite is where this suite runs, so the PostgreSQL retype (``array_to_json`` up,
a bracket-to-brace array literal down) is exercised by the integration lane's
``alembic upgrade head`` against a real server rather than here.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from cryptography.fernet import Fernet
from sqlalchemy import Connection, create_engine, text

from services import journal_encryption as je

_BASE_REVISION = "b1937b21d2f9"  # pragma: allowlist secret
_REVISION = "e8a3c5f7b9d2"  # pragma: allowlist secret
_MARKER = "enc::v1::"

# The JSON text each seeded row held before the upgrade, as the old column
# types stored it. Row 2 of each table is NULL and must stay NULL.
_EMBEDDING_JSON = json.dumps([0.125, -0.5, 3e-07, 1.0])
_TAGS_JSON = json.dumps(["F5", "phase:withdrawal"])
_READS = {
    "corpusfragment.embedding": "SELECT embedding FROM corpusfragment WHERE id = 1",
    "journalentry.vault_tags": "SELECT vault_tags FROM journalentry WHERE id = 1",
}
_NULL_READS = (
    "SELECT embedding FROM corpusfragment WHERE id = 2",
    "SELECT vault_tags FROM journalentry WHERE id = 2",
)
_SEEDED = {
    "corpusfragment.embedding": _EMBEDDING_JSON,
    "journalentry.vault_tags": _TAGS_JSON,
}


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
    """Just the two migrated columns, each with one seeded and one NULL row.

    The migration touches nothing else on either table, and SQLite enforces no
    foreign key here, so the rest of each table is left out.
    """
    with _connect(db_url) as conn:
        conn.execute(text("CREATE TABLE corpusfragment (id INTEGER PRIMARY KEY, embedding JSON)"))
        conn.execute(text("CREATE TABLE journalentry (id INTEGER PRIMARY KEY, vault_tags JSON)"))
        conn.execute(
            text("INSERT INTO corpusfragment (id, embedding) VALUES (1, :v), (2, NULL)"),
            {"v": _EMBEDDING_JSON},
        )
        conn.execute(
            text("INSERT INTO journalentry (id, vault_tags) VALUES (1, :v), (2, NULL)"),
            {"v": _TAGS_JSON},
        )


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Config]:
    """A SQLite database stamped at the parent revision, with a real key configured."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'derived_lists.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    for name in je.PRODUCTION_SIGNAL_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(je.KEYS_ENV_VAR, Fernet.generate_key().decode())
    je.reset_cache()
    _bootstrap(async_url)
    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _BASE_REVISION)
    yield cfg
    je.reset_cache()


def _url(cfg: Config) -> str:
    url = cfg.get_main_option("sqlalchemy.url")
    assert url is not None
    return url


def _stored(db_url: str) -> dict[str, str]:
    with _connect(db_url) as conn:
        return {name: conn.execute(text(sql)).scalar_one() for name, sql in _READS.items()}


def _nulls(db_url: str) -> list[object]:
    with _connect(db_url) as conn:
        return [conn.execute(text(sql)).scalar_one() for sql in _NULL_READS]


def test_the_migration_chains_from_the_current_head(migration_config: Config) -> None:
    """This revision keeps its authored parent and leaves the chain with a single head."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    assert script.get_heads() == [_REVISION]


def test_upgrade_encrypts_each_list_and_downgrade_restores_its_json(
    migration_config: Config,
) -> None:
    """Up: ciphertext of the JSON. Down: the JSON verbatim. Up again: no double encryption."""
    db_url = _url(migration_config)

    command.upgrade(migration_config, _REVISION)
    for name, stored in _stored(db_url).items():
        assert stored.startswith(_MARKER), f"{name} was left in the clear"
        assert _SEEDED[name] not in stored
        assert json.loads(je.decrypt(stored)) == json.loads(_SEEDED[name])
    assert _nulls(db_url) == [None, None]

    command.downgrade(migration_config, _BASE_REVISION)
    assert _stored(db_url) == _SEEDED
    assert _nulls(db_url) == [None, None]

    command.upgrade(migration_config, _REVISION)
    for name, stored in _stored(db_url).items():
        assert je.decrypt(stored) == _SEEDED[name]


def test_upgrade_leaves_an_already_encrypted_value_alone(migration_config: Config) -> None:
    """A value the codec already wrote is not wrapped a second time."""
    db_url = _url(migration_config)
    token = je.encrypt(_TAGS_JSON)
    with _connect(db_url) as conn:
        conn.execute(text("UPDATE journalentry SET vault_tags = :t WHERE id = 1"), {"t": token})

    command.upgrade(migration_config, _REVISION)

    assert _stored(db_url)["journalentry.vault_tags"] == token


def test_without_a_key_the_upgrade_keeps_the_json_text(
    migration_config: Config, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Key presence is the switch: un-keyed, every value comes through as it was."""
    monkeypatch.delenv(je.KEYS_ENV_VAR)
    je.reset_cache()
    db_url = _url(migration_config)

    command.upgrade(migration_config, _REVISION)

    assert _stored(db_url) == _SEEDED
    assert _nulls(db_url) == [None, None]
