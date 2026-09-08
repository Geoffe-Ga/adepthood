"""Three pre-commit gates must never report a verdict from an unverified interpreter.

Three hook entries -- ``bandit``, ``backend-complexity`` and
``backend-tests-coverage`` -- opened with
``bash -c '[ -f .venv/bin/activate ] && source .venv/bin/activate; ...'``.  The
``;`` is the whole defect: it ends the guard rather than chaining it, so the
gate that follows runs whatever the ambient ``PATH`` offers.  Measured at
``c1ba2093`` in a checkout with no ``.venv`` and the pinned tools merely on
``PATH``, the ``bandit`` entry printed ``✓ Bandit checks passed`` and exited 0
having activated nothing and verified nothing.  A gate that reports a pass it
did not earn is worse than a gate that is missing, because the pass is quoted.

Two scripts had the same shape one layer down: ``security.sh`` answered a
``bandit: command not found`` with ``✗ Bandit found issues``, and ``test.sh``
answered a missing ``pytest`` with ``✗ Tests failed``.  Both name a finding
nobody made.  ``complexity.sh`` already got this right -- a ``command -v``
presence loop that exits with a distinct "could not analyse" code -- and this
module holds all three to that standard.

Why the fixture stubs the gate script
-------------------------------------
The obvious test -- run the hook entry with a tools-free ``PATH`` and assert a
non-zero exit -- passes with the bug fully present, because at ``c1ba2093`` the
*gate* fails for its own reasons (``bandit: command not found`` -> exit 1).  So
every environment case here replaces the gate script the entry names with a
stub that touches a marker file and exits 0.  A stub cannot fail for
tool-absence, so a non-zero exit can only have come from the wrapper, and the
marker distinguishes "the gate was refused" from "the gate ran and passed".

The entries are *parsed* out of ``.pre-commit-config.yaml`` by hook id and then
executed, never restated here.  A restated copy of a command string is exactly
how this defect came to have three homes.  The parse is a text parse: PyYAML is
absent from every requirements file in this repo, so ``import yaml`` would turn
this guard into a collection error on the 3.11 and 3.12 compat jobs instead of a
test -- the same rule ``test_precommit_mypy_deps`` and
``test_frontend_bin_resolution`` document.

The environment cases build their own ``PATH`` out of a curated symlink
directory rather than borrowing the host's ``/usr/bin``.  Whether a bare system
``PATH`` carries a pinned ``python``, ``pytest`` or ``bandit`` depends on the
host -- it does not under a developer's ``.venv``, and it may under CI's ``uv
pip install --system`` -- and a fixture whose meaning depends on the host is
not a fixture.  Case 2, which has to model CI, prepends the directory holding
the interpreter running this suite: that interpreter is the one
``check-all.sh``'s ``deps.sh`` preflight has already matched against the pins.
"""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_CONFIG = _REPO_ROOT / ".pre-commit-config.yaml"
_SCRIPTS_BACKEND = _REPO_ROOT / "scripts" / "backend"

# The wrapper the three entries must route through, spelled as a hook writes it:
# repo-root-relative, because pre-commit runs hooks with the repo root as cwd.
_WRAPPER_ENTRY = "scripts/backend/with-venv.sh"
_WRAPPER_SCRIPT = _REPO_ROOT / "scripts" / "backend" / "with-venv.sh"

# The three hooks that gate the backend through a script under scripts/backend/,
# and the script each one is expected to reach.
_GUARDED_HOOKS = {
    "bandit": "security.sh",
    "backend-complexity": "complexity.sh",
    "backend-tests-coverage": "test.sh",
}

# The decorative guard itself. `;` terminates the guard instead of chaining it,
# so everything after it runs unconditionally.
_DECORATIVE_GUARD = "[ -f .venv/bin/activate ] &&"

# Any scripts/backend/<name>.sh reference inside one entry line.
_BACKEND_SCRIPT_RE = re.compile(r"scripts/backend/([a-z][a-z-]*)\.sh")

# An `entry:` line anywhere in the config.
_ENTRY_LINE_RE = re.compile(r"^[ \t]*entry:[ \t]*(?P<value>.+?)[ \t]*$", re.MULTILINE)

# The gate scripts whose invocation must be preceded by the wrapper. `deps.sh`
# is deliberately absent: it is the wrapper's own verifier, not a gate it wraps.
_MUST_BE_WRAPPED = frozenset({"security.sh", "complexity.sh", "test.sh"})

