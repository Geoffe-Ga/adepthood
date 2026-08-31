"""A cron-driven workflow must say what happened, in the place a human looks.

A scheduled run reaches nobody. There is no PR to annotate, no author waiting on
a check, and nothing to click through from. The whole audience is the Actions
run list, which shows one word per run: success or failure. So a workflow that
fails for a benign reason and one that fails because a credential expired render
identically, and both render identically to one that has quietly been failing
for a month.

The grooming workflow is the worked example. It reported failure on most of its
recent scheduled runs. Some were false reds -- the grooming finished and the
action then exited non-zero for using more turns than its cap allowed. One was a
real red: a weekly usage limit, one turn, nothing attempted. Nothing in the run
list distinguished them, and nothing outside the run list was written at all.

Three properties make the difference legible, and this module holds every
actively scheduled workflow to them:

* it writes to ``$GITHUB_STEP_SUMMARY``, so the run carries a sentence rather
  than a colour;
* it has an ``if: failure()`` job calling the shared failure reporter, so a
  failure opens or updates one tracking issue instead of scrolling away;
* if it invokes Claude and marks a step ``continue-on-error``, the same job runs
  the outcome classifier. That pairing is the masking vector: without it, a
  later edit could leave ``continue-on-error`` in place with nothing left to
  interpret the outcome, and every failure would report success forever.

Mentioning ``$GITHUB_STEP_SUMMARY`` is not writing to it. One of these
workflows asks the model, in its prompt text, to append a summary; the file name
appears, and the workflow itself writes nothing. So the check looks for a
redirection, a ``tee``, or a script reading the variable out of the environment.

Parsed as plain text. PyYAML is deliberately in no requirements file, and a
guard over CI configuration must not be the thing that introduces a parser
dependency -- imported here it would turn this module into a collection error on
the 3.11 and 3.12 compat jobs, which is a louder version of the silence it
exists to prevent.

Every check takes the workflows directory or a single workflow as an argument,
so the same code that grades the real tree is pointed at a deliberately
violating tree below. A gate never observed to fail is not known to be a gate.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tests.workflow_text import jobs, without_comment_lines

_REPO_ROOT = Path(__file__).resolve().parents[3]
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"

# Column-anchored on purpose. An active cron is `schedule:` indented two spaces
# under `on:`; a paused one is `  # schedule:` with its cron lines commented
# beneath, which is how most of the scan workflows are parked and how they are
# documented to be re-enabled -- by uncommenting. Matching the commented form
# would make this guard demand reporting from workflows that never run.
_ACTIVE_SCHEDULE = re.compile(r"^  schedule:\s*$", re.MULTILINE)

_CLAUDE_ACTION = "anthropics/claude-code-action"
_REPORT_FAILURE_CALL = "./.github/workflows/_report-failure.yml"
_FAILURE_CONDITION = "if: failure()"
_CLASSIFIER = "classify_claude_outcome.sh"
_CONTINUE_ON_ERROR = "continue-on-error: true"

# Writing to the summary, in the three shapes this repo uses: a redirection, a
# `tee`, or a script pulling the path out of the environment. A bare mention of
# the variable -- for instance inside a prompt asking the model to append -- is
# not a write and must not satisfy the check.
_STEP_SUMMARY_WRITE = re.compile(
    r">>\s*\"?\$GITHUB_STEP_SUMMARY"
    r"|tee\s+(?:-a\s+)?\"?\$GITHUB_STEP_SUMMARY"
    r"|environ(?:\.get)?[(\[]\s*[\"']GITHUB_STEP_SUMMARY"
)


def _code(workflow: Path) -> str:
    """Return the workflow with whole-line comments dropped.

    Reading code rather than raw text keeps a rationale that quotes a forbidden
    shape from tripping the guard that forbids it -- and keeps a paused cron,
    which lives entirely in comments, from counting.
    """
    return without_comment_lines(workflow.read_text(encoding="utf-8"))


def _jobs(workflow: Path) -> dict[str, str]:
    """Return each job's body, keyed by job id, with its comments already gone.

    ``if: failure()`` and the reporter call have to sit in the *same* job to
    mean anything, and a whole-file substring search cannot tell.
    """
    return jobs(_code(workflow))


def _actively_scheduled(workflows: Path) -> list[Path]:
    """Every workflow in ``workflows`` that a cron really starts today."""
    return [
        workflow
        for workflow in sorted(workflows.glob("*.yml"))
        if _ACTIVE_SCHEDULE.search(_code(workflow))
    ]


def _claude_invoking(workflows: Path) -> list[Path]:
    """Every workflow in ``workflows`` that runs the Claude action."""
    return [
        workflow
        for workflow in sorted(workflows.glob("*.yml"))
        if _CLAUDE_ACTION in _code(workflow)
    ]


def _step_summary_shortfall(workflow: Path) -> str | None:
    """Describe how ``workflow`` fails to write a run summary, or ``None``."""
    if _STEP_SUMMARY_WRITE.search(_code(workflow)):
        return None
    return (
        f"{workflow.name} runs on a cron and writes nothing to $GITHUB_STEP_SUMMARY, "
        "so its run list entry is a colour and nothing else"
    )


def _failure_report_shortfall(workflow: Path) -> str | None:
    """Describe how ``workflow`` fails to report its own failures, or ``None``."""
    for body in _jobs(workflow).values():
        if _FAILURE_CONDITION in body and _REPORT_FAILURE_CALL in body:
            return None
    return (
        f"{workflow.name} has no `if: failure()` job calling {_REPORT_FAILURE_CALL}, "
        "so a failing cron run notifies nobody and looks like a run with nothing to do"
    )


def _masked_claude_jobs(workflow: Path) -> list[str]:
    """Return the jobs that swallow a Claude step's failure without classifying it."""
    if _CLAUDE_ACTION not in _code(workflow):
        return []
    return [
        job
        for job, body in _jobs(workflow).items()
        if _CONTINUE_ON_ERROR in body and _CLASSIFIER not in body
    ]


