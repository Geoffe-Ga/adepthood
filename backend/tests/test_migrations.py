"""Static sanity checks on the alembic migration scripts.

BUG-INFRA-022: earlier the downgrade for the timestamptz migration used a
subtly-different ``USING`` expression from the upgrade, which failed on
Postgres.  The real round-trip check runs against a Postgres container in
CI (see ``.github/workflows/backend-ci.yml``).  These tests catch the
cheap-to-detect regressions at unit-test speed so drift is surfaced before
CI wakes up.
"""

from __future__ import annotations

from pathlib import Path

import pytest

MIGRATIONS_DIR = Path(__file__).parent.parent / "migrations" / "versions"

TIMESTAMPTZ_MIGRATION = MIGRATIONS_DIR / "78b1620cafde_convert_datetime_columns_to_timestamptz.py"


def test_timestamptz_migration_exists() -> None:
    """Regression guard: the migration file must stay where Alembic finds it."""
    assert TIMESTAMPTZ_MIGRATION.is_file()


def test_upgrade_and_downgrade_use_same_using_expression() -> None:
    """BUG-INFRA-022: the upgrade and downgrade ``USING`` expressions must
    be structurally identical so ``alembic downgrade -1`` round-trips.

    Specifically, both should produce ``"col" AT TIME ZONE 'UTC'`` — the
    conversion is symmetric (timestamp ↔ timestamptz in UTC), so the
    expression should be the same for both directions.
    """
    text = TIMESTAMPTZ_MIGRATION.read_text()
    upgrade_section = text.split("def upgrade")[1].split("def downgrade")[0]
    downgrade_section = text.split("def downgrade")[1]

    # The exact f-string literal used in both directions.
    expected_literal = "f'\"{column}\" AT TIME ZONE \\'UTC\\''"
    assert expected_literal in upgrade_section, "upgrade uses a different USING clause"
    assert expected_literal in downgrade_section, (
        "downgrade uses a different USING clause — BUG-INFRA-022 regressed"
    )


@pytest.mark.parametrize("direction", ["upgrade", "downgrade"])
def test_both_directions_exist(direction: str) -> None:
    """Every migration must define both ``upgrade`` and ``downgrade``.

    Without this any new migration could ship without a rollback path,
    re-introducing the same class of bug BUG-INFRA-022 caught.
    """
    for path in MIGRATIONS_DIR.glob("*.py"):
        if path.name.startswith("_"):
            continue
        text = path.read_text()
        assert f"def {direction}" in text, f"{path.name} missing {direction}()"