# Utilities the wrapper and the three gate scripts legitimately need. The
# curated PATH carries these and nothing else, so `python`, `pytest` and
# `bandit` are provably absent unless a case puts them back.
_CURATED_UTILITIES = (
    "bash",
    "sh",
    "env",
    "cat",
    "dirname",
    "basename",
    "head",
    "tr",
    "mkdir",
    "rm",
    "sleep",
    "ls",
)

# The stub drops this in cwd when it runs. Its presence is the assertion that
# the gate executed; its absence is the assertion that the wrapper refused.
_MARKER_NAME = "gate-ran.marker"

_STUB = """#!/usr/bin/env bash
# Stand-in for the real gate script, installed by
# backend/tests/scripts/test_precommit_venv_guard.py.
#
# It has no tools to be missing, so it cannot fail the way the real gate fails
# on a tools-free PATH. Any non-zero exit from the hook entry therefore came
# from the wrapper, and the marker below says whether the gate was reached.
set -euo pipefail
: > "GATE_MARKER"
echo "VIRTUAL_ENV=${VIRTUAL_ENV:-<unset>}"
exit 0
""".replace("GATE_MARKER", _MARKER_NAME)

# A stand-in for `.venv/bin/activate`. Fabricated rather than borrowed from the
# repo's own virtualenv so the case means the same thing on a developer box and
# on CI, which has no `.venv` at all. The wrapper's contract is "source this
# file, then run the gate inside what it set up", and that is exactly what a
# real activate script does with these two variables.
_FAKE_ACTIVATE = """# Minimal stand-in for a virtualenv activate script.
VIRTUAL_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export VIRTUAL_ENV
PATH="$VIRTUAL_ENV/bin:$PATH"
export PATH
"""


def _hook_entry(hook_id: str) -> str:
    """Return the raw ``entry:`` value of one pre-commit hook.

    Args:
        hook_id: The hook's ``id:`` in ``.pre-commit-config.yaml``.

    Returns:
        The entry value, with the ``entry:`` key and surrounding space stripped.

    Raises:
        AssertionError: If the hook or its ``entry:`` line is absent, so a
            parse failure reports loudly instead of vacuously passing.
    """
    config = _CONFIG.read_text(encoding="utf-8")
    if f"- id: {hook_id}" not in config:
        raise AssertionError(f"no hook with id {hook_id!r} in {_CONFIG}")
    block = config.split(f"- id: {hook_id}", 1)[1]
    for line in block.splitlines():
        stripped = line.strip()
        if stripped.startswith("entry:"):
            return stripped[len("entry:") :].strip()
    raise AssertionError(f"hook {hook_id!r} has no entry: line")


def _gate_script_name(entry: str) -> str:
    """Return the single gate script one entry invokes, ignoring the wrapper.

    Args:
        entry: One hook's ``entry:`` value.

    Returns:
        The bare filename, e.g. ``security.sh``.

    Raises:
        AssertionError: If the entry names no gate script, or more than one.
    """
    names = [f"{stem}.sh" for stem in _BACKEND_SCRIPT_RE.findall(entry) if stem != "with-venv"]
    if len(names) != 1:
        raise AssertionError(f"expected exactly one gate script in entry {entry!r}, found {names}")
    return names[0]


def _curated_bin(root: Path) -> Path:
    """Build a PATH directory holding only the utilities the gates need.

    Args:
        root: A directory to create the ``curated-bin`` directory under.

    Returns:
        The directory, populated with symlinks to the resolved utilities.

    Raises:
        AssertionError: If a utility cannot be resolved on the host, so a
            thinned PATH never silently becomes an empty one.
    """
    curated = root / "curated-bin"
    curated.mkdir(exist_ok=True)
    for name in _CURATED_UTILITIES:
        resolved = shutil.which(name)
        if resolved is None:
            raise AssertionError(f"cannot build a curated PATH: {name!r} not on PATH")
        target = curated / name
        if not target.exists():
            target.symlink_to(resolved)
    return curated


