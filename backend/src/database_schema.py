"""Fail-fast proof that the connected database matches the Alembic graph.

SQLAlchemy models describe the shape new code expects; they do not prove the
database a running process connected to has that shape. A stale database can
therefore serve healthy-looking routes until a later write reaches the first
new column or table. This module turns that delayed, request-owned 500 into a
startup refusal with the exact recovery command.

Only revision identifiers cross this boundary. No database URL, driver error,
table contents, or credentials are rendered into the operator-facing failure.
"""

from __future__ import annotations

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine

MIGRATION_COMMAND = "cd backend && alembic upgrade head"

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
_ALEMBIC_INI = _BACKEND_ROOT / "alembic.ini"
_MIGRATIONS = _BACKEND_ROOT / "migrations"


class DatabaseSchemaMismatchError(RuntimeError):
    """The connected database cannot safely serve this application revision."""


def alembic_script_heads() -> frozenset[str]:
    """Return repository migration heads using cwd-independent paths."""
    config = Config(str(_ALEMBIC_INI))
    config.set_main_option("script_location", str(_MIGRATIONS))
    return frozenset(ScriptDirectory.from_config(config).get_heads())


def _unreadable_stamp_message() -> str:
    """Explain an absent/unreadable stamp without echoing connection details."""
    return (
        "Database schema revision cannot be verified because alembic_version is "
        "missing or unreadable. Refusing startup before accepting traffic. Run "
        f"`{MIGRATION_COMMAND}` and start the backend again."
    )


def _mismatch_message(current: set[str], expected: frozenset[str]) -> str:
    """Explain a behind/divergent stamp and name the deterministic recovery."""
    return (
        "Database schema is behind or does not match this application: "
        f"database revisions={sorted(current)}, repository heads={sorted(expected)}. "
        "Refusing startup before accepting traffic. Run "
        f"`{MIGRATION_COMMAND}` and start the backend again."
    )


async def require_database_schema_current(engine: AsyncEngine) -> None:
    """Raise before service startup unless the database is at every script head.

    Raises:
        DatabaseSchemaMismatchError: The Alembic stamp is absent, unreadable,
            behind, ahead, or divergent from the checked-out migration graph.
    """
    expected = alembic_script_heads()
    try:
        async with engine.connect() as connection:
            result = await connection.execute(text("SELECT version_num FROM alembic_version"))
            current = set(result.scalars().all())
    except SQLAlchemyError as exc:
        raise DatabaseSchemaMismatchError(_unreadable_stamp_message()) from exc

    if current != expected:
        raise DatabaseSchemaMismatchError(_mismatch_message(current, expected))
