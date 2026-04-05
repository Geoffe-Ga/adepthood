"""Tests for phase-2-06: pytest/coverage config consolidation.

Verify that configuration lives in a single source of truth (pyproject.toml)
and legacy config files have been removed.
"""

import pathlib
import tomllib
from typing import Any

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent


class TestConfigConsolidation:
    """Ensure pytest and coverage config is consolidated in pyproject.toml."""

    def test_pytest_ini_deleted(self) -> None:
        assert not (BACKEND_DIR / "pytest.ini").exists(), "pytest.ini should be deleted"

    def test_coveragerc_deleted(self) -> None:
        assert not (BACKEND_DIR / ".coveragerc").exists(), ".coveragerc should be deleted"

    def test_pyproject_has_pytest_ini_options(self) -> None:
        cfg = _load_pyproject()
        opts = cfg["tool"]["pytest"]["ini_options"]
        assert "testpaths" in opts
        assert "addopts" in opts
        assert "pythonpath" in opts

    def test_pyproject_addopts_has_cov_flags(self) -> None:
        cfg = _load_pyproject()
        addopts = cfg["tool"]["pytest"]["ini_options"]["addopts"]
        assert "--cov=src" in addopts
        assert "--cov-report=term-missing" in addopts
        assert "--cov-fail-under=90" in addopts

    def test_pyproject_addopts_has_strict_flags(self) -> None:
        cfg = _load_pyproject()
        addopts = cfg["tool"]["pytest"]["ini_options"]["addopts"]
        assert "--strict-markers" in addopts
        assert "--strict-config" in addopts

    def test_pyproject_has_coverage_run(self) -> None:
        cfg = _load_pyproject()
        run = cfg["tool"]["coverage"]["run"]
        assert run["branch"] is True
        # source should point to src (where the code actually lives)
        assert "src" in run["source"]

    def test_pyproject_coverage_omit_excludes_tests_but_not_init(self) -> None:
        cfg = _load_pyproject()
        run = cfg["tool"]["coverage"]["run"]
        omit = run.get("omit", [])
        # __init__.py should NOT be omitted (contains real import logic)
        init_patterns = [p for p in omit if "__init__" in p]
        assert not init_patterns, f"__init__.py should not be omitted: {init_patterns}"
        # tests should be omitted
        assert any("test" in p for p in omit), "test files should be omitted"

    def test_pyproject_has_coverage_report(self) -> None:
        cfg = _load_pyproject()
        report = cfg["tool"]["coverage"]["report"]
        assert report["show_missing"] is True


def _load_pyproject() -> dict[str, Any]:
    path = BACKEND_DIR / "pyproject.toml"
    with path.open("rb") as f:
        return tomllib.load(f)
