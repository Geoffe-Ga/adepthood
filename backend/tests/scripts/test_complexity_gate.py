"""Tests for the complexity gate in ``scripts/backend/complexity.sh``.

The complexity stage of ``check-all.sh`` does not gate. It fails open three
separate ways, and each one alone is enough to let unmaintainable code walk
past a check that prints a tick.

First, the maintainability call is ``radon mi -a src/ || true``. ``-a`` belongs
to ``radon cc``, so ``radon mi`` rejects the argv, writes an argparse usage
error to stderr, and exits 2 -- which ``|| true`` discards. Repairing the argv
is necessary but not sufficient: ``radon`` is a reporter, not a gate. It exits
0 while printing a module ranked C, so the only way to gate the maintainability
index is to treat non-empty ``radon mi -n C`` output as the failure. The index
has therefore never been enforced at all, only printed.

Second, ``xenon`` runs at ``--max-absolute B --max-modules B --max-average B``
-- a full letter more lenient than the documented A-grade threshold and than
the pre-push hook, which already gates at A. B-grade code passes the local gate
and then fails CI, which is the specific failure mode that teaches operators to
distrust the local gate. That drift exists because the thresholds are written
down twice, in this script and again inline in ``.pre-commit-config.yaml``, so
the tests below also pin the single-source-of-truth arrangement that keeps the
two from diverging again.

Third, a missing ``radon`` or ``xenon`` prints a warning and exits 0, so a
broken toolchain is indistinguishable from clean code.

The script has no in-process seam and deliberately gains none: it derives its
target from ``SCRIPT_DIR/../../backend``, so each test copies the real,
unmodified script into a miniature checkout under ``tmp_path`` and runs it
there against a purpose-built module. The fake ``backend/`` carries the same
``[tool.radon]`` block as the real one -- read from it verbatim, so the copy
cannot drift -- because radon reads that config from the working directory the
script cds into. Replicating it keeps the fixture faithful and simultaneously
proves the gate's own thresholds win over ambient configuration.

Two of the fixtures are chosen so that a failure is attributable to exactly one
metric. The maintainability violator is 120 straight-line assignments with no
functions at all: it has no cyclomatic blocks, so xenon passes it at A/A/A and
only a real maintainability gate can catch it. The cyclomatic violator is a
single seven-branch function that ranks B on complexity and A on
maintainability, so it is caught only by tightening xenon back to A.

The ``.pre-commit-config.yaml`` and ``check-all.sh`` wiring is asserted by
reading the files rather than by executing them, following the static
assertions in ``test_coverage_report_only.py``; running ``check-all.sh`` would
run the entire backend suite.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCRIPTS_DIR = _REPO_ROOT / "scripts" / "backend"
_COMPLEXITY_SCRIPT = _SCRIPTS_DIR / "complexity.sh"
_CHECK_ALL_SCRIPT = _SCRIPTS_DIR / "check-all.sh"
_BACKEND_PYPROJECT = _REPO_ROOT / "backend" / "pyproject.toml"
_PRE_COMMIT_CONFIG = _REPO_ROOT / ".pre-commit-config.yaml"

_SUBPROCESS_TIMEOUT_SECONDS = 120

# The script's own documented exit codes. Conflating "your code is too complex"
# with "the analyser could not run" sends an operator to refactor code that is
# fine while the broken toolchain goes unmentioned.
_ACCEPTABLE_EXIT_CODE = 0
_THRESHOLD_EXIT_CODE = 1
_ANALYSIS_ERROR_EXIT_CODE = 2

# radon's maintainability bands are A = 100-20, B = 19-10, C = 9-0, so the
# documented "MI >= B" threshold makes rank C the violation and ``-n C`` the
# filter that lists offenders.
_MI_VIOLATION_RANK = "C"
# xenon's documented thresholds: A-grade absolute, modules, and average.
_XENON_STRICT_ARGS = (
    "--max-absolute",
    "A",
    "--max-modules",
    "A",
    "--max-average",
    "A",
)

# Substrings the operator needs in order to reach for the right metric. Pinned
# as substrings so the exact phrasing stays the implementer's choice.
_MAINTAINABILITY_MESSAGE = "maintainability"
_COMPLEXITY_MESSAGE = "complexity"

# argparse's own output when radon rejects the argv. Its presence anywhere in a
# passing run means the analyser never ran and the tick was unearned.
_RADON_ARGV_ERROR_MARKERS = ("usage: radon", "unrecognized arguments")

# Thresholds the help text still advertises, both superseded: A-grade
# cyclomatic complexity is <= 5, not <= 10, and the maintainability floor is
# rank B, which starts at 10, not 20.
_SUPERSEDED_THRESHOLD_STRINGS = ("<= 10", ">= 20")
_HELP_FLAG = "--help"
_HELP_USAGE_MARKER = "Usage:"
_UNKNOWN_FLAG = "--not-a-real-option"

# Only the system directories, so the venv's radon and xenon are unreachable
# while bash, dirname, and cat remain available on macOS and CI Linux alike.
_TOOLLESS_PATH = "/usr/bin:/bin"
_PATH_ENV = "PATH"
_TOOL_NAMES = ("radon", "xenon")

# Enough straight-line statements to reach rank C with margin; 80 already
# reaches it, and the module holds no functions, so xenon sees nothing at all.
_MI_VIOLATION_STATEMENT_COUNT = 120
_GENERATED_MODULE_DOCSTRING = '"""Fixture module staged for the complexity gate."""'

_MI_VIOLATOR_MODULE = "sprawling.py"
_BRANCHING_MODULE = "branching.py"
_CLEAN_MODULE = "arithmetic.py"

# One function, seven branches: rank B on cyclomatic complexity and rank A on
# the maintainability index, so xenon at A/A/A is the only thing that can
# reject it.
_BRANCHING_SOURCE = '''"""Fixture module staged for the complexity gate."""


def classify(value: int) -> str:
    """Return a size label for the value."""
    if value < 0:
        return "negative"
    if value == 0:
        return "zero"
    if value < 10:
        return "small"
    if value < 100:
        return "medium"
    if value < 1000:
        return "large"
    if value < 10000:
        return "huge"
    return "enormous"
'''

_CLEAN_SOURCE = '''"""Fixture module staged for the complexity gate."""


def add(left: int, right: int) -> int:
    """Return the sum of the two operands."""
    return left + right
'''

_RADON_CONFIG_HEADER = "[tool.radon]"
_TOML_SECTION_SEPARATOR = "\n["

# Wiring the consolidation must produce, and the wiring it must remove.
_COMPLEXITY_SCRIPT_REFERENCE = "scripts/backend/complexity.sh"
_NON_GATING_MI_HOOK_ENTRY = "radon mi src/ -n B"
# Threshold flags restated in the hook config are the mechanism by which the
# script drifted to B in the first place, so they belong in one file only.
_DUPLICATED_THRESHOLD_FLAGS = ("--max-absolute", "--max-modules", "--max-average")

_COMPLEXITY_CHECK_NAME = "Complexity analysis"
_COMPLEXITY_SCRIPT_NAME = "complexity.sh"
_RUN_CHECK_CALL_PREFIX = 'run_check "'


def _radon_config_section() -> str:
    """Return the real backend ``[tool.radon]`` block, verbatim.

    Read rather than duplicated so the staged checkout keeps matching the
    ambient configuration production actually runs under.

    Returns:
        The section header plus its keys, ending before the next TOML table.
    """
    text = _BACKEND_PYPROJECT.read_text()
    if _RADON_CONFIG_HEADER not in text:
        pytest.fail(f"{_BACKEND_PYPROJECT} no longer defines {_RADON_CONFIG_HEADER}")
    body = text.split(_RADON_CONFIG_HEADER, 1)[1].split(_TOML_SECTION_SEPARATOR, 1)[0]
    return f"{_RADON_CONFIG_HEADER}{body}"


def _mi_violator_source() -> str:
    """Return a module dense enough to rank C on the maintainability index.

    Every statement is a top-level assignment, so the module contains no
    cyclomatic blocks whatsoever and xenon has nothing to object to.

    Returns:
        Python source for the staged fixture module.
    """
    lines = [_GENERATED_MODULE_DOCSTRING, ""]
    lines.extend(
        f"variable_{index} = ({index} + {index + 1}) * ({index + 2} - {index + 3})"
        f" / ({index + 4} or 1) + ({index + 5} % ({index + 6} or 1))"
        f" - ({index + 7} ** 2)"
        for index in range(_MI_VIOLATION_STATEMENT_COUNT)
    )
    return "\n".join(lines) + "\n"


@dataclass(frozen=True)
class _StagedCheckout:
    """A miniature checkout the real script can be relocated into and run."""

    script: Path
    source_dir: Path


def _stage_checkout(tmp_path: Path, module_name: str, source: str) -> _StagedCheckout:
    """Build the tree layout the script derives its target directory from.

    Args:
        tmp_path: Per-test directory that becomes the fake repository root.
        module_name: Filename of the fixture module placed in ``backend/src``.
        source: Python source written into that module.

    Returns:
        The relocated script and the source directory it will analyse.
    """
    scripts_dir = tmp_path / "scripts" / "backend"
    scripts_dir.mkdir(parents=True)
    source_dir = tmp_path / "backend" / "src"
    source_dir.mkdir(parents=True)

    script = scripts_dir / _COMPLEXITY_SCRIPT.name
    # copy, not copyfile: the executable bit has to survive.
    shutil.copy(_COMPLEXITY_SCRIPT, script)
    (tmp_path / "backend" / "pyproject.toml").write_text(_radon_config_section())
    (source_dir / module_name).write_text(source)

    return _StagedCheckout(script=script, source_dir=source_dir)


def _bash_executable() -> str:
    """Return an absolute path to bash, failing the test if there is none.

    Returns:
        The resolved interpreter path, so the subprocess call never relies on
        a partial executable name.
    """
    found = shutil.which("bash")
    if found is None:
        pytest.fail("bash is required to exercise the shell scripts under test")
    return found


def _run_script(
    script: Path,
    *args: str,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run a complexity script and capture its outcome.

    Args:
        script: The script to execute, real or relocated.
        *args: Flags to pass through to it.
        env: Environment for the child; ``None`` inherits the current one.

    Returns:
        The completed process, never raising on a non-zero exit code.
    """
    return subprocess.run(
        [_bash_executable(), str(script), *args],
        capture_output=True,
        text=True,
        check=False,
        env=env,
        timeout=_SUBPROCESS_TIMEOUT_SECONDS,
    )


