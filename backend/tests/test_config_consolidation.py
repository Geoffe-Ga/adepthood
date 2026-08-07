"""Tests for phase-2-06: pytest/coverage config consolidation.

Verify that configuration lives in a single source of truth (pyproject.toml)
and legacy config files have been removed.
"""

import pathlib
import tomllib
from typing import Any

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent


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

    def test_pyproject_addopts_has_no_coverage_flags(self) -> None:
        """Coverage flags must stay out of addopts — they poison the TDD loop.

        These flags used to live here. The effect was that a targeted run
        during Red->Green (``pytest tests/test_foo.py``) instrumented all
        ~11k statements, wrote coverage.xml, and then FAILED the run against
        a whole-repo 90% gate that one file can never satisfy: a green file
        exited 1. That false red cost ~12s and several wasted agent turns on
        the most-repeated loop in a Ralph tick (#2075).

        The threshold is not relaxed — it moved to the invocations that
        actually gate, asserted by the tests below.
        """
        cfg = _load_pyproject()
        addopts = cfg["tool"]["pytest"]["ini_options"]["addopts"]
        assert "--cov" not in addopts, (
            f"coverage must not be in addopts, or every targeted test run pays "
            f"for it and fails the whole-repo threshold: {addopts!r}"
        )

    def test_check_all_collects_coverage_data_for_the_gate(self) -> None:
        """Gate 2 must still produce the coverage data coverage.sh gates on.

        Removing coverage from addopts means the suite no longer collects it
        implicitly, so the Gate 2 script has to ask for it explicitly. If this
        regresses, ``coverage.sh --report-only`` finds no data and check-all
        stops gating coverage at all.
        """
        check_all = (REPO_ROOT / "scripts" / "backend" / "check-all.sh").read_text()
        assert '"test.sh" --unit --coverage-data' in check_all

    def test_pre_push_hook_still_enforces_the_threshold(self) -> None:
        """The pre-push hook is the second place the 90% gate is enforced."""
        hooks = (REPO_ROOT / ".pre-commit-config.yaml").read_text()
        assert "--cov-fail-under=90" in hooks

    def test_suite_runs_distributed(self) -> None:
        """Whole-suite runs must be distributed; serial costs 16 min a round.

        Gate 2 re-runs the entire suite on every drop-back, so a serial suite
        multiplies straight into tick latency (#2076).
        """
        assert "pytest-xdist" in (BACKEND_DIR / "requirements-dev.txt").read_text()
        test_sh = (REPO_ROOT / "scripts" / "backend" / "test.sh").read_text()
        assert '-n "$PYTEST_WORKERS"' in test_sh

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
