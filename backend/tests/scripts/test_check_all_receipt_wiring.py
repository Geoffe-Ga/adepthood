"""Tests for the receipt wiring in ``scripts/backend/check-all.sh``.

The gate runs every stage from scratch every time, including the runs where
nothing it measures has moved. Absorbing main into a worktree lane routinely
changes only planning notes, and paying a full backend suite to discover that
is the cost this wiring removes: the gate asks the receipt primitive whether the
verdict it already earned still describes this tree, and reuses it when it does.

The danger in that trade is obvious and the tests are weighted accordingly. Most
of them assert the gate ran anyway. The single most important one asserts that
the security stage runs even on a short-circuit: lint, format, mypy, complexity
and the tests are a pure function of the fingerprinted inputs, but ``pip-audit``
consults an advisory database over the network, so an advisory published after
the receipt was written would make an unchanged tree print green about a
vulnerability that now exists. A cached security check is a cached lie with a
publication date on it. The dependency-drift preflight runs for the same reason:
it compares the installed environment against the pinned requirements, which can
change without any file in the tree changing.

Recording is fenced just as tightly. A receipt is written only when a full run
passed every stage AND the tree was byte-identical at the start and the end of
the run. Without that second condition, editing a file while a seven-minute
suite is in flight records a verdict for a tree that was never tested as a
whole -- half the run measured the old bytes and half the new.

The skip is asserted to live inside the ``run_check`` helper rather than at its
call sites, because two existing suites parse the seven ``run_check "`` lines of
this script as text. A rewrite that renamed or restructured those calls would
turn this change into a silent failure of unrelated tests, so the coupling is
pinned here where it is visible.

Nothing here runs a real stage. The sibling stage scripts are replaced with
shims in a miniature checkout under ``tmp_path``: each records that it ran, can
be told to fail, and can be told to edit the tree mid-run. Running the real
``check-all.sh`` in place would run the very suite this change exists to stop
re-running -- and would deadlock against the whole-suite lock while this file is
itself executing under that suite.
"""

from __future__ import annotations

import itertools
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from tests.helpers.git_env import detached_git_env

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCRIPTS_DIR = _REPO_ROOT / "scripts" / "backend"
_CHECK_ALL_SCRIPT = _SCRIPTS_DIR / "check-all.sh"
_VERIFIED_SCRIPT = _REPO_ROOT / "scripts" / "quality" / "verified.sh"

_CLAUDE_DOC = _REPO_ROOT / "CLAUDE.md"
_AGENTS_DOC = _REPO_ROOT / "AGENTS.md"
_RALPH_PROMPT = _REPO_ROOT / "scripts" / "ralph" / "PROMPT.md"
_STAY_GREEN_SKILL = _REPO_ROOT / ".claude" / "skills" / "stay-green" / "SKILL.md"

_SUBPROCESS_TIMEOUT_SECONDS = 120

_GATE = "backend"
_FORCE_FLAG = "--force"

_ALL_PASSED_EXIT_CODE = 0
_CHECK_FAILED_EXIT_CODE = 1

# Stage scripts, split by whether a receipt may excuse them. The two always-run
# stages measure things no content hash can see: the installed environment, and
# an advisory database that changes without the tree changing.
_DEPS_STAGE = "deps.sh"
_SECURITY_STAGE = "security.sh"
_ALWAYS_RUN_STAGES = (_DEPS_STAGE, _SECURITY_STAGE)
_SKIPPABLE_STAGES = (
    "lint.sh",
    "format.sh",
    "typecheck.sh",
    "complexity.sh",
    "test.sh",
    "coverage.sh",
)
_ALL_STAGES = (*_ALWAYS_RUN_STAGES, *_SKIPPABLE_STAGES)

# The operator-visible check names, in the order the script runs them. Two other
# suites match these as text, so the skip must not touch the call sites.
_EXPECTED_CHECK_NAMES = (
    "Linting",
    "Formatting",
    "Type checking",
    "Security checks",
    "Complexity analysis",
    "Unit tests",
    "Coverage report",
)
_RUN_CHECK_CALL_PREFIX = 'run_check "'