def _run_tool(*args: str) -> subprocess.CompletedProcess[str]:
    """Run one of the analysers directly, through the current interpreter.

    Args:
        *args: The module name followed by its own arguments.

    Returns:
        The completed process, never raising on a non-zero exit code.
    """
    return subprocess.run(
        [sys.executable, "-m", *args],
        capture_output=True,
        text=True,
        check=False,
        timeout=_SUBPROCESS_TIMEOUT_SECONDS,
    )


def _combined_output(result: subprocess.CompletedProcess[str]) -> str:
    """Return both captured streams lowercased, for substring assertions.

    Args:
        result: A completed process whose streams were captured.

    Returns:
        stdout and stderr concatenated and lowercased.
    """
    return f"{result.stdout}{result.stderr}".lower()


def _run_check_invocations() -> list[str]:
    """Return the ``run_check`` call lines of check-all.sh, excluding its definition.

    Returns:
        The stripped call lines, in the order the script runs them.
    """
    return [
        line.strip()
        for line in _CHECK_ALL_SCRIPT.read_text().splitlines()
        if line.strip().startswith(_RUN_CHECK_CALL_PREFIX)
    ]


def test_maintainability_violation_fails_the_gate(tmp_path: Path) -> None:
    """A module ranked C on the maintainability index must fail the build.

    This is the fault the broken argv hides twice over: the analyser is never
    reached, and even when it is reached it exits 0 while printing the
    violation. Nothing short of inspecting radon's output can turn this into a
    failure, so a passing run here means the index is still only decorative.
    """
    checkout = _stage_checkout(tmp_path, _MI_VIOLATOR_MODULE, _mi_violator_source())

    result = _run_script(checkout.script)

    assert result.returncode == _THRESHOLD_EXIT_CODE, (
        f"a rank-{_MI_VIOLATION_RANK} module must fail the gate; got exit "
        f"{result.returncode} with stdout: {result.stdout!r} stderr: {result.stderr!r}"
    )
    assert _MAINTAINABILITY_MESSAGE in result.stderr.lower(), (
        f"stderr must name the maintainability index; got: {result.stderr!r}"
    )
    assert _MI_VIOLATOR_MODULE in _combined_output(result), (
        f"the offending module must be named; got: {_combined_output(result)!r}"
    )


