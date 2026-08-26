"""Tripwires for the contract-fuzz job's CI wiring.

The failure mode of a DAST job is not a red build -- it is a green one that
fuzzed nothing. This file guards the wiring around the fuzzer: that the job
stands up a real instance against Postgres, proves its credential before
spending it, and hands the verdict to CI unswallowed.

What it deliberately does *not* do any more is assert that strings appear
somewhere in a YAML file. That was tried and it failed: with the whole
``schemathesis run`` invocation commented out, every such assertion still
passed, because a substring search cannot tell a live command from a
commented-out one. So the command moved into
``backend/scripts/dast/contract_fuzz.sh``, where it can be executed, and the
exclusion list moved with it. Everything about the fuzzer's arguments is now
asserted by running it under a recording stub, in
``test_contract_fuzz_script.py``. What is left here reads the workflow, and the
two mechanisms it reads it with -- comment-stripping and per-step extraction --
are themselves tested against deliberately violating fixtures at the bottom of
this file, because a guard nobody has watched fail is not known to work.

The workflow is parsed as plain text rather than with PyYAML on purpose. PyYAML
is absent from ``requirements.txt``, ``requirements-lock.txt`` and
``requirements-dev.txt``, so ``import yaml`` would turn this guard into a
collection error on the ``backend-compat`` job instead of a passing check.
"""

from __future__ import annotations

import re
import textwrap
from pathlib import Path

import pytest

from rate_limit import RATE_LIMIT_OVERRIDE_ENV_VAR
from tests.scripts.dast.test_contract_fuzz_catches_a_planted_bug import REQUIRE_ENV_VAR

_REPO_ROOT = Path(__file__).resolve().parents[4]
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "dast-contract.yml"
_REQUIREMENTS = _REPO_ROOT / "backend" / "requirements-dast.txt"

# Text that would leave the job structurally present but report a red run as a
# green one. Fragments that only *look* disarming inside the fuzz step are not
# listed: that step is pinned by exact equality below, which is strictly
# stronger than any blacklist of shell idioms could be.
_DISARMING_FRAGMENTS = (
    "continue-on-error",
    "if: false",
    "if: ${{ false }}",
)

_FUZZ_STEP = "Contract fuzz"
_MINT_STEP = "Mint a bearer token and prove it works"
_SELF_PROOF_STEP = "Prove the fuzzer catches a planted bug"

# The suite that runs the pinned fuzzer against a deliberately broken app and
# requires it to fail. Named here rather than restated as prose because a
# renamed file must turn this red, not leave a step running nothing.
_SELF_PROOF_SUITE = "tests/scripts/dast/test_contract_fuzz_catches_a_planted_bug.py"

# The fuzz step's whole command. Asserted by equality rather than by containment
# so that nothing can be appended: a trailing command becomes the step's exit
# code, and a leading ``#`` makes the command disappear entirely.
_FUZZ_COMMAND = "scripts/dast/contract_fuzz.sh"

_ARTIFACT_NAME = "dast-contract-report"

_USES = re.compile(r"^\s*(?:- )?uses:\s*(?P<action>\S+)\s*(?P<comment>#.*)?$", re.MULTILINE)
_SHA_PINNED = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")
_EXACT_PIN = re.compile(r"^[A-Za-z0-9._-]+==[^\s;#]+$")
_RUN_KEY = re.compile(r"^(?P<indent>\s*)run:\s*(?P<inline>.*?)\s*$")

# YAML block scalar introducers; anything else after ``run:`` is the command.
_BLOCK_SCALARS = ("|", "|-", "|+", ">", ">-", ">+")


@pytest.fixture(scope="module")
def workflow() -> str:
    """Return the contract-fuzz workflow as text."""
    assert _WORKFLOW.is_file(), f"{_WORKFLOW} does not exist"
    return _WORKFLOW.read_text(encoding="utf-8")


def without_comment_lines(workflow_text: str) -> str:
    """Return the workflow with whole-line comments removed.

    The header explains at length why this job does not run on
    ``pull_request_target`` and why ``continue-on-error`` would be worse than no
    job at all; a substring search over the raw file would read those
    explanations as the very things they forbid.

    Args:
        workflow_text: The workflow file's contents.

    Returns:
        The same text with every comment-only line dropped.
    """
    return "\n".join(
        line for line in workflow_text.splitlines() if not line.strip().startswith("#")
    )


def step_body(workflow_text: str, step_name: str) -> list[str]:
    """Return the lines belonging to one named step.

    Args:
        workflow_text: The workflow file's contents.
        step_name: The step's ``name:`` value.

    Returns:
        Every line after the step's own ``- name:`` line, up to the next item in
        the same sequence.
    """
    lines = workflow_text.splitlines()
    marker = re.compile(rf"^(?P<indent>\s*)- name: {re.escape(step_name)}\s*$")
    start, indent = None, ""
    for index, line in enumerate(lines):
        found = marker.match(line)
        if found:
            start, indent = index, found.group("indent")
            break
    assert start is not None, f"the workflow declares no step named {step_name!r}"
    body: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith(f"{indent}- "):
            break
        body.append(line)
    return body