_RECEIPTS_DIR = Path(".gate-state") / "receipts"
_RECEIPT_SUFFIX = ".receipt"
_RECORDED_AT_FIELD = "recorded_at"

_TREE_CHANGED_MESSAGE = "tree changed during the run"
_SECURITY_MENTION = "security"

_MARKER_DIR_ENV = "ADEPTHOOD_MARKER_DIR"
_FAILING_STAGE_ENV = "ADEPTHOOD_FAILING_STAGE"
_MUTATE_ON_STAGE_ENV = "ADEPTHOOD_MUTATE_ON_STAGE"
_MUTATE_FILE_ENV = "ADEPTHOOD_MUTATE_FILE"

_PATH_ENV = "PATH"
_VIRTUALENV_ENV = "VIRTUAL_ENV"
_POSTGRES_URL_ENV = "TEST_POSTGRES_URL"
_REQUIRE_POSTGRES_ENV = "INTEGRATION_LANE_REQUIRE_POSTGRES"
_FAKE_PIP_FREEZE_ENV = "ADEPTHOOD_FAKE_PIP_FREEZE"
_FAKE_PYTHON_VERSION_ENV = "ADEPTHOOD_FAKE_PYTHON_VERSION"
_FAKE_HOSTNAME_ENV = "ADEPTHOOD_FAKE_HOSTNAME"

_BASELINE_PIP_FREEZE = "example-package==1.0.0"
_BASELINE_PYTHON_VERSION = "Python 3.12.0 (stub build)"
_BASELINE_HOSTNAME = "gate-host-one"
_BASELINE_VIRTUALENV = "/opt/gate/venv-one"

_SHIM_MODE = 0o755
_SHIM_DIR_NAME = "bin"
_CHECKOUT_DIR_NAME = "repo"
_MARKERS_DIR_NAME = "markers"
_RUN_DIR_PREFIX = "run-"

_CHECK_ALL_RELATIVE_PATH = Path("scripts") / "backend" / "check-all.sh"
_VERIFIED_RELATIVE_PATH = Path("scripts") / "quality" / "verified.sh"
_BACKEND_DIR = Path("backend")
_MUTABLE_FILE = _BACKEND_DIR / "src" / "service.py"
_PRE_COMMIT_CONFIG = Path(".pre-commit-config.yaml")

# Comfortably above any degenerate-input floor, so the ample checkout is never
# mistaken for a misconfigured gate.
_TRACKED_FILE_COUNT = 80
_SPARSE_FILE_COUNT = 0

_MODULE_TEXT = '"""Fixture module measured by the backend gate."""\n\nVALUE = 1\n'
_PYPROJECT_TEXT = "[tool.example]\nvalue = 1\n"
_PRE_COMMIT_TEXT = "repos: []\n"
_MID_RUN_EDIT_TEXT = "EDITED_WHILE_THE_GATE_RAN = True"

_DEFAULT_BRANCH = "main"
_INITIAL_COMMIT_MESSAGE = "stage the fixture checkout"
_GIT_IDENTITY_ARGS = (
    "-c",
    "user.email=gate@example.invalid",
    "-c",
    "user.name=Gate Fixture",
    "-c",
    "commit.gpgsign=false",
)

# The documentation this change has to correct. The unconditional instruction to
# run every hook over every file before every commit is what trains an operator
# to treat the gate as a ritual rather than a signal; the replacement is nuanced
# rather than absent, so only the unconditional phrasing is asserted against.
_UNCONDITIONAL_MANDATE_CASES = (
    pytest.param(_CLAUDE_DOC, "before every commit attempt", id="claude-guardrail"),
    pytest.param(_CLAUDE_DOC, "do this before every commit", id="claude-command-comment"),
    pytest.param(_AGENTS_DOC, "before attempting a commit", id="agents-feedback-loop"),
)

# The rule an operator needs when a run is refused, and the file name that lets
# them find the lock that refused it.
_CONCURRENCY_RULE_MARKERS = ("concurrent", "backend-suite.lock")
_CONCURRENCY_DOC_CASES = (
    pytest.param(_RALPH_PROMPT, id="ralph-prompt"),
    pytest.param(_STAY_GREEN_SKILL, id="stay-green-skill"),
)