def test_the_maintainability_violator_is_invisible_to_xenon(tmp_path: Path) -> None:
    """The fixture isolates the maintainability metric from the xenon one.

    This is what makes the previous test's failure attributable. The module
    genuinely ranks C, xenon at its strictest passes it because there are no
    cyclomatic blocks to rank, and radon still exits 0 while reporting the
    violation -- which is precisely why the gate has to read radon's output
    rather than its exit status.
    """
    checkout = _stage_checkout(tmp_path, _MI_VIOLATOR_MODULE, _mi_violator_source())

    report = _run_tool("radon", "mi", "-s", "-n", _MI_VIOLATION_RANK, str(checkout.source_dir))
    assert _MI_VIOLATOR_MODULE in report.stdout, (
        f"the fixture must genuinely rank {_MI_VIOLATION_RANK}; radon said: {report.stdout!r}"
    )
    assert report.returncode == _ACCEPTABLE_EXIT_CODE, (
        "radon reports violations without failing; a gate built on its exit "
        f"status would pass. Got exit {report.returncode}"
    )

    strict_xenon = _run_tool("xenon", *_XENON_STRICT_ARGS, str(checkout.source_dir))
    assert strict_xenon.returncode == _ACCEPTABLE_EXIT_CODE, (
        "xenon must pass this fixture, or a failing gate proves nothing about "
        f"the maintainability index; got: {strict_xenon.stderr!r}"
    )


