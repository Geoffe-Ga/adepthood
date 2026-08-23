"""Tripwires for the cross-boundary drift lane and the way it finds its tests.

A handful of frontend Jest tests exist only to read backend source and fail
when the two stacks disagree -- the ten APTITUDE colours and their schedule,
the upload cap, the consent copy's promises about what is collected.
``frontend-ci.yml`` is scoped to ``frontend/**`` on purpose (the whole
pipeline, audit gate and ~450 suites, is too much to pull into a one-line
backend change), and that scoping had an unwritten consequence: a guard whose
entire job is to watch backend source never ran on a backend-only pull
request. A backend change that gave a consent source its first writer merged
green and turned ``main`` red afterwards, on an unrelated PR that happened to
touch a frontend file.

The lane fixes that by running *only* those guards from ``backend-ci.yml``:
seconds, no audit gate, no bundler. This module pins the two properties that
make it real rather than decorative.

**The set is discovered, never listed.** A YAML path list, or an array of
filenames inside the runner, is the same defect class as the bug it repairs:
it goes stale in silence and nothing notices. ``cross-boundary-drift.sh``
finds the guards at run time by the marker each one carries -- an import of
the shared ``@/testing/backendSource`` helper, which is the only supported way
to reach across the boundary, so declaring and reading are the same act. The
tests below assert the runner names no test file of its own, that a
marker-bearing test invented inside a throwaway checkout is picked up with no
edit anywhere, that discovering nothing is an error rather than a clean sweep,
and that the marker is the population: no frontend test hand-rolls its own
path into ``backend/``.

**The lane cannot be disarmed.** The workflow must invoke the runner from a
job whose failure fails the run, and the runner must itself be a trigger path
-- ``backend-ci.yml`` fires on ``backend/**`` and ``scripts/backend/**``, so a
gate living under ``scripts/frontend/`` would otherwise be editable without
running anything at all.

The workflow is parsed as plain text rather than with PyYAML on purpose:
PyYAML is in none of the requirements files, so ``import yaml`` would turn
this guard into a collection error on the compat jobs instead of a passing
check. The runner is exercised by copying it into a miniature checkout under
``tmp_path``, the arrangement ``test_complexity_gate.py`` uses, because it
derives its own root from ``SCRIPT_DIR/../..`` and gains no in-process seam.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCRIPT_RELATIVE = Path("scripts") / "frontend" / "cross-boundary-drift.sh"
_SCRIPT = _REPO_ROOT / _SCRIPT_RELATIVE
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "backend-ci.yml"
_FRONTEND = _REPO_ROOT / "frontend"
_JEST_CONFIG = _FRONTEND / "jest.config.js"
_GUARD_SETUP = _FRONTEND / "jest.setup.crossBoundary.js"

_SUBPROCESS_TIMEOUT_SECONDS = 60

# The one string that makes a test discoverable: the module specifier of the
# shared helper every cross-boundary test reads backend source through.
_MARKER = "@/testing/backendSource"

_JOB_NAME = "cross-boundary-drift"
_INVOCATION = "scripts/frontend/cross-boundary-drift.sh"
_TRIGGER_PATH = f'- "{_INVOCATION}"'

# Fragments that would leave the job structurally present but toothless.
_DISARMING_FRAGMENTS = (
    "continue-on-error",
    "|| true",
    "|| exit 0",
    "set +e",
    "if: false",
    "--passWithNoTests",
)

_JOBS_HEADER = re.compile(r"^jobs:[ \t]*$", re.MULTILINE)
_TOP_LEVEL_JOB = re.compile(r"^  (?P<name>[A-Za-z0-9_-]+):[ \t]*$", re.MULTILINE)

# A test that resolves its own way into backend/ rather than using the helper.
_HAND_ROLLED_BACKEND_PATH = re.compile(r"""['"]backend['"]|backend/src/[\w/]+\.py""")
_READS_FILES = re.compile(r"\b(readFileSync|readdirSync|readFile|readdir)\b")

_INVENTED_GUARD = Path("frontend") / "src" / "invented" / "__tests__" / "inventedGuard.test.ts"


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


def _run(*args: str, checkout: Path = _REPO_ROOT) -> subprocess.CompletedProcess[str]:
    """Run the drift runner, real or relocated, and capture its outcome.

    Args:
        *args: Flags to pass through to the script.
        checkout: Root of the tree holding the copy to run; the real repository
            by default.

    Returns:
        The completed process, never raising on a non-zero exit code.
    """
    return subprocess.run(
        [_bash_executable(), str(checkout / _SCRIPT_RELATIVE), *args],
        capture_output=True,
        text=True,
        check=False,
        timeout=_SUBPROCESS_TIMEOUT_SECONDS,
    )


