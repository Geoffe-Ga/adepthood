"""Tests for the gate-receipt primitive in ``scripts/quality/verified.sh``.

A quality gate that takes seven minutes gets skipped, and a gate that is skipped
protects nothing. The primitive under test lets a gate prove that a previous
green run is *still true*, so an unchanged tree can reuse the verdict it already
earned instead of re-running the whole backend suite to absorb a merge that
touched only a planning note.

The entire value of that claim rests on the fingerprint being impossible to
satisfy dishonestly. A timestamp, a commit SHA, or a flag an agent sets about
itself would all produce a receipt that says "verified" about a tree nobody
verified. So the fingerprint is a content hash of the declared inputs plus the
environment those inputs were measured in, and the majority of the tests below
exist to prove a receipt is REFUSED: one for each way the tree, the interpreter,
the installed packages, the virtualenv, the host, or the outcome-affecting
environment can differ from the state that earned the verdict. A cache test that
only proves the cache hits is worthless.

Two of the refusals are worth more than the rest because they are silent rather
than loud. Hashing the stream of content hashes alone would let a file renamed
with identical content collide with the tree it came from, so each path is
hashed alongside its content. And a gate whose declared paths match nothing
hashes the empty string into a *stable* fingerprint that matches in every tree
on earth -- which is exactly what a wrong working directory or a typo'd path
looks like -- so degenerate input is an error, never a hit.

The two failure exits are kept distinct on purpose. Exit 1 means "not verified,
run the gate" and exit 2 means "cannot evaluate"; neither one may ever be read
as permission to skip, which is why the caller tests assert the full run happens
in both cases.

Every test copies the real script into a miniature checkout under ``tmp_path``,
initialises it as a git repository, and runs it there. The script derives its
tree root from ``SCRIPT_DIR/../..`` precisely so it cannot be aimed at the live
checkout by an unlucky working directory, and one test pins that by running it
from an unrelated repository. ``pip``, ``python3`` and ``uname`` are shadowed on
``PATH`` by shims reporting values a test controls, so the environment
components can be mutated one at a time without touching the machine or the
shared virtualenv.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_VERIFIED_SCRIPT = _REPO_ROOT / "scripts" / "quality" / "verified.sh"

_SUBPROCESS_TIMEOUT_SECONDS = 60

# The only gate in the registry today, plus a name that is well formed but
# unregistered: the two must not be confused, since one is a refusal and the
# other is an operator typo.
_GATE = "backend"
_UNREGISTERED_GATE = "frontend"

_FINGERPRINT_COMMAND = "fingerprint"
_RECORD_COMMAND = "record"
_CHECK_COMMAND = "check"
_EXPLAIN_FLAG = "--explain"
_HELP_FLAG = "--help"

# Documented exit codes. 0 is the only one that may license reuse of a verdict.
_HIT_EXIT_CODE = 0
_MISS_EXIT_CODE = 1
_CANNOT_EVALUATE_EXIT_CODE = 2

_GATE_STATE_DIR = Path(".gate-state")
_RECEIPTS_DIR = _GATE_STATE_DIR / "receipts"
_RECEIPT_SUFFIX = ".receipt"

_SHA256_PATTERN = re.compile(r"\A[0-9a-f]{64}\Z")

# The named components of the fingerprint, in the vocabulary ``--explain`` uses.
_PATHS_COMPONENT = "paths"
_INTERPRETER_COMPONENT = "interpreter"
_PACKAGES_COMPONENT = "packages"
_VENV_COMPONENT = "venv"
_HOST_COMPONENT = "host"
_ENV_COMPONENT = "env"
_COMPONENTS = (
    _PATHS_COMPONENT,
    _INTERPRETER_COMPONENT,
    _PACKAGES_COMPONENT,
    _VENV_COMPONENT,
    _HOST_COMPONENT,
    _ENV_COMPONENT,
)

# A receipt has to say which gate it was written for, under which schema, and
# when. Without the gate name a receipt copied between gates is undetectable;
# without the schema version a change to the hashing scheme silently keeps
# honouring receipts computed the old way; without the timestamp the caller
# cannot tell an operator when the verdict it is reusing was earned.
_GATE_FIELD = "gate"
_SCHEMA_VERSION_FIELD = "schema_version"
_FINGERPRINT_FIELD = "fingerprint"
_RECORDED_AT_FIELD = "recorded_at"
_RECEIPT_FIELDS = (
    _SCHEMA_VERSION_FIELD,
    _GATE_FIELD,
    _FINGERPRINT_FIELD,
    _RECORDED_AT_FIELD,
)

_PATH_ENV = "PATH"
_VIRTUALENV_ENV = "VIRTUAL_ENV"
_POSTGRES_URL_ENV = "TEST_POSTGRES_URL"
_REQUIRE_POSTGRES_ENV = "INTEGRATION_LANE_REQUIRE_POSTGRES"

# Knobs the shims read, so a test can move exactly one environment component.
_FAKE_PIP_FREEZE_ENV = "ADEPTHOOD_FAKE_PIP_FREEZE"
_FAKE_PYTHON_VERSION_ENV = "ADEPTHOOD_FAKE_PYTHON_VERSION"
_FAKE_HOSTNAME_ENV = "ADEPTHOOD_FAKE_HOSTNAME"

_BASELINE_PIP_FREEZE = "example-package==1.0.0"
_OTHER_PIP_FREEZE = "example-package==2.0.0"
_BASELINE_PYTHON_VERSION = "Python 3.12.0 (stub build)"
_OTHER_PYTHON_VERSION = "Python 3.13.0 (stub build)"
_BASELINE_HOSTNAME = "gate-host-one"
_OTHER_HOSTNAME = "gate-host-two"
_BASELINE_VIRTUALENV = "/opt/gate/venv-one"
_OTHER_VIRTUALENV = "/opt/gate/venv-two"
_POSTGRES_URL = "postgresql://gate/one"
_OTHER_POSTGRES_URL = "postgresql://gate/two"
_TRUTHY = "1"

_SHIM_MODE = 0o755
_SHIM_DIR_NAME = "bin"
_CHECKOUT_DIR_NAME = "repo"
_DECOY_DIR_NAME = "decoy"

_SCRIPT_RELATIVE_PATH = Path("scripts") / "quality" / "verified.sh"

# Fixture files inside the gate's declared paths, each staged for one refusal.
_SOURCE_FILE = Path("backend") / "src" / "service.py"
_TEST_FILE = Path("backend") / "tests" / "test_service.py"
_PYPROJECT_FILE = Path("backend") / "pyproject.toml"
_RENAMABLE_FILE = Path("backend") / "src" / "renamable.py"
_RENAMED_FILE = Path("backend") / "src" / "renamed.py"
_DELETABLE_FILE = Path("backend") / "src" / "deletable.py"
_UNTRACKED_FILE = Path("backend") / "src" / "appeared.py"
_PRE_COMMIT_CONFIG = Path(".pre-commit-config.yaml")

# Files outside every declared path. A merge that touches only these is the
# case the whole receipt mechanism exists to make cheap.
_OUTSIDE_FILES = (Path("README.md"), Path("plan") / "notes.md")

# Comfortably above any sane degenerate-input floor, so the ample checkout is
# never mistaken for a misconfigured one.
_TRACKED_FILE_COUNT = 80
# A checkout with essentially nothing in the declared paths: what a typo'd path
# or a wrong tree root produces.
_SPARSE_FILE_COUNT = 0
_DECOY_FILE_COUNT = 12

_MODULE_TEXT = '"""Fixture module measured by the backend gate."""\n\nVALUE = 1\n'
_OUTSIDE_TEXT = "A note the backend gate does not measure.\n"
_PYPROJECT_TEXT = "[tool.example]\nvalue = 1\n"
_PRE_COMMIT_TEXT = "repos: []\n"
_MUTATION_TEXT = "\nEXTRA = 2\n"

_DEFAULT_BRANCH = "main"
_INITIAL_COMMIT_MESSAGE = "stage the fixture checkout"
_EMPTY_COMMIT_MESSAGE = "a commit that changes no file content"
_GIT_IDENTITY_ARGS = (
    "-c",
    "user.email=gate@example.invalid",
    "-c",
    "user.name=Gate Fixture",
    "-c",
    "commit.gpgsign=false",
)

_USAGE_MARKER = "Usage:"
_TRACEBACK_MARKER = "Traceback"
_DEGENERATE_MESSAGE_MARKERS = ("path", "match")

# Well-formed-looking names that must be rejected before any interpolation.
_INVALID_GATE_NAMES = ("../escape", "back end", "Backend", "back/end", "")

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
        The resolved interpreter path, so no subprocess call relies on a
        partial executable name.
    """
    found = shutil.which("bash")
    if found is None:
        pytest.fail("bash is required to exercise the shell scripts under test")
    return found