_STAGE_SHIM = """#!/usr/bin/env bash
STAGE="@STAGE@"
printf '%s\\n' "$*" >> "$ADEPTHOOD_MARKER_DIR/$STAGE"
if [ "${ADEPTHOOD_MUTATE_ON_STAGE:-}" = "$STAGE" ]; then
    printf '%s\\n' "@MID_RUN_EDIT@" >> "$ADEPTHOOD_MUTATE_FILE"
fi
if [ "${ADEPTHOOD_FAILING_STAGE:-}" = "$STAGE" ]; then
    exit 1
fi
exit 0
"""

_PIP_SHIM = """#!/usr/bin/env bash
if [ "${{1:-}}" = "freeze" ]; then
    printf '%s\\n' "${{{freeze_env}:-{default}}}"
    exit 0
fi
exit 0
"""

_PYTHON_SHIM = """#!/usr/bin/env bash
if [ "${{1:-}}" = "-VV" ]; then
    printf '%s\\n' "${{{version_env}:-{default}}}"
    exit 0
fi
exec "{real}" "$@"
"""

_UNAME_SHIM = """#!/usr/bin/env bash
if [ "${{1:-}}" = "-n" ]; then
    printf '%s\\n' "${{{hostname_env}:-{default}}}"
    exit 0
fi
exec "{real}" "$@"
"""


def _bash_executable() -> str:
    """Return an absolute path to bash, failing the test if there is none.

    Returns:
        The resolved interpreter path.
    """
    found = shutil.which("bash")
    if found is None:
        pytest.fail("bash is required to exercise the shell scripts under test")
    return found


def _git_executable() -> str:
    """Return an absolute path to git, failing the test if there is none.

    Returns:
        The resolved git path used to build the miniature checkout.
    """
    found = shutil.which("git")
    if found is None:
        pytest.fail("git is required to build the fixture checkout")
    return found


def _real_executable(name: str) -> str:
    """Return the absolute path of a command before the shims shadow it.

    Args:
        name: Command whose real implementation a shim delegates to.

    Returns:
        The resolved path to the real command.
    """
    found = shutil.which(name)
    if found is None:
        pytest.fail(f"{name} is required to build the shim for {name}")
    return found


def _require_script(path: Path) -> Path:
    """Return the script path, failing with a clear reason when it is absent.

    Args:
        path: Location the production script is expected to occupy.

    Returns:
        The same path, once its existence is established.
    """
    if not path.exists():
        pytest.fail(f"{path} does not exist; the gate-receipt wiring is unimplemented")
    return path


def _write(root: Path, relative: Path, text: str) -> None:
    """Write a fixture file into the staged checkout, creating parents.

    Args:
        root: Tree root of the staged checkout.
        relative: Path of the file relative to that root.
        text: Contents to write.
    """
    destination = root / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(text)


