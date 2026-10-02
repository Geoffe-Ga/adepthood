"""Every index the SQLite fixture mirrors must be one ``alembic check`` skips.

``backend/conftest.py`` hand-writes a ``..._test`` stand-in for each unique
index that only a migration creates, because the models do not declare it.
``alembic check`` (the CI migration-drift job) compares a migrated Postgres
against those same models, so it sees each such index as drift -- an index
autogenerate would drop -- unless ``migrations/env.py`` lists it in
``_RAW_SQL_MANAGED_INDEXES``. ``alembic check`` only runs against a live
Postgres in CI, so this guard reads both lists from source and catches a
missing entry in the unit lane instead.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

from conftest import _SQLITE_ALWAYS_INDEXES, _SQLITE_CONCURRENT_ONLY_INDEXES

_ENV_PATH = Path(__file__).resolve().parents[1] / "migrations" / "env.py"
_SKIP_SET_NAME = "_RAW_SQL_MANAGED_INDEXES"
_MIRROR_SUFFIX = "_test"
_MIRROR_NAME = re.compile(r'CREATE UNIQUE INDEX IF NOT EXISTS "(?P<name>[a-z0-9_]+)"')


def _skipped_index_names() -> set[str]:
    """Return the string literals in ``env.py``'s ``_RAW_SQL_MANAGED_INDEXES``."""
    tree = ast.parse(_ENV_PATH.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and node.target.id == _SKIP_SET_NAME
            and node.value is not None
        ):
            return {
                literal.value
                for literal in ast.walk(node.value)
                if isinstance(literal, ast.Constant) and isinstance(literal.value, str)
            }
    msg = f"{_SKIP_SET_NAME} not found in {_ENV_PATH}"
    raise AssertionError(msg)


def _mirrored_production_names() -> set[str]:
    """Return the production index name behind every SQLite fixture mirror."""
    names: set[str] = set()
    for statement in (*_SQLITE_ALWAYS_INDEXES, *_SQLITE_CONCURRENT_ONLY_INDEXES):
        match = _MIRROR_NAME.search(statement)
        assert match is not None, f"unparseable mirror statement: {statement}"
        mirror = match.group("name")
        assert mirror.endswith(_MIRROR_SUFFIX), f"mirror {mirror} lacks the _test suffix"
        names.add(mirror.removesuffix(_MIRROR_SUFFIX))
    return names


def test_the_skip_set_parses_to_a_non_empty_set() -> None:
    """A rename or reshape of the skip set must fail here, not pass vacuously."""
    assert "ix_coursestage_stage_number_unique" in _skipped_index_names()


def test_every_mirrored_index_is_skipped_by_alembic_check() -> None:
    """A migration-owned index the models do not declare must not read as drift."""
    mirrored = _mirrored_production_names()
    assert mirrored, "the SQLite fixture declares no index mirrors"

    assert sorted(mirrored - _skipped_index_names()) == []