def _git_executable() -> str:
    """Return an absolute path to git, failing the test if there is none.

    Returns:
        The resolved git path used to build the miniature checkouts.
    """
    found = shutil.which("git")
    if found is None:
        pytest.fail("git is required to build the fixture checkouts")
    return found


def _real_executable(name: str) -> str:
    """Return the absolute path of a command before the shims shadow it.

    Args:
        name: Command whose real implementation a shim delegates to for the
            arguments it does not stub.

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
        pytest.fail(f"{path} does not exist; the gate-receipt primitive is unimplemented")
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

    The global configuration is detached so an operator's hooks path, commit
    template, or signing settings cannot reach into the fixture.

    Args:
        root: Working directory for the command.
        *args: Arguments following ``git``.
    """
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull}
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


def _install_shims(shim_dir: Path) -> None:
    """Write the ``pip``, ``python3`` and ``uname`` stand-ins onto disk.

    Each shim answers only the one query the fingerprint asks it and delegates
    everything else to the real command, so shadowing them cannot disturb
    unrelated tooling.

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


def _shim_env(shim_dir: Path) -> dict[str, str]:
    """Return an environment where every fingerprint input is under test control.

    Args:
        shim_dir: Directory holding the stand-in executables.

    Returns:
        A copy of the ambient environment with the shims in front on ``PATH``
        and the outcome-affecting variables pinned to known values.
    """
    _install_shims(shim_dir)
    env = dict(os.environ)
    env[_PATH_ENV] = f"{shim_dir}{os.pathsep}{env[_PATH_ENV]}"
    env[_VIRTUALENV_ENV] = _BASELINE_VIRTUALENV
    env[_FAKE_PIP_FREEZE_ENV] = _BASELINE_PIP_FREEZE
    env[_FAKE_PYTHON_VERSION_ENV] = _BASELINE_PYTHON_VERSION
    env[_FAKE_HOSTNAME_ENV] = _BASELINE_HOSTNAME
    env.pop(_POSTGRES_URL_ENV, None)
    env.pop(_REQUIRE_POSTGRES_ENV, None)
    return env


@dataclass(frozen=True)
class _Checkout:
    """A miniature repository the real script can be relocated into and run."""

    root: Path
    script: Path
    env: dict[str, str]

    def run(
        self,
        *args: str,
        env: dict[str, str] | None = None,
        cwd: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        """Invoke the script under test and capture its outcome.

        Args:
            *args: Subcommand and flags.
            env: Environment override; ``None`` uses the checkout's own.
            cwd: Working directory override; ``None`` uses the tree root.

        Returns:
            The completed process, never raising on a non-zero exit code.
        """
        return subprocess.run(
            [_bash_executable(), str(self.script), *args],
            cwd=cwd if cwd is not None else self.root,
            env=env if env is not None else self.env,
            capture_output=True,
            text=True,
            check=False,
            timeout=_SUBPROCESS_TIMEOUT_SECONDS,
        )

    def fingerprint(self, env: dict[str, str] | None = None) -> str:
        """Return the current fingerprint, failing the test if it cannot be taken.

        Args:
            env: Environment override; ``None`` uses the checkout's own.

        Returns:
            The fingerprint printed on stdout, stripped of trailing newline.
        """
        result = self.run(_FINGERPRINT_COMMAND, _GATE, env=env)
        if result.returncode != _HIT_EXIT_CODE:
            pytest.fail(
                f"fingerprint exited {result.returncode}: {result.stdout!r} {result.stderr!r}",
            )
        return result.stdout.strip()

    def record(self, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        """Write a receipt for the backend gate.

        Args:
            env: Environment override; ``None`` uses the checkout's own.

        Returns:
            The completed process, so callers can assert on refusals too.
        """
        return self.run(_RECORD_COMMAND, _GATE, env=env)

    def check(
        self,
        *flags: str,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        """Ask whether the recorded verdict still describes this tree.

        Args:
            *flags: Extra flags, such as ``--explain``.
            env: Environment override; ``None`` uses the checkout's own.

        Returns:
            The completed process, never raising on a non-zero exit code.
        """
        return self.run(_CHECK_COMMAND, _GATE, *flags, env=env)

    def receipt_path(self) -> Path:
        """Return the location of the backend gate's receipt.

        Returns:
            The single per-gate receipt path, whether or not it exists yet.
        """
        return self.root / _RECEIPTS_DIR / f"{_GATE}{_RECEIPT_SUFFIX}"

    def env_with(self, changes: dict[str, str | None]) -> dict[str, str]:
        """Return the checkout environment with variables set or removed.

        Args:
            changes: Variables to apply; a ``None`` value removes the variable,
                which is how the unset cases are expressed.

        Returns:
            A new environment mapping; the checkout's own stays untouched.
        """
        env = dict(self.env)
        for key, value in changes.items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
        return env


def _stage_checkout(
    parent: Path,
    *,
    tracked_file_count: int = _TRACKED_FILE_COUNT,
    initialise_git: bool = True,
) -> _Checkout:
    """Build a miniature checkout holding the real script and fixture inputs.

    Args:
        parent: Directory the checkout and its shim directory are created under.
        tracked_file_count: Number of filler modules inside the declared paths;
            a small count stands in for a misconfigured gate.
        initialise_git: Whether to make the tree a git repository at all.

    Returns:
        The staged checkout, ready to run.
    """
    root = parent / _CHECKOUT_DIR_NAME
    (root / _SCRIPT_RELATIVE_PATH.parent).mkdir(parents=True)
    shutil.copy(_require_script(_VERIFIED_SCRIPT), root / _SCRIPT_RELATIVE_PATH)

    _write(root, _PRE_COMMIT_CONFIG, _PRE_COMMIT_TEXT)
    _write(root, _PYPROJECT_FILE, _PYPROJECT_TEXT)
    for fixture in (_SOURCE_FILE, _TEST_FILE, _RENAMABLE_FILE, _DELETABLE_FILE):
        _write(root, fixture, _MODULE_TEXT)
    for index in range(tracked_file_count):
        _write(root, Path("backend") / "src" / f"filler_{index:03d}.py", _MODULE_TEXT)
    for outside in _OUTSIDE_FILES:
        _write(root, outside, _OUTSIDE_TEXT)

    if initialise_git:
        _git(root, "init", "-q", "-b", _DEFAULT_BRANCH)
        _git(root, "add", "-A")
        _git(root, "commit", "-q", "--no-verify", "-m", _INITIAL_COMMIT_MESSAGE)

    return _Checkout(
        root=root,
        script=root / _SCRIPT_RELATIVE_PATH,
        env=_shim_env(parent / _SHIM_DIR_NAME),
    )


@pytest.fixture
def checkout(tmp_path: Path) -> _Checkout:
    """Return an ample, committed checkout with the shims already in place.

    Args:
        tmp_path: Per-test directory holding the checkout and its shims.

    Returns:
        The staged checkout under test.
    """
    return _stage_checkout(tmp_path)


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


def _rewritten_field(text: str, key: str, value: str) -> str:
    """Return the receipt with one field replaced.

    Args:
        text: Full receipt contents.
        key: Field name to overwrite.
        value: Replacement value.

    Returns:
        The rewritten receipt text.
    """
    return re.sub(
        rf"^(\s*{key}\s*=\s*).*$",
        rf"\g<1>{value}",
        text,
        count=1,
        flags=re.MULTILINE,
    )


def _assert_hit(result: subprocess.CompletedProcess[str], reason: str) -> None:
    """Assert the receipt was honoured.

    Args:
        result: Completed ``check`` invocation.
        reason: Why this state deserves to reuse the earlier verdict.
    """
    assert result.returncode == _HIT_EXIT_CODE, (
        f"{reason}; got exit {result.returncode} with "
        f"stdout: {result.stdout!r} stderr: {result.stderr!r}"
    )


def _assert_miss(result: subprocess.CompletedProcess[str], reason: str) -> None:
    """Assert the receipt was refused as stale rather than as unevaluable.

    Args:
        result: Completed ``check`` invocation.
        reason: The difference that must invalidate the earlier verdict.
    """
    assert result.returncode == _MISS_EXIT_CODE, (
        f"{reason} must force the gate to run again (exit {_MISS_EXIT_CODE}); "
        f"got exit {result.returncode} with stdout: {result.stdout!r} "
        f"stderr: {result.stderr!r}"
    )


def _assert_tree_mutation_misses(
    subject: _Checkout,
    mutate: Callable[[Path], None],
    reason: str,
) -> None:
    """Record a verdict, change the tree, and assert the verdict is refused.

    The hit is asserted before the mutation so a refusal afterwards is
    attributable to the mutation rather than to a fingerprint that never
    matched anything.

    Args:
        subject: The staged checkout.
        mutate: Callable applying the change, given the tree root.
        reason: Description of the change, used in assertion messages.
    """
    assert subject.record().returncode == _HIT_EXIT_CODE
    _assert_hit(subject.check(), "an untouched tree must reuse its verdict")

    mutate(subject.root)

    _assert_miss(subject.check(), reason)


def _assert_env_mutation_misses(
    subject: _Checkout,
    baseline: dict[str, str | None],
    mutation: dict[str, str | None],
    reason: str,
) -> None:
    """Record under one environment and assert a changed one is refused.

    Args:
        subject: The staged checkout.
        baseline: Environment changes in force when the receipt is written.
        mutation: Further changes applied before the check.
        reason: Description of the change, used in assertion messages.
    """
    recording_env = subject.env_with(baseline)
    assert subject.record(env=recording_env).returncode == _HIT_EXIT_CODE
    _assert_hit(
        subject.check(env=recording_env),
        "the recording environment must reuse its own verdict",
    )

    _assert_miss(subject.check(env=subject.env_with({**baseline, **mutation})), reason)


def _assert_explains(result: subprocess.CompletedProcess[str], expected: str) -> None:
    """Assert ``--explain`` named exactly the component that moved.

    Args:
        result: Completed ``check --explain`` invocation.
        expected: The component name that must be reported.
    """
    _assert_miss(result, f"a changed {expected} component")
    named = result.stdout.split()
    assert expected in named, (
        f"--explain must name the {expected!r} component; got stdout: {result.stdout!r}"
    )
    for other in _COMPONENTS:
        if other != expected:
            assert other not in named, (
                f"only {expected!r} changed, but --explain also named {other!r}; "
                f"got stdout: {result.stdout!r}"
            )


def _edit_source(root: Path) -> None:
    """Append a line to a source file inside the declared paths.

    Args:
        root: Tree root of the staged checkout.
    """
    (root / _SOURCE_FILE).write_text(_MODULE_TEXT + _MUTATION_TEXT)


def _edit_test(root: Path) -> None:
    """Append a line to a test file inside the declared paths.

    Args:
        root: Tree root of the staged checkout.
    """
    (root / _TEST_FILE).write_text(_MODULE_TEXT + _MUTATION_TEXT)


def _edit_pyproject(root: Path) -> None:
    """Change the backend tool configuration.

    Args:
        root: Tree root of the staged checkout.
    """
    (root / _PYPROJECT_FILE).write_text(_PYPROJECT_TEXT + "other = 2\n")


def _add_untracked_file(root: Path) -> None:
    """Create a new, uncommitted, unignored file inside a declared path.

    Args:
        root: Tree root of the staged checkout.
    """
    _write(root, _UNTRACKED_FILE, _MODULE_TEXT)


def _delete_declared_file(root: Path) -> None:
    """Remove a tracked file from the working tree.

    Args:
        root: Tree root of the staged checkout.
    """
    (root / _DELETABLE_FILE).unlink()


def _rename_with_identical_content(root: Path) -> None:
    """Move a file without altering a single byte of its content.

    Args:
        root: Tree root of the staged checkout.
    """
    shutil.move(str(root / _RENAMABLE_FILE), str(root / _RENAMED_FILE))


def test_fingerprint_is_a_stable_sha256_over_repeated_calls(checkout: _Checkout) -> None:
    """Two reads of an untouched tree must agree, byte for byte.

    Everything downstream is an equality comparison against this string, so any
    instability -- a timestamp, an unsorted listing, a hash of a directory
    iteration order -- turns every receipt into a coin flip and the gate learns
    to distrust its own cache.
    """
    first = checkout.fingerprint()
    second = checkout.fingerprint()

    assert _SHA256_PATTERN.match(first), (
        f"the fingerprint must be a lowercase sha256 hex digest; got: {first!r}"
    )
    assert first == second, (
        "repeated fingerprints of an untouched tree diverged, so no receipt "
        f"could ever match: {first!r} then {second!r}"
    )


def test_fingerprint_ignores_the_current_working_directory(
    checkout: _Checkout,
    tmp_path: Path,
) -> None:
    """The tree measured is the script's own, never the one the caller stands in.

    Deriving the root from ``git rev-parse --show-toplevel`` would make the
    fingerprint depend on where the caller happened to be, so a worktree lane
    invoked from inside another checkout would record a receipt about somebody
    else's files.
    """
    decoy = _stage_checkout(tmp_path / _DECOY_DIR_NAME, tracked_file_count=_DECOY_FILE_COUNT)

    from_root = checkout.fingerprint()
    from_decoy = checkout.run(_FINGERPRINT_COMMAND, _GATE, cwd=decoy.root)

    assert from_decoy.returncode == _HIT_EXIT_CODE, from_decoy.stderr
    assert from_decoy.stdout.strip() == from_root, (
        "the fingerprint changed with the working directory, so the tree root "
        "is being resolved from the caller's cwd instead of from the script"
    )


def test_unchanged_tree_reuses_its_recorded_verdict(checkout: _Checkout) -> None:
    """The one case that may skip work: nothing at all has moved.

    Every other test in this module exists to fence this one in.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE
    assert checkout.receipt_path().exists(), "record must write the gate's receipt"

    _assert_hit(checkout.check(), "an untouched tree must reuse its verdict")


