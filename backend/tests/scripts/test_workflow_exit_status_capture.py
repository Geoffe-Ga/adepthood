"""A ``run:`` block that reads an exit status must first stop ``-e`` from acting on it.

GitHub runs an unadorned ``run:`` block under ``/usr/bin/bash -e {0}``. Opening
the block with ``set -uo pipefail`` adds two options and clears NOTHING: ``-e``
is inherited from the invocation and survives. So in

    set -uo pipefail
    some | pipeline
    status=${PIPESTATUS[0]}
    case "$status" in ... esac

the shell exits ON the pipeline the moment it fails, and the capture line, the
whole ``case``, and any ``$GITHUB_STEP_SUMMARY`` write beneath it are
unreachable. They are not "run in the failure case"; they are dead code that
has never once executed. The step still goes red, which is why this survives
review: the workflow looks like it is doing what it says.

What makes it worth a guard rather than a fix in two files is which code dies.
The dead lines are always the ones that distinguish outcomes -- the ``case``
that separates "we looked and it drifted" from "we could not look at all", the
branch that downgrades an expected exit 1 to a warning. Every one of them is
the part a human reads. The two workflows this was found in each carry a
comment asserting the opposite ("``$?`` is inspected explicitly rather than left
to ``set -e``"), which is the tell that the author believed ``set -uo pipefail``
had replaced the inherited options rather than added to them. That belief is one
copy-paste away from the next workflow.

WHAT COUNTS AS CLEARING IT, and why each one really does:

* ``set +e`` before the read -- the direct form, and the one already used
  correctly in backend-ci.yml.
* an explicit ``shell:`` for the step whose command lacks ``-e``, e.g.
  ``shell: bash {0}`` -- the option is never set in the first place.
* reading the status inside a ``||`` list, as in ``cmd || status=$?`` --
  ``-e`` is defined not to act on a command that is the left operand of ``||``,
  so the failure is caught rather than fatal. This is the dominant safe idiom
  in this repo and must not be flagged; a guard that cried wolf on it would be
  switched off within a week.

``set +e`` is read as a STATE, not a latch. ``set -e`` turns it back on, and a
``set +e`` nested inside a conditional may not have run at all, so neither one
excuses the reads below it. Getting that wrong is not a rounding error: the
reporter block in ``_report-failure.yml`` clears errexit, restores it, and keeps
going, so a latching read would call every later line in that block guarded and
the next unguarded read added there would be exactly as invisible as the two
this module was written to catch.

This is a text heuristic over shell, and it is honest about being one. It does
not know which branch of an ``if`` runs, or that a function defined here is
called there. It is calibrated to be quiet on the idioms this repo actually
uses and loud on the one shape that has already shipped twice.

Parsed as plain text, following test_scheduled_workflow_legibility.py. PyYAML is
deliberately in no requirements file, and a guard over CI configuration must not
be the thing that introduces a parser dependency -- imported here it would turn
this module into a collection error on the 3.11 and 3.12 compat jobs.

Every check takes the workflows directory as an argument, so the same code that
grades the real tree is pointed at a deliberately violating tree below, and at a
clean one. A gate never observed to fail is not known to be a gate.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"

# `${PIPESTATUS[n]}` or a bare `$?`. Both are reads of a status that `-e` will
# have prevented the shell from ever reaching.
_STATUS_READ = re.compile(r"\$\{PIPESTATUS\[|\$\?")

# The start of a step's inline script: `run: |`, `run: |-`, `run: >`, and so on.
_RUN_BLOCK = re.compile(r"^(\s*)run:\s*[|>][-+]?\s*$")

# A step's shell override, e.g. `shell: bash {0}`.
_SHELL_OVERRIDE = re.compile(r"^\s*shell:\s*(?P<command>.+?)\s*$")

# A new list item inside `steps:` -- `- name:`, `- uses:`, `- run:`. Any of them
# ends the previous step, which is what scopes a `shell:` to the right script.
_STEP_START = re.compile(r"^\s*-\s+\w[\w-]*:")

# A `defaults:` mapping, which may sit at workflow level or job level and whose
# `run: shell:` supplies the shell for every step below it that declares none.
# A step's own `shell:` still wins; this is only what a step inherits.
_DEFAULTS_BLOCK = re.compile(r"^(\s*)defaults:\s*$")

_CLEARS_ERREXIT = re.compile(r"^\s*set\s+\+[a-zA-Z]*e")

# `set -e`, `set -eo pipefail`, `set -euo pipefail`, `set -o errexit`. Written so
# that `set -uo pipefail` -- which carries no `e` in its bundle, and is the
# opening line of both offenders -- does NOT match: it adds two options and
# turns errexit back on for nobody.
_RESTORES_ERREXIT = re.compile(r"^\s*set\s+-(?:[a-zA-Z]*e[a-zA-Z]*|o\s+errexit)(?:\s|$)")

# `-e` reaches bash either as its own flag or inside a bundle like `-eo`. The
# long form is spelled out separately because `set -o errexit` is legal too.
_ERREXIT_IN_COMMAND = re.compile(r"(?<![\w-])-[a-zA-Z]*e|(?<![\w-])-o\s+errexit")


@dataclass(frozen=True)
class Script:
    """One ``run:`` block, with the shell its step asked for."""

    workflow: str
    line: int
    body: str
    shell: str | None

    @property
    def runs_under_errexit(self) -> bool:
        """Whether the shell starts this script with ``-e`` already set.

        No ``shell:`` means GitHub's default for a Linux runner, which is
        ``bash -e {0}``. An explicit one is taken at its word.
        """
        if self.shell is None:
            return True
        return bool(_ERREXIT_IN_COMMAND.search(self.shell))


def _code(workflow: Path) -> list[str]:
    """Return the workflow's lines with whole-line comments dropped.

    YAML and the shell inside a ``run:`` block both comment with ``#``, so one
    filter serves both. It also keeps a rationale that quotes ``$?`` -- both
    offending workflows have one -- from being read as a use of it.
    """
    return [
        line
        for line in workflow.read_text(encoding="utf-8").splitlines()
        if not line.lstrip().startswith("#")
    ]


def _default_shells(lines: list[str]) -> list[tuple[int, str]]:
    """Return ``(line index, shell)`` for every ``defaults: run: shell:`` in the file.

    A workflow- or job-level default is the shell a step with no ``shell:`` of
    its own actually gets, so discarding it makes every such step look like
    GitHub's ``bash -e {0}`` when it may be something with no ``-e`` at all --
    and a correct workflow gets reported. There is no ``defaults:`` in this repo
    today, which is exactly why the reading has to be right before one appears.
    """
    found: list[tuple[int, str]] = []
    index = 0
    while index < len(lines):
        block = _DEFAULTS_BLOCK.match(lines[index])
        if block is None:
            index += 1
            continue
        indent = len(block.group(1))
        index += 1
        while index < len(lines):
            line = lines[index]
            if line.strip() and len(line) - len(line.lstrip()) <= indent:
                break
            override = _SHELL_OVERRIDE.match(line)
            if override is not None:
                found.append((index, override.group("command")))
            index += 1
    return found


def _inherited_shell(defaults: list[tuple[int, str]], line: int) -> str | None:
    """Return the default shell in force at ``line``: the last one declared above it."""
    applicable = [shell for declared_at, shell in defaults if declared_at < line]
    return applicable[-1] if applicable else None


def _scripts(workflow: Path) -> list[Script]:
    """Return every inline script in ``workflow``, each carrying its step's shell."""
    lines = _code(workflow)
    defaults = _default_shells(lines)
    found: list[Script] = []
    shell: str | None = None
    index = 0
    while index < len(lines):
        line = lines[index]
        if _STEP_START.match(line):
            shell = None
        override = _SHELL_OVERRIDE.match(line)
        if override is not None:
            shell = override.group("command")
        block = _RUN_BLOCK.match(line)
        if block is None:
            index += 1
            continue
        run_line = index
        indent = len(block.group(1))
        body: list[str] = []
        index += 1
        while index < len(lines):
            candidate = lines[index]
            if candidate.strip() and len(candidate) - len(candidate.lstrip()) <= indent:
                break
            body.append(candidate)
            index += 1
        # A `shell:` may sit either side of `run:` within the same step, so the
        # rest of the step is swept before the script is judged.
        lookahead = index
        while lookahead < len(lines) and not _STEP_START.match(lines[lookahead]):
            trailing = _SHELL_OVERRIDE.match(lines[lookahead])
            if trailing is not None:
                shell = trailing.group("command")
            lookahead += 1
        found.append(
            Script(
                workflow=workflow.name,
                line=index - len(body),
                body="\n".join(body),
                shell=shell if shell is not None else _inherited_shell(defaults, run_line),
            )
        )
    return found


