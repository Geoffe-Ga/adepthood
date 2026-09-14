"""Round-trip proof for the provider-managed custody migration."""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
_BASE_REVISION = "b4c8d2e6f0a1"  # pragma: allowlist secret
_CUSTODY_REVISION = "c5d9e1f3a7b2"  # pragma: allowlist secret


def _config(database: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    async_url = f"sqlite+aiosqlite:///{database}"
    # migrations/env.py deliberately prefers DATABASE_URL so the Alembic CLI
    # always targets the same database as the running application.  Pin that
    # process-level input as well as the Config value: a developer shell or a
    # neighbouring integration test may otherwise redirect this round-trip to
    # an unrelated database despite its unique tmp_path.
    monkeypatch.setenv("DATABASE_URL", async_url)
    config = Config(str(_BACKEND_ROOT / "alembic.ini"))
    # Embedded migration tests must not let fileConfig disable loggers created
    # earlier in the suite.  Production CLI invocations still load alembic.ini.
    config.config_file_name = None
    config.set_main_option("script_location", str(_BACKEND_ROOT / "migrations"))
    config.set_main_option("sqlalchemy.url", async_url)
    return config


def _create_legacy_schema(database: Path) -> None:
    engine = create_engine(f"sqlite:///{database}")
    with engine.begin() as connection:
        connection.execute(
            text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY)")
        )
        connection.execute(
            text("INSERT INTO alembic_version (version_num) VALUES (:revision)"),
            {"revision": _BASE_REVISION},
        )
        connection.execute(
            text(
                "CREATE TABLE vaultactivation ("
                "id INTEGER NOT NULL PRIMARY KEY, "
                "user_id INTEGER NOT NULL UNIQUE, "
                "activation_id VARCHAR(200) NOT NULL UNIQUE, "
                "consumer_identity VARCHAR(200) NOT NULL UNIQUE, "
                "creek_job_id VARCHAR(200) UNIQUE, "
                "state VARCHAR(32) NOT NULL, "
                "retryable BOOLEAN NOT NULL, "
                "failure_reason VARCHAR(64), "
                "credential_received_at DATETIME, "
                "attested_confidential BOOLEAN, "
                "created_at DATETIME NOT NULL, "
                "updated_at DATETIME NOT NULL, "
                "CONSTRAINT ck_vaultactivation_state_valid CHECK ("
                "state IN ('submitting', 'pending', 'provisioning', "
                "'awaiting_key_ceremony', 'awaiting_handoff', 'ready', "
                "'failed', 'deleting', 'deleted')))"
            )
        )
        for row_id, state, attested in (
            (1, "awaiting_key_ceremony", 1),
            (2, "ready", 1),
            (3, "pending", None),
        ):
            connection.execute(
                text(
                    "INSERT INTO vaultactivation ("
                    "id, user_id, activation_id, consumer_identity, creek_job_id, "
                    "state, retryable, failure_reason, attested_confidential, "
                    "created_at, updated_at) VALUES ("
                    ":id, :id, :activation, :consumer, :job, :state, true, null, "
                    ":attested, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                ),
                {
                    "id": row_id,
                    "activation": f"activation-{row_id}",
                    "consumer": f"consumer-{row_id}",
                    "job": f"job-{row_id}",
                    "state": state,
                    "attested": attested,
                },
            )
    engine.dispose()


def test_custody_migration_names_legacy_truth_and_retires_waiting_rows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Old rows become explicit and no account remains on the removed ceremony rung."""
    database = tmp_path / "vault-custody.sqlite3"
    _create_legacy_schema(database)
    config = _config(database, monkeypatch)

    command.upgrade(config, _CUSTODY_REVISION)

    engine = create_engine(f"sqlite:///{database}")
    with engine.connect() as connection:
        rows = (
            connection.execute(
                text(
                    "SELECT id, state, retryable, failure_reason, "
                    "attested_confidential, custody_mode "
                    "FROM vaultactivation ORDER BY id"
                )
            )
            .mappings()
            .all()
        )
    assert [dict(row) for row in rows] == [
        {
            "id": 1,
            "state": "failed",
            "retryable": 0,
            "failure_reason": "provider_rejected",
            "attested_confidential": 0,
            "custody_mode": "wrapped_artifact_only",
        },
        {
            "id": 2,
            "state": "ready",
            "retryable": 1,
            "failure_reason": None,
            "attested_confidential": 0,
            "custody_mode": None,
        },
        {
            "id": 3,
            "state": "pending",
            "retryable": 1,
            "failure_reason": None,
            "attested_confidential": 0,
            "custody_mode": None,
        },
    ]
    migrated_columns = inspect(engine).get_columns("vaultactivation")
    assert "custody_mode" in {column["name"] for column in migrated_columns}
    engine.dispose()

    command.downgrade(config, _BASE_REVISION)

    engine = create_engine(f"sqlite:///{database}")
    assert "custody_mode" not in {
        column["name"] for column in inspect(engine).get_columns("vaultactivation")
    }
    with engine.connect() as connection:
        definition = connection.execute(
            text("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vaultactivation'")
        ).scalar_one()
    assert "awaiting_key_ceremony" in definition
    engine.dispose()
