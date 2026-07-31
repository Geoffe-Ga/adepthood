"""Tests for the coverage consolidation in ``scripts/backend/coverage.sh``.

``check-all.sh`` ran the entire backend suite twice. Stage 6 (``test.sh
--unit``) and stage 7 (``coverage.sh``) each executed the same few thousand
tests, because ``[tool.pytest.ini_options] addopts`` already injects
``--cov=src --cov=scripts`` and ``--cov-fail-under=90`` into every pytest
process: stage 6 was already enforcing the threshold and already writing
``coverage.xml``, and stage 7 bought nothing but a second seven-minute wait.
Together they pushed the gate past the ten-minute per-command ceiling that
kills an agent mid-run, which turns the local gate into something operators
skip rather than something that predicts CI.

The fix is to let stage 7 report from the coverage data stage 6 already wrote.
That trades duplicated work for a new way to fail open: a report rendered from
a data file that is absent, or left over from an unrelated run, prints a number
nobody earned. So these tests pin the whole contract, not just the speedup:
``--report-only`` must never start a test runner, must still pass the 90%
threshold to the reporter, must still emit the XML report CI consumes, and must
refuse loudly when the coverage data file does not exist.

The scripts are driven through fake ``pytest`` and ``coverage`` executables in a
``tmp_path`` directory prepended to ``PATH``; each records its argv to a log
named by an environment variable and exits with a status a second environment
variable supplies (0 unless a test asks otherwise). That knob is what lets the
suite prove the reporter's failures are honored rather than merely that the
threshold flag was passed. Nothing here runs a real suite, parses real coverage
data, or writes inside the checkout. The ``check-all.sh`` wiring is asserted by
reading the script rather than by executing it, since executing it would invoke
the very long suite this change exists to stop running twice.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCRIPTS_DIR = _REPO_ROOT / "scripts" / "backend"
_COVERAGE_SCRIPT = _SCRIPTS_DIR / "coverage.sh"
_CHECK_ALL_SCRIPT = _SCRIPTS_DIR / "check-all.sh"

# Log destinations for the two shims; read back as "who was invoked, with what".
_PYTEST_LOG_ENV = "ADEPTHOOD_FAKE_PYTEST_LOG"
_COVERAGE_LOG_ENV = "ADEPTHOOD_FAKE_COVERAGE_LOG"
# Exit status each shim returns; unset means 0, so only tests about failure
# handling have to think about it.
_PYTEST_EXIT_ENV = "ADEPTHOOD_FAKE_PYTEST_EXIT"
_COVERAGE_EXIT_ENV = "ADEPTHOOD_FAKE_COVERAGE_EXIT"
_SHIM_MODE = 0o755
_SUBPROCESS_TIMEOUT_SECONDS = 60

# coverage.py's own convention for locating its data file.
COVERAGE_DATA_FILE_ENV = "COVERAGE_FILE"

REPORT_ONLY_FLAG = "--report-only"
XML_FLAG = "--xml"
COVERAGE_REPORT_COMMAND = "report"
COVERAGE_XML_COMMAND = "xml"
# The gate itself. A consolidation that drops this flag reports a percentage
# without failing on it, which is a silently weakened threshold.
COVERAGE_THRESHOLD_FLAG = "--fail-under=90"
PYTEST_THRESHOLD_FLAG = "--cov-fail-under=90"

# The script's own documented exit codes: 1 means the measured coverage fell
# short, 2 means coverage could not be measured or reported at all. Conflating
# them tells an operator with a corrupt data file to go write tests.
BELOW_THRESHOLD_EXIT_CODE = 1
COVERAGE_ERROR_EXIT_CODE = 2

# coverage.py's own statuses, from ``coverage.cmdline``: ``FAIL_UNDER`` for a
# coverage shortfall and ``ERR`` for anything else that went wrong. The script
# consumes these, so the two must not be read as interchangeable failures.
COVERAGE_PY_FAIL_UNDER_STATUS = 2
COVERAGE_PY_ERROR_STATUS = 1

# The wording the operator needs: which artifact is missing, and where it was
# looked for. Pinned as a substring so phrasing stays the implementer's choice.
MISSING_DATA_MESSAGE = "coverage data"
# The claim a threshold miss must make, and that a reporter error must not.
BELOW_THRESHOLD_MESSAGE = "below threshold"

TEST_RUNNER_SCRIPT = "test.sh"
COVERAGE_RUNNER_SCRIPT = "coverage.sh"
UNIT_TESTS_CHECK = "Unit tests"
COVERAGE_CHECK = "Coverage report"
EXPECTED_CHECK_NAMES = (
    "Linting",
    "Formatting",
    "Type checking",
    "Security checks",
    "Complexity analysis",
    UNIT_TESTS_CHECK,
    COVERAGE_CHECK,
)
_RUN_CHECK_CALL_PREFIX = 'run_check "'
# Artifacts a previous run leaves behind; reporting from them is stale data.
STALE_COVERAGE_ARTIFACTS = (".coverage", "coverage.xml")

_SHIM_TEMPLATE = """#!/usr/bin/env bash
printf "%s\\n" "$*" >> "${log_env_var}"
exit "${{{exit_env_var}:-0}}"
"""


def _write_shim(path: Path, log_env_var: str, exit_env_var: str) -> None:
    """Write an executable that appends its argv to a log file, then exits.

    Args:
        path: Destination of the fake executable; its filename is the command
            name that will be shadowed on ``PATH``.
        log_env_var: Name of the environment variable holding the log path.
        exit_env_var: Name of the environment variable holding the status to
            exit with; unset means 0, so the shim succeeds by default.
    """
    path.write_text(
        _SHIM_TEMPLATE.format(log_env_var=log_env_var, exit_env_var=exit_env_var),
    )
    path.chmod(_SHIM_MODE)


def _read_log(path: Path) -> list[str]:
    """Return one entry per recorded invocation, empty when never invoked.

    Args:
        path: Log file written by a shim; absent until its command runs once.

    Returns:
        The recorded argv lines with surrounding whitespace and blanks removed.
    """
    if not path.exists():
        return []
    return [line.strip() for line in path.read_text().splitlines() if line.strip()]


@dataclass(frozen=True)
class _ShimHarness:
    """The shimmed environment plus the recorders that observe what ran."""

    env: dict[str, str]
    pytest_log: Path
    coverage_log: Path
    coverage_data: Path

    def pytest_calls(self) -> list[str]:
        """Return the argv of every fake ``pytest`` invocation."""
        return _read_log(self.pytest_log)

    def coverage_calls(self) -> list[str]:
        """Return the argv of every fake ``coverage`` invocation."""
        return _read_log(self.coverage_log)

    def coverage_calls_named(self, command: str) -> list[str]:
        """Return the fake ``coverage`` invocations whose subcommand matches.

        Args:
            command: The coverage.py subcommand, such as ``report`` or ``xml``.

        Returns:
            The matching argv lines, in invocation order.
        """
        return [call for call in self.coverage_calls() if call.split()[0] == command]

    def with_coverage_exit(self, status: int) -> dict[str, str]:
        """Return the environment with the fake ``coverage`` failing on purpose.

        Args:
            status: Exit status the shim returns, standing in for one of
                coverage.py's own.

        Returns:
            A copy of the shim environment; the fixture's own stays untouched.
        """
        return {**self.env, _COVERAGE_EXIT_ENV: str(status)}


@pytest.fixture
def harness(tmp_path: Path) -> _ShimHarness:
    """Shadow ``pytest`` and ``coverage`` on ``PATH`` with argv recorders.

    The real commands are never reachable from the scripts under test, so a
    regression that re-runs the suite shows up as a recorded ``pytest``
    invocation rather than as a seven-minute test. Both shims succeed unless a
    test asks for a failure via :meth:`_ShimHarness.with_coverage_exit`.

    Args:
        tmp_path: Per-test directory holding the shims, the logs, and a stand-in
            coverage data file.

    Returns:
        The environment that activates the shims plus the paths to read back.
    """
    shim_dir = tmp_path / "shims"
    shim_dir.mkdir()
    _write_shim(shim_dir / "pytest", _PYTEST_LOG_ENV, _PYTEST_EXIT_ENV)
    _write_shim(shim_dir / "coverage", _COVERAGE_LOG_ENV, _COVERAGE_EXIT_ENV)

    pytest_log = tmp_path / "pytest-calls.log"
    coverage_log = tmp_path / "coverage-calls.log"
    coverage_data = tmp_path / ".coverage"
    coverage_data.write_text("stand-in for the data file stage 6 writes\n")

    env = dict(os.environ)
    # Inherited values would silently make every shim fail; each test opts in.
    env.pop(_PYTEST_EXIT_ENV, None)
    env.pop(_COVERAGE_EXIT_ENV, None)
    env["PATH"] = f"{shim_dir}{os.pathsep}{env['PATH']}"
    env[_PYTEST_LOG_ENV] = str(pytest_log)
    env[_COVERAGE_LOG_ENV] = str(coverage_log)
    env[COVERAGE_DATA_FILE_ENV] = str(coverage_data)

    return _ShimHarness(
        env=env,
        pytest_log=pytest_log,
        coverage_log=coverage_log,
        coverage_data=coverage_data,
    )


def _run_coverage_script(
    env: dict[str, str],
    *args: str,
) -> subprocess.CompletedProcess[str]:
    """Run the real ``coverage.sh`` with the shims in place.

    Args:
        env: Environment activating the shims.
        *args: Flags to pass to the script.

    Returns:
        The completed process, never raising on a non-zero exit code.
    """
    return subprocess.run(
        [str(_COVERAGE_SCRIPT), *args],
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=_SUBPROCESS_TIMEOUT_SECONDS,
    )


def _run_check_invocations() -> list[str]:
    """Return the ``run_check`` call lines of check-all.sh, excluding its definition."""
    return [
        line.strip()
        for line in _CHECK_ALL_SCRIPT.read_text().splitlines()
        if line.strip().startswith(_RUN_CHECK_CALL_PREFIX)
    ]


def test_report_only_reports_from_disk_without_running_the_suite(
    harness: _ShimHarness,
) -> None:
    """``--report-only`` renders the existing data instead of re-running pytest.

    The recorded invocations carry the whole contract: zero test runs (the point
    of the change), one ``coverage report`` still carrying the 90% threshold (so
    the consolidation cannot quietly drop the gate), and one ``coverage xml`` (so
    the artifact CI consumes is still produced).
    """
    result = _run_coverage_script(harness.env, REPORT_ONLY_FLAG, XML_FLAG)

    assert result.returncode == 0, result.stderr
    assert harness.pytest_calls() == [], (
        "--report-only must report from the coverage data on disk; "
        "invoking pytest reintroduces the duplicated suite run"
    )

    report_calls = harness.coverage_calls_named(COVERAGE_REPORT_COMMAND)
    assert len(report_calls) == 1, harness.coverage_calls()
    assert COVERAGE_THRESHOLD_FLAG in report_calls[0].split(), (
        f"the report must still fail under 90%; got: {report_calls[0]}"
    )
    assert len(harness.coverage_calls_named(COVERAGE_XML_COMMAND)) == 1, (
        f"--xml must still write coverage.xml; got: {harness.coverage_calls()}"
    )


def test_report_only_fails_loudly_when_the_coverage_data_is_missing(
    harness: _ShimHarness,
    tmp_path: Path,
) -> None:
    """A missing data file is an error, never a quiet pass or a stale number.

    This is the fail-open the consolidation could introduce: with nothing on
    disk to report, the only safe outcomes are a non-zero exit and a message
    naming the file that was looked for. Falling back to running the suite would
    silently restore the duplicated run, so that is asserted against too.
    """
    missing = tmp_path / "never-written" / ".coverage"
    env = {**harness.env, COVERAGE_DATA_FILE_ENV: str(missing)}

    result = _run_coverage_script(env, REPORT_ONLY_FLAG)

    assert result.returncode == COVERAGE_ERROR_EXIT_CODE, result.stderr
    assert MISSING_DATA_MESSAGE in result.stderr.lower(), (
        f"stderr must say the coverage data is missing; got: {result.stderr!r}"
    )
    assert str(missing) in result.stderr, (
        f"stderr must name the path it looked for; got: {result.stderr!r}"
    )
    assert harness.pytest_calls() == [], (
        "missing coverage data must abort, not fall back to running the suite"
    )


def test_report_only_fails_the_build_when_the_reporter_reports_a_shortfall(
    harness: _ShimHarness,
) -> None:
    """A threshold miss fails the gate and produces no passing artifact.

    Passing ``--fail-under`` to the reporter only matters if the reporter's
    verdict is honored, so the shortfall is simulated at its source: coverage.py
    exiting with its ``FAIL_UNDER`` status. The XML report is asserted absent
    because shipping CI an artifact rendered by a run that failed its own
    threshold is precisely the fail-open the consolidation must not open.
    """
    env = harness.with_coverage_exit(COVERAGE_PY_FAIL_UNDER_STATUS)

    result = _run_coverage_script(env, REPORT_ONLY_FLAG, XML_FLAG)

    assert result.returncode == BELOW_THRESHOLD_EXIT_CODE, (
        f"a shortfall must fail the build; got exit {result.returncode} "
        f"with stderr: {result.stderr!r}"
    )
    assert BELOW_THRESHOLD_MESSAGE in result.stderr.lower(), (
        f"stderr must name the shortfall; got: {result.stderr!r}"
    )
    assert harness.coverage_calls_named(COVERAGE_XML_COMMAND) == [], (
        f"a failing report must not go on to write coverage.xml; got: {harness.coverage_calls()}"
    )
    assert harness.pytest_calls() == [], (
        "a shortfall must be reported, not re-measured by running the suite"
    )


def test_report_only_distinguishes_a_reporter_error_from_a_shortfall(
    harness: _ShimHarness,
) -> None:
    """An unreadable data file is an error, not a coverage shortfall.

    coverage.py returns its generic error status for a corrupt data file or a
    bad configuration, which says nothing about how much code the suite covered.
    Collapsing it into the shortfall exit sends the operator off to write tests
    they do not need while the broken toolchain goes unmentioned, so the script
    keeps the two exit codes its own documentation promises.
    """
    env = harness.with_coverage_exit(COVERAGE_PY_ERROR_STATUS)

    result = _run_coverage_script(env, REPORT_ONLY_FLAG)

    assert result.returncode == COVERAGE_ERROR_EXIT_CODE, (
        f"a reporter error must exit {COVERAGE_ERROR_EXIT_CODE}, not "
        f"{BELOW_THRESHOLD_EXIT_CODE}; got exit {result.returncode} "
        f"with stderr: {result.stderr!r}"
    )
    assert BELOW_THRESHOLD_MESSAGE not in result.stderr.lower(), (
        f"a reporter error must not be reported as missing coverage; got: {result.stderr!r}"
    )
    assert result.stderr.strip(), "a failing run must tell the operator something"


def test_check_all_triggers_at_most_one_test_run() -> None:
    """Exactly one stage runs the suite, and the coverage stage only reports.

    Read statically because executing check-all.sh would run the full suite this
    change exists to stop running twice.
    """
    calls = _run_check_invocations()
    test_calls = [call for call in calls if TEST_RUNNER_SCRIPT in call]
    coverage_calls = [call for call in calls if COVERAGE_RUNNER_SCRIPT in call]

    assert len(test_calls) == 1, calls
    assert len(coverage_calls) == 1, calls
    assert REPORT_ONLY_FLAG in coverage_calls[0].split(), (
        f"the coverage stage must report from disk, not re-run pytest: {coverage_calls[0]}"
    )


def test_check_all_still_reports_all_seven_checks() -> None:
    """The operator-visible summary must not shrink as the stages consolidate.

    Speeding the gate up by deleting a check is not the fix being asked for, so
    every named check keeps its own pass or fail line.
    """
    calls = _run_check_invocations()

    for name in EXPECTED_CHECK_NAMES:
        assert any(call.startswith(f'{_RUN_CHECK_CALL_PREFIX}{name}"') for call in calls), (
            f"check {name!r} disappeared from the summary; got: {calls}"
        )
    assert len(calls) == len(EXPECTED_CHECK_NAMES), calls


def test_check_all_purges_stale_coverage_artifacts_before_the_test_stage() -> None:
    """Yesterday's data file must not survive into today's report.

    Reporting from disk is only trustworthy if the disk was cleared first:
    coverage.py appends parallel data files, and a leftover ``coverage.xml``
    would be handed to CI as if it described this run.
    """
    text = _CHECK_ALL_SCRIPT.read_text()
    marker = f'{_RUN_CHECK_CALL_PREFIX}{UNIT_TESTS_CHECK}"'
    assert marker in text
    preamble = text.split(marker)[0]

    for artifact in STALE_COVERAGE_ARTIFACTS:
        assert artifact in preamble, (
            f"{artifact} must be purged before the suite runs, "
            "or the coverage report can describe an earlier run"
        )


def test_coverage_script_without_flags_still_runs_the_suite(
    harness: _ShimHarness,
) -> None:
    """Standalone use is unchanged: no flags still means one full pytest run.

    The consolidation belongs to check-all.sh. Anyone invoking coverage.sh
    directly still gets a measured run, threshold included.
    """
    result = _run_coverage_script(harness.env)

    assert result.returncode == 0, result.stderr
    calls = harness.pytest_calls()
    assert len(calls) == 1, calls
    assert PYTEST_THRESHOLD_FLAG in calls[0].split(), (
        f"the standalone run must keep its own threshold; got: {calls[0]}"
    )
    assert harness.coverage_calls_named(COVERAGE_REPORT_COMMAND) == []
