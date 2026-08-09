"""Tests for the suite lock and targeted runs in ``scripts/backend/test.sh``.

Two whole-suite runs in one tree fight over the same coverage data file, the
same SQLite fixtures, and the same CPU allotment that ``-n auto`` sized for one
process. The results they print are not wrong so much as unproven: neither run
observed the machine it claims to describe. The lock below refuses the second
run outright rather than letting it produce a number nobody can act on, and it
does so by PID so a crashed run cannot wedge the tree forever.

The second half of the contract is the targeted run. Driving a single test file
through this script currently means either editing it or bypassing it, because
the whole-suite argv -- xdist distribution and marker selection -- is applied
unconditionally. That is what pushes people to call ``pytest`` directly during
the red-to-green loop, which is also how they discover the hard way that a
partial run cannot satisfy a whole-repo coverage threshold. So a positional path
runs exactly that path, unsharded and unfiltered, and asking for coverage
alongside it is a usage error rather than a confusing failure at the end.

Taking the lock is atomic; recovering from a stale one is the part that is not.
The recovery reads the holder, decides it is dead, removes the file, and creates
its own -- four steps, with a whole scheduling quantum available between any two
of them. Two runs that both looked at the same dead PID can therefore both come
away owning the suite, the second having deleted the first's brand-new lock on
the strength of a decision about a file that no longer existed. That is the one
outcome the lock exists to prevent, so it is tested by holding the window open
on purpose rather than by racing for it.

Every test copies the real script into a miniature checkout under ``tmp_path``
and drives it through a fake ``pytest`` on ``PATH`` that records its argv, can
be told to fail, can report what the lock file held while it ran, can overwrite
the lock to impersonate another owner, and can block until the test releases it.
A ``head`` shim beside it can freeze a run just after it has read the lock file,
which is the read half of the read-decide-remove-create sequence. Invoking the
real runner here is not merely slow: this file executes inside the very suite the
lock guards, so a real whole-suite run would take the lock against itself and
hang.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_TEST_SCRIPT = _REPO_ROOT / "scripts" / "backend" / "test.sh"

_SUBPROCESS_TIMEOUT_SECONDS = 60

# Documented exit codes. 3 is new and deliberately distinct from 1: "your tests
# failed" and "this result would not have been trustworthy" call for opposite
# responses from the operator.
_PASSED_EXIT_CODE = 0
_TESTS_FAILED_EXIT_CODE = 1
_USAGE_ERROR_EXIT_CODE = 2
_REFUSED_EXIT_CODE = 3

_LOCK_RELATIVE_PATH = Path(".gate-state") / "locks" / "backend-suite.lock"

# The whole-suite argv, which a targeted run must not inherit: xdist would shard
# a single file across workers whose module-scoped database fixtures assume one
# worker per file, and the marker expression would silently drop a test the
# caller named explicitly.
_WORKER_FLAG = "-n"
_DIST_FLAG = "--dist"
_DIST_STRATEGY = "loadfile"
_MARKER_FLAG = "-m"
_UNIT_MARKER_EXPRESSION = "not integration and not e2e"
_WHOLE_SUITE_TARGET = "tests/"

_TARGETED_PATH = "tests/test_fixture_module.py"
_TARGETED_NODE_ID = "tests/test_fixture_module.py::test_one_behaviour"

_COVERAGE_FLAG = "--coverage"
_COVERAGE_DATA_FLAG = "--coverage-data"
_UNKNOWN_FLAG = "--not-a-real-option"

# The words the refusal has to carry: the rule, so the operator understands the
# refusal is about trust rather than about tidiness, and the threshold, so the
# coverage rejection points at the reason instead of just saying no.
_UNPROVEN_MARKER = "unproven"
_THRESHOLD_MARKER = "threshold"

_PYTEST_LOG_ENV = "ADEPTHOOD_FAKE_PYTEST_LOG"
_PYTEST_EXIT_ENV = "ADEPTHOOD_FAKE_PYTEST_EXIT"
_LOCK_FILE_ENV = "ADEPTHOOD_LOCK_FILE"
_LOCK_PROBE_ENV = "ADEPTHOOD_LOCK_PROBE"
_HIJACK_PID_ENV = "ADEPTHOOD_HIJACK_PID"
_PATH_ENV = "PATH"

# Each names a file the corresponding shim waits for before returning, so a run
# can be frozen at a chosen point. ``pytest`` freezes a run that already holds
# the lock; ``head`` freezes one immediately after it has read the lock file,
# which is where the stale-lock recovery makes its decision.
_PYTEST_GATE_ENV = "ADEPTHOOD_PYTEST_GATE"
_HEAD_GATE_ENV = "ADEPTHOOD_HEAD_GATE"

# Written by a shim once it is actually blocked, so the test waits on an
# observed state rather than on a duration.
_BLOCKED_MARKER_SUFFIX = ".blocked"
_GATE_RELEASE_TEXT = "go\n"
_GATE_POLL_SECONDS = 0.02
_GATE_WAIT_TIMEOUT_SECONDS = 30.0

_WINNER_GATE_NAME = "winner-pytest-gate"
_LOSER_GATE_NAME = "loser-head-gate"

_ARGV_MARKER = "--ARGV--"
_SHIM_MODE = 0o755
_SHIM_DIR_NAME = "bin"
_CHECKOUT_DIR_NAME = "repo"
_OTHER_CHECKOUT_DIR_NAME = "other-repo"

_SCRIPT_RELATIVE_PATH = Path("scripts") / "backend" / "test.sh"
_BACKEND_TESTS_DIR = Path("backend") / "tests"

# A PID that no longer exists, standing in for a run killed mid-suite.
_DEAD_PID_SEARCH_START = 40000
_DEAD_PID_SEARCH_STOP = 49999

# The signals the release has to survive. A lock left behind by a run cancelled
# with a keystroke wedges the tree until somebody deletes a file they have never
# heard of, and the second-best outcome of that is a bypass flag.
_TRAP_SIGNALS = ("EXIT", "INT", "TERM")
_TRAP_KEYWORD = "trap"

_HIJACKING_PID = "999999"

# Placeholders are substituted by replacement rather than by ``str.format`` so
# the shell's own ``${...}`` expansions do not have to be brace-escaped, which
# is how a shim ends up writing to a path named after a literal dollar sign.
_PYTEST_SHIM = """#!/usr/bin/env bash
{ printf '%s\\n' "@MARKER@"; printf '%s\\n' "$@"; } >> "@LOG@"
if [ -n "${@PROBE@:-}" ] && [ -f "@LOCK@" ]; then
    cp "@LOCK@" "${@PROBE@}"