def _frontend_test_files() -> list[Path]:
    """Return every Jest test file in the frontend tree.

    Returns:
        Absolute paths, installed packages excluded, sorted for stable
        comparison against the runner's own output.
    """
    return sorted(
        path
        for pattern in ("*.test.ts", "*.test.tsx")
        for path in _FRONTEND.rglob(pattern)
        if "node_modules" not in path.parts
    )


def _listed(result: subprocess.CompletedProcess[str]) -> list[str]:
    """Return the repository-relative paths a ``--list`` run printed.

    Args:
        result: A completed ``--list`` invocation.

    Returns:
        One path per non-blank line of stdout.
    """
    return [line for line in result.stdout.splitlines() if line.strip()]


def _fake_checkout(root: Path, *, marked: bool) -> Path:
    """Build a miniature checkout carrying the real runner and one test file.

    Args:
        root: Directory to build the checkout in.
        marked: Whether the invented test carries the discovery marker.

    Returns:
        The checkout root, ready to run the copied script from.
    """
    script = root / _SCRIPT_RELATIVE
    script.parent.mkdir(parents=True)
    script.write_bytes(_SCRIPT.read_bytes())
    script.chmod(0o755)

    invented = root / _INVENTED_GUARD
    invented.parent.mkdir(parents=True)
    body = f"import {{ backendPath }} from '{_MARKER}';\n" if marked else "const x = 1;\n"
    invented.write_text(body, encoding="utf-8")
    return root


class TestDiscovery:
    """The set of cross-boundary guards is derived at run time, not written down."""

    def test_the_runner_is_an_executable_gate(self) -> None:
        """A gate nobody can execute is a gate that never ran."""
        assert _SCRIPT.is_file(), f"{_SCRIPT} is missing"
        assert _SCRIPT.stat().st_mode & 0o111, f"{_SCRIPT} is not executable"

    def test_lists_guards_that_all_exist(self) -> None:
        """Discovery finds something, and everything it finds is a real file."""
        result = _run("--list")

        assert result.returncode == 0, result.stderr
        listed = _listed(result)
        assert listed, "discovery found no cross-boundary guards at all"
        for relative in listed:
            assert (_REPO_ROOT / relative).is_file(), f"listed a missing path: {relative}"

    def test_lists_exactly_the_marker_bearing_tests(self) -> None:
        """The runner's answer matches an independent scan for the marker.

        Derived here rather than compared against a checked-in list, so a guard
        added tomorrow changes both sides of this assertion at once.
        """
        expected = sorted(
            str(path.relative_to(_REPO_ROOT))
            for path in _frontend_test_files()
            if _MARKER in path.read_text(encoding="utf-8")
        )

        result = _run("--list")

        assert sorted(_listed(result)) == expected

    def test_no_frontend_test_reads_backend_source_without_the_marker(self) -> None:
        """No frontend test spells out its own way into ``backend/``.

        A cheap backstop, and knowingly not the whole answer: a test that
        crosses the boundary through a helper in another module, or through a
        computed path, reads no differently here. That is why completeness is
        enforced at run time by ``jest.setup.crossBoundary.js`` instead --
        which is how ``journeyLedger.test.ts``, invisible to this scan, was
        found. What this pins is the narrower promise that nothing in the tree
        resolves a literal backend path by hand.
        """
        undeclared = [
            str(path.relative_to(_REPO_ROOT))
            for path in _frontend_test_files()
            if _MARKER not in (text := path.read_text(encoding="utf-8"))
            and _HAND_ROLLED_BACKEND_PATH.search(text)
            and _READS_FILES.search(text)
        ]

        assert undeclared == [], (
            "these frontend tests reach into backend/ without the marker, so the "
            f"drift lane cannot discover them: {undeclared}"
        )

    def test_the_runner_names_no_test_file_of_its_own(self) -> None:
        """A hand-maintained list is the defect, wherever it is written down."""
        named = re.findall(r"[\w/.-]+\.test\.tsx?", _SCRIPT.read_text(encoding="utf-8"))

        assert named == [], f"discovery has grown a hand-maintained list: {named}"

    def test_finds_a_guard_that_did_not_exist_when_it_was_written(self, tmp_path: Path) -> None:
        """A brand-new marked test is covered the day it is written.

        Nothing in this checkout was ever taught about the invented file, which
        is the whole property: covering it required no edit to the runner, the
        workflow, or any manifest.
        """
        checkout = _fake_checkout(tmp_path, marked=True)

        result = _run("--list", checkout=checkout)

        assert result.returncode == 0, result.stderr
        assert _listed(result) == [_INVENTED_GUARD.as_posix()]

    def test_discovering_nothing_is_an_error_not_a_clean_sweep(self, tmp_path: Path) -> None:
        """An empty sweep must be loud; a silent tick is how gates rot."""
        checkout = _fake_checkout(tmp_path, marked=False)

        result = _run("--list", checkout=checkout)

        assert result.returncode != 0, "discovering nothing passed as if it were clean"
        assert _MARKER in result.stderr

    def test_an_e2e_spec_carrying_the_marker_is_not_swept_in(self, tmp_path: Path) -> None:
        """``frontend/e2e`` is excluded structurally, not just by nobody trying yet.

        An e2e spec matches ``*.test.ts`` like any other, so before
        ``--exclude-dir=e2e`` the claim that the lane skips them held only because
        no e2e spec happened to import the marker. One that did would be handed to
        ``--runTestsByPath`` under the default Jest config, in a job with no live
        backend, rather than under ``jest.e2e.config.js``.

        Args:
            tmp_path: Pytest-provided scratch directory.
        """
        checkout = _fake_checkout(tmp_path, marked=True)
        spec = checkout / "frontend" / "e2e" / "invented.e2e.test.ts"
        spec.parent.mkdir(parents=True, exist_ok=True)
        spec.write_text(f"import {{ backendPath }} from '{_MARKER}';\n", encoding="utf-8")

        listed = _listed(_run("--list", checkout=checkout))

        assert not any("e2e/" in path for path in listed), (
            "an e2e spec importing the marker was swept into the cross-boundary lane; "
            f"it would run under the wrong Jest config. Listed: {listed}"
        )
        assert listed, "the marked non-e2e guard should still be discovered"

    def test_rejects_an_unknown_flag_rather_than_running_something_else(self) -> None:
        """Argv typos must fail loudly rather than degrade into a default run."""
        result = _run("--everything")

        assert result.returncode != 0
        assert "--everything" in result.stderr