def _unguarded_reads(script: Script) -> list[str]:
    """Return the lines of ``script`` that read a status ``-e`` will never let it reach.

    ``set +e`` is tracked as a state that can be turned back OFF, not as a latch.
    A block that clears errexit, reads its status, restores errexit and then goes
    on to a second pipeline is the correct shape -- and the shipped reporter has
    exactly it -- so a latch would declare the whole remainder of that block
    guarded and stop looking. The guard's whole subject is the code below a
    restore.

    Only a ``set +e`` at the script's own indentation counts as clearing.
    ``if [ "$mode" = soft ]; then set +e; fi`` may not have run, so a status read
    after it is still a read that ``-e`` may never let the shell reach.
    """
    if not script.runs_under_errexit:
        return []
    lines = script.body.splitlines()
    base = min((len(line) - len(line.lstrip()) for line in lines if line.strip()), default=0)
    offending: list[str] = []
    cleared = False
    for line in lines:
        top_level = len(line) - len(line.lstrip()) <= base
        if top_level and _CLEARS_ERREXIT.search(line):
            cleared = True
            continue
        # Any restore counts, nested or not: after one, errexit MAY be back on,
        # and "may" is enough to make the next unguarded read unreachable.
        if _RESTORES_ERREXIT.search(line):
            cleared = False
            continue
        if cleared:
            continue
        if not _STATUS_READ.search(line):
            continue
        # `cmd || status=$?` catches the failure instead of dying on it. `-e`
        # does not act on the left operand of `||`, so the read is reachable.
        if "||" in line:
            continue
        offending.append(line.strip())
    return offending