# --- The real tree ---------------------------------------------------------


def test_the_repository_has_actively_scheduled_workflows_to_check() -> None:
    """A guard over an empty set passes for the wrong reason."""
    assert _actively_scheduled(_WORKFLOWS), "no workflow runs on a cron; this guard is inert"


def test_the_repository_has_claude_invoking_workflows_to_check() -> None:
    """Same, for the half of this module that grades the masking vector."""
    assert _claude_invoking(_WORKFLOWS), "no workflow invokes Claude; this guard is inert"


def test_a_commented_out_cron_is_not_counted_as_active() -> None:
    """Most scan workflows are parked behind a commented cron and must stay out of scope.

    Asserted as a strict inequality rather than a count: re-enabling a paused
    scan is a normal thing to do, and a guard that a maintainer has to edit to
    do it is a guard they will delete instead.
    """
    mentions = [
        workflow
        for workflow in sorted(_WORKFLOWS.glob("*.yml"))
        if "schedule:" in workflow.read_text(encoding="utf-8")
    ]

    assert len(_actively_scheduled(_WORKFLOWS)) < len(mentions)


@pytest.mark.parametrize(
    "workflow", _actively_scheduled(_WORKFLOWS), ids=lambda path: str(path.name)
)
def test_a_scheduled_workflow_writes_a_run_summary(workflow: Path) -> None:
    """Nobody is watching a cron run; the summary is the only place it can speak."""
    assert _step_summary_shortfall(workflow) is None, _step_summary_shortfall(workflow)


@pytest.mark.parametrize(
    "workflow", _actively_scheduled(_WORKFLOWS), ids=lambda path: str(path.name)
)
def test_a_scheduled_workflow_reports_its_own_failures(workflow: Path) -> None:
    """One shared reporter, so a failure opens or updates an issue rather than scrolling away."""
    assert _failure_report_shortfall(workflow) is None, _failure_report_shortfall(workflow)


@pytest.mark.parametrize("workflow", _claude_invoking(_WORKFLOWS), ids=lambda path: str(path.name))
def test_a_swallowed_claude_step_is_classified_in_the_same_job(workflow: Path) -> None:
    """``continue-on-error`` with nothing reading the outcome greens every failure.

    This is the shape a later edit reaches for when a false red is annoying:
    silence the step, forget to read what it produced. The classifier is what
    makes swallowing the exit code safe, so the two travel together or not at all.
    """
    assert not _masked_claude_jobs(workflow)


def test_the_shared_failure_reporter_exists() -> None:
    """Every scheduled workflow is about to call it; a dangling `uses:` is a startup failure."""
    assert (_REPO_ROOT / _REPORT_FAILURE_CALL.removeprefix("./")).is_file()


# --- The same checks, pointed at a tree built to fail them -----------------
#
# Everything above passes on a repository where these checks do nothing at all.
# These cases are the proof that they do something.

