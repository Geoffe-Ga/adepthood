"""Tripwires for the sweep that watches the scheduled workflows from outside.

``startup_failure`` is the quietest failure GitHub has: the workflow file is
rejected before a single job is created, so there is no job, no step, no log,
and every in-workflow reporting job is never created and therefore never fires.
Twelve scan workflows sat in exactly that state and never executed once. Nothing
inside them could ever have said so, which is why the watcher lives outside.

``scripts/ci/check_scheduled_runs.sh`` is that watcher, and its whole product is
an exit code plus a step summary. Every case below **runs the real script**: a
stub ``gh`` first on ``PATH`` (no network, no token, no GitHub), throwaway
workflow files, and a stub reporter that records its argv. Asserting a truth
table against a mocked helper would only prove the mock works; the thing under
test is a shell script, and it has no in-process seam.

Three properties carry the design and each is pinned below:

* the three exit codes stay distinct, and 2 (the sweep could not be completed)
  outranks 1 (something is sick). An incomplete sweep read as a clean one is the
  precise failure this watcher exists to prevent, so a transport fault must
  never round down to 0;
* a paused cron -- ``  # schedule:`` with its cron lines commented beneath, how
  most of the parked scans are stored and documented to be re-enabled -- is
  invisible to the sweep, and a sweep that finds no actively scheduled workflow
  at all fails rather than reporting a clean bill over nothing;
* one reporter call per sick workflow, not one per sick run. Per-run calls would
  add N comments saying the same thing, and noise is how the original failures
  went unread.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SWEEP = _REPO_ROOT / "scripts" / "ci" / "check_scheduled_runs.sh"

EXIT_OK = 0
EXIT_SICK = 1
EXIT_TRANSPORT = 2

SICK = "startup_failure"

REPO = "owner/repo"
ACTIVE_NAME = "active.yml"
PAUSED_NAME = "paused.yml"

# An actively scheduled workflow: `schedule:` indented two spaces under `on:`.
ACTIVE_WORKFLOW = """name: Active
on:
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:

jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: "true"
"""

# A parked one. The cron is commented out, so it cannot run and cannot be sick;
# demanding health from it would file issues against workflows that are off.
PAUSED_WORKFLOW = """name: Paused
on:
  # schedule:
  #   - cron: "0 7 * * *"
  workflow_dispatch:

jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: "true"
"""


def _runs(*conclusions: str | None) -> str:
    """Serialise a ``gh run list`` payload, newest first, one entry per conclusion."""
    return json.dumps(
        [
            {
                "conclusion": conclusion,
                "createdAt": f"2026-08-{20 - index:02d}T06:10:00Z",
                "databaseId": 9000 + index,
            }
            for index, conclusion in enumerate(conclusions)
        ]
    )


@dataclass(frozen=True)
class Sweep:
    """One run of the sweep: its verdict, what it said, and whom it called."""

    returncode: int
    stdout: str
    stderr: str
    summary: str
    gh_calls: list[str]
    reporter_calls: list[str]


def _write_stub(path: Path, log: Path, exit_code: int, stdout: str = "") -> None:
    """Write an executable stub that appends its argv to ``log`` and exits ``exit_code``."""
    path.write_text(
        "#!/usr/bin/env bash\n"
        f'printf "%s\\n" "$*" >> {shlex.quote(str(log))}\n'
        f"printf '%s' {shlex.quote(stdout)}\n"
        f"exit {exit_code}\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _lines(log: Path) -> list[str]:
    """Return one entry per recorded invocation, or nothing if the stub was never called."""
    if not log.exists():
        return []
    return [line for line in log.read_text(encoding="utf-8").splitlines() if line]


def _sweep(
    tmp_path: Path,
    workflows: dict[str, str],
    *,
    gh_stdout: str = "[]",
    gh_exit: int = 0,
    reporter_exit: int = 0,
) -> Sweep:
    """Run the real sweep over throwaway workflows with a stub ``gh`` and a stub reporter."""
    workflows_dir = tmp_path / "workflows"
    workflows_dir.mkdir(exist_ok=True)
    for name, body in workflows.items():
        (workflows_dir / name).write_text(body, encoding="utf-8")

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    gh_log = tmp_path / "gh-argv.log"
    _write_stub(bin_dir / "gh", gh_log, gh_exit, gh_stdout)

    reporter_log = tmp_path / "reporter-argv.log"
    reporter = tmp_path / "stub-reporter.sh"
    _write_stub(reporter, reporter_log, reporter_exit)

    summary = tmp_path / "step-summary.md"
    env = {
        **os.environ,
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "GITHUB_STEP_SUMMARY": str(summary),
        "GITHUB_REPOSITORY": REPO,
    }
    result = subprocess.run(
        [
            str(_SWEEP),
            "--workflows-dir",
            str(workflows_dir),
            "--repo",
            REPO,
            "--reporter",
            str(reporter),
        ],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    return Sweep(
        returncode=result.returncode,
        stdout=result.stdout,
        stderr=result.stderr,
        summary=summary.read_text(encoding="utf-8") if summary.exists() else "",
        gh_calls=_lines(gh_log),
        reporter_calls=_lines(reporter_log),
    )


# --- The healthy case, and the sick one it must stay distinct from ---------


def test_a_healthy_workflow_exits_clean_and_files_nothing(tmp_path: Path) -> None:
    """Nothing sick in view means exit 0 and, above all, no issue opened."""
    sweep = _sweep(tmp_path, {ACTIVE_NAME: ACTIVE_WORKFLOW}, gh_stdout=_runs("success", "success"))

    assert sweep.returncode == EXIT_OK
    assert sweep.reporter_calls == []


def test_a_startup_failure_is_reported_and_exits_sick(tmp_path: Path) -> None:
    """The failure with no job, no step and no log gets the one report it can get."""
    sweep = _sweep(tmp_path, {ACTIVE_NAME: ACTIVE_WORKFLOW}, gh_stdout=_runs(SICK, "success"))

    assert sweep.returncode == EXIT_SICK
    assert len(sweep.reporter_calls) == 1
    assert f"--workflow {ACTIVE_NAME}" in sweep.reporter_calls[0]


def test_several_sick_runs_of_one_workflow_file_one_report(tmp_path: Path) -> None:
    """One call per sick workflow, not per sick run: repeats would be N identical comments."""
    sweep = _sweep(
        tmp_path,
        {ACTIVE_NAME: ACTIVE_WORKFLOW},
        gh_stdout=_runs(SICK, "success", SICK),
    )

    assert sweep.returncode == EXIT_SICK
    assert len(sweep.reporter_calls) == 1


def test_a_startup_failure_behind_a_green_latest_run_still_counts(tmp_path: Path) -> None:
    """Grouping by conclusion instead of by date is what made the original triage wrong.

    The newest run here succeeded, so a check that only inspected the head of
    the list would call this workflow healthy while it was being rejected days
    ago and may be again.
    """
    sweep = _sweep(
        tmp_path,
        {ACTIVE_NAME: ACTIVE_WORKFLOW},
        gh_stdout=_runs("success", "success", SICK),
    )

    assert sweep.returncode == EXIT_SICK
    assert len(sweep.reporter_calls) == 1
    assert "success" in sweep.summary


# --- What the sweep is allowed to look at ----------------------------------


def test_a_paused_cron_is_never_swept(tmp_path: Path) -> None:
    """A commented-out schedule cannot run, so demanding health from it is a false alarm."""
    sweep = _sweep(
        tmp_path,
        {ACTIVE_NAME: ACTIVE_WORKFLOW, PAUSED_NAME: PAUSED_WORKFLOW},
        gh_stdout=_runs("success"),
    )

    assert sweep.returncode == EXIT_OK
    assert len(sweep.gh_calls) == 1
    assert f"--workflow {ACTIVE_NAME}" in sweep.gh_calls[0]
    assert PAUSED_NAME not in sweep.summary
    assert ACTIVE_NAME in sweep.summary


@pytest.mark.parametrize(
    "workflows",
    [
        pytest.param({}, id="no-workflows-at-all"),
        pytest.param({PAUSED_NAME: PAUSED_WORKFLOW}, id="every-cron-paused"),
    ],
)
def test_a_sweep_over_nothing_is_not_a_clean_bill(
    tmp_path: Path, workflows: dict[str, str]
) -> None:
    """Finding no actively scheduled workflow means the sweep proved nothing.

    Exiting 0 here would be a green check forever the day the enumeration
    breaks, which is the same silence the watcher exists to end.
    """
    sweep = _sweep(tmp_path, workflows)

    assert sweep.returncode == EXIT_TRANSPORT
    assert sweep.gh_calls == []
    assert sweep.reporter_calls == []


# --- Transport faults: distinct from sick, and never rounded down to clean ---


def test_a_failed_gh_call_is_unknown_health_not_good_health(tmp_path: Path) -> None:
    """If the API could not be asked, no answer was received; that is not a pass."""
    sweep = _sweep(tmp_path, {ACTIVE_NAME: ACTIVE_WORKFLOW}, gh_stdout="", gh_exit=1)

    assert sweep.returncode == EXIT_TRANSPORT
    assert sweep.returncode != EXIT_OK
    assert sweep.reporter_calls == []


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param("not json", id="unparseable"),
        pytest.param("", id="empty-body"),
        pytest.param("null", id="json-null"),
    ],
)
def test_a_zero_exit_with_something_that_is_not_a_run_array_is_unknown(
    tmp_path: Path, payload: str
) -> None:
    """``gh`` exiting 0 while printing a body that is not a run list answers nothing."""
    sweep = _sweep(tmp_path, {ACTIVE_NAME: ACTIVE_WORKFLOW}, gh_stdout=payload)

    assert sweep.returncode == EXIT_TRANSPORT
    assert sweep.reporter_calls == []


def test_a_json_object_instead_of_a_run_array_is_unknown(tmp_path: Path) -> None:
    """A well-formed body of the wrong shape must not read as an empty, healthy run list.

    Counting sick runs with ``[.[] | select(...)] | length`` iterates an object's
    VALUES, so a body of ``{}`` counts zero sick runs and passes the numeric
    guard, while the latest-run lookup indexes an object with a number, fails,
    and leaves the conclusion blank. The result is a clean bill printed beside an
    empty conclusion -- an answer that was never received, reported as good news,
    which is the one outcome the exit-2 path exists to keep out.
    """
    sweep = _sweep(tmp_path, {ACTIVE_NAME: ACTIVE_WORKFLOW}, gh_stdout="{}")

    assert sweep.returncode == EXIT_TRANSPORT
    assert sweep.reporter_calls == []


def test_a_reporter_that_fails_outranks_the_sick_verdict(tmp_path: Path) -> None:
    """An alarm that could not be filed leaves the failure unattended, so exit 2, not 1."""
    sweep = _sweep(
        tmp_path,
        {ACTIVE_NAME: ACTIVE_WORKFLOW},
        gh_stdout=_runs(SICK),
        reporter_exit=1,
    )

    assert sweep.returncode == EXIT_TRANSPORT
    assert sweep.returncode != EXIT_SICK
    assert len(sweep.reporter_calls) == 1


# --- Workflows with nothing conclusive to say ------------------------------


def test_a_workflow_that_has_never_run_is_not_called_sick(tmp_path: Path) -> None:
    """An empty run list is a fact about a new workflow, not a failure to report."""
    sweep = _sweep(tmp_path, {ACTIVE_NAME: ACTIVE_WORKFLOW}, gh_stdout="[]")

    assert sweep.returncode == EXIT_OK
    assert sweep.reporter_calls == []
    assert "never run" in sweep.summary


def test_a_run_still_in_flight_is_named_rather_than_left_blank(tmp_path: Path) -> None:
    """A null conclusion is a running job; printed blank it reads as a missing field."""
    sweep = _sweep(tmp_path, {ACTIVE_NAME: ACTIVE_WORKFLOW}, gh_stdout=_runs(None, "success"))

    assert sweep.returncode == EXIT_OK
    assert sweep.reporter_calls == []
    assert "in progress" in sweep.summary


# --- The report itself is the entire audience of a cron run ----------------


def test_the_step_summary_names_each_workflow_and_its_latest_conclusion(tmp_path: Path) -> None:
    """A scheduled run reaches nobody but the run list; the summary is all a human gets."""
    sweep = _sweep(tmp_path, {ACTIVE_NAME: ACTIVE_WORKFLOW}, gh_stdout=_runs("failure", "success"))

    assert f"`{ACTIVE_NAME}`: failure" in sweep.summary
    assert "2026-08-20" in sweep.summary
    assert ACTIVE_NAME in sweep.stdout


def test_the_sweep_actually_asks_gh_for_the_runs(tmp_path: Path) -> None:
    """Guards the stub: a script that never called ``gh`` would pass every case above."""
    sweep = _sweep(tmp_path, {ACTIVE_NAME: ACTIVE_WORKFLOW}, gh_stdout=_runs("success"))

    assert len(sweep.gh_calls) == 1
    call = sweep.gh_calls[0]
    assert "run list" in call
    assert f"--repo {REPO}" in call
    assert f"--workflow {ACTIVE_NAME}" in call
    assert "--limit" in call
    assert "--json conclusion,createdAt,databaseId" in call


def test_the_sweep_script_is_executable() -> None:
    """The workflow invokes it directly; mode 100644 would exit 126 and look like a crash."""
    assert os.access(_SWEEP, os.X_OK)