def _violations(workflows: Path) -> dict[str, list[str]]:
    """Map each workflow filename to the unreachable status reads it contains."""
    found: dict[str, list[str]] = {}
    for workflow in sorted(workflows.glob("*.yml")):
        offending = [read for script in _scripts(workflow) for read in _unguarded_reads(script)]
        if offending:
            found[workflow.name] = offending
    return found


# --- The real tree ---------------------------------------------------------


def test_the_repository_has_inline_scripts_to_check() -> None:
    """A guard over an empty set passes for the wrong reason."""
    scripts = [script for workflow in _WORKFLOWS.glob("*.yml") for script in _scripts(workflow)]

    assert scripts, "no `run:` blocks were parsed out of the workflows; this guard is inert"


def test_the_repository_reads_exit_statuses_somewhere() -> None:
    """Same, one level in: the detector must have something to detect."""
    reads = [
        script
        for workflow in _WORKFLOWS.glob("*.yml")
        for script in _scripts(workflow)
        if _STATUS_READ.search(script.body)
    ]

    assert reads, "no workflow reads $? or ${PIPESTATUS[...]}; this guard is inert"


def test_no_workflow_reads_a_status_that_errexit_will_never_let_it_reach() -> None:
    """The guard itself: a verdict block below an unguarded pipeline is dead code."""
    violations = _violations(_WORKFLOWS)

    assert not violations, "\n".join(
        f"{name}: reads a status under an inherited `set -e`, so this line and "
        f"everything below it in the block is unreachable: {reads}"
        for name, reads in violations.items()
    )


def test_the_correctly_guarded_workflows_are_not_flagged() -> None:
    """The false-positive half. A guard that fires on the right idiom gets deleted.

    backend-ci.yml brackets its read with ``set +e`` / ``set -e``; scan-groom.yml
    and four others use ``cmd || status=$?``. Both are correct, both are common
    here, and neither may be reported.
    """
    guarded = {
        "backend-ci.yml",
        "scan-groom.yml",
        "_claude-scan.yml",
        "scheduled-health.yml",
        "weekly-playbook.yml",
        "dependabot-to-ralph-issue.yml",
    }
    violations = _violations(_WORKFLOWS)

    assert not (guarded & violations.keys())