def test_receipt_records_the_gate_schema_fingerprint_and_time(checkout: _Checkout) -> None:
    """A receipt has to carry enough to be audited and to be invalidated.

    The fingerprint is what the check compares; the gate name is what makes a
    misfiled receipt detectable; the schema version is what lets a change to
    the hashing scheme retire every receipt at once; the timestamp is what the
    caller shows an operator when it reuses a verdict.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE
    text = checkout.receipt_path().read_text()

    for field in _RECEIPT_FIELDS:
        assert _receipt_field(text, field), f"the receipt must record {field}"
    assert _receipt_field(text, _GATE_FIELD) == _GATE
    assert _receipt_field(text, _FINGERPRINT_FIELD) == checkout.fingerprint(), (
        "the recorded fingerprint must be the one the tree currently produces"
    )


def test_recording_a_receipt_does_not_invalidate_it(checkout: _Checkout) -> None:
    """Writing the receipt must not change what the receipt describes.

    A receipt stored inside a fingerprinted path would invalidate itself the
    instant it was written, and the resulting permanent miss would look exactly
    like a working cache that simply never hits.
    """
    before = checkout.fingerprint()
    assert checkout.record().returncode == _HIT_EXIT_CODE

    assert checkout.fingerprint() == before, (
        "the receipt is stored somewhere the fingerprint measures, so the act "
        "of recording a verdict destroys it"
    )
    _assert_hit(checkout.check(), "a freshly recorded receipt")


def test_receipts_do_not_accumulate(checkout: _Checkout) -> None:
    """One file per gate, overwritten, with no partial writes left behind.

    A directory that grows a file per run is a disk leak on a machine running
    four worktree lanes, and a stray temp file is the visible symptom of a
    non-atomic write that a concurrent reader could observe half-finished.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE
    assert checkout.record().returncode == _HIT_EXIT_CODE

    receipts = sorted((checkout.root / _RECEIPTS_DIR).iterdir())
    assert receipts == [checkout.receipt_path()], (
        f"exactly one receipt file must exist per gate; found: {receipts}"
    )


