"""Tests for the pre-push hook reusing a fresh check-all receipt.

``./scripts/backend/check-all.sh`` runs the unit suite under coverage and
enforces the 90% threshold. The ``backend-tests-coverage`` pre-push hook then
ran the same suite again from scratch, on every push, without ever asking
whether anything had changed in between. ``test.sh --reuse-verified-unit`` lets
the hook skip exactly the part check-all already proved -- and nothing else.

What check-all proves is narrower than what the hook runs. Its suite is
``-m "not integration and not e2e"``; the hook's SQLite pass has no marker
filter, so it also runs the integration- and e2e-marked tests that live outside
``tests/integration``, and then the Postgres pass over ``tests/integration``.
So a reuse may skip only the unit selection: the remainder still runs, every
time. The coverage threshold does carry over, because the denominator is fixed
by the configured source set -- running more tests can only raise the number.

The receipt is keyed on the WHOLE tree (gate ``backend-suite``), not on the
backend gate's narrower paths, because the unit suite reads files outside
``backend/`` and ``scripts/`` -- workflows, ADRs, CLAUDE.md, frontend sources.
And a receipt describes a working tree, while a push describes a commit, so the
reuse additionally demands a clean tree and that the pushed sha is HEAD.

Most tests here assert that the hook did NOT reuse: a miss, an unevaluable
receipt, a dirty tree in every shape, a sha mismatch, and the flag being absent
each have to fall back to the unchanged full run. A failing remainder test must
still fail the push.

Nothing here runs a real suite. The real ``test.sh`` and ``verified.sh`` are
copied into a miniature git checkout under ``tmp_path`` and driven through a
fake ``pytest`` that records its argv; ``pip``, ``python3`` and ``uname`` are
pinned so the receipt's environment components are stable.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

from tests.helpers.git_env import detached_git_env

_REPO_ROOT = Path(__file__).resolve().parents[3]
_TEST_SCRIPT = _REPO_ROOT / "scripts" / "backend" / "test.sh"
_VERIFIED_SCRIPT = _REPO_ROOT / "scripts" / "quality" / "verified.sh"
_PRE_COMMIT_CONFIG_PATH = _REPO_ROOT / ".pre-commit-config.yaml"
_CLAUDE_DOC = _REPO_ROOT / "CLAUDE.md"

_SUBPROCESS_TIMEOUT_SECONDS = 120

_PASSED_EXIT_CODE = 0
_TESTS_FAILED_EXIT_CODE = 1
_USAGE_ERROR_EXIT_CODE = 2
_REFUSED_EXIT_CODE = 3
_NO_TESTS_COLLECTED_EXIT_CODE = 5

_REUSE_FLAG = "--reuse-verified-unit"
_HOOK_ARGS = ("--all", "--coverage", _REUSE_FLAG)
_FULL_ARGS = ("--all", "--coverage")

_SUITE_GATE = "backend-suite"
_HOOK_ID = "backend-tests-coverage"
_HOOK_ENTRY_PREFIX = "scripts/backend/with-venv.sh ./scripts/backend/test.sh --all --coverage"

_MARKER_FLAG = "-m"
_REMAINDER_MARKER_EXPRESSION = "integration or e2e"
_IGNORE_INTEGRATION = "--ignore=tests/integration"
_WHOLE_SUITE_TARGET = "tests/"
_INTEGRATION_TARGET = "tests/integration"
_WORKER_FLAG = "-n"
_DIST_FLAG = "--dist"
_DIST_STRATEGY = "loadfile"
_COVERAGE_ARG_PREFIX = "--cov"
_FULL_THRESHOLD = "--cov-fail-under=90"
_SQLITE_COLLECT_ONLY_THRESHOLD = "--cov-fail-under=0"

_RECORDED_AT_FIELD = "recorded_at"
_REUSE_MESSAGE = "reusing"
_COVERAGE_MENTION = "coverage"

_ARGV_MARKER = "--ARGV--"
_SHIM_MODE = 0o755
_CHECKOUT_DIR_NAME = "repo"
_SHIM_DIR_NAME = "bin"
_LOG_NAME = "pytest-calls.log"
_LOCK_RELATIVE_PATH = Path(".gate-state") / "locks" / "backend-suite.lock"
_RECEIPT_RELATIVE_PATH = Path(".gate-state") / "receipts" / f"{_SUITE_GATE}.receipt"

_PHASE_FAILURE_ENV = "ADEPTHOOD_PHASE_FAILURE"
_PHASE_EXIT_ENV = "ADEPTHOOD_PHASE_EXIT"
_LOCK_PROBE_ENV = "ADEPTHOOD_LOCK_PROBE"
_TO_REF_ENV = "PRE_COMMIT_TO_REF"
_PRE_COMMIT_ENV_PREFIX = "PRE_COMMIT"
_PATH_ENV = "PATH"
_VIRTUALENV_ENV = "VIRTUAL_ENV"
_ENV_COMPONENT_VARS = ("TEST_POSTGRES_URL", "INTEGRATION_LANE_REQUIRE_POSTGRES")
_FAKE_PIP_FREEZE_ENV = "ADEPTHOOD_FAKE_PIP_FREEZE"
_FAKE_PYTHON_VERSION_ENV = "ADEPTHOOD_FAKE_PYTHON_VERSION"
_FAKE_HOSTNAME_ENV = "ADEPTHOOD_FAKE_HOSTNAME"

_SQLITE_PHASE = "sqlite"
_POSTGRES_PHASE = "postgres"

_BASELINE_PIP_FREEZE = "example-package==1.0.0"
_BASELINE_PYTHON_VERSION = "Python 3.12.0 (stub build)"
_BASELINE_HOSTNAME = "gate-host-one"
_BASELINE_VIRTUALENV = "/opt/gate/venv-one"

# Comfortably above verified.sh's degenerate-input floor, so the ample checkout
# is never mistaken for a misconfigured gate; the sparse one is below it.
_TRACKED_FILE_COUNT = 80
_SPARSE_FILE_COUNT = 0

_BACKEND_DIR = Path("backend")
_SOURCE_FILE = _BACKEND_DIR / "src" / "service.py"
_UNTRACKED_FILE = _BACKEND_DIR / "src" / "work_in_progress.py"
# Outside backend/ and scripts/ on purpose: the unit suite reads this kind of
# file, so a whole-tree receipt is the only one that can see it change.
_OUTSIDE_FILE = Path("CLAUDE.md")
_GITIGNORE_TEXT = ".gate-state/\n"
_MODULE_TEXT = '"""Fixture module measured by the receipt."""\n\nVALUE = 1\n'
_EDIT_TEXT = "EDITED = True\n"
_DOC_TEXT = "# Fixture guide\n"
_PRE_COMMIT_TEXT = "repos: []\n"

_GIT_IDENTITY_ARGS = (
    "-c",
    "user.email=gate@example.invalid",
    "-c",
    "user.name=Gate Fixture",
    "-c",
    "commit.gpgsign=false",
)

_PYTEST_SHIM = """#!/usr/bin/env bash
phase=sqlite
for argument in "$@"; do
    if [ "$argument" = tests/integration ]; then phase=postgres; fi