_ACTIVE_CRON = 'on:\n  schedule:\n    - cron: "0 4 * * *"\n  workflow_dispatch:\n'
_PAUSED_CRON = 'on:\n  # schedule:\n  #   - cron: "0 4 * * *"\n  workflow_dispatch:\n'


def _write(workflows: Path, name: str, body: str) -> Path:
    """Write one workflow file into a throwaway workflows directory."""
    workflows.mkdir(parents=True, exist_ok=True)
    path = workflows / name
    path.write_text(body, encoding="utf-8")
    return path


def _compliant(workflows: Path) -> Path:
    """A scheduled workflow that satisfies every check here."""
    return _write(
        workflows,
        "compliant.yml",
        "name: Compliant\n"
        f"{_ACTIVE_CRON}"
        "jobs:\n"
        "  work:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        "      - name: Report\n"
        '        run: echo "ran" >> "$GITHUB_STEP_SUMMARY"\n'
        "  report-failure:\n"
        "    needs: work\n"
        "    if: failure()\n"
        f"    uses: {_REPORT_FAILURE_CALL}\n",
    )


def test_the_checks_can_be_satisfied(tmp_path: Path) -> None:
    """A check that fails on everything is as useless as one that fails on nothing."""
    workflow = _compliant(tmp_path / "workflows")

    assert _actively_scheduled(tmp_path / "workflows") == [workflow]
    assert _step_summary_shortfall(workflow) is None
    assert _failure_report_shortfall(workflow) is None
    assert not _masked_claude_jobs(workflow)


def test_a_paused_cron_is_discovered_by_nothing(tmp_path: Path) -> None:
    """The commented form must stay invisible even though the word is right there."""
    _write(
        tmp_path / "workflows",
        "paused.yml",
        f"name: Paused\n{_PAUSED_CRON}jobs:\n  work:\n    runs-on: ubuntu-latest\n",
    )

    assert _actively_scheduled(tmp_path / "workflows") == []


def test_a_scheduled_workflow_with_no_summary_is_caught(tmp_path: Path) -> None:
    """Including the near miss: naming the variable without ever writing to it."""
    silent = _write(
        tmp_path / "workflows",
        "silent.yml",
        "name: Silent\n"
        f"{_ACTIVE_CRON}"
        "jobs:\n"
        "  work:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        "      - name: Ask the model to write the summary itself\n"
        "        run: |\n"
        "          echo 'append your summary to $GITHUB_STEP_SUMMARY'\n",
    )

    assert _step_summary_shortfall(silent) is not None


def test_a_scheduled_workflow_with_no_failure_report_is_caught(tmp_path: Path) -> None:
    """A summary nobody reads on a run nobody opens is still silence."""
    unreported = _write(
        tmp_path / "workflows",
        "unreported.yml",
        "name: Unreported\n"
        f"{_ACTIVE_CRON}"
        "jobs:\n"
        "  work:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        "      - name: Report\n"
        '        run: echo "ran" >> "$GITHUB_STEP_SUMMARY"\n',
    )

    assert _failure_report_shortfall(unreported) is not None


def test_a_failure_condition_in_a_different_job_does_not_count(tmp_path: Path) -> None:
    """Two halves of the contract in two jobs is neither half of it.

    A whole-file substring search would pass this file, which is why the jobs
    are split apart before either string is looked for.
    """
    split = _write(
        tmp_path / "workflows",
        "split.yml",
        "name: Split\n"
        f"{_ACTIVE_CRON}"
        "jobs:\n"
        "  work:\n"
        "    if: failure()\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        "      - name: Report\n"
        '        run: echo "ran" >> "$GITHUB_STEP_SUMMARY"\n'
        "  publish:\n"
        "    needs: work\n"
        f"    uses: {_REPORT_FAILURE_CALL}\n",
    )

    assert _failure_report_shortfall(split) is not None


def test_a_swallowed_claude_step_without_a_classifier_is_caught(tmp_path: Path) -> None:
    """The masking vector, written out: silence the step, read nothing it produced."""
    masked = _write(
        tmp_path / "workflows",
        "masked.yml",
        "name: Masked\n"
        "on:\n  workflow_dispatch:\n"
        "jobs:\n"
        "  ask:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        f"      - uses: {_CLAUDE_ACTION}@v1\n"
        f"        {_CONTINUE_ON_ERROR}\n"
        "      - name: Report\n"
        '        run: echo "ran" >> "$GITHUB_STEP_SUMMARY"\n',
    )

    assert _masked_claude_jobs(masked) == ["ask"]