fi
if [ -n "${@HIJACK@:-}" ]; then
    printf '%s\\n' "${@HIJACK@}" > "@LOCK@"
fi
gate="${@PYTEST_GATE@:-}"
if [ -n "$gate" ] && [ ! -f "$gate" ]; then
    : > "$gate@BLOCKED@"
    while [ ! -f "$gate" ]; do sleep @POLL@; done
fi
exit "${@EXIT@:-0}"
"""

# Reads the lock file for real, then -- and only when the gate variable names a
# file that does not exist yet -- stalls before handing the answer back. That
# reproduces a run descheduled after the read in the read-decide-remove-create
# recovery, with the decision already made against the state it saw. Untouched
# in every other test: with the variable unset it is a plain delegation.
_HEAD_SHIM = """#!/usr/bin/env bash
answer="$("@REAL@" "$@")"
gate="${@HEAD_GATE@:-}"
if [ -n "$gate" ] && [ ! -f "$gate" ]; then
    : > "$gate@BLOCKED@"
    while [ ! -f "$gate" ]; do sleep @POLL@; done
fi
printf '%s\\n' "$answer"
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


def _real_executable(name: str) -> str:
    """Return the absolute path of a command before a shim shadows it.

    Args:
        name: Command whose real implementation a shim delegates to.

    Returns:
        The resolved path to the real command.
    """
    found = shutil.which(name)
    if found is None:
        pytest.fail(f"{name} is required to build the shim for {name}")
    return found


def _blocked_marker(gate: Path) -> Path:
    """Return the file a shim creates once it is blocked on this gate.

    Args:
        gate: Path the shim waits for.

    Returns:
        The announcement file's path.
    """
    return Path(f"{gate}{_BLOCKED_MARKER_SUFFIX}")


def _release(gate: Path) -> None:
    """Let whatever is blocked on this gate proceed; safe to call twice.

    Args:
        gate: Path the shim waits for.
    """
    gate.write_text(_GATE_RELEASE_TEXT)