def test_a_change_outside_the_declared_paths_still_reuses_the_verdict(
    checkout: _Checkout,
) -> None:
    """A merge that touches only planning notes must not re-run the suite.

    This is the case the whole mechanism is built for: absorbing main into a
    lane routinely changes nothing the backend gate measures, and paying the
    full suite to observe that is the cost being removed.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE

    for outside in _OUTSIDE_FILES:
        (checkout.root / outside).write_text(_OUTSIDE_TEXT + _MUTATION_TEXT)

    _assert_hit(
        checkout.check(),
        "files outside every declared path cannot change what the gate measures",
    )


def test_a_new_commit_with_identical_content_still_reuses_the_verdict(
    checkout: _Checkout,
) -> None:
    """History is not an input; only the bytes on disk are.

    Folding a commit SHA or a branch position into the fingerprint would make
    every merge commit a miss, which reintroduces the exact cost the receipt
    removes while looking like a correctness measure.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE

    _git(checkout.root, "commit", "-q", "--no-verify", "--allow-empty", "-m", _EMPTY_COMMIT_MESSAGE)

    _assert_hit(checkout.check(), "a commit that changed no file content")


def test_editing_a_source_file_refuses_the_verdict(checkout: _Checkout) -> None:
    """Changed production code invalidates every verdict about it.

    The most basic honesty requirement: a receipt that survives an edit to the
    code under test is a lie printed in green.
    """
    _assert_tree_mutation_misses(checkout, _edit_source, "an edited source file")