def test_a_classifier_in_another_job_does_not_unmask_the_swallowed_step(tmp_path: Path) -> None:
    """The classifier reads the failing job's own execution file; elsewhere it reads nothing."""
    elsewhere = _write(
        tmp_path / "workflows",
        "elsewhere.yml",
        "name: Elsewhere\n"
        "on:\n  workflow_dispatch:\n"
        "jobs:\n"
        "  ask:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        f"      - uses: {_CLAUDE_ACTION}@v1\n"
        f"        {_CONTINUE_ON_ERROR}\n"
        "  interpret:\n"
        "    needs: ask\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        f"      - run: scripts/ci/{_CLASSIFIER} --step-outcome failure\n",
    )

    assert _masked_claude_jobs(elsewhere) == ["ask"]


def test_a_swallowed_claude_step_beside_its_classifier_is_accepted(tmp_path: Path) -> None:
    """The pairing the rule actually asks for, so the rule is not simply a ban."""
    paired = _write(
        tmp_path / "workflows",
        "paired.yml",
        "name: Paired\n"
        "on:\n  workflow_dispatch:\n"
        "jobs:\n"
        "  ask:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        f"      - uses: {_CLAUDE_ACTION}@v1\n"
        f"        {_CONTINUE_ON_ERROR}\n"
        f"      - run: scripts/ci/{_CLASSIFIER} --step-outcome failure\n",
    )

    assert _masked_claude_jobs(paired) == []


def test_a_swallowed_step_in_a_workflow_that_never_calls_claude_is_out_of_scope(
    tmp_path: Path,
) -> None:
    """The rule is about an unread model outcome, not about ``continue-on-error`` as such."""
    ordinary = _write(
        tmp_path / "workflows",
        "ordinary.yml",
        "name: Ordinary\n"
        "on:\n  workflow_dispatch:\n"
        "jobs:\n"
        "  flaky:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        "      - run: ./flaky-upload.sh\n"
        f"        {_CONTINUE_ON_ERROR}\n",
    )

    assert _masked_claude_jobs(ordinary) == []


# --- The wiring the unit tests cannot see ----------------------------------
#
# The classifier's own test suite invokes it directly, so it passes whatever the
# caller decides to pass. That leaves one substitution completely uncovered:
# feeding it `steps.<id>.conclusion` instead of `steps.<id>.outcome`. Under
# `continue-on-error: true` a failed step's `outcome` stays `failure` while its
# `conclusion` becomes `success` -- so the wrong one reports success for every
# failure the classifier exists to catch, and every unit test still passes.
# Only the workflow text shows it, so only a check over the workflow text can
# catch it.

_STEP_OUTCOME_REF = re.compile(r"steps\.[A-Za-z_][\w-]*\.outcome\b")
_STEP_CONCLUSION_REF = re.compile(r"steps\.[A-Za-z_][\w-]*\.conclusion\b")


def _classifying_jobs(workflow: Path) -> dict[str, str]:
    """Return the jobs in ``workflow`` that run the outcome classifier."""
    return {job: body for job, body in _jobs(workflow).items() if _CLASSIFIER in body}


def _conclusion_wiring_shortfall(workflow: Path) -> str | None:
    """Describe how ``workflow`` feeds the classifier the wrong signal, or ``None``."""
    for job, body in _classifying_jobs(workflow).items():
        if _STEP_CONCLUSION_REF.search(body):
            return (
                f"{workflow.name} job `{job}` feeds the classifier a step's `conclusion`; "
                "under continue-on-error that reads `success` for every failure"
            )
        if not _STEP_OUTCOME_REF.search(body):
            return (
                f"{workflow.name} job `{job}` runs the classifier without reading any "
                "step's `outcome`, so nothing tells it whether the step failed"
            )
    return None


def test_some_workflow_actually_wires_the_classifier() -> None:
    """Otherwise the check below grades an empty set and reports success."""
    wired = [w for w in sorted(_WORKFLOWS.glob("*.yml")) if _classifying_jobs(w)]

    assert wired, "no workflow runs the outcome classifier; this guard is inert"


@pytest.mark.parametrize("workflow", _claude_invoking(_WORKFLOWS), ids=lambda path: str(path.name))
def test_the_classifier_is_told_the_outcome_not_the_conclusion(workflow: Path) -> None:
    """The one substitution that disables the mechanism while every other test stays green."""
    assert _conclusion_wiring_shortfall(workflow) is None, _conclusion_wiring_shortfall(workflow)