def test_cyclomatic_violation_fails_the_gate(tmp_path: Path) -> None:
    """A rank-B function must fail the gate, at the documented A-grade threshold.

    The script gates at B, so this module passes locally today and is rejected
    by the pre-push hook and by CI, which both already gate at A. The fixture
    ranks A on maintainability, so the only thing that can reject it is xenon
    tightened back to the documented threshold.
    """
    checkout = _stage_checkout(tmp_path, _BRANCHING_MODULE, _BRANCHING_SOURCE)

    result = _run_script(checkout.script)

    assert result.returncode == _THRESHOLD_EXIT_CODE, (
        "a rank-B block must fail the gate at the documented A-grade threshold; "
        f"got exit {result.returncode} with stdout: {result.stdout!r} stderr: {result.stderr!r}"
    )
    assert _COMPLEXITY_MESSAGE in result.stderr.lower(), (
        f"stderr must name cyclomatic complexity; got: {result.stderr!r}"
    )
    assert _MAINTAINABILITY_MESSAGE not in result.stderr.lower(), (
        "a complexity failure must not be reported as a maintainability one, or "
        f"the operator is sent to the wrong metric; got: {result.stderr!r}"
    )
    assert _BRANCHING_MODULE in _combined_output(result), (
        f"the offending module must be named; got: {_combined_output(result)!r}"
    )


def test_clean_tree_passes_without_an_argv_error(tmp_path: Path) -> None:
    """Clean code passes, and no analyser was silently rejected on the way.

    A tick printed while argparse complains on stderr is the whole defect. The
    argv assertion is what stops the gate from being "fixed" by leaving the bad
    flag in place, and it is only meaningful alongside the violation tests: a
    gate that aborts on anything would pass those and fail this one.
    """
    checkout = _stage_checkout(tmp_path, _CLEAN_MODULE, _CLEAN_SOURCE)

    result = _run_script(checkout.script)

    assert result.returncode == _ACCEPTABLE_EXIT_CODE, (
        f"clean code must pass; got exit {result.returncode} with "
        f"stdout: {result.stdout!r} stderr: {result.stderr!r}"
    )
    combined = _combined_output(result)
    for marker in _RADON_ARGV_ERROR_MARKERS:
        assert marker not in combined, (
            f"the run reported success while an analyser rejected its arguments "
            f"({marker!r}); got: {combined!r}"
        )