def test_editing_a_test_file_refuses_the_verdict(checkout: _Checkout) -> None:
    """Changed tests invalidate the verdict as surely as changed code.

    The gate's output is a function of both sides. Fingerprinting only ``src``
    would let a rewritten assertion inherit the previous run's green.
    """
    _assert_tree_mutation_misses(checkout, _edit_test, "an edited test file")


def test_editing_the_backend_configuration_refuses_the_verdict(checkout: _Checkout) -> None:
    """Tool configuration decides what the gate even checks.

    Lint rules, coverage thresholds and marker definitions all live in
    ``pyproject.toml``, so a receipt that survives an edit to it can carry a
    verdict earned under different rules entirely.
    """
    _assert_tree_mutation_misses(checkout, _edit_pyproject, "an edited pyproject.toml")


def test_a_new_untracked_file_refuses_the_verdict(checkout: _Checkout) -> None:
    """Work in progress counts, because the gate would have run against it.

    Listing only ``--cached`` paths would make a brand-new, uncommitted module
    invisible to the fingerprint while being perfectly visible to pytest, which
    is the most common shape of a mid-development tree.
    """
    _assert_tree_mutation_misses(checkout, _add_untracked_file, "a new untracked file")


def test_deleting_a_declared_file_refuses_the_verdict(checkout: _Checkout) -> None:
    """Removing an input changes the input set, hence the fingerprint.

    A deleted-but-still-cached path that keeps contributing its old hash would
    let a tree that no longer contains a module claim a verdict earned while it
    did.
    """
    _assert_tree_mutation_misses(checkout, _delete_declared_file, "a deleted file")


