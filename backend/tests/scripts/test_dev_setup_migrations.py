"""The canonical local setup path cannot declare a stale database ready."""

from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_DEV_SETUP = _REPO_ROOT / "scripts" / "dev-setup.sh"
_README = _REPO_ROOT / "README.md"
_MIGRATION_COMMAND = "alembic upgrade head"


def test_dev_setup_runs_migrations_before_announcing_success() -> None:
    """The setup script must stop when Alembic cannot bring the database to head."""
    source = _DEV_SETUP.read_text(encoding="utf-8")

    migration = source.index(f"if ! (cd backend && {_MIGRATION_COMMAND})")
    success = source.index("Setup complete! Your environment is ready.")

    assert migration < success
    assert "exit 1" in source[migration:success]


def test_getting_started_documents_the_same_recovery_command() -> None:
    """An operator rejected at boot must find the exact remedy in Getting Started."""
    readme = _README.read_text(encoding="utf-8")
    getting_started = readme[readme.index("## 🚀 Getting Started") : readme.index("## 🔒")]

    assert _MIGRATION_COMMAND in getting_started
    assert "behind" in getting_started.lower()
    assert "after pulling" in getting_started.lower()