def test_missing_analysers_are_an_error_not_a_pass(tmp_path: Path) -> None:
    """An unavailable toolchain must be loud, never a third silent success.

    Warning and exiting 0 makes a broken environment indistinguishable from
    clean code, which is the most expensive of the three fail-opens: it hides
    the other two.
    """
    checkout = _stage_checkout(tmp_path, _CLEAN_MODULE, _CLEAN_SOURCE)
    env = {**os.environ, _PATH_ENV: _TOOLLESS_PATH}

    result = _run_script(checkout.script, env=env)

    assert result.returncode == _ANALYSIS_ERROR_EXIT_CODE, (
        f"an unavailable analyser must exit {_ANALYSIS_ERROR_EXIT_CODE}; got exit "
        f"{result.returncode} with stdout: {result.stdout!r} stderr: {result.stderr!r}"
    )
    assert any(tool in result.stderr.lower() for tool in _TOOL_NAMES), (
        f"stderr must name the missing analyser so it can be installed; got: {result.stderr!r}"
    )


def test_help_no_longer_advertises_the_superseded_thresholds() -> None:
    """The help text must not document numbers the gate does not enforce.

    Help that promises a cyclomatic ceiling of 10 and a maintainability floor
    of 20 describes neither the gate nor the documented thresholds, so an
    operator reading it draws the wrong conclusion about code that passed.
    """
    result = _run_script(_COMPLEXITY_SCRIPT, _HELP_FLAG)

    assert result.returncode == _ACCEPTABLE_EXIT_CODE, result.stderr
    assert _HELP_USAGE_MARKER in result.stdout, (
        f"{_HELP_FLAG} must still print usage; got: {result.stdout!r}"
    )
    for stale in _SUPERSEDED_THRESHOLD_STRINGS:
        assert stale not in result.stdout, (
            f"the help still advertises the superseded threshold {stale!r}; got: {result.stdout!r}"
        )


def test_unknown_option_is_an_analysis_error() -> None:
    """An unrecognised flag stays a loud error naming the flag.

    Existing contract, asserted so the rewrite keeps it: a typo must not be
    silently ignored and then reported as a clean run.
    """
    result = _run_script(_COMPLEXITY_SCRIPT, _UNKNOWN_FLAG)

    assert result.returncode == _ANALYSIS_ERROR_EXIT_CODE, (
        f"got exit {result.returncode} with stderr: {result.stderr!r}"
    )
    assert _UNKNOWN_FLAG in result.stderr, (
        f"stderr must name the rejected flag; got: {result.stderr!r}"
    )


def test_pre_push_complexity_hooks_route_through_the_script() -> None:
    """Pre-push and check-all must gate through one implementation.

    The B-drift happened because the two paths were written independently. If
    the hooks keep invoking the analysers themselves, the next threshold change
    lands in one place and not the other and the drift returns.
    """
    config = _PRE_COMMIT_CONFIG.read_text()

    assert _COMPLEXITY_SCRIPT_REFERENCE in config, (
        f"pre-push complexity gating must call {_COMPLEXITY_SCRIPT_REFERENCE}, not reimplement it"
    )
    assert _NON_GATING_MI_HOOK_ENTRY not in config, (
        f"the hook entry {_NON_GATING_MI_HOOK_ENTRY!r} cannot fail a push: radon "
        "exits 0 whatever it prints"
    )


def test_pre_commit_config_does_not_restate_the_complexity_thresholds() -> None:
    """The thresholds live in the script alone, so they cannot diverge again.

    Duplicated literals are the root cause under repair, not an incidental
    detail: the script said B while the hook said A for as long as both were
    allowed to carry their own copy.
    """
    config = _PRE_COMMIT_CONFIG.read_text()

    for flag in _DUPLICATED_THRESHOLD_FLAGS:
        assert flag not in config, (
            f"{flag} is restated in {_PRE_COMMIT_CONFIG.name}; thresholds belong "
            f"only in {_COMPLEXITY_SCRIPT_REFERENCE}"
        )


def test_check_all_still_runs_the_complexity_check() -> None:
    """The gate stays wired into check-all.sh.

    Read statically because running check-all.sh runs the whole backend suite.
    """
    calls = _run_check_invocations()
    complexity_calls = [
        call
        for call in calls
        if call.startswith(f'{_RUN_CHECK_CALL_PREFIX}{_COMPLEXITY_CHECK_NAME}"')
    ]

    assert len(complexity_calls) == 1, calls
    assert _COMPLEXITY_SCRIPT_NAME in complexity_calls[0], complexity_calls[0]