def step_run_command(workflow_text: str, step_name: str) -> str:
    """Return one step's shell command, with comment lines and blanks removed.

    Comment-stripping is the point: the disarm this guard exists to catch is a
    ``#`` in front of the command, and a raw-text search reads a commented-out
    command as a live one.

    Args:
        workflow_text: The workflow file's contents.
        step_name: The step's ``name:`` value.

    Returns:
        The command the step runs, dedented, or the empty string when the step
        runs nothing at all.
    """
    body = step_body(workflow_text, step_name)
    for index, line in enumerate(body):
        key = _RUN_KEY.match(line)
        if key is None:
            continue
        if key.group("inline") not in _BLOCK_SCALARS:
            return key.group("inline")
        return _block_scalar(body[index + 1 :], len(key.group("indent")))
    return ""


def _block_scalar(lines: list[str], key_indent: int) -> str:
    """Return the body of a ``run: |`` block, without comments or blank lines.

    Args:
        lines: The lines following the ``run:`` key, within the same step.
        key_indent: Indentation of the ``run:`` key itself; the block is
            whatever is indented further than that.

    Returns:
        The block's live commands, dedented and newline-joined.
    """
    kept = [
        line
        for line in lines
        if line.strip() and not line.strip().startswith("#") and _leading_spaces(line) > key_indent
    ]
    return textwrap.dedent("\n".join(kept)).strip()


def _leading_spaces(line: str) -> int:
    """Return how many spaces a line is indented by.

    Args:
        line: One line of the workflow.

    Returns:
        The count of leading spaces.
    """
    return len(line) - len(line.lstrip(" "))


def test_the_job_never_runs_on_pull_request_target(workflow: str) -> None:
    """A job that runs application code must not hold write-scoped credentials."""
    assert "pull_request_target" not in without_comment_lines(workflow)
    assert re.search(r"^permissions:\n  contents: read$", workflow, re.MULTILINE), workflow


def test_the_job_is_reachable_on_demand_and_on_a_schedule(workflow: str) -> None:
    """Landing non-blocking is only honest if it still actually runs.

    The job is deliberately not a pull-request gate yet -- its first honest run
    is red on pre-existing 500s that no PR author introduced -- but a job with
    no trigger is a job nobody will ever read the findings of.
    """
    live = without_comment_lines(workflow)
    assert re.search(r"^  workflow_dispatch:$", live, re.MULTILINE), live
    assert re.search(r"^  schedule:$", live, re.MULTILINE), live
    assert re.search(r'^    - cron: "[^"]+"$', live, re.MULTILINE), live


def test_every_action_is_sha_pinned(workflow: str) -> None:
    """A floating tag is a supply-chain hole in a job that holds a database."""
    actions = _USES.findall(workflow)
    assert actions, "the workflow uses no actions at all"
    for action, comment in actions:
        assert _SHA_PINNED.match(action), f"{action} is not pinned to a 40-character SHA"
        assert comment, f"{action} carries no version comment"


def test_the_job_stands_up_its_own_instance_against_postgres(workflow: str) -> None:
    """Dialect-specific behaviour is the gap this job exists to close."""
    live = without_comment_lines(workflow)
    assert "postgres:16" in live
    # Started the way the Dockerfile does -- module ``main`` with PYTHONPATH=src.
    assert "PYTHONPATH=src python -m uvicorn main:app" in live
    assert "src.main:app" not in live
    # ``/health/ready``, not ``/health``: the startup seeder must finish first.
    assert "/health/ready" in live


def test_the_job_proves_its_credential_before_spending_it(workflow: str) -> None:
    """A run holding a broken token is denied uniformly and violates no check."""
    minting = step_run_command(workflow, _MINT_STEP)
    assert "scripts.dast.tokens" in minting, minting
    assert "DAST_TOKEN=" in minting, minting


def test_the_job_proves_the_fuzzer_can_fail_before_trusting_it(workflow: str) -> None:
    """A gate nobody has watched fail is not known to work.

    Everything else here checks that the fuzz command is *built* correctly. This
    step is the only thing that checks the fuzzer, once it really runs, fails on
    a violation -- which is what separates a healthy gate from one that fuzzed
    zero operations and exited 0.
    """
    command = step_run_command(workflow, _SELF_PROOF_STEP)
    assert _SELF_PROOF_SUITE in command, command
    assert "pytest" in command, command
    # Without this the step would skip on a runner whose install silently did
    # nothing, and skipping is the failure mode the whole job is about.
    armed = f'{REQUIRE_ENV_VAR}: "1"'
    assert armed in "\n".join(step_body(workflow, _SELF_PROOF_STEP)), armed


def test_the_fuzz_step_runs_the_extracted_script_and_nothing_else(workflow: str) -> None:
    """Equality, not containment: nothing appended, nothing commented out.

    A trailing command would become the step's exit code and swallow the
    fuzzer's verdict; a leading ``#`` would leave the step green having run
    nothing. Both show up here as an inequality.
    """
    assert step_run_command(workflow, _FUZZ_STEP) == _FUZZ_COMMAND