done
{ printf '%s\\n' "@MARKER@"; printf '%s\\n' "$@"; } >> "@LOG@"
if [ -n "${ADEPTHOOD_LOCK_PROBE:-}" ] && [ -f "@LOCK@" ]; then
    cp "@LOCK@" "$ADEPTHOOD_LOCK_PROBE"
fi
if [ "${ADEPTHOOD_PHASE_FAILURE:-}" = "$phase" ]; then
    exit "${ADEPTHOOD_PHASE_EXIT:-1}"
fi
exit 0
"""

_PIP_SHIM = """#!/usr/bin/env bash
if [ "${1:-}" = "freeze" ]; then
    printf '%s\\n' "${@FREEZE_ENV@:-@FREEZE@}"
fi
exit 0
"""

_PYTHON_SHIM = """#!/usr/bin/env bash
if [ "${1:-}" = "-VV" ]; then
    printf '%s\\n' "${@VERSION_ENV@:-@VERSION@}"
    exit 0
fi
exec "@REAL@" "$@"
"""

_UNAME_SHIM = """#!/usr/bin/env bash
if [ "${1:-}" = "-n" ]; then
    printf '%s\\n' "${@HOSTNAME_ENV@:-@HOSTNAME@}"
    exit 0
fi
exec "@REAL@" "$@"
"""


def _executable(name: str) -> str:
    """Return the absolute path of a command, failing the test if it is absent.

    Args:
        name: Command to resolve on the ambient ``PATH``.

    Returns:
        The resolved path.
    """
    found = shutil.which(name)
    if found is None:
        pytest.fail(f"{name} is required to exercise the pre-push receipt reuse")
    return found


def _render(template: str, substitutions: dict[str, str]) -> str:
    """Fill a shim template by plain replacement.

    Replacement rather than ``str.format`` so the shell's own ``${...}``
    expansions need no brace escaping.

    Args:
        template: Shim source with ``@NAME@`` placeholders.
        substitutions: Placeholder to value.

    Returns:
        The rendered shim source.
    """
    for placeholder, value in substitutions.items():
        template = template.replace(placeholder, value)
    return template


def _write_shim(directory: Path, name: str, body: str) -> None:
    """Write one executable shim.

    Args:
        directory: Directory prepended to ``PATH``.
        name: Command the shim shadows.
        body: Shim source.
    """
    shim = directory / name
    shim.write_text(body)
    shim.chmod(_SHIM_MODE)


def _clean_env(shim_dir: Path) -> dict[str, str]:
    """Return a subprocess environment no ambient hook or lane can steer.

    These tests themselves run inside the pre-push hook, where pre-commit has
    exported ``PRE_COMMIT_TO_REF`` naming the real push. Inherited, it would
    point every fixture at a commit the fixture does not contain.

    Args:
        shim_dir: Directory holding the shims, prepended to ``PATH``.

    Returns:
        The environment every invocation in this module starts from.
    """
    env = {
        key: value
        for key, value in detached_git_env().items()
        if not key.startswith(_PRE_COMMIT_ENV_PREFIX)
    }
    for name in (*_ENV_COMPONENT_VARS, _PHASE_FAILURE_ENV, _PHASE_EXIT_ENV, _LOCK_PROBE_ENV):
        env.pop(name, None)
    env[_PATH_ENV] = f"{shim_dir}{os.pathsep}{env[_PATH_ENV]}"
    env[_VIRTUALENV_ENV] = _BASELINE_VIRTUALENV
    env[_FAKE_PIP_FREEZE_ENV] = _BASELINE_PIP_FREEZE
    env[_FAKE_PYTHON_VERSION_ENV] = _BASELINE_PYTHON_VERSION
    env[_FAKE_HOSTNAME_ENV] = _BASELINE_HOSTNAME
    return env


@dataclass(frozen=True)
class _Checkout:
    """A miniature git checkout holding the real runner and receipt primitive."""

    root: Path
    log: Path
    env: dict[str, str]

    def git(self, *args: str) -> str:
        """Run git inside the checkout, failing the test on error.

        Args:
            *args: Arguments following ``git``.

        Returns:
            The command's stripped stdout.
        """
        result = subprocess.run(
            [_executable("git"), *_GIT_IDENTITY_ARGS, *args],
            cwd=self.root,
            env=self.env,
            capture_output=True,
            text=True,
            check=False,
            timeout=_SUBPROCESS_TIMEOUT_SECONDS,
        )
        if result.returncode != 0:
            pytest.fail(f"git {args} failed: {result.stdout!r} {result.stderr!r}")
        return result.stdout.strip()

    def head(self) -> str:
        """Return the checkout's HEAD commit.

        Returns:
            The full sha HEAD resolves to.
        """
        return self.git("rev-parse", "HEAD")

    def commit_all(self, message: str) -> None:
        """Stage every change and commit it.

        Args:
            message: Commit message.
        """
        self.git("add", "-A")
        self.git("commit", "-q", "--no-verify", "-m", message)

    def record_receipt(self) -> None:
        """Record the whole-tree receipt, as a green check-all run would."""
        result = subprocess.run(
            [
                _executable("bash"),
                str(self.root / "scripts/quality/verified.sh"),
                "record",
                _SUITE_GATE,
            ],
            cwd=self.root,
            env=self.env,
            capture_output=True,
            text=True,
            check=False,
            timeout=_SUBPROCESS_TIMEOUT_SECONDS,
        )
        assert result.returncode == _PASSED_EXIT_CODE, (
            f"verified.sh could not record the {_SUITE_GATE} receipt; the gate is "
            f"unregistered or the fixture is degenerate: {result.stderr!r}"
        )

    def recorded_at(self) -> str:
        """Return the timestamp the receipt was recorded at.

        Returns:
            The receipt's ``recorded_at`` value.
        """
        for line in (self.root / _RECEIPT_RELATIVE_PATH).read_text().splitlines():
            key, _, value = line.partition("=")
            if key == _RECORDED_AT_FIELD:
                return value
        pytest.fail("the receipt carries no recorded_at field")

    def run(
        self, *args: str, extra_env: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        """Invoke the copied ``test.sh`` from the tree root, as the hook does.

        Args:
            *args: Flags passed to the runner.
            extra_env: Additional environment entries.

        Returns:
            The completed process, never raising on a non-zero exit.
        """
        return subprocess.run(
            [_executable("bash"), str(self.root / "scripts/backend/test.sh"), *args],
            cwd=self.root,
            env={**self.env, **(extra_env or {})},
            capture_output=True,
            text=True,
            check=False,
            timeout=_SUBPROCESS_TIMEOUT_SECONDS,
        )

    def push_hook(
        self, *, to_ref: str | None = None, extra_env: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        """Invoke the runner exactly as the pre-push hook entry does.

        Args:
            to_ref: The pushed sha pre-commit exports, or None for a manual run.
            extra_env: Additional environment entries.

        Returns:
            The completed process.
        """
        env = dict(extra_env or {})
        if to_ref is not None:
            env[_TO_REF_ENV] = to_ref
        return self.run(*_HOOK_ARGS, extra_env=env)

    def invocations(self) -> list[list[str]]:
        """Return the argv of every fake ``pytest`` call, one list per call.

        Returns:
            The recorded argument lists, in invocation order.
        """
        if not self.log.exists():
            return []
        chunks = self.log.read_text().split(f"{_ARGV_MARKER}\n")
        return [[line for line in chunk.splitlines() if line] for chunk in chunks if chunk.strip()]


def _stage_checkout(parent: Path, *, tracked_file_count: int = _TRACKED_FILE_COUNT) -> _Checkout:
    """Build a committed checkout with the real scripts and every shim in place.

    Args:
        parent: Directory the checkout, shims and log are created under.
        tracked_file_count: Filler modules committed under ``backend/src``.

    Returns:
        The staged checkout, clean and committed.
    """
    root = parent / _CHECKOUT_DIR_NAME
    for relative, source in (
        (Path("scripts/backend/test.sh"), _TEST_SCRIPT),
        (Path("scripts/quality/verified.sh"), _VERIFIED_SCRIPT),
    ):
        (root / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(source, root / relative)
    (root / _BACKEND_DIR / "tests" / "integration").mkdir(parents=True)
    (root / ".gitignore").write_text(_GITIGNORE_TEXT)
    (root / ".pre-commit-config.yaml").write_text(_PRE_COMMIT_TEXT)
    (root / _OUTSIDE_FILE).write_text(_DOC_TEXT)
    (root / _SOURCE_FILE).parent.mkdir(parents=True)
    (root / _SOURCE_FILE).write_text(_MODULE_TEXT)
    for index in range(tracked_file_count):
        (root / _BACKEND_DIR / "src" / f"filler_{index:03d}.py").write_text(_MODULE_TEXT)

    shim_dir = parent / _SHIM_DIR_NAME
    shim_dir.mkdir()
    log = parent / _LOG_NAME
    _write_shim(
        shim_dir,
        "pytest",
        _render(
            _PYTEST_SHIM,
            {
                "@MARKER@": _ARGV_MARKER,
                "@LOG@": str(log),
                "@LOCK@": str(root / _LOCK_RELATIVE_PATH),
            },
        ),
    )
    _write_shim(
        shim_dir,
        "pip",
        _render(
            _PIP_SHIM, {"@FREEZE_ENV@": _FAKE_PIP_FREEZE_ENV, "@FREEZE@": _BASELINE_PIP_FREEZE}
        ),
    )
    _write_shim(
        shim_dir,
        "python3",
        _render(
            _PYTHON_SHIM,
            {
                "@VERSION_ENV@": _FAKE_PYTHON_VERSION_ENV,
                "@VERSION@": _BASELINE_PYTHON_VERSION,
                "@REAL@": _executable("python3"),
            },
        ),
    )
    _write_shim(
        shim_dir,
        "uname",
        _render(
            _UNAME_SHIM,
            {
                "@HOSTNAME_ENV@": _FAKE_HOSTNAME_ENV,
                "@HOSTNAME@": _BASELINE_HOSTNAME,
                "@REAL@": _executable("uname"),
            },
        ),
    )

    checkout = _Checkout(root=root, log=log, env=_clean_env(shim_dir))
    checkout.git("init", "-q", "-b", "main")
    checkout.commit_all("stage the fixture checkout")
    return checkout


@pytest.fixture
def checkout(tmp_path: Path) -> _Checkout:
    """Return a clean, committed checkout with no receipt recorded yet.

    Args:
        tmp_path: Per-test directory holding the checkout, shims and log.

    Returns:
        The staged checkout.
    """
    return _stage_checkout(tmp_path)


def _assert_full_run(checkout: _Checkout, result: subprocess.CompletedProcess[str]) -> None:
    """Assert the runner fell back to the unchanged ``--all --coverage`` run.

    Args:
        checkout: The staged checkout whose pytest calls are inspected.
        result: The runner's completed process.
    """
    assert result.returncode == _PASSED_EXIT_CODE, result.stdout + result.stderr
    calls = checkout.invocations()
    assert len(calls) == 2, f"expected the SQLite and Postgres passes; got: {calls}"
    sqlite, postgres = calls
    assert _MARKER_FLAG not in sqlite, (
        f"a full run must not filter the SQLite pass by marker -- that would drop "
        f"the unit suite nobody re-verified; got: {sqlite}"
    )
    assert _SQLITE_COLLECT_ONLY_THRESHOLD in sqlite, sqlite
    assert _FULL_THRESHOLD in postgres, (
        f"a full run must enforce the coverage threshold on the combined data; got: {postgres}"
    )


def _assert_reused(checkout: _Checkout, result: subprocess.CompletedProcess[str]) -> None:
    """Assert the runner skipped the unit selection and ran only the remainder.

    Args:
        checkout: The staged checkout whose pytest calls are inspected.
        result: The runner's completed process.
    """
    assert result.returncode == _PASSED_EXIT_CODE, result.stdout + result.stderr
    calls = checkout.invocations()
    assert len(calls) == 2, f"expected the remainder and the Postgres pass; got: {calls}"
    sqlite, postgres = calls
    for expected in (
        _MARKER_FLAG,
        _REMAINDER_MARKER_EXPRESSION,
        _IGNORE_INTEGRATION,
        _WORKER_FLAG,
        _DIST_FLAG,
        _DIST_STRATEGY,
    ):
        assert expected in sqlite, f"the remainder pass lost {expected!r}; got: {sqlite}"
    assert sqlite[-1] == _WHOLE_SUITE_TARGET, sqlite
    assert postgres[-1] == _INTEGRATION_TARGET, postgres
    assert _MARKER_FLAG not in postgres, (
        "the Postgres pass must run tests/integration exactly as the full run does; "
        f"got: {postgres}"
    )
    for call in calls:
        coverage_args = [arg for arg in call if arg.startswith(_COVERAGE_ARG_PREFIX)]
        assert not coverage_args, (
            f"a partial run measured against a whole-repo threshold fails for a reason "
            f"unrelated to the code; the receipt already proved it. Got: {coverage_args}"
        )


# --- the reuse itself ---


@pytest.mark.parametrize("pushed", ["head", "manual"])
def test_a_fresh_receipt_on_a_clean_pushed_head_runs_only_the_remainder(
    checkout: _Checkout, pushed: str
) -> None:
    """A verified, unchanged, committed tree skips only the unit selection.

    The integration- and e2e-marked tests outside ``tests/integration`` and the
    Postgres pass are not part of what check-all proved, so they still run. A
    manual invocation (no ``PRE_COMMIT_TO_REF``) reuses on the first two
    conditions alone.

    Args:
        checkout: Clean committed fixture.
        pushed: ``head`` for a real push of HEAD, ``manual`` for no pushed sha.
    """
    checkout.record_receipt()

    result = checkout.push_hook(to_ref=checkout.head() if pushed == "head" else None)

    _assert_reused(checkout, result)


def test_the_reuse_says_what_it_reused_and_when_it_was_earned(checkout: _Checkout) -> None:
    """An operator watching a push finish early must be told why.

    The message names the reuse, the coverage threshold that carried over, and
    the receipt's timestamp, as check-all's own short-circuit does.
    """
    checkout.record_receipt()
    recorded_at = checkout.recorded_at()

    result = checkout.push_hook(to_ref=checkout.head())

    output = (result.stdout + result.stderr).lower()
    assert _REUSE_MESSAGE in output, output
    assert _COVERAGE_MENTION in output, output
    assert recorded_at.lower() in output, (
        f"the reuse must name when the verdict was earned ({recorded_at!r}); got: {output!r}"
    )


def test_the_reused_run_still_takes_the_whole_suite_lock(
    checkout: _Checkout, tmp_path: Path
) -> None:
    """The remainder is still a whole-suite run and must not race check-all.

    Args:
        checkout: Clean committed fixture.
        tmp_path: Where the lock probe is written.
    """
    checkout.record_receipt()
    probe = tmp_path / "lock-while-running"

    result = checkout.push_hook(to_ref=checkout.head(), extra_env={_LOCK_PROBE_ENV: str(probe)})

    _assert_reused(checkout, result)
    assert probe.read_text().strip().isdigit(), "the remainder ran without holding the lock"
    assert not (checkout.root / _LOCK_RELATIVE_PATH).exists(), "the lock was not released"


def test_a_reused_run_is_refused_while_another_suite_holds_the_lock(checkout: _Checkout) -> None:
    """A live holder refuses the reused run with the same exit code as a full one."""
    checkout.record_receipt()
    lock = checkout.root / _LOCK_RELATIVE_PATH
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text(f"{os.getpid()}\n")

    result = checkout.push_hook(to_ref=checkout.head())

    assert result.returncode == _REFUSED_EXIT_CODE, result.stdout + result.stderr
    assert checkout.invocations() == []


# --- every way the reuse must be refused ---


def test_no_receipt_runs_the_whole_suite(checkout: _Checkout) -> None:
    """A miss is not permission to skip anything."""
    _assert_full_run(checkout, checkout.push_hook(to_ref=checkout.head()))


def test_a_receipt_for_an_earlier_commit_runs_the_whole_suite(checkout: _Checkout) -> None:
    """A receipt for a tree that has since moved is a miss."""
    checkout.record_receipt()
    (checkout.root / _SOURCE_FILE).write_text(_MODULE_TEXT + _EDIT_TEXT)
    checkout.commit_all("move the tree after the receipt")

    _assert_full_run(checkout, checkout.push_hook(to_ref=checkout.head()))


def test_a_change_outside_backend_and_scripts_runs_the_whole_suite(checkout: _Checkout) -> None:
    """The unit suite reads files outside the backend gate's paths.

    A receipt keyed only on ``backend scripts .pre-commit-config.yaml`` would
    still hit after this commit, and the hook would skip the very tests that
    assert on the edited document.
    """
    checkout.record_receipt()
    (checkout.root / _OUTSIDE_FILE).write_text(_DOC_TEXT + _EDIT_TEXT)
    checkout.commit_all("edit a document the unit suite reads")

    _assert_full_run(checkout, checkout.push_hook(to_ref=checkout.head()))


def test_an_unevaluable_receipt_runs_the_whole_suite(tmp_path: Path) -> None:
    """``verified.sh`` exiting cannot-evaluate is not permission to skip.

    Args:
        tmp_path: Directory for a checkout too sparse to fingerprint.
    """
    sparse = _stage_checkout(tmp_path, tracked_file_count=_SPARSE_FILE_COUNT)

    _assert_full_run(sparse, sparse.push_hook(to_ref=sparse.head()))


def _edit_unstaged(checkout: _Checkout) -> None:
    """Leave a tracked backend file modified but unstaged.

    Args:
        checkout: Fixture to dirty.
    """
    (checkout.root / _SOURCE_FILE).write_text(_MODULE_TEXT + _EDIT_TEXT)


def _edit_staged(checkout: _Checkout) -> None:
    """Leave a tracked backend file modified and staged, but uncommitted.

    Args:
        checkout: Fixture to dirty.
    """
    _edit_unstaged(checkout)
    checkout.git("add", str(_SOURCE_FILE))


def _add_untracked(checkout: _Checkout) -> None:
    """Leave a new, unignored backend file uncommitted.

    Args:
        checkout: Fixture to dirty.
    """
    (checkout.root / _UNTRACKED_FILE).write_text(_MODULE_TEXT)


def _edit_outside(checkout: _Checkout) -> None:
    """Leave a tracked file outside backend/ and scripts/ modified.

    Args:
        checkout: Fixture to dirty.
    """
    (checkout.root / _OUTSIDE_FILE).write_text(_DOC_TEXT + _EDIT_TEXT)


@pytest.mark.parametrize(
    "dirty",
    [
        pytest.param(_edit_unstaged, id="unstaged-tracked-edit"),
        pytest.param(_edit_staged, id="staged-edit"),
        pytest.param(_add_untracked, id="untracked-file"),
        pytest.param(_edit_outside, id="edit-outside-backend"),
    ],
)
def test_a_receipt_for_a_dirty_tree_runs_the_whole_suite(
    checkout: _Checkout, dirty: object
) -> None:
    """A receipt describes the working tree; a push describes the commit.

    The receipt is recorded AFTER the edit, so it genuinely hits -- and is
    still the wrong evidence, because the commit being pushed does not contain
    the edit the receipt verified.

    Args:
        checkout: Clean committed fixture.
        dirty: How the working tree is made to differ from HEAD.
    """
    assert callable(dirty)
    dirty(checkout)
    checkout.record_receipt()

    _assert_full_run(checkout, checkout.push_hook(to_ref=checkout.head()))


def test_a_pushed_sha_other_than_head_runs_the_whole_suite(checkout: _Checkout) -> None:
    """Pushing a ref other than the checked-out one: the receipt says nothing about it."""
    pushed = checkout.head()
    (checkout.root / _SOURCE_FILE).write_text(_MODULE_TEXT + _EDIT_TEXT)
    checkout.commit_all("advance HEAD past the pushed commit")
    checkout.record_receipt()

    _assert_full_run(checkout, checkout.push_hook(to_ref=pushed))


def test_an_unresolvable_pushed_sha_runs_the_whole_suite(checkout: _Checkout) -> None:
    """A pushed ref git cannot resolve is a mismatch, never a match."""
    checkout.record_receipt()

    _assert_full_run(checkout, checkout.push_hook(to_ref="0" * 40))


def test_without_the_flag_a_fresh_receipt_changes_nothing(checkout: _Checkout) -> None:
    """The reuse is opt-in: every other caller of ``--all --coverage`` is unchanged."""
    checkout.record_receipt()

    _assert_full_run(checkout, checkout.run(*_FULL_ARGS, extra_env={_TO_REF_ENV: checkout.head()}))


# --- the remainder is still a gate ---


@pytest.mark.parametrize(("phase", "expected_calls"), [(_SQLITE_PHASE, 1), (_POSTGRES_PHASE, 2)])
def test_a_failing_remainder_test_still_fails_the_push(
    checkout: _Checkout, phase: str, expected_calls: int
) -> None:
    """Reuse narrows what runs; it never turns a red test green.

    Args:
        checkout: Clean committed fixture.
        phase: Which pass the fake pytest fails.
        expected_calls: How many passes run before the failure stops the hook.
    """
    checkout.record_receipt()

    result = checkout.push_hook(to_ref=checkout.head(), extra_env={_PHASE_FAILURE_ENV: phase})

    assert result.returncode == _TESTS_FAILED_EXIT_CODE, result.stdout + result.stderr
    assert len(checkout.invocations()) == expected_calls
    assert not (checkout.root / _LOCK_RELATIVE_PATH).exists()


def test_a_remainder_that_selects_nothing_still_runs_the_postgres_pass(checkout: _Checkout) -> None:
    """Pytest's own "no tests collected" is not a failure of the remainder.

    If every integration-marked test outside ``tests/integration`` were moved
    into it, the marker would select nothing; that must not wedge every push.
    Any other non-zero code still fails, as the previous test proves.
    """
    checkout.record_receipt()

    result = checkout.push_hook(
        to_ref=checkout.head(),
        extra_env={
            _PHASE_FAILURE_ENV: _SQLITE_PHASE,
            _PHASE_EXIT_ENV: str(_NO_TESTS_COLLECTED_EXIT_CODE),
        },
    )

    _assert_reused(checkout, result)


def test_no_tests_collected_still_fails_a_full_run(checkout: _Checkout) -> None:
    """The tolerance for exit 5 is confined to the remainder pass."""
    result = checkout.push_hook(
        to_ref=checkout.head(),
        extra_env={
            _PHASE_FAILURE_ENV: _SQLITE_PHASE,
            _PHASE_EXIT_ENV: str(_NO_TESTS_COLLECTED_EXIT_CODE),
        },
    )

    assert result.returncode == _TESTS_FAILED_EXIT_CODE, result.stdout + result.stderr


@pytest.mark.parametrize(
    "args",
    [
        pytest.param((_REUSE_FLAG,), id="unit-default"),
        pytest.param(("--all", _REUSE_FLAG), id="no-coverage"),
        pytest.param(("--all", "--coverage-data", _REUSE_FLAG), id="coverage-data"),
        pytest.param((*_HOOK_ARGS, "tests/test_x.py"), id="positional-path"),
    ],
)
def test_the_flag_outside_the_hook_shape_is_a_usage_error(
    checkout: _Checkout, args: tuple[str, ...]
) -> None:
    """The flag means one thing: the pre-push ``--all --coverage`` run.

    Args:
        checkout: Clean committed fixture.
        args: An invocation the flag cannot describe.
    """
    checkout.record_receipt()

    result = checkout.run(*args)

    assert result.returncode == _USAGE_ERROR_EXIT_CODE, result.stdout + result.stderr
    assert checkout.invocations() == []


# --- the wiring ---


def _hook_entry() -> str:
    """Return the pre-push suite hook's ``entry:`` value, parsed as text.

    Returns:
        The entry with the key and surrounding whitespace removed.
    """
    block = _PRE_COMMIT_CONFIG_PATH.read_text().split(f"- id: {_HOOK_ID}", 1)[1]
    for line in block.splitlines():
        stripped = line.strip()
        if stripped.startswith("entry:"):
            return stripped.removeprefix("entry:").strip()
    pytest.fail(f"hook {_HOOK_ID!r} has no entry: line")


def test_the_pre_push_hook_opts_into_the_reuse() -> None:
    """The hook is the one caller of the flag, still routed through the venv guard."""
    entry = _hook_entry()

    assert entry.startswith(_HOOK_ENTRY_PREFIX), entry
    assert _REUSE_FLAG in entry.split(), entry


def test_claude_md_says_the_pre_push_reuses_the_receipt() -> None:
    """The Stay Green ladder must not still promise a full five-minute suite."""
    step = next(
        line for line in _CLAUDE_DOC.read_text().splitlines() if line.startswith("3. **Git hooks**")
    )
    paragraph = _CLAUDE_DOC.read_text().split(step, 1)[1].split("\n4. ", 1)[0]
    text = f"{step}{paragraph}".lower()

    assert "receipt" in text, text
    assert "integration" in text, text