# --- The same check, pointed at trees built to fail and to pass it ---------


_OFFENDING_WORKFLOW = """\
name: Offender
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Compare and report
        run: |
          set -uo pipefail
          some-command 2>&1 | tee "$report"
          status=${PIPESTATUS[0]}
          case "$status" in
            0) verdict="clean" ;;
            *) verdict="broken" ;;
          esac
          echo "$verdict" >> "$GITHUB_STEP_SUMMARY"
"""

_GUARDED_WORKFLOWS = {
    "set-plus-e.yml": """\
name: Guarded by set +e
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Compare and report
        run: |
          set -uo pipefail
          set +e
          some-command 2>&1 | tee "$report"
          status=${PIPESTATUS[0]}
          set -e
          echo "$status" >> "$GITHUB_STEP_SUMMARY"
""",
    "or-list.yml": """\
name: Guarded by an or-list
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Compare and report
        run: |
          set -euo pipefail
          status=0
          some-command || status=$?
          echo "$status" >> "$GITHUB_STEP_SUMMARY"
""",
    "shell-override.yml": """\
name: Guarded by a shell override
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Compare and report
        shell: bash {0}
        run: |
          set -uo pipefail
          some-command 2>&1 | tee "$report"
          status=${PIPESTATUS[0]}
          echo "$status" >> "$GITHUB_STEP_SUMMARY"
""",
    "no-status-read.yml": """\
name: Reads nothing
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Just run it
        run: |
          set -euo pipefail
          some-command
""",
}


_RESTORING_WORKFLOW = """\
name: Clears errexit, restores it, then reads another status
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Fetch, then report
        run: |
          set -uo pipefail
          set +e
          fetch 2>&1 | tee "$log"
          first_status=${PIPESTATUS[0]}
          set -e
          second 2>&1 | tee "$other"
          second_status=${PIPESTATUS[0]}
          echo "$second_status" >> "$GITHUB_STEP_SUMMARY"
"""

_CONDITIONALLY_CLEARED_WORKFLOW = """\
name: Clears errexit only on one branch
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Maybe soft
        run: |
          set -uo pipefail
          if [ "$MODE" = "soft" ]; then
            set +e
          fi
          some-command 2>&1 | tee "$report"
          status=${PIPESTATUS[0]}
          echo "$status" >> "$GITHUB_STEP_SUMMARY"
"""

_DEFAULT_SHELL_WORKFLOW = """\
name: Inherits a shell with no -e
defaults:
  run:
    shell: bash {0}
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Compare and report
        run: |
          set -uo pipefail
          some-command 2>&1 | tee "$report"
          status=${PIPESTATUS[0]}
          echo "$status" >> "$GITHUB_STEP_SUMMARY"
"""

_DEFAULT_SHELL_OVERRIDDEN_WORKFLOW = """\
name: Inherits a safe shell and then opts back into -e
defaults:
  run:
    shell: bash {0}
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Compare and report
        shell: bash -e {0}
        run: |
          set -uo pipefail
          some-command 2>&1 | tee "$report"
          status=${PIPESTATUS[0]}
          echo "$status" >> "$GITHUB_STEP_SUMMARY"
"""


def _tree(root: Path, files: dict[str, str]) -> Path:
    """Write a throwaway workflows directory and return it."""
    workflows = root / "workflows"
    workflows.mkdir(parents=True, exist_ok=True)
    for name, body in files.items():
        (workflows / name).write_text(body, encoding="utf-8")
    return workflows


def test_the_check_fails_on_a_tree_built_to_violate_it(tmp_path: Path) -> None:
    """The gate is observed failing before it is trusted to pass."""
    workflows = _tree(tmp_path, {"offender.yml": _OFFENDING_WORKFLOW})

    violations = _violations(workflows)

    assert "offender.yml" in violations
    assert violations["offender.yml"] == ["status=${PIPESTATUS[0]}"]