def test_renaming_a_file_without_changing_it_refuses_the_verdict(
    checkout: _Checkout,
) -> None:
    """Paths are hashed alongside content, not merely the content stream.

    A rename moves code between packages, changes what imports resolve, and can
    break collection outright, yet the multiset of blob hashes is untouched. If
    only the hashes were combined, this move would be invisible -- the quietest
    possible way for the cache to be wrong.
    """
    _assert_tree_mutation_misses(
        checkout,
        _rename_with_identical_content,
        "a file renamed with identical content",
    )


def test_changed_installed_packages_refuse_the_verdict(checkout: _Checkout) -> None:
    """A different dependency set is a different program.

    The suite's outcome depends on what is installed, which is why the gate
    already runs a drift preflight; a receipt that outlives an upgrade would
    hand back a verdict earned against packages that are no longer present.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE
    _assert_hit(checkout.check(), "an unchanged package set")

    _assert_miss(
        checkout.check(env=checkout.env_with({_FAKE_PIP_FREEZE_ENV: _OTHER_PIP_FREEZE})),
        "a changed pip freeze",
    )


def test_a_changed_interpreter_refuses_the_verdict(checkout: _Checkout) -> None:
    """Cross-version behaviour is precisely what the compat matrix exists for.

    Syntax accepted by one interpreter and rejected by another is a recurring
    source of CI-only failures here, so a verdict earned on one interpreter
    must never be reused on a different one.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE

    _assert_miss(
        checkout.check(env=checkout.env_with({_FAKE_PYTHON_VERSION_ENV: _OTHER_PYTHON_VERSION})),
        "a changed python3 -VV",
    )


def test_a_changed_virtualenv_refuses_the_verdict(checkout: _Checkout) -> None:
    """Two virtualenvs on one machine are two different package sets.

    The lanes each have their own environment, and reusing a verdict across
    them measures whichever one happened to be active last.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE

    _assert_miss(
        checkout.check(env=checkout.env_with({_VIRTUALENV_ENV: _OTHER_VIRTUALENV})),
        "a different active virtualenv",
    )


def test_an_unset_virtualenv_refuses_the_verdict(checkout: _Checkout) -> None:
    """No virtualenv at all is the shape of the most common operator mistake.

    Invoking the gate without activating the environment in the same shell call
    runs everything against the system interpreter. That state must never
    inherit a verdict earned inside the virtualenv, or the cache silently
    converts a misconfigured run into a green one.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE

    _assert_miss(
        checkout.check(env=checkout.env_with({_VIRTUALENV_ENV: None})),
        "an unset VIRTUAL_ENV",
    )