def _git(root: Path, *args: str) -> None:
    """Run a git command inside the staged checkout, failing the test on error.

    Args:
        root: Working directory for the command.
        *args: Arguments following ``git``.
    """
    env = detached_git_env(GIT_CONFIG_GLOBAL=os.devnull)
    result = subprocess.run(
        [_git_executable(), *_GIT_IDENTITY_ARGS, *args],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=_SUBPROCESS_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        pytest.fail(f"git {args} failed in {root}: {result.stdout!r} {result.stderr!r}")


def _install_stage_shims(scripts_dir: Path) -> None:
    """Replace every sibling stage script with a recorder.

    Args:
        scripts_dir: The staged ``scripts/backend`` directory.
    """
    for stage in _ALL_STAGES:
        shim = scripts_dir / stage
        shim.write_text(
            _STAGE_SHIM.replace("@STAGE@", stage).replace("@MID_RUN_EDIT@", _MID_RUN_EDIT_TEXT),
        )
        shim.chmod(_SHIM_MODE)


def _install_tool_shims(shim_dir: Path) -> None:
    """Write the ``pip``, ``python3`` and ``uname`` stand-ins onto disk.

    The fingerprint reads all three, so they are pinned to fixed values; a
    machine-dependent component would make the receipt tests flaky rather than
    wrong, which is worse.

    Args:
        shim_dir: Directory that will be prepended to ``PATH``.
    """
    shim_dir.mkdir(parents=True, exist_ok=True)
    pip = shim_dir / "pip"
    pip.write_text(
        _PIP_SHIM.format(freeze_env=_FAKE_PIP_FREEZE_ENV, default=_BASELINE_PIP_FREEZE),
    )
    python = shim_dir / "python3"
    python.write_text(
        _PYTHON_SHIM.format(
            version_env=_FAKE_PYTHON_VERSION_ENV,
            default=_BASELINE_PYTHON_VERSION,
            real=_real_executable("python3"),
        ),
    )
    uname = shim_dir / "uname"
    uname.write_text(
        _UNAME_SHIM.format(
            hostname_env=_FAKE_HOSTNAME_ENV,
            default=_BASELINE_HOSTNAME,
            real=_real_executable("uname"),
        ),
    )
    for shim in (pip, python, uname):
        shim.chmod(_SHIM_MODE)


@dataclass(frozen=True)
class _Run:
    """One invocation of the staged gate, plus the markers it left behind."""

    result: subprocess.CompletedProcess[str]
    marker_dir: Path

    def stages_that_ran(self) -> set[str]:
        """Return the names of the stage scripts that were invoked.

        Returns:
            One entry per stage that recorded a marker.
        """
        return {marker.name for marker in self.marker_dir.iterdir()}

    def output(self) -> str:
        """Return both captured streams lowercased, for substring assertions.

        Returns:
            stdout and stderr concatenated and lowercased.
        """
        return f"{self.result.stdout}{self.result.stderr}".lower()


@dataclass
class _Gate:
    """A miniature checkout whose stages are recorders rather than real checks."""

    root: Path
    script: Path
    markers_root: Path
    env: dict[str, str]
    runs: itertools.count[int] = field(default_factory=itertools.count)

    def run(self, *args: str, extra_env: dict[str, str] | None = None) -> _Run:
        """Invoke the staged gate with a fresh marker directory.

        Args:
            *args: Flags passed to ``check-all.sh``.
            extra_env: Additional environment entries, such as a stage to fail.

        Returns:
            The completed process together with the markers it produced.
        """
        marker_dir = self.markers_root / f"{_RUN_DIR_PREFIX}{next(self.runs)}"
        marker_dir.mkdir(parents=True)
        env = {**self.env, _MARKER_DIR_ENV: str(marker_dir), **(extra_env or {})}
        result = subprocess.run(
            [_bash_executable(), str(self.script), *args],
            cwd=self.root,
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=_SUBPROCESS_TIMEOUT_SECONDS,
        )
        return _Run(result=result, marker_dir=marker_dir)

    def receipt_path(self) -> Path:
        """Return the location of the backend gate's receipt.

        Returns:
            The single per-gate receipt path, whether or not it exists yet.
        """
        return self.root / _RECEIPTS_DIR / f"{_GATE}{_RECEIPT_SUFFIX}"


def _stage_gate(
    parent: Path,
    *,
    tracked_file_count: int = _TRACKED_FILE_COUNT,
) -> _Gate:
    """Build a checkout holding the real gate, the real primitive, and shims.

    Markers are written outside the tree root on purpose: a stage that recorded
    itself inside a fingerprinted path would make every run look like a tree
    edited mid-flight.

    Args:
        parent: Directory the checkout, shims and markers are created under.
        tracked_file_count: Number of filler modules inside the declared paths.

    Returns:
        The staged gate, ready to run.
    """
    root = parent / _CHECKOUT_DIR_NAME
    scripts_dir = root / _CHECK_ALL_RELATIVE_PATH.parent
    scripts_dir.mkdir(parents=True)
    (root / _VERIFIED_RELATIVE_PATH.parent).mkdir(parents=True)

    shutil.copy(_require_script(_CHECK_ALL_SCRIPT), root / _CHECK_ALL_RELATIVE_PATH)
    shutil.copy(_require_script(_VERIFIED_SCRIPT), root / _VERIFIED_RELATIVE_PATH)
    _install_stage_shims(scripts_dir)

    _write(root, _PRE_COMMIT_CONFIG, _PRE_COMMIT_TEXT)
    _write(root, _BACKEND_DIR / "pyproject.toml", _PYPROJECT_TEXT)
    _write(root, _MUTABLE_FILE, _MODULE_TEXT)
    for index in range(tracked_file_count):
        _write(root, _BACKEND_DIR / "src" / f"filler_{index:03d}.py", _MODULE_TEXT)

    _git(root, "init", "-q", "-b", _DEFAULT_BRANCH)
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "--no-verify", "-m", _INITIAL_COMMIT_MESSAGE)

    _install_tool_shims(parent / _SHIM_DIR_NAME)
    env = detached_git_env()
    env[_PATH_ENV] = f"{parent / _SHIM_DIR_NAME}{os.pathsep}{env[_PATH_ENV]}"
    env[_VIRTUALENV_ENV] = _BASELINE_VIRTUALENV
    env[_FAKE_PIP_FREEZE_ENV] = _BASELINE_PIP_FREEZE
    env[_FAKE_PYTHON_VERSION_ENV] = _BASELINE_PYTHON_VERSION
    env[_FAKE_HOSTNAME_ENV] = _BASELINE_HOSTNAME
    env.pop(_POSTGRES_URL_ENV, None)
    env.pop(_REQUIRE_POSTGRES_ENV, None)
    env.pop(_FAILING_STAGE_ENV, None)
    env.pop(_MUTATE_ON_STAGE_ENV, None)

    return _Gate(
        root=root,
        script=root / _CHECK_ALL_RELATIVE_PATH,
        markers_root=parent / _MARKERS_DIR_NAME,
        env=env,
    )