class TestWiring:
    """The lane runs where the breaking change is, and cannot be skipped."""

    @staticmethod
    def _workflow() -> str:
        """Return the backend workflow's text.

        Returns:
            The file contents, read fresh so no fixture caches a stale copy.
        """
        return _WORKFLOW.read_text(encoding="utf-8")

    def _job_body(self) -> str:
        """Return the YAML body of the drift job.

        Returns:
            Everything between the job's key and the next top-level job.
        """
        workflow = self._workflow()
        jobs_at = _JOBS_HEADER.search(workflow)
        assert jobs_at is not None, "backend-ci.yml has no jobs: block"
        bounds = list(_TOP_LEVEL_JOB.finditer(workflow, jobs_at.end()))
        for index, match in enumerate(bounds):
            if match.group("name") != _JOB_NAME:
                continue
            end = bounds[index + 1].start() if index + 1 < len(bounds) else len(workflow)
            return workflow[match.end() : end]
        pytest.fail(f"backend-ci.yml has no {_JOB_NAME} job")

    def test_backend_ci_runs_the_drift_lane(self) -> None:
        """The guards run from the workflow the breaking change triggers."""
        assert _INVOCATION in self._job_body()

    def test_the_lane_is_not_disarmed(self) -> None:
        """No fragment that would let the job report success without gating."""
        body = self._job_body()

        present = [fragment for fragment in _DISARMING_FRAGMENTS if fragment in body]

        assert present == [], f"{_JOB_NAME} can pass without gating: {present}"

    def test_editing_the_runner_triggers_the_workflow(self) -> None:
        """The gate's own file is a trigger path, on push and pull_request both.

        ``backend-ci.yml`` fires on ``backend/**`` and ``scripts/backend/**``,
        neither of which covers a runner living under ``scripts/frontend/``.
        """
        workflow = self._workflow()
        jobs_at = _JOBS_HEADER.search(workflow)
        assert jobs_at is not None
        triggers = workflow[: jobs_at.start()]

        assert triggers.count(_TRIGGER_PATH) == 2

    def test_the_lane_runs_the_guards_and_nothing_else(self) -> None:
        """Targeted by path, with no coverage run to drag the suite in."""
        script = _SCRIPT.read_text(encoding="utf-8")

        assert "--runTestsByPath" in script, "the lane must target the discovered guards"
        assert "--coverage" not in script, "coverage would pull the whole suite into a backend PR"

    def test_the_runner_and_the_suite_guard_agree_on_the_marker(self) -> None:
        """One string, spelled the same in bash and in TypeScript.

        The runner greps for the marker and the suite guard demands it; a
        rename that reached only one of them would leave every guard
        undiscoverable while both files still looked correct.
        """
        rule = (_FRONTEND / "src" / "testing" / "crossBoundaryReport.ts").read_text(
            encoding="utf-8",
        )

        assert f"'{_MARKER}'" in _SCRIPT.read_text(encoding="utf-8")
        assert f"'{_MARKER}'" in rule

    def test_jest_runs_the_completeness_guard_on_every_suite(self) -> None:
        """The marker cannot be forgotten, because omitting it fails the suite."""
        assert _GUARD_SETUP.is_file(), f"{_GUARD_SETUP} is missing"

        config = _JEST_CONFIG.read_text(encoding="utf-8")

        assert _GUARD_SETUP.name in config, (
            "the completeness guard must be in setupFilesAfterEnv, or a new "
            "cross-boundary test can skip the marker unnoticed"
        )