def test_a_changed_hostname_refuses_the_verdict(checkout: _Checkout) -> None:
    """Receipts are local claims and must not survive a move between machines.

    A receipts directory that ever reaches CI or another developer would
    otherwise assert that a suite passed on hardware it never ran on.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE

    _assert_miss(
        checkout.check(env=checkout.env_with({_FAKE_HOSTNAME_ENV: _OTHER_HOSTNAME})),
        "a different host",
    )


@pytest.mark.parametrize(
    ("baseline", "mutation"),
    [
        pytest.param({}, {_POSTGRES_URL_ENV: _POSTGRES_URL}, id="postgres-url-appears"),
        pytest.param(
            {_POSTGRES_URL_ENV: _POSTGRES_URL},
            {_POSTGRES_URL_ENV: None},
            id="postgres-url-disappears",
        ),
        pytest.param(
            {_POSTGRES_URL_ENV: _POSTGRES_URL},
            {_POSTGRES_URL_ENV: _OTHER_POSTGRES_URL},
            id="postgres-url-changes",
        ),
        pytest.param({}, {_REQUIRE_POSTGRES_ENV: _TRUTHY}, id="require-postgres-appears"),
    ],
)
def test_outcome_affecting_environment_variables_refuse_the_verdict(
    checkout: _Checkout,
    baseline: dict[str, str | None],
    mutation: dict[str, str | None],
) -> None:
    """The integration lane's switches decide which tests run at all.

    These two variables select between a skipped integration lane, a live
    Postgres lane, and a hard failure when Postgres is demanded but missing.
    A receipt that survives them would let a run with the lane switched off
    hand its green to a run that was supposed to exercise the real database.

    Args:
        checkout: The staged checkout.
        baseline: Environment in force when the receipt is written.
        mutation: The single change applied before the check.
    """
    _assert_env_mutation_misses(checkout, baseline, mutation, "a changed lane switch")


def test_a_missing_receipt_is_a_miss_not_a_hit(checkout: _Checkout) -> None:
    """With nothing recorded there is nothing to reuse.

    The default has to be "run the gate": an absent receipt is the state of
    every fresh clone and every worktree the fleet creates.
    """
    assert not checkout.receipt_path().exists()

    _assert_miss(checkout.check(), "no receipt at all")


def test_a_receipt_naming_another_gate_is_refused(checkout: _Checkout) -> None:
    """A receipt is only evidence about the gate it names.

    Receipts are per-gate files, so a copied or misfiled one is otherwise
    indistinguishable from a legitimate verdict; recording the gate inside the
    receipt is what makes that detectable at all.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE
    receipt = checkout.receipt_path()
    receipt.write_text(_rewritten_field(receipt.read_text(), _GATE_FIELD, _UNREGISTERED_GATE))

    _assert_miss(checkout.check(), "a receipt written for a different gate")


def test_a_receipt_from_an_older_schema_is_refused(checkout: _Checkout) -> None:
    """Bumping the schema retires every receipt in existence.

    When the set of hashed components changes, old fingerprints answer a
    different question. Without the version, the first receipt written under
    the old scheme keeps being honoured under the new one.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE
    receipt = checkout.receipt_path()
    current = _receipt_field(receipt.read_text(), _SCHEMA_VERSION_FIELD)
    stale = f"{current}-superseded"
    receipt.write_text(_rewritten_field(receipt.read_text(), _SCHEMA_VERSION_FIELD, stale))

    _assert_miss(checkout.check(), f"a receipt recorded under schema {stale}")


@pytest.mark.parametrize(
    "contents",
    [
        pytest.param("", id="empty"),
        pytest.param("schema", id="truncated"),
        pytest.param("\x00\x01 not a receipt\n", id="binary-junk"),
    ],
)
def test_a_corrupt_receipt_is_refused_without_crashing(
    checkout: _Checkout,
    contents: str,
) -> None:
    """A half-written receipt sends the gate back to work, quietly and safely.

    An interrupted run, a full disk, or a killed process can all leave a stub
    behind. Refusing it is the only safe reading, and doing so without a shell
    traceback is what keeps operators from assuming the tool itself is broken
    and reaching for a bypass flag.

    Args:
        checkout: The staged checkout.
        contents: Damaged receipt contents to plant.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE
    checkout.receipt_path().write_text(contents)

    result = checkout.check()

    _assert_miss(result, "a corrupt receipt")
    assert _TRACEBACK_MARKER not in f"{result.stdout}{result.stderr}", (
        f"a corrupt receipt must be handled, not crashed on; got: {result.stderr!r}"
    )


def test_a_degenerate_gate_cannot_be_recorded_or_checked(tmp_path: Path) -> None:
    """Declared paths that match almost nothing are an error, never a hit.

    This is the failure that would defeat every other test in this file. A
    typo'd path or a wrong tree root hashes the empty input into a perfectly
    stable fingerprint, so the receipt matches in any tree at all and the gate
    reports green about a codebase it never looked at. Both writing and reading
    such a receipt must refuse, and the message must point at the paths so the
    operator fixes the configuration instead of the code.
    """
    sparse = _stage_checkout(tmp_path, tracked_file_count=_SPARSE_FILE_COUNT)

    recorded = sparse.record()
    checked = sparse.check()

    for label, result in (("record", recorded), ("check", checked)):
        assert result.returncode == _CANNOT_EVALUATE_EXIT_CODE, (
            f"{label} on a gate matching almost no files must exit "
            f"{_CANNOT_EVALUATE_EXIT_CODE}; got exit {result.returncode} with "
            f"stdout: {result.stdout!r} stderr: {result.stderr!r}"
        )
    message = f"{recorded.stdout}{recorded.stderr}".lower()
    for marker in _DEGENERATE_MESSAGE_MARKERS:
        assert marker in message, (
            f"the refusal must explain that the declared paths matched too few "
            f"files (missing {marker!r}); got: {message!r}"
        )
    assert not sparse.receipt_path().exists(), "a refused record must write no receipt"