@pytest.mark.parametrize("name", sorted(_GUARDED_WORKFLOWS))
def test_the_check_passes_each_way_of_clearing_errexit(tmp_path: Path, name: str) -> None:
    """Each accepted form is exercised on its own, so a broken one cannot hide."""
    workflows = _tree(tmp_path, {name: _GUARDED_WORKFLOWS[name]})

    assert _violations(workflows) == {}


def test_a_restore_puts_the_guard_back_on_for_the_rest_of_the_block(tmp_path: Path) -> None:
    """``set +e`` is a state, not a latch, and the shipped reporter proves why.

    That block clears errexit for its fetch, restores it, and then runs more
    commands. A guard that stopped looking at the first ``set +e`` would declare
    every later line guarded -- so the next unguarded read added beneath the
    restore would be exactly as invisible as the two this module was written to
    catch, in a file that had already been cleaned up once.
    """
    workflows = _tree(tmp_path, {"restoring.yml": _RESTORING_WORKFLOW})

    violations = _violations(workflows)

    assert violations.get("restoring.yml") == ["second_status=${PIPESTATUS[0]}"], (
        "the read below `set -e` was treated as guarded by the `set +e` above it"
    )


def test_a_conditional_clear_does_not_count_as_clearing(tmp_path: Path) -> None:
    """``set +e`` inside an ``if`` may not have run, and "may not" is enough.

    On the branch that skips it the shell still dies on the pipeline, which is
    the whole defect -- present on one path instead of all of them, and harder
    to see for it.
    """
    workflows = _tree(tmp_path, {"conditional.yml": _CONDITIONALLY_CLEARED_WORKFLOW})

    assert _violations(workflows) == {"conditional.yml": ["status=${PIPESTATUS[0]}"]}


def test_setting_pipefail_alone_is_not_read_as_restoring_errexit(tmp_path: Path) -> None:
    """``set -uo pipefail`` has no ``e`` in it, and both offenders open with that line.

    Reading it as a restore would re-arm the guard immediately after every
    ``set +e``, reporting the correctly guarded workflows and getting the whole
    check switched off.
    """
    workflows = _tree(tmp_path, {"set-plus-e.yml": _GUARDED_WORKFLOWS["set-plus-e.yml"]})

    assert _violations(workflows) == {}


def test_a_step_inheriting_a_defaults_shell_without_e_is_not_flagged(tmp_path: Path) -> None:
    """A workflow-level ``defaults: run: shell:`` is the shell the step really gets.

    Discarding it makes a correct workflow look like GitHub's ``bash -e {0}``,
    and this module's own docstring already promises a ``shell:`` override is an
    accepted way of clearing errexit. Nothing in this repo declares ``defaults:``
    yet, which is the reason to fix the reading now rather than after the first
    false report.
    """
    workflows = _tree(tmp_path, {"defaults.yml": _DEFAULT_SHELL_WORKFLOW})

    assert _violations(workflows) == {}


def test_a_step_shell_overrides_an_inherited_one(tmp_path: Path) -> None:
    """The other half: inheriting a safe default must not excuse opting back in.

    A step that names ``bash -e {0}`` for itself runs under errexit whatever the
    workflow's default was, so its unguarded read is as dead as any other.
    """
    workflows = _tree(tmp_path, {"overridden.yml": _DEFAULT_SHELL_OVERRIDDEN_WORKFLOW})

    assert _violations(workflows) == {"overridden.yml": ["status=${PIPESTATUS[0]}"]}


def test_a_status_read_inside_a_comment_is_not_a_use(tmp_path: Path) -> None:
    """Both real offenders describe `$?` in prose directly above the code.

    A guard that reads comments would fire on the rationale as well as the
    fault, and would keep firing after the fault was fixed.
    """
    workflows = _tree(
        tmp_path,
        {
            "commented.yml": """\
name: Only talks about it
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Compare and report
        run: |
          set -euo pipefail
          # $? is inspected explicitly rather than left to `set -e`.
          some-command
""",
        },
    )

    assert _violations(workflows) == {}