def _wait_until_blocked(
    gate: Path,
    process: subprocess.Popen[str],
    reason: str,
) -> None:
    """Block until a run announces it is frozen, failing rather than hanging.

    Args:
        gate: Path the shim waits for; its marker is what this waits on.
        process: The run expected to reach the shim, so an early exit is
            reported as itself instead of as a timeout.
        reason: What the absent marker would mean, for the failure message.
    """
    marker = _blocked_marker(gate)
    deadline = time.monotonic() + _GATE_WAIT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if marker.exists():
            return
        if process.poll() is not None:
            pytest.fail(f"{reason}: the run exited {process.returncode} instead")
        time.sleep(_GATE_POLL_SECONDS)
    pytest.fail(f"{reason}: {marker} never appeared within {_GATE_WAIT_TIMEOUT_SECONDS}s")


def _dead_pid() -> int:
    """Return a PID that is not running, for the stale-lock cases.

    Returns:
        A process id no live process holds.
    """
    for candidate in range(_DEAD_PID_SEARCH_START, _DEAD_PID_SEARCH_STOP):
        try:
            os.kill(candidate, 0)
        except ProcessLookupError:
            return candidate
        except PermissionError:
            continue
    pytest.fail("no unused process id could be found for the stale-lock fixture")


def _invocations(log: Path) -> list[list[str]]:
    """Return the argv of every fake ``pytest`` call, one list per call.

    Args:
        log: File the shim appends to; absent until pytest is invoked once.

    Returns:
        The recorded argument lists, in invocation order.
    """
    if not log.exists():
        return []
    chunks = log.read_text().split(f"{_ARGV_MARKER}\n")
    return [[line for line in chunk.splitlines() if line] for chunk in chunks if chunk.strip()]