def _classifying_workflow(workflows: Path, name: str, reference: str) -> Path:
    """A Claude-invoking workflow whose classifier step reads ``reference``."""
    return _write(
        workflows,
        name,
        f"name: {name}\n"
        f"{_ACTIVE_CRON}"
        "jobs:\n"
        "  work:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        f"      - uses: {_CLAUDE_ACTION}@v1\n"
        "        id: run\n"
        f"        {_CONTINUE_ON_ERROR}\n"
        "      - env:\n"
        f"          STEP_OUTCOME: ${{{{ {reference} }}}}\n"
        f'        run: scripts/ci/{_CLASSIFIER} --step-outcome "$STEP_OUTCOME"\n',
    )


def test_wiring_the_conclusion_is_caught(tmp_path: Path) -> None:
    """The failure is silent in production, so it has to be loud here."""
    wrong = _classifying_workflow(tmp_path / "workflows", "wrong.yml", "steps.run.conclusion")

    assert _conclusion_wiring_shortfall(wrong) is not None


def test_wiring_the_outcome_is_accepted(tmp_path: Path) -> None:
    """The control: a check that rejects the correct wiring too would just be noise."""
    right = _classifying_workflow(tmp_path / "workflows", "right.yml", "steps.run.outcome")

    assert _conclusion_wiring_shortfall(right) is None


def test_classifying_on_neither_signal_is_caught(tmp_path: Path) -> None:
    """Running the classifier without telling it whether the step failed answers nothing."""
    blind = _write(
        tmp_path / "workflows",
        "blind.yml",
        f"name: Blind\n{_ACTIVE_CRON}"
        "jobs:\n"
        "  work:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        f"      - uses: {_CLAUDE_ACTION}@v1\n"
        f"      - run: scripts/ci/{_CLASSIFIER} --execution-file out.json\n",
    )

    assert _conclusion_wiring_shortfall(blind) is not None


# --- Every verdict the classifier can reach must be handled by its callers ---
#
# The classifier answers with one word and exits 0, so the caller's `case` is
# what turns that word into a job result. A token the script can emit and the
# caller has never heard of falls to the wildcard, which fails closed -- safe,
# but it means a benign outcome reports red. That is how the `skipped` verdict
# was found in the first place: the action declined to run, the caller had no
# branch for it, and a run where nothing was wrong went red.

_CLASSIFIER_TOKENS = (
    "completed",
    "turn-cap-overrun",
    "usage-limit",
    "auth-failure",
    "agent-error",
    "no-result",
    "skipped",
)


def test_the_token_list_matches_the_classifier() -> None:
    """A token added to the script without being listed here escapes the check below."""
    script = (_REPO_ROOT / "scripts" / "ci" / _CLASSIFIER).read_text(encoding="utf-8")
    missing = [token for token in _CLASSIFIER_TOKENS if f'verdict "{token}"' not in script]

    assert not missing, f"listed here but never emitted by the classifier: {missing}"


@pytest.mark.parametrize(
    "workflow",
    [w for w in sorted(_WORKFLOWS.glob("*.yml")) if _CLASSIFIER in _code(w)],
    ids=lambda path: str(path.name),
)
def test_a_caller_handles_every_verdict_the_classifier_can_reach(workflow: Path) -> None:
    """An unhandled benign verdict reports red, which is the defect being fixed."""
    body = "\n".join(b for b in _jobs(workflow).values() if _CLASSIFIER in b)
    unhandled = [token for token in _CLASSIFIER_TOKENS if f"{token})" not in body]

    assert not unhandled, f"{workflow.name} runs the classifier but never branches on: {unhandled}"


@pytest.mark.parametrize(
    "workflow",
    [w for w in sorted(_WORKFLOWS.glob("*.yml")) if _CLASSIFIER in _code(w)],
    ids=lambda path: str(path.name),
)
def test_a_caller_tells_the_classifier_whether_a_skip_is_possible(workflow: Path) -> None:
    """Silence means the strict reading, which reddens every dispatch from a branch."""
    body = "\n".join(b for b in _jobs(workflow).values() if _CLASSIFIER in b)

    assert "--skip-permitted" in body, (
        f"{workflow.name} never passes --skip-permitted, so a dispatch from any "
        "branch that edits this file reports a failure for a run that was "
        "deliberately declined"
    )