def test_the_job_cannot_be_disarmed(workflow: str) -> None:
    """Each fragment below turns a failing run into a passing one."""
    live = without_comment_lines(workflow)
    for fragment in _DISARMING_FRAGMENTS:
        assert fragment not in live, f"{fragment!r} would disarm the gate"


def test_the_report_is_uploaded_even_when_the_run_fails(workflow: str) -> None:
    """The artifact is the only way to read a failure that happened on a runner."""
    live = without_comment_lines(workflow)
    assert f"name: {_ARTIFACT_NAME}" in live
    assert "if: always()" in live


def test_the_instance_is_started_with_the_dast_rate_limit_override(workflow: str) -> None:
    """Without it the global 60/minute limit answers most of the run with 429.

    Anchored to the start of the line rather than searched for as a substring:
    the variable is namespaced, and a plain containment check would be satisfied
    by any variable whose name merely ends with the one the application reads.
    """
    declared = rf"^\s*{re.escape(RATE_LIMIT_OVERRIDE_ENV_VAR)}: \S+$"
    live = without_comment_lines(workflow)
    assert re.search(declared, live, re.MULTILINE), live


def test_the_job_installs_the_pinned_dast_tooling(workflow: str) -> None:
    """Schemathesis is pinned in a file of its own; see that file's own header."""
    assert "backend/requirements-dast.txt" in without_comment_lines(workflow)


def test_the_dast_requirements_are_exactly_pinned() -> None:
    """A range here would make the gate's verdict depend on the day it ran."""
    assert _REQUIREMENTS.is_file(), f"{_REQUIREMENTS} does not exist"
    lines = [
        line.strip()
        for line in _REQUIREMENTS.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert lines, "the requirements file pins nothing"
    for line in lines:
        assert _EXACT_PIN.match(line), f"{line!r} is not an exact == pin"
    assert any(line.startswith("schemathesis==") for line in lines), lines


# --------------------------------------------------------------------------
# Meta-tests: the guards above, run against deliberately violating fixtures.
#
# Every assertion in this file's previous incarnation passed against a workflow
# whose fuzz command was commented out. These prove the replacements do not.
# --------------------------------------------------------------------------

_FIXTURE = """\
jobs:
  contract-fuzz:
    steps:
      - name: Contract fuzz
        working-directory: backend
        run: |
{body}
      - name: Server log
        run: cat "$UVICORN_LOG"
"""


def _fixture(*command_lines: str) -> str:
    """Build a miniature workflow whose fuzz step runs the given lines.

    Args:
        command_lines: The step's command, one line per argument, undented.

    Returns:
        Workflow text the readers above can be pointed at.
    """
    body = "\n".join(f"          {line}" for line in command_lines)
    return _FIXTURE.format(body=body)


def test_the_step_reader_sees_a_commented_out_command() -> None:
    """The disarm that defeated the previous guard, asserted to be visible now."""
    commented = _fixture(f"# {_FUZZ_COMMAND}", 'echo "contract fuzz skipped"')
    assert step_run_command(commented, _FUZZ_STEP) == 'echo "contract fuzz skipped"'
    assert step_run_command(commented, _FUZZ_STEP) != _FUZZ_COMMAND


def test_the_step_reader_sees_a_swallowed_exit_code() -> None:
    """``|| true`` after the command is a red run reported as a green one."""
    swallowed = _fixture(f"{_FUZZ_COMMAND} || true")
    assert step_run_command(swallowed, _FUZZ_STEP) != _FUZZ_COMMAND


def test_the_step_reader_sees_a_trailing_command() -> None:
    """The step's exit code is the last command's, so an appended line disarms it."""
    trailing = _fixture(_FUZZ_COMMAND, "echo done")
    assert step_run_command(trailing, _FUZZ_STEP) != _FUZZ_COMMAND


def test_the_step_reader_stops_at_the_next_step() -> None:
    """A reader that ran past its step would read the next step's command as its own."""
    assert step_run_command(_fixture(_FUZZ_COMMAND), _FUZZ_STEP) == _FUZZ_COMMAND
    assert step_run_command(_fixture(_FUZZ_COMMAND), "Server log") == 'cat "$UVICORN_LOG"'


def test_the_step_reader_refuses_a_step_that_is_not_there() -> None:
    """A renamed step must fail loudly, not silently assert about nothing."""
    with pytest.raises(AssertionError, match="no step named"):
        step_run_command(_fixture(_FUZZ_COMMAND), "Step that does not exist")


def test_the_disarm_guard_ignores_prose_and_catches_the_real_thing() -> None:
    """Comment-blind in both directions: no false alarm, and no false clearance."""
    prose = "# adding continue-on-error would be worse than no job\njobs:\n"
    assert "continue-on-error" not in without_comment_lines(prose)
    real = "jobs:\n  contract-fuzz:\n    continue-on-error: true\n"
    assert "continue-on-error" in without_comment_lines(real)