@pytest.fixture
def gate(tmp_path: Path) -> _Gate:
    """Return an ample staged gate with recorder stages in place.

    Args:
        tmp_path: Per-test directory holding the checkout, shims and markers.

    Returns:
        The staged gate under test.
    """
    return _stage_gate(tmp_path)


def _run_check_invocations() -> list[str]:
    """Return the ``run_check`` call lines of the real check-all.sh.

    Returns:
        The stripped call lines, in the order the script runs them.
    """
    return [
        line.strip()
        for line in _CHECK_ALL_SCRIPT.read_text().splitlines()
        if line.strip().startswith(_RUN_CHECK_CALL_PREFIX)
    ]


def _receipt_field(text: str, key: str) -> str:
    """Return one ``key=value`` field of a receipt.

    Args:
        text: Full receipt contents.
        key: Field name to extract.

    Returns:
        The field's value with surrounding whitespace removed.
    """
    match = re.search(rf"^\s*{key}\s*=\s*(?P<value>\S.*?)\s*$", text, re.MULTILINE)
    if match is None:
        pytest.fail(f"the receipt does not record {key!r}; got: {text!r}")
    return match.group("value")


def _record_a_receipt(subject: _Gate) -> _Run:
    """Run the gate once so a receipt exists to be reused.

    Args:
        subject: The staged gate.

    Returns:
        The completed first run, asserted green and asserted to have recorded.
    """
    first = subject.run()
    assert first.result.returncode == _ALL_PASSED_EXIT_CODE, first.result.stderr
    assert subject.receipt_path().exists(), (
        "a full run with every stage passing must record a receipt, or nothing "
        f"downstream can ever be reused; output: {first.output()!r}"
    )
    return first


def test_a_matching_receipt_skips_the_deterministic_stages(gate: _Gate) -> None:
    """Lint, format, mypy, complexity and the suite are reused, not re-run.

    These five are a pure function of the fingerprinted inputs, so re-deriving
    them from an identical tree buys nothing and costs the whole reason the gate
    gets skipped by hand instead of run.
    """
    _record_a_receipt(gate)

    second = gate.run()

    assert second.result.returncode == _ALL_PASSED_EXIT_CODE, second.result.stderr
    ran = second.stages_that_ran()
    for stage in _SKIPPABLE_STAGES:
        assert stage not in ran, (
            f"{stage} ran again against an unchanged tree; the receipt bought "
            f"nothing. Stages that ran: {sorted(ran)}"
        )