@dataclass(frozen=True)
class _Runner:
    """A miniature checkout the real test runner can be relocated into."""

    root: Path
    script: Path
    log: Path
    env: dict[str, str]

    def run(
        self,
        *args: str,
        extra_env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        """Invoke the runner and capture its outcome.

        Args:
            *args: Flags and positional paths passed to the script.
            extra_env: Additional environment entries, such as a forced exit.

        Returns:
            The completed process, never raising on a non-zero exit code.
        """
        return subprocess.run(
            [_bash_executable(), str(self.script), *args],
            cwd=self.root,
            env={**self.env, **(extra_env or {})},
            capture_output=True,
            text=True,
            check=False,
            timeout=_SUBPROCESS_TIMEOUT_SECONDS,
        )

    def spawn(
        self,
        *args: str,
        extra_env: dict[str, str] | None = None,
    ) -> subprocess.Popen[str]:
        """Start the runner without waiting for it, for the concurrency cases.

        Args:
            *args: Flags and positional paths passed to the script.
            extra_env: Additional environment entries, such as a shim gate.

        Returns:
            The running process, to be waited on once the test releases it.
        """
        return subprocess.Popen(
            [_bash_executable(), str(self.script), *args],
            cwd=self.root,
            env={**self.env, **(extra_env or {})},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def lock_path(self) -> Path:
        """Return this tree's whole-suite lock location.

        Returns:
            The lock path, whether or not it exists yet.
        """
        return self.root / _LOCK_RELATIVE_PATH

    def hold_lock(self, pid: int) -> Path:
        """Plant a lock file naming the given process.

        Args:
            pid: Process id recorded as the holder.

        Returns:
            The lock path that was written.
        """
        lock = self.lock_path()
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text(f"{pid}\n")
        return lock

    def invocations(self) -> list[list[str]]:
        """Return the argv of every fake ``pytest`` call.

        Returns:
            The recorded argument lists, in invocation order.
        """
        return _invocations(self.log)

    def only_invocation(self) -> list[str]:
        """Return the argv of the single expected ``pytest`` call.

        Returns:
            The recorded argument list.
        """
        calls = self.invocations()
        if len(calls) != 1:
            pytest.fail(f"expected exactly one pytest invocation; got: {calls}")
        return calls[0]

    def output(self, result: subprocess.CompletedProcess[str]) -> str:
        """Return both captured streams lowercased, for substring assertions.

        Args:
            result: A completed process whose streams were captured.

        Returns:
            stdout and stderr concatenated and lowercased.
        """
        return f"{result.stdout}{result.stderr}".lower()


def _stage_runner(parent: Path, *, directory_name: str = _CHECKOUT_DIR_NAME) -> _Runner:
    """Build a checkout holding the real runner and a fake ``pytest``.

    Args:
        parent: Directory the checkout and its shim are created under.
        directory_name: Name of the tree root, so two independent trees can
            coexist for the cross-tree isolation case.

    Returns:
        The staged runner, ready to invoke.
    """
    root = parent / directory_name
    (root / _SCRIPT_RELATIVE_PATH.parent).mkdir(parents=True)
    (root / _BACKEND_TESTS_DIR).mkdir(parents=True)
    shutil.copy(_TEST_SCRIPT, root / _SCRIPT_RELATIVE_PATH)

    shim_dir = parent / f"{_SHIM_DIR_NAME}-{directory_name}"
    shim_dir.mkdir(parents=True)
    log = parent / f"pytest-calls-{directory_name}.log"
    lock = root / _LOCK_RELATIVE_PATH
    substitutions = {
        "@MARKER@": _ARGV_MARKER,
        "@LOG@": str(log),
        "@LOCK@": str(lock),
        "@PROBE@": _LOCK_PROBE_ENV,
        "@HIJACK@": _HIJACK_PID_ENV,
        "@EXIT@": _PYTEST_EXIT_ENV,
        "@PYTEST_GATE@": _PYTEST_GATE_ENV,
        "@HEAD_GATE@": _HEAD_GATE_ENV,
        "@BLOCKED@": _BLOCKED_MARKER_SUFFIX,
        "@POLL@": str(_GATE_POLL_SECONDS),
        "@REAL@": _real_executable("head"),
    }
    for name, template in (("pytest", _PYTEST_SHIM), ("head", _HEAD_SHIM)):
        body = template
        for placeholder, value in substitutions.items():
            body = body.replace(placeholder, value)
        shim = shim_dir / name
        shim.write_text(body)
        shim.chmod(_SHIM_MODE)

    env = dict(os.environ)
    env[_PATH_ENV] = f"{shim_dir}{os.pathsep}{env[_PATH_ENV]}"
    env[_PYTEST_LOG_ENV] = str(log)
    env[_LOCK_FILE_ENV] = str(lock)
    for knob in (
        _PYTEST_EXIT_ENV,
        _LOCK_PROBE_ENV,
        _HIJACK_PID_ENV,
        _PYTEST_GATE_ENV,
        _HEAD_GATE_ENV,
    ):
        env.pop(knob, None)

    return _Runner(root=root, script=root / _SCRIPT_RELATIVE_PATH, log=log, env=env)


@pytest.fixture
def runner(tmp_path: Path) -> _Runner:
    """Return a staged runner with the fake ``pytest`` in place.

    Args:
        tmp_path: Per-test directory holding the checkout, shim and log.

    Returns:
        The staged runner under test.
    """
    return _stage_runner(tmp_path)


def test_a_second_whole_suite_run_is_refused_while_one_is_in_flight(
    runner: _Runner,
) -> None:
    """Two suites in one tree produce two results and prove neither.

    They share the coverage data file, the fixture database, and the cores that
    ``-n auto`` allocated to a single process. The honest response is to refuse
    the second run and say why, because a red that came from contention teaches
    the operator to rerun until green, which is how a real failure gets rerun
    away.
    """
    holder = os.getpid()
    runner.hold_lock(holder)

    result = runner.run()

    assert result.returncode == _REFUSED_EXIT_CODE, (
        f"a contended whole-suite run must exit {_REFUSED_EXIT_CODE}, distinctly "
        f"from a test failure; got exit {result.returncode} with "
        f"stderr: {result.stderr!r}"
    )
    assert str(holder) in f"{result.stdout}{result.stderr}", (
        f"the refusal must name the holding PID so it can be inspected or "
        f"killed; got: {result.stderr!r}"
    )
    assert _UNPROVEN_MARKER in runner.output(result), (
        f"the refusal must state that a contended result is unproven until "
        f"re-run alone; got: {result.stderr!r}"
    )
    assert runner.invocations() == [], "a refused run must not start pytest at all"


def test_a_lock_held_by_a_dead_process_is_stolen(runner: _Runner) -> None:
    """A crashed run must not wedge the tree until somebody deletes a file.

    A lock nobody can clear is worse than no lock: the documented workaround
    becomes deleting state by hand, and the next step from there is bypassing
    the gate entirely.
    """
    runner.hold_lock(_dead_pid())

    result = runner.run()

    assert result.returncode == _PASSED_EXIT_CODE, (
        f"a stale lock must be stolen, not obeyed; got exit {result.returncode} "
        f"with stderr: {result.stderr!r}"
    )
    assert len(runner.invocations()) == 1, runner.invocations()
    assert not runner.lock_path().exists(), "the stolen lock must be released at the end"


@dataclass(frozen=True)
class _Outcome:
    """What one of two concurrently started runs came away with."""

    returncode: int
    stdout: str
    stderr: str

    def output(self) -> str:
        """Return both captured streams, for substring assertions.

        Returns:
            stdout and stderr concatenated.
        """
        return f"{self.stdout}{self.stderr}"


def _await(process: subprocess.Popen[str]) -> _Outcome:
    """Wait for a spawned run and capture what it said.

    Args:
        process: A run started with :meth:`_Runner.spawn`.

    Returns:
        Its exit code and both streams.
    """
    stdout, stderr = process.communicate(timeout=_SUBPROCESS_TIMEOUT_SECONDS)
    return _Outcome(returncode=process.returncode, stdout=stdout, stderr=stderr)


def _race_two_stealers(runner: _Runner, tmp_path: Path) -> tuple[_Outcome, _Outcome]:
    """Point two whole-suite runs at one stale lock with the window held open.

    The loser is frozen by its ``head`` shim the instant it has read the stale
    PID -- decision made, file not yet removed. Only then is the winner started,
    and it is allowed to complete the whole steal and reach pytest, where its own
    shim holds it so the lock stays taken. Releasing the loser at that point
    replays exactly the interleaving a scheduler would produce by chance.

    Args:
        runner: The staged runner; both runs share its tree and its pytest log.
        tmp_path: Per-test directory holding the two gate files.

    Returns:
        The outcome of the run that acquired first, then of the run that was
        descheduled mid-recovery.
    """
    winner_gate = tmp_path / _WINNER_GATE_NAME
    loser_gate = tmp_path / _LOSER_GATE_NAME
    runner.hold_lock(_dead_pid())

    with contextlib.ExitStack() as stack:
        loser = stack.enter_context(runner.spawn(extra_env={_HEAD_GATE_ENV: str(loser_gate)}))
        stack.callback(_release, loser_gate)
        _wait_until_blocked(loser_gate, loser, "the second run never read the stale lock")

        winner = stack.enter_context(runner.spawn(extra_env={_PYTEST_GATE_ENV: str(winner_gate)}))
        stack.callback(_release, winner_gate)
        _wait_until_blocked(winner_gate, winner, "the first run never reached pytest")

        _release(loser_gate)
        loser_outcome = _await(loser)
        _release(winner_gate)
        winner_outcome = _await(winner)

    return winner_outcome, loser_outcome


def test_two_runs_stealing_one_stale_lock_do_not_both_proceed(
    runner: _Runner,
    tmp_path: Path,
) -> None:
    """Only the fast path is atomic; the stale-lock recovery has to be too.

    Recovering from a dead holder is four steps -- read the PID, judge it dead,
    remove the file, create a new one -- and nothing binds them together. Two
    runs that both read the same dead PID can both conclude they may steal; the
    second then removes the first's brand-new lock on the strength of a decision
    about a file that no longer exists, and creates its own. Both proceed, which
    is precisely the concurrent whole-suite run the lock exists to refuse:
    one coverage data file, one set of fixture databases, and cores that
    ``-n auto`` handed out twice.

    The assertion is on how many times pytest was started, not on the lock
    file's contents, because starting the suite twice is the harm. A version of
    this test that started both runs and hoped they collided would pass on a
    loaded machine, pass on a fast one, and never once prove the window was
    closed -- a green that means nothing is worse than no test, because it
    licenses the next change to the recovery path.

    Args:
        runner: The staged runner.
        tmp_path: Per-test directory holding the two shim gates.
    """
    winner, loser = _race_two_stealers(runner, tmp_path)

    assert len(runner.invocations()) == 1, (
        "two whole-suite runs started pytest against the same tree; the second "
        "stole a lock it had already decided was stale. Invocations: "
        f"{runner.invocations()}"
    )
    assert winner.returncode == _PASSED_EXIT_CODE, (
        f"the run that acquired the lock must finish normally; got exit "
        f"{winner.returncode} with stderr: {winner.stderr!r}"
    )
    assert loser.returncode == _REFUSED_EXIT_CODE, (
        f"the run descheduled mid-recovery must be refused with exit "
        f"{_REFUSED_EXIT_CODE} once it finds the lock taken; got exit "
        f"{loser.returncode} with output: {loser.output()!r}"
    )


def test_the_lock_is_held_for_the_duration_and_released_afterwards(
    runner: _Runner,
    tmp_path: Path,
) -> None:
    """The lock exists while the suite runs and is gone once it stops.

    Taking it after the suite, or never writing the PID into it, would leave the
    refusal above with nothing to detect and nothing to name.
    """
    probe = tmp_path / "lock-during-run.txt"

    result = runner.run(extra_env={_LOCK_PROBE_ENV: str(probe)})

    assert result.returncode == _PASSED_EXIT_CODE, result.stderr
    assert probe.exists(), "no lock file existed while the suite was running"
    recorded = probe.read_text().strip()
    assert recorded.isdigit(), (
        f"the lock must contain the holding PID so a stale one can be detected; got: {recorded!r}"
    )
    assert recorded != str(os.getpid()), (
        "the lock recorded this test process rather than the running script"
    )
    assert not runner.lock_path().exists(), "the lock must be released when the run ends"


def test_the_lock_is_released_after_a_failing_run(
    runner: _Runner,
    tmp_path: Path,
) -> None:
    """Failing tests are the normal case, so they must not leave a lock behind.

    Releasing only on success would mean the first red run blocks every
    subsequent run in that tree, which converts an ordinary failure into an
    unexplained refusal. The probe is what makes this test mean something: a
    run that never took the lock at all would also end with no lock file.
    """
    probe = tmp_path / "lock-during-failing-run.txt"

    result = runner.run(
        extra_env={
            _PYTEST_EXIT_ENV: str(_TESTS_FAILED_EXIT_CODE),
            _LOCK_PROBE_ENV: str(probe),
        },
    )

    assert result.returncode == _TESTS_FAILED_EXIT_CODE, (
        f"test failures must still exit {_TESTS_FAILED_EXIT_CODE}; got exit "
        f"{result.returncode} with stderr: {result.stderr!r}"
    )
    assert probe.exists(), "the failing run never held the lock, so releasing it proves nothing"
    assert not runner.lock_path().exists(), (
        "a failing run left its lock behind, so the next run in this tree is refused"
    )


def test_a_run_does_not_release_a_lock_it_no_longer_owns(runner: _Runner) -> None:
    """Release is by ownership, not by path.

    If the holder was stolen from -- because this run overran and another took
    over -- deleting the file on the way out would strip the new owner's
    protection and let a third run start against a suite already in flight.
    """
    result = runner.run(extra_env={_HIJACK_PID_ENV: _HIJACKING_PID})

    assert result.returncode == _PASSED_EXIT_CODE, result.stderr
    lock = runner.lock_path()
    assert lock.exists(), (
        "the lock was removed by a process that no longer owned it, unprotecting "
        "whichever run took it over"
    )
    assert lock.read_text().strip() == _HIJACKING_PID, lock.read_text()


def test_the_release_trap_covers_interruption_and_termination() -> None:
    """A cancelled run releases its lock, or the tree is wedged by a keystroke.

    Read statically because the interesting states are a signal delivered
    mid-suite, which cannot be staged without running a suite.
    """
    trap_lines = [
        line.strip()
        for line in _TEST_SCRIPT.read_text().splitlines()
        if line.strip().startswith(_TRAP_KEYWORD)
    ]

    assert trap_lines, f"{_TEST_SCRIPT.name} installs no trap, so a cancelled run keeps the lock"
    assert any(all(signal in line.split() for signal in _TRAP_SIGNALS) for line in trap_lines), (
        f"one trap must cover {list(_TRAP_SIGNALS)}; got: {trap_lines}"
    )


def test_a_lock_in_another_tree_does_not_block_this_one(
    runner: _Runner,
    tmp_path: Path,
) -> None:
    """Worktree lanes run in parallel and must not serialise against each other.

    The contention being prevented is over one tree's shared files. A lock keyed
    anywhere but the tree root would collapse four independent lanes into a
    queue and cost more time than the whole change saves.
    """
    other = _stage_runner(tmp_path, directory_name=_OTHER_CHECKOUT_DIR_NAME)
    other.hold_lock(os.getpid())

    result = runner.run()

    assert result.returncode == _PASSED_EXIT_CODE, (
        f"a lock held in an unrelated tree blocked this one; got exit "
        f"{result.returncode} with stderr: {result.stderr!r}"
    )
    assert len(runner.invocations()) == 1, runner.invocations()


def test_a_targeted_run_neither_takes_nor_blocks_on_the_lock(runner: _Runner) -> None:
    """One file is cheap and shares almost nothing, so it is allowed to proceed.

    Blocking it would make the red-to-green loop wait on a suite the developer
    is not interested in, and taking the lock would let a trivial run refuse the
    whole-suite run behind it. The warning is what stops a surprising result
    from being read as a real one, since the machine really is busy.
    """
    holder = os.getpid()
    lock = runner.hold_lock(holder)

    result = runner.run(_TARGETED_PATH)

    assert result.returncode == _PASSED_EXIT_CODE, (
        f"a targeted run must not be blocked by the suite lock; got exit "
        f"{result.returncode} with stderr: {result.stderr!r}"
    )
    assert str(holder) in f"{result.stdout}{result.stderr}", (
        f"a targeted run under contention must warn and name the holder; got: "
        f"{result.stdout!r} {result.stderr!r}"
    )
    assert lock.read_text().strip() == str(holder), (
        "a targeted run must leave the whole-suite lock exactly as it found it"
    )


def test_a_targeted_run_creates_no_lock(runner: _Runner) -> None:
    """Nothing is written for a run that does not need protecting.

    A lock taken and released by every single-file run is a window in which the
    whole-suite run is refused for no reason at all.
    """
    result = runner.run(_TARGETED_PATH)

    assert result.returncode == _PASSED_EXIT_CODE, result.stderr
    assert not runner.lock_path().exists(), (
        "a targeted run created the whole-suite lock, which can refuse an unrelated full run"
    )


def test_a_positional_path_runs_pytest_on_exactly_that_path(runner: _Runner) -> None:
    """The named path is run, alone, unsharded and unfiltered.

    Sharding one file across xdist workers breaks the module-scoped database
    fixtures the suite relies on, and applying the unit marker expression would
    silently drop a test the caller asked for by name. Appending the whole
    ``tests/`` tree would quietly restore the full run the caller was avoiding.
    """
    result = runner.run(_TARGETED_PATH)

    assert result.returncode == _PASSED_EXIT_CODE, result.stderr
    argv = runner.only_invocation()
    assert _TARGETED_PATH in argv, f"the requested path must be run; got: {argv}"
    for unwanted in (_WORKER_FLAG, _DIST_FLAG, _MARKER_FLAG, _WHOLE_SUITE_TARGET):
        assert unwanted not in argv, (
            f"a targeted run must not carry the whole-suite argument {unwanted!r}; got: {argv}"
        )


def test_a_node_id_is_passed_through_unchanged(runner: _Runner) -> None:
    """A single test can be named, which is the whole point during a fix.

    Rewriting or splitting the ``::`` syntax would turn a request for one test
    into a request for its file, and the developer would never notice.
    """
    result = runner.run(_TARGETED_NODE_ID)

    assert result.returncode == _PASSED_EXIT_CODE, result.stderr
    argv = runner.only_invocation()
    assert _TARGETED_NODE_ID in argv, f"the node id must reach pytest intact; got: {argv}"


@pytest.mark.parametrize("flag", [_COVERAGE_FLAG, _COVERAGE_DATA_FLAG])
def test_coverage_with_a_positional_path_is_a_usage_error(
    runner: _Runner,
    flag: str,
) -> None:
    """A partial run cannot satisfy a whole-repo threshold, so it is refused up front.

    Allowing the combination produces a run that measures one file against a
    ninety-percent gate over the whole codebase and fails for a reason that has
    nothing to do with the test being written. Failing at parse time, with the
    reason stated, is the difference between a lesson and an hour lost.

    Args:
        runner: The staged runner.
        flag: The coverage option combined with a positional path.
    """
    result = runner.run(flag, _TARGETED_PATH)

    assert result.returncode == _USAGE_ERROR_EXIT_CODE, (
        f"{flag} with a positional path must exit {_USAGE_ERROR_EXIT_CODE}; got "
        f"exit {result.returncode} with stderr: {result.stderr!r}"
    )
    assert _THRESHOLD_MARKER in runner.output(result), (
        f"the refusal must explain that a partial run cannot meet a whole-repo "
        f"coverage threshold; got: {result.stderr!r}"
    )
    assert runner.invocations() == [], "a usage error must not start pytest"


def test_an_unknown_flag_is_still_a_usage_error(runner: _Runner) -> None:
    """Accepting positional paths must not turn a typo into a silent path.

    Existing contract, pinned so the new parsing keeps it: a mistyped option
    that fell through to the positional list would be handed to pytest as a
    file name and reported as a collection error nobody can read.
    """
    result = runner.run(_UNKNOWN_FLAG)

    assert result.returncode == _USAGE_ERROR_EXIT_CODE, (
        f"got exit {result.returncode} with stderr: {result.stderr!r}"
    )
    assert _UNKNOWN_FLAG in result.stderr, (
        f"stderr must name the rejected flag; got: {result.stderr!r}"
    )


def test_a_whole_suite_run_keeps_its_distribution_and_marker_selection(
    runner: _Runner,
) -> None:
    """The default invocation is unchanged by the addition of targeted runs.

    The distribution strategy and the marker expression are what make the full
    run correct and fast; a refactor that reached them while adding positional
    handling would quietly change what the gate measures.
    """
    result = runner.run()

    assert result.returncode == _PASSED_EXIT_CODE, result.stderr
    argv = runner.only_invocation()
    for expected in (
        _WORKER_FLAG,
        _DIST_FLAG,
        _DIST_STRATEGY,
        _MARKER_FLAG,
        _UNIT_MARKER_EXPRESSION,
        _WHOLE_SUITE_TARGET,
    ):
        assert expected in argv, f"the whole-suite invocation lost {expected!r}; got: {argv}"


# --- the pre-push hook must not bypass the lock this module exists to prove ---

_HOOK_ID = "backend-tests-coverage"
_RUNNER_PATH = "scripts/backend/test.sh"


def _hook_entry(hook_id: str) -> str:
    """Return the ``entry:`` line of one pre-commit hook, as raw text.

    Parsed as text rather than with PyYAML on purpose: that package is absent
    from every requirements file here, and importing it turns this guard into a
    collection error on the 3.11 compat job instead of a test.
    """
    config = (_REPO_ROOT / ".pre-commit-config.yaml").read_text()
    block = config.split(f"- id: {hook_id}", 1)[1]
    for line in block.splitlines():
        if line.strip().startswith("entry:"):
            return line
    raise AssertionError(f"hook {hook_id!r} has no entry: line")


def test_the_pre_push_suite_hook_routes_through_the_test_script() -> None:
    """The pre-push whole-suite run takes the lock, like every other whole-suite run.

    The hook used to invoke ``pytest`` directly, which is the one path in the
    repo that runs the entire suite *without* acquiring
    ``.gate-state/locks/backend-suite.lock``. That is not a style point: a
    ``git push`` firing while ``check-all.sh`` is mid-run gives two whole-suite
    runs sharing one coverage data file, one set of SQLite fixtures, and the
    cores ``-n auto`` sized for a single process. Neither result describes the
    machine it claims to -- and the failure is a wrong *number*, not a crash,
    so nothing announces it.

    ``test.sh --all --coverage`` is the same run: it distributes
    (``-n "$PYTEST_WORKERS" --dist loadfile``) and applies
    ``--cov-fail-under=90``, and it takes the lock first.
    """
    entry = _hook_entry(_HOOK_ID)

    assert _RUNNER_PATH in entry, (
        f"the {_HOOK_ID} hook must run the whole suite through {_RUNNER_PATH}, "
        f"which takes the whole-suite lock; got: {entry.strip()}"
    )
    assert "pytest -n auto" not in entry, (
        f"the hook invokes pytest directly, bypassing the whole-suite lock; got: {entry.strip()}"
    )