def _farm(root: Path) -> Path:
    """Build a minimal checkout that the hook entries can run inside.

    ``backend`` and the config are symlinked to the real ones; ``scripts`` is
    copied, because a case has to be able to replace a gate script with a stub
    and because ``deps.sh`` must resolve from the copy's own directory.

    Args:
        root: A directory to create the ``farm`` directory under.

    Returns:
        The farm's root, which never contains a ``.venv`` unless a case adds one.
    """
    farm = root / "farm"
    farm.mkdir()
    (farm / "backend").symlink_to(_REPO_ROOT / "backend", target_is_directory=True)
    (farm / ".pre-commit-config.yaml").symlink_to(_CONFIG)
    shutil.copytree(_SCRIPTS_BACKEND, farm / "scripts" / "backend")
    return farm


def _install_stub(farm: Path, script_name: str) -> None:
    """Replace one copied gate script with the marker-touching stub.

    Args:
        farm: The farm root from :func:`_farm`.
        script_name: The gate script's bare filename.
    """
    stub = farm / "scripts" / "backend" / script_name
    stub.write_text(_STUB, encoding="utf-8")
    stub.chmod(0o755)


def _install_fake_venv(farm: Path) -> None:
    """Give the farm a ``.venv`` whose ``activate`` sets ``VIRTUAL_ENV``.

    Args:
        farm: The farm root from :func:`_farm`.
    """
    activate = farm / ".venv" / "bin" / "activate"
    activate.parent.mkdir(parents=True)
    activate.write_text(_FAKE_ACTIVATE, encoding="utf-8")


def _run(farm: Path, argv: list[str], path: str) -> subprocess.CompletedProcess[str]:
    """Run an argv inside the farm under an explicit, minimal environment.

    ``VIRTUAL_ENV`` is deliberately not inherited: pytest itself runs inside the
    activated project virtualenv, and inheriting it would pre-answer the very
    question case 3 asks.

    Args:
        farm: The farm root, used as cwd.
        argv: The command, whose first element is resolved to an absolute path.
        path: The ``PATH`` the command sees.

    Returns:
        The completed process, with text streams captured.
    """
    candidate = farm / argv[0]
    if candidate.is_file():
        executable = str(candidate)
    else:
        resolved = shutil.which(argv[0])
        if resolved is None:
            raise AssertionError(f"cannot resolve argv[0] {argv[0]!r}")
        executable = resolved
    # S603 is per-file-ignored for backend/tests/scripts/**: the shell script
    # *is* the unit under test, so there is no in-process seam to drive it through.
    return subprocess.run(
        [executable, *argv[1:]],
        cwd=farm,
        env={"PATH": path, "HOME": str(farm), "LC_ALL": "C"},
        capture_output=True,
        text=True,
        check=False,
    )


def _staged_entry(farm: Path, hook_id: str) -> list[str]:
    """Parse one hook's entry and stub the gate script it names.

    Args:
        farm: The farm root from :func:`_farm`.
        hook_id: The hook whose entry to prepare.

    Returns:
        The entry as an argv list, ready for :func:`_run`.
    """
    entry = _hook_entry(hook_id)
    _install_stub(farm, _gate_script_name(entry))
    return shlex.split(entry)


class TestTheGuardParsesTheRealConfig:
    """A parse failure must report loudly rather than pass vacuously."""

    @pytest.mark.parametrize("hook_id", sorted(_GUARDED_HOOKS))
    def test_the_hook_has_an_entry(self, hook_id: str) -> None:
        """Every guarded hook is still declared with an ``entry:``."""
        assert _hook_entry(hook_id)

    @pytest.mark.parametrize(("hook_id", "script_name"), sorted(_GUARDED_HOOKS.items()))
    def test_the_entry_names_its_gate_script(self, hook_id: str, script_name: str) -> None:
        """The entry still reaches the script this module believes it gates."""
        assert _gate_script_name(_hook_entry(hook_id)) == script_name

    def test_the_curated_path_excludes_the_pinned_tools(self, tmp_path: Path) -> None:
        """The thinned PATH really is missing what the cases assume it is missing."""
        curated = str(_curated_bin(tmp_path))
        for absent in ("python", "python3", "pytest", "bandit", "radon", "xenon"):
            assert shutil.which(absent, path=curated) is None, (
                f"the curated PATH still resolves {absent!r}, so the environment "
                f"cases would not be testing what they claim to"
            )