@pytest.mark.parametrize("name", _INVALID_GATE_NAMES)
def test_an_invalid_gate_name_is_rejected_before_any_path_is_touched(
    checkout: _Checkout,
    name: str,
) -> None:
    """The gate name is the only value that reaches a path, so it is validated.

    A name carrying a separator or a traversal segment would let a caller aim
    the receipt read or write anywhere on disk. Rejecting the name up front,
    without creating or reading a single file, is what keeps the receipt
    directory the only thing this script can touch.

    Args:
        checkout: The staged checkout.
        name: A malformed gate name.
    """
    before = sorted(path.relative_to(checkout.root) for path in checkout.root.rglob("*"))

    result = checkout.run(_CHECK_COMMAND, name)

    assert result.returncode == _CANNOT_EVALUATE_EXIT_CODE, (
        f"the malformed gate name {name!r} must exit {_CANNOT_EVALUATE_EXIT_CODE}; "
        f"got exit {result.returncode} with stderr: {result.stderr!r}"
    )
    after = sorted(path.relative_to(checkout.root) for path in checkout.root.rglob("*"))
    assert after == before, (
        f"the malformed gate name {name!r} changed the tree; a rejected name "
        "must not create, read, or remove anything"
    )


def test_an_unregistered_gate_name_cannot_be_evaluated(checkout: _Checkout) -> None:
    """A well-formed name with no declared paths is a caller error, not a miss.

    Returning "not verified" for a gate that does not exist would send the
    caller off to run a gate nobody defined; exit 2 names the real problem.
    """
    result = checkout.run(_CHECK_COMMAND, _UNREGISTERED_GATE)

    assert result.returncode == _CANNOT_EVALUATE_EXIT_CODE, (
        f"an unregistered gate must exit {_CANNOT_EVALUATE_EXIT_CODE}; got exit "
        f"{result.returncode} with stderr: {result.stderr!r}"
    )
    assert _UNREGISTERED_GATE in f"{result.stdout}{result.stderr}", (
        f"the message must name the unknown gate; got: {result.stderr!r}"
    )


def test_a_tree_that_is_not_a_repository_cannot_be_evaluated(tmp_path: Path) -> None:
    """Without git there is no file listing, so there is no honest answer.

    Falling back to an empty listing here would produce the same stable
    fingerprint the degenerate-input guard exists to reject.
    """
    unversioned = _stage_checkout(tmp_path, initialise_git=False)

    result = unversioned.run(_FINGERPRINT_COMMAND, _GATE)

    assert result.returncode == _CANNOT_EVALUATE_EXIT_CODE, (
        f"a non-repository must exit {_CANNOT_EVALUATE_EXIT_CODE}; got exit "
        f"{result.returncode} with stdout: {result.stdout!r} stderr: {result.stderr!r}"
    )


def test_explain_names_the_paths_component(checkout: _Checkout) -> None:
    """An operator who is refused deserves to know which input moved.

    Without this, a refusal is indistinguishable from a broken cache, and the
    documented response to a cache nobody understands is to disable it.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE
    _edit_source(checkout.root)

    _assert_explains(checkout.check(_EXPLAIN_FLAG), _PATHS_COMPONENT)


def test_explain_names_the_packages_component(checkout: _Checkout) -> None:
    """An environment refusal must not be reported as a code change.

    Naming ``paths`` when the real difference was an upgraded dependency sends
    the operator to diff a tree that did not move.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE

    _assert_explains(
        checkout.check(
            _EXPLAIN_FLAG,
            env=checkout.env_with({_FAKE_PIP_FREEZE_ENV: _OTHER_PIP_FREEZE}),
        ),
        _PACKAGES_COMPONENT,
    )


def test_explain_names_the_env_component(checkout: _Checkout) -> None:
    """A lane switch is the least visible difference, so it must be named.

    Nothing about the tree or the environment looks different to the eye when
    a single exported variable changes, which makes this the refusal most
    likely to be mistaken for a bug in the receipt mechanism.
    """
    assert checkout.record().returncode == _HIT_EXIT_CODE

    _assert_explains(
        checkout.check(
            _EXPLAIN_FLAG,
            env=checkout.env_with({_POSTGRES_URL_ENV: _POSTGRES_URL}),
        ),
        _ENV_COMPONENT,
    )


def test_help_documents_the_three_subcommands(checkout: _Checkout) -> None:
    """The primitive is meant to be called by other gates, so it documents itself.

    A gate author who cannot discover ``record`` and ``check`` will hand-roll a
    timestamp file instead, which is the design this replaces.
    """
    result = checkout.run(_HELP_FLAG)

    assert result.returncode == _HIT_EXIT_CODE, result.stderr
    assert _USAGE_MARKER in result.stdout, f"--help must print usage; got: {result.stdout!r}"
    for command in (_FINGERPRINT_COMMAND, _RECORD_COMMAND, _CHECK_COMMAND):
        assert command in result.stdout, (
            f"--help must document the {command!r} subcommand; got: {result.stdout!r}"
        )