def test_a_matching_receipt_still_runs_security_and_the_drift_preflight(
    gate: _Gate,
) -> None:
    """The two network- and environment-dated stages are never cached.

    ``pip-audit`` asks an advisory database that changes without any file in
    the tree changing, so a fingerprint match says nothing about whether the
    dependencies are still safe today. The drift preflight is exempt for the
    mirror-image reason: it compares the installed packages against the pinned
    requirements, and the installed packages are not part of the tree at all.
    A short-circuit that skipped either would turn the receipt into a way of
    outrunning a vulnerability disclosure.
    """
    _record_a_receipt(gate)

    second = gate.run()

    ran = second.stages_that_ran()
    for stage in _ALWAYS_RUN_STAGES:
        assert stage in ran, (
            f"{stage} was skipped on a receipt hit, so a change it alone can "
            f"detect would go unreported. Stages that ran: {sorted(ran)}"
        )


def test_force_runs_every_stage_despite_a_matching_receipt(gate: _Gate) -> None:
    """The escape hatch re-derives everything from scratch.

    An operator who suspects the cache needs a way to prove the tree from
    nothing, and it has to be a flag on this run rather than a way to delete
    or forge receipts.
    """
    _record_a_receipt(gate)

    forced = gate.run(_FORCE_FLAG)

    assert forced.result.returncode == _ALL_PASSED_EXIT_CODE, forced.result.stderr
    assert forced.stages_that_ran() == set(_ALL_STAGES), (
        f"{_FORCE_FLAG} must run every stage; ran: {sorted(forced.stages_that_ran())}"
    )


def test_a_first_run_executes_every_stage_and_records_a_receipt(gate: _Gate) -> None:
    """With nothing recorded, the gate does all the work and banks the result.

    Recording is the whole point of the full run; a gate that never writes a
    receipt is simply the old gate with extra code paths.
    """
    first = gate.run()

    assert first.result.returncode == _ALL_PASSED_EXIT_CODE, first.result.stderr
    assert first.stages_that_ran() == set(_ALL_STAGES), (
        f"a run with no receipt must run everything; ran: {sorted(first.stages_that_ran())}"
    )
    assert gate.receipt_path().exists(), "a clean full run must record a receipt"


def test_a_failing_stage_records_no_receipt(gate: _Gate) -> None:
    """A red run banks nothing, so the next run cannot inherit its green.

    Recording unconditionally at the end would make the very first failure
    permanent: the next invocation would short-circuit past the stage that
    failed and report success.
    """
    failed = gate.run(extra_env={_FAILING_STAGE_ENV: "lint.sh"})

    assert failed.result.returncode == _CHECK_FAILED_EXIT_CODE, (
        f"a failing stage must fail the gate; got exit {failed.result.returncode}"
    )
    assert not gate.receipt_path().exists(), (
        "a run with a failing check recorded a receipt, so the failure can be "
        "skipped past on the next invocation"
    )


def test_a_tree_edited_during_the_run_records_no_receipt(gate: _Gate) -> None:
    """A run that measured two different trees proves nothing about either.

    Editing a file while a long suite is in flight is ordinary developer
    behaviour, and the resulting run tested the old bytes in some stages and
    the new bytes in others. Recording the end-state fingerprint would attach
    that mixture's green to a tree that was never checked as a whole, and the
    operator would never know, so the run stays green while the receipt is
    withheld and the reason is said out loud.
    """
    edited = gate.run(
        extra_env={
            _MUTATE_ON_STAGE_ENV: "test.sh",
            _MUTATE_FILE_ENV: str(gate.root / _MUTABLE_FILE),
        },
    )

    assert edited.result.returncode == _ALL_PASSED_EXIT_CODE, (
        f"every stage passed, so the run itself is green; got exit "
        f"{edited.result.returncode} with output: {edited.output()!r}"
    )
    assert not gate.receipt_path().exists(), (
        "the tree changed mid-run, so the verdict describes a mixture of two "
        "trees and must not be banked"
    )
    assert _TREE_CHANGED_MESSAGE in edited.output(), (
        f"the withheld receipt must be explained; got: {edited.output()!r}"
    )