class TestAnUnverifiedEnvironmentIsRefused:
    """Case 1 -- the defect. No ``.venv``, no pinned toolchain, no verdict."""

    @pytest.mark.parametrize("hook_id", sorted(_GUARDED_HOOKS))
    def test_the_gate_never_runs(self, hook_id: str, tmp_path: Path) -> None:
        """The hook must refuse, not report a pass it could not have earned."""
        farm = _farm(tmp_path)
        argv = _staged_entry(farm, hook_id)

        result = _run(farm, argv, str(_curated_bin(tmp_path)))

        assert result.returncode != 0, (
            f"hook {hook_id!r} reported success from an environment nothing "
            f"verified: no .venv, no pinned toolchain on PATH. "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )
        assert not (farm / _MARKER_NAME).exists(), (
            f"hook {hook_id!r} ran its gate before proving the environment; "
            f"stdout={result.stdout!r}"
        )

    def test_the_refusal_names_the_precondition_and_the_remedy(self, tmp_path: Path) -> None:
        """A refusal nobody can act on costs as much as a wrong verdict."""
        farm = _farm(tmp_path)
        argv = _staged_entry(farm, "bandit")

        result = _run(farm, argv, str(_curated_bin(tmp_path)))

        assert ".venv" in result.stderr, (
            f"the refusal never names the missing virtualenv: {result.stderr!r}"
        )
        assert "python -m venv .venv" in result.stderr, (
            f"the refusal never gives the remedy: {result.stderr!r}"
        )


