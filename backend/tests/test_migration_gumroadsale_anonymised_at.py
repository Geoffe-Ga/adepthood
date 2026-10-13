"""Round trip for the ``gumroadsale.anonymised_at`` migration (#3063 AC15).

The owner ratified the sale receipt's lifetime as "180 days after the sale is
anonymised at account deletion". The row recorded no such instant, so account
deletion now stamps one. The column is additive and nullable: a sale that was
never anonymised, including every row written before this revision, keeps
``NULL`` -- its clock has not started.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, DateTime, create_engine, inspect, text
from sqlmodel import SQLModel

from models.gumroad_sale import GumroadSale

_BASE_REVISION = "a7c9e1f3b5d8"  # pragma: allowlist secret
_REVISION = "b3d5f7a9c1e2"  # pragma: allowlist secret
_TABLE = "gumroadsale"
_COLUMN = "anonymised_at"
_INSERT_LEGACY_SALE = text(
    "INSERT INTO gumroadsale (gumroad_sale_id, product_id, email, resource_name,"
    " is_recurring_charge, refunded, raw_payload, created_at)"
    " VALUES ('sale-1', 'prod', 'buyer@example.com', 'sale', 0, 0, '{}',"
    " '2026-09-01T00:00:00+00:00')"
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


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database holding one legacy sale, stamped at the parent revision."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'anonymised_at.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    with _connect(async_url) as conn:
        conn.execute(
            text(
                "CREATE TABLE gumroadsale (id INTEGER PRIMARY KEY,"
                " gumroad_sale_id VARCHAR NOT NULL UNIQUE, product_id VARCHAR NOT NULL,"
                " email VARCHAR NOT NULL, resource_name VARCHAR NOT NULL,"
                " is_recurring_charge BOOLEAN NOT NULL, refunded BOOLEAN NOT NULL,"
                " raw_payload JSON NOT NULL, created_at DATETIME NOT NULL,"
                " token_pack_credited_at DATETIME, token_pack_credited_user_id INTEGER,"
                " revocation_processed_at DATETIME)"
            )
        )
        conn.execute(_INSERT_LEGACY_SALE)
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


def _columns(db_url: str) -> dict[str, dict[str, object]]:
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        return {c["name"]: dict(c) for c in inspect(engine).get_columns(_TABLE)}
    finally:
        engine.dispose()


def test_the_model_declares_a_nullable_timezone_aware_stamp() -> None:
    """The ORM column the deletion path writes: nullable, timestamptz."""
    column = SQLModel.metadata.tables[_TABLE].c[_COLUMN]
    assert column.nullable is True
    assert isinstance(column.type, DateTime)
    assert column.type.timezone is True
    assert GumroadSale.model_fields[_COLUMN].default is None


def test_the_migration_chains_from_the_obligation_head(migration_config: Config) -> None:
    """One linear chain: this revision sits directly on the head it was written against."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    assert script.get_heads() == [_REVISION]


def test_upgrade_adds_the_stamp_and_leaves_legacy_sales_unanonymised(
    migration_config: Config,
) -> None:
    """Additive only: a sale recorded before this revision has no anonymisation instant."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    columns = _columns(db_url)
    assert columns[_COLUMN]["nullable"] is True
    with _connect(db_url) as conn:
        legacy = conn.execute(text("SELECT anonymised_at, email FROM gumroadsale")).one()
    assert tuple(legacy) == (None, "buyer@example.com")


def test_downgrade_drops_the_stamp_and_keeps_the_sales(migration_config: Config) -> None:
    """Down removes the column; the receipts themselves stay."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    with _connect(db_url) as conn:
        conn.execute(text("UPDATE gumroadsale SET anonymised_at = '2026-10-13T00:00:00+00:00'"))

    command.downgrade(migration_config, _BASE_REVISION)

    assert _COLUMN not in _columns(db_url)
    with _connect(db_url) as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM gumroadsale")).scalar_one() == 1