def test_the_short_circuit_names_the_gate_the_time_and_the_security_stage(
    gate: _Gate,
) -> None:
    """A reused verdict has to say what it is reusing and what it still ran.

    An operator looking at a gate that finished in seconds needs three facts to
    trust it: which gate was reused, when that verdict was earned, and that the
    security stage was not part of the bargain.
    """
    _record_a_receipt(gate)
    recorded_at = _receipt_field(gate.receipt_path().read_text(), _RECORDED_AT_FIELD)

    second = gate.run()

    output = second.output()
    assert _GATE in output, f"the short-circuit must name the gate; got: {output!r}"
    assert recorded_at.lower() in output, (
        f"the short-circuit must name when the verdict was earned "
        f"({recorded_at!r}); got: {output!r}"
    )
    assert _SECURITY_MENTION in output, (
        f"the short-circuit must state that the security stage still ran; got: {output!r}"
    )


def test_a_gate_that_cannot_be_evaluated_runs_everything(tmp_path: Path) -> None:
    """An unevaluable receipt is not permission to skip, nor a reason to fail.

    The primitive refuses degenerate input rather than hashing the empty string
    into a fingerprint that matches everywhere. The caller's only safe response
    is to do all the work, and it must not turn an otherwise-green run red just
    because the cache was unusable.
    """
    sparse = _stage_gate(tmp_path, tracked_file_count=_SPARSE_FILE_COUNT)

    run = sparse.run()

    assert run.stages_that_ran() == set(_ALL_STAGES), (
        "an unevaluable receipt check must fall back to the full gate; ran: "
        f"{sorted(run.stages_that_ran())}"
    )
    assert run.result.returncode == _ALL_PASSED_EXIT_CODE, (
        "every stage passed, so an unusable cache must not fail the run; got "
        f"exit {run.result.returncode} with output: {run.output()!r}"
    )


def test_the_seven_run_check_call_lines_are_unchanged() -> None:
    """The skip lives inside ``run_check``, not at its call sites.

    Two other suites in this directory read these lines as text to discover the
    stage names and the flags they carry. Implementing the short-circuit by
    renaming, conditioning, or reordering the calls would break those suites
    from a distance, which is the kind of coupling that gets diagnosed as a
    flaky test rather than as a design decision.
    """
    calls = _run_check_invocations()

    assert len(calls) == len(_EXPECTED_CHECK_NAMES), (
        f"expected exactly {len(_EXPECTED_CHECK_NAMES)} run_check calls; got: {calls}"
    )
    for call, name in zip(calls, _EXPECTED_CHECK_NAMES, strict=True):
        assert call.startswith(f'{_RUN_CHECK_CALL_PREFIX}{name}"'), (
            f"the call line for {name!r} changed shape, which breaks the suites "
            f"that parse it as text; got: {call!r}"
        )


@pytest.mark.parametrize(("document", "mandate"), _UNCONDITIONAL_MANDATE_CASES)
def test_the_docs_drop_the_unconditional_whole_tree_precommit_mandate(
    document: Path,
    mandate: str,
) -> None:
    """Running every hook over every file before every commit is no longer the rule.

    The instruction is what teaches an operator that the gate is a ritual with a
    fixed price rather than a signal proportional to the change, and a fixed
    price that high is what makes bypassing it attractive. The replacement keeps
    the whole-tree run available for the cases that need it -- wide renames,
    suspected cross-file type errors -- so this asserts only that the
    unconditional phrasing is gone, not that the command is never mentioned.

    Args:
        document: The documentation file under test.
        mandate: The unconditional phrasing that must no longer appear.
    """
    text = document.read_text()

    assert mandate not in text, (
        f"{document.name} still issues the unconditional mandate {mandate!r}; "
        "the rule must become proportional to the change being made"
    )


@pytest.mark.parametrize("document", _CONCURRENCY_DOC_CASES)
def test_the_agent_docs_state_the_no_concurrent_suite_rule(document: Path) -> None:
    """Agents driving lanes must know why a suite run can be refused outright.

    A worker that meets the refusal without having read the rule will read it as
    a broken script and route around it, which is precisely the behaviour the
    lock exists to prevent. Naming the lock file gives them somewhere to look.

    Args:
        document: The agent-facing document under test.
    """
    text = document.read_text().lower()

    for marker in _CONCURRENCY_RULE_MARKERS:
        assert marker in text, (
            f"{document.name} does not state the no-concurrent-suite rule "
            f"(missing {marker!r}), so an agent meeting the refusal has nothing to read"
        )
