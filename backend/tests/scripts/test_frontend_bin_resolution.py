"""Executable frontend gates resolve their tools locally, never through ``npx``.

``npx <bin>`` is a *resolver*, not a runner: when the tree it runs in has no
``node_modules``, it silently downloads whatever package on the public registry
answers to that name and executes it. Measured inside a Ralph fleet worktree,
which is created without ``node_modules``, a single ``git commit`` of one clean
frontend file produced four broken hooks and two unreviewed installs -- one of
which was a squatter package that merely shares the name of the project's
pinned TypeScript compiler. A quality gate that fetches and runs an arbitrary
third-party program is worse than an absent one, because it reports a verdict.

``npx --no-install`` is not the fix, and was measured too: in a tree without
``node_modules`` it still resolves out of the shared ``~/.npm/_npx`` cache, and
for an uncached name it still queries the registry. The only hermetic form is an
explicit path into the project's own ``node_modules/.bin``, which either runs
the pinned binary or fails immediately with exit 127 and no network at all.

These are text-parse assertions rather than PyYAML ones on purpose. PyYAML is
absent from every requirements file, so ``import yaml`` would turn this guard
into a collection error on the backend-compat job instead of a passing check --
the same rule ``test_pre_push_hook_installation`` documents.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_CONFIG = _REPO_ROOT / ".pre-commit-config.yaml"
_FRONTEND_SCRIPT_DIR = _REPO_ROOT / "scripts" / "frontend"
_DEV_SETUP = _REPO_ROOT / "scripts" / "dev-setup.sh"
_GUARD = _FRONTEND_SCRIPT_DIR / "require-node-modules.sh"

# The guard every frontend hook entry must run before it invokes a node binary,
# spelled as the hook writes it (repo-root-relative, because pre-commit runs
# hooks with the repo root as cwd).
_GUARD_ENTRY = "scripts/frontend/require-node-modules.sh"

# ``npx`` in *command* position: at the start of a line, or after a shell
# separator. Deliberately not a bare substring match -- ``node_modules/.bin/npx``
# would be hermetic, and a word like "npxish" is not an invocation.
_BARE_NPX_RE = re.compile(r"(?:^|[\s;&|(`])npx\s")

# A pre-commit ``entry:`` line for a hook that runs inside frontend/. Every one
# of them has to clear the guard first.
_FRONTEND_ENTRY_RE = re.compile(r"^\s+entry:\s*(.*cd frontend.*)$", re.MULTILINE)

# The number of frontend hook entries the config carries today: eslint,
# prettier, typecheck, tests, tests-coverage, commitlint. Asserted as a floor so
# the "every entry is guarded" test cannot pass by matching nothing.
_MIN_FRONTEND_ENTRIES = 6

# Every gate surface swept below, as a floor for the same reason.
_MIN_GATE_FILES = 8


def _gate_files() -> list[Path]:
    """Return every executable gate surface that may invoke a node binary."""
    return [_CONFIG, _DEV_SETUP, *sorted(_FRONTEND_SCRIPT_DIR.glob("*.sh"))]


def _offending_lines(text: str) -> list[tuple[int, str]]:
    """Return the 1-based numbered lines that invoke a bare ``npx``.

    Comment lines are exempt: this module and the scripts it guards have to be
    able to name the hazard in prose without tripping their own detector.
    """
    return [
        (number, line)
        for number, line in enumerate(text.splitlines(), start=1)
        if not line.lstrip().startswith("#") and _BARE_NPX_RE.search(line)
    ]


class TestTheSweepIsNonVacuous:
    """A guard that scans nothing passes for the wrong reason."""

    def test_every_gate_surface_exists(self) -> None:
        """A renamed or deleted script must fail loudly, not silently drop out."""
        missing = [path for path in _gate_files() if not path.is_file()]
        assert not missing, f"swept gate surfaces that do not exist: {missing}"

    def test_the_sweep_covers_the_known_gate_surfaces(self) -> None:
        """The config, the dev bootstrap, and every frontend script."""
        names = {path.name for path in _gate_files()}
        assert {".pre-commit-config.yaml", "dev-setup.sh"} <= names
        assert {"lint.sh", "format.sh", "typecheck.sh", "test.sh"} <= names
        assert len(_gate_files()) >= _MIN_GATE_FILES

    def test_the_detector_recognises_a_bare_npx(self) -> None:
        """Prove the regex fires on the exact shapes that were shipping."""
        assert _offending_lines("npx jest --passWithNoTests")
        assert _offending_lines("entry: bash -c 'cd frontend && npx tsc --noEmit'")
        assert _offending_lines("npx expo install")

    def test_the_detector_accepts_the_hermetic_forms(self) -> None:
        """The replacements, and prose about the hazard, must not trip it."""
        assert not _offending_lines("./node_modules/.bin/jest --passWithNoTests")
        assert not _offending_lines("npm run lint")
        assert not _offending_lines("  # never invoke npx here")


class TestNoGateInvokesABareNpx:
    """The defect itself: a gate that resolves its tool from the network."""

    @pytest.mark.parametrize("path", _gate_files(), ids=lambda path: path.name)
    def test_the_gate_resolves_its_tools_locally(self, path: Path) -> None:
        """Any hit here is a hook that can download and run a stranger's code."""
        offenders = _offending_lines(path.read_text(encoding="utf-8"))
        assert not offenders, (
            f"{path.relative_to(_REPO_ROOT)} invokes a bare `npx`, which downloads "
            f"and executes whatever the registry serves when node_modules is absent: "
            f"{offenders}. Call ./node_modules/.bin/<tool> instead."
        )


class TestTheFailureIsLegible:
    """Without node_modules the gate must say so, not die as `command not found`."""

    def test_the_shared_guard_exists_and_is_executable(self) -> None:
        """One helper, not a copy of the check per call site."""
        assert _GUARD.is_file(), f"{_GUARD} is missing"
        assert _GUARD.stat().st_mode & 0o111, f"{_GUARD} is not executable"

    def test_the_guard_names_the_remedy(self) -> None:
        """An error that does not say what to run costs a debugging session."""
        assert "npm ci" in _GUARD.read_text(encoding="utf-8")

    def test_every_frontend_hook_entry_clears_the_guard(self) -> None:
        """Including the ones that shell out through npm scripts."""
        entries = _FRONTEND_ENTRY_RE.findall(_CONFIG.read_text(encoding="utf-8"))
        assert len(entries) >= _MIN_FRONTEND_ENTRIES, (
            f"expected at least {_MIN_FRONTEND_ENTRIES} frontend hook entries, "
            f"found {len(entries)} -- has the entry shape changed?"
        )
        unguarded = [entry for entry in entries if _GUARD_ENTRY not in entry]
        assert not unguarded, f"frontend hook entries with no node_modules guard: {unguarded}"