class TestAPinnedAmbientToolchainIsAccepted:
    """Case 2 -- CI's shape. ``uv pip install --system``, no ``.venv`` anywhere.

    ``.github/workflows/backend-ci.yml`` installs the pinned requirements into
    the system interpreter and then runs these very hooks. A guard that merely
    asserted a ``.venv`` directory exists would fail the required
    ``backend-quality`` job on every pull request -- stricter in appearance and
    simply wrong.
    """

    @pytest.mark.parametrize("hook_id", sorted(_GUARDED_HOOKS))
    def test_the_gate_runs(self, hook_id: str, tmp_path: Path) -> None:
        """Pins proven present on PATH are a verified environment."""
        farm = _farm(tmp_path)
        argv = _staged_entry(farm, hook_id)
        path = f"{Path(sys.executable).parent}{os.pathsep}{_curated_bin(tmp_path)}"

        result = _run(farm, argv, path)

        assert result.returncode == 0, (
            f"hook {hook_id!r} refused CI's own environment -- pinned tools on "
            f"PATH, no .venv. stdout={result.stdout!r} stderr={result.stderr!r}"
        )
        assert (farm / _MARKER_NAME).exists(), (
            f"hook {hook_id!r} exited 0 without running its gate; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )


class TestAProjectVirtualenvIsActivated:
    """Case 3 -- the behaviour developers and Ralph lanes rely on is unchanged."""

    @pytest.mark.parametrize("hook_id", sorted(_GUARDED_HOOKS))
    def test_the_gate_runs_inside_the_activated_virtualenv(
        self, hook_id: str, tmp_path: Path
    ) -> None:
        """Activation is the point: exiting 0 without it would be the old bug."""
        farm = _farm(tmp_path)
        argv = _staged_entry(farm, hook_id)
        _install_fake_venv(farm)

        result = _run(farm, argv, str(_curated_bin(tmp_path)))

        assert result.returncode == 0, (
            f"hook {hook_id!r} refused an activatable .venv; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )
        assert (farm / _MARKER_NAME).exists(), (
            f"hook {hook_id!r} exited 0 without running its gate; stdout={result.stdout!r}"
        )
        assert f"VIRTUAL_ENV={(farm / '.venv').resolve()}" in result.stdout, (
            f"the gate ran without the .venv activated, which is the defect this "
            f"module exists to prevent; stdout={result.stdout!r}"
        )


class TestTheDecorativeGuardCannotComeBack:
    """Case 4 -- the recurrence sweep over the config's own text."""

    def test_no_entry_carries_the_fall_through_guard(self) -> None:
        """``[ -f .venv/bin/activate ] && ... ; gate`` always runs the gate."""
        offenders = [
            (number, line)
            for number, line in enumerate(_CONFIG.read_text(encoding="utf-8").splitlines(), start=1)
            if line.strip().startswith("entry:") and _DECORATIVE_GUARD in line
        ]
        assert not offenders, (
            f"an entry re-states the decorative venv guard, whose `;` makes it "
            f"run the gate regardless of whether activation happened: {offenders}. "
            f"Route through {_WRAPPER_ENTRY} instead."
        )

    def test_every_backend_gate_entry_routes_through_the_wrapper(self) -> None:
        """One wrapper, so there is no shell logic left for a fourth hook to copy."""
        unwrapped = [
            entry
            for entry in _ENTRY_LINE_RE.findall(_CONFIG.read_text(encoding="utf-8"))
            if _MUST_BE_WRAPPED.intersection(
                f"{stem}.sh" for stem in _BACKEND_SCRIPT_RE.findall(entry)
            )
            and _WRAPPER_ENTRY not in entry
        ]
        assert not unwrapped, (
            f"these hook entries invoke a backend gate without first proving the "
            f"interpreter matches the pins: {unwrapped}"
        )

    def test_the_sweep_looks_at_every_guarded_hook(self) -> None:
        """A sweep that matched nothing would pass for the wrong reason."""
        wrapped = [
            entry
            for entry in _ENTRY_LINE_RE.findall(_CONFIG.read_text(encoding="utf-8"))
            if _WRAPPER_ENTRY in entry
        ]
        assert len(wrapped) == len(_GUARDED_HOOKS), (
            f"expected {len(_GUARDED_HOOKS)} wrapped backend gate entries, "
            f"found {len(wrapped)}: {wrapped}"
        )


class TestAMissingToolIsNotAFinding:
    """Cases 5 and 6 -- the wrong-verdict messages one layer below the hooks."""

    def test_security_reports_the_missing_bandit_not_a_finding(self, tmp_path: Path) -> None:
        """``bandit: command not found`` is not ``✗ Bandit found issues``."""
        farm = _farm(tmp_path)

        result = _run(
            farm,
            ["scripts/backend/security.sh", "--bandit-only"],
            str(_curated_bin(tmp_path)),
        )

        assert result.returncode != 0
        assert "bandit" in result.stderr, (
            f"the failure never names the missing scanner: {result.stderr!r}"
        )
        assert "found issues" not in result.stderr, (
            f"an absent scanner was reported as a security finding: {result.stderr!r}"
        )

    def test_the_test_runner_reports_the_missing_pytest_not_a_failure(self, tmp_path: Path) -> None:
        """A missing runner is a result we failed to obtain, not a red suite."""
        farm = _farm(tmp_path)

        result = _run(
            farm,
            ["scripts/backend/test.sh", "tests/scripts/test_precommit_venv_guard.py"],
            str(_curated_bin(tmp_path)),
        )

        assert result.returncode != 0
        assert "pytest" in result.stderr, (
            f"the failure never names the missing runner: {result.stderr!r}"
        )
        assert "Tests failed" not in result.stderr, (
            f"an absent runner was reported as a test failure: {result.stderr!r}"
        )


class TestTheWrapperIsAUsableScript:
    """The wrapper is the single place the shell logic now lives."""

    def test_it_exists_and_is_executable(self) -> None:
        """A hook entry naming a non-executable file fails as a puzzle."""
        assert _WRAPPER_SCRIPT.is_file(), f"{_WRAPPER_SCRIPT} does not exist"
        assert os.access(_WRAPPER_SCRIPT, os.X_OK), f"{_WRAPPER_SCRIPT} is not executable"

    def test_it_fails_fast(self) -> None:
        """``set -euo pipefail``: a wrapper that swallows errors is the old bug."""
        assert "set -euo pipefail" in _WRAPPER_SCRIPT.read_text(encoding="utf-8")

    def test_it_offers_no_escape_hatch(self) -> None:
        """An env var that skips verification is a second decorative guard.

        Comment lines are exempt, so the script can name the hazard in prose
        without tripping its own guard.
        """
        code = [
            line
            for line in _WRAPPER_SCRIPT.read_text(encoding="utf-8").splitlines()
            if not line.lstrip().startswith("#")
        ]
        offenders = [line for line in code if "PYTHON_ENV" in line]
        assert not offenders, (
            f"the wrapper reads an environment variable that can bypass "
            f"verification; deps.sh is the only verifier: {offenders}"
        )

    def test_its_refusal_does_not_recommend_a_worse_remedy(self) -> None:
        """Never tell the operator to pip-install into an ambient interpreter."""
        body = _WRAPPER_SCRIPT.read_text(encoding="utf-8")
        assert "--cov-fail-under" not in body
        assert "sudo pip" not in body
