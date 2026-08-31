"""A reusable workflow's caller must hold every permission the callee asks for.

GitHub refuses a workflow file whose called reusable workflow requests a
permission the caller does not have, and it refuses it *before* scheduling
anything: the run ends as ``startup_failure`` with zero jobs and no log. ``gh
run view`` says only "This run likely failed because of a workflow file issue".

That is how twelve ``scan-*`` workflows -- a11y, bugs, complexity, coverage,
dead code, deps, docs, mutation, perf, security, todo, types -- never ran once.
Each called ``_claude-scan.yml``, which needs ``id-token: write`` for the OIDC
exchange, while declaring no ``permissions:`` block of its own and so inheriting
a default token that never carries that scope.

``actionlint`` passes on both files. It is a relationship between two documents,
not a fault in either, so nothing local sees it. This test is what sees it.

Parsed as text rather than with a YAML library, matching
``test_dependabot_ignores.py``: PyYAML is deliberately absent from every
requirements file here, and a guard over CI config should not be the thing that
adds a parser dependency.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tests.workflow_text import jobs

_WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"

# `uses: ./.github/workflows/<file>` -- a call to a reusable workflow in this
# repo. Calls to third-party workflows are out of scope: their permission needs
# are not readable from here.
_LOCAL_CALL = re.compile(r"^\s*uses:\s*\./(\.github/workflows/[\w.-]+)\s*$", re.MULTILINE)

# A top-level block opens at column zero; its entries are indented and its end
# is the next line that is neither indented nor blank.
_TOP_LEVEL_PERMISSIONS = re.compile(r"^permissions:\s*\n((?:[ \t]+.*\n|\n)*)", re.MULTILINE)
# The same block one level in, on a job. Its entries are indented deeper still,
# which is what ends it at the job's next key.
_JOB_PERMISSIONS = re.compile(r"^    permissions:\s*\n((?:[ \t]{5,}.*\n|\n)*)", re.MULTILINE)
# A trailing `# why` is ordinary YAML and this repo writes it constantly, so the
# value must be allowed to end at a comment rather than only at end of line.
# Requiring end of line made this whole guard silently vacuous for any callee
# that annotated its scopes: the block parsed to {} and "grants less than it
# asks" became unreachable, which reads exactly like a passing check.
_SCOPE = re.compile(r"^\s+([a-z-]+):\s*([a-z-]+)\s*(?:#.*)?$")

# Ranked weakest to strongest: holding `write` satisfies a callee asking `read`,
# but not the reverse, and `none` satisfies nothing.
_RANK = {"none": 0, "read": 1, "write": 2}


def _scopes(block: str) -> dict[str, str]:
    """Read `scope: level` pairs out of one already-isolated permissions block."""
    scopes: dict[str, str] = {}
    for line in block.splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        entry = _SCOPE.match(line)
        if entry is not None:
            scopes[entry.group(1)] = entry.group(2)
    return scopes


def _permissions(workflow: Path) -> dict[str, str]:
    """The workflow's top-level permission scopes, or ``{}`` if it declares none."""
    match = _TOP_LEVEL_PERMISSIONS.search(workflow.read_text())
    return {} if match is None else _scopes(match.group(1))


def _jobs(workflow: Path) -> dict[str, str]:
    """Return each job's body, keyed by job id.

    A permissions block only grants anything to the job it sits in, so the file
    has to be split before either half of the relationship is looked for.

    Comments are deliberately left in, unlike every other caller of the shared
    reader: a commented-out scope is not a grant, and a job whose permissions
    block is entirely commented out must read as granting nothing rather than as
    absent.
    """
    return jobs(workflow.read_text())


def _effective_permissions(caller: Path, callee: Path) -> list[dict[str, str]]:
    """What each job that calls ``callee`` actually holds when GitHub evaluates it.

    A job-level block REPLACES the file's rather than adding to it, which is the
    documented way to keep a wide scope off the jobs that have no business with
    it: the contract-drift workflow holds `contents: read` and nothing else, says
    in its own header that it references no secret at all, and reaches the public
    network -- so the reporting job it gained is granted `issues: write` on
    itself, and hoisting that to the file's header to satisfy a check that only
    read column zero would hand issue-write scope to the network-facing job.

    One map per calling job, never a union across jobs: a grant on some OTHER
    job is exactly the thing that does not count.
    """
    call = f"uses: ./.github/workflows/{callee.name}"
    top = _permissions(caller)
    held = [
        _scopes(own.group(1)) if (own := _JOB_PERMISSIONS.search(body)) else top
        for body in _jobs(caller).values()
        if call in body
    ]
    return held or [top]


def _callers() -> list[tuple[Path, Path]]:
    """Every (caller, callee) pair where the callee lives in this repo."""
    repo = _WORKFLOWS.parents[1]
    return [
        (caller, repo / relative)
        for caller in sorted(_WORKFLOWS.glob("*.yml"))
        for relative in _LOCAL_CALL.findall(caller.read_text())
    ]


def test_the_repository_has_reusable_workflow_callers_to_check() -> None:
    """A guard that checks nothing passes for the wrong reason."""
    assert _callers(), "no workflow calls a local reusable workflow; this guard is inert"


@pytest.mark.parametrize(
    ("caller", "callee"),
    _callers(),
    ids=lambda path: path.name if isinstance(path, Path) else str(path),
)
def test_a_caller_holds_every_permission_its_callee_requests(caller: Path, callee: Path) -> None:
    """Otherwise the run is rejected outright and reports no reason anywhere."""
    assert callee.is_file(), f"{caller.name} calls {callee}, which does not exist"
    required = _permissions(callee)
    short = {
        scope: f"callee needs {need}, calling job has {held.get(scope, 'nothing')}"
        for held in _effective_permissions(caller, callee)
        for scope, need in required.items()
        if _RANK.get(held.get(scope, "none"), 0) < _RANK.get(need, 0)
    }
    assert not short, (
        f"{caller.name} calls {callee.name} but grants less than it asks: {short}. "
        "GitHub rejects this file before creating any job -- the run ends as "
        "startup_failure with no log to read."
    )


# --- Job-level grants, which the check above cannot currently see ----------
#
# The parser reads only the block anchored at column zero, so a caller that
# narrows scope on the calling job -- the documented way to do this, and the way
# GitHub actually evaluates a `uses:` job -- is reported as short when it is not.
#
# That false positive has a bad remedy and a good one. The bad one is hoisting
# the missing scope to the top level, which hands it to every job in the file:
# the contract-drift workflow deliberately holds `contents: read` and nothing
# else, states in its own header that it references no secret at all, and reaches
# the public network. Giving that job issue-write scope to quiet a test is a
# larger change than the one being made. The good one is granting the scope on
# the reporting job alone and teaching this guard to look there, which is what
# the two cases below specify.
#
# They drive the check by calling the parametrized case above directly, on
# workflow files written under `tmp_path`. Nothing here reads the real tree: the
# behaviour being pinned is the parser's, and a fixture states the relationship
# in eight lines where a real pair states it in three hundred.

_CALLEE_ASKING_FOR_ISSUES = """\
name: Reusable reporter
on:
  workflow_call:
permissions:
  contents: read
  issues: write
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - run: echo reporting
"""


def _write_pair(tmp_path: Path, caller_body: str) -> tuple[Path, Path]:
    """Write a caller and the callee it invokes, and return both paths."""
    callee = tmp_path / "_report-failure.yml"
    callee.write_text(_CALLEE_ASKING_FOR_ISSUES, encoding="utf-8")
    caller = tmp_path / "caller.yml"
    caller.write_text(caller_body, encoding="utf-8")
    return caller, callee


def test_a_scope_granted_on_the_calling_job_satisfies_the_callee(tmp_path: Path) -> None:
    """GitHub evaluates the calling job's effective permissions, not the file's header.

    A workflow that keeps its top-level grant minimal and widens only the job
    that needs it is doing the right thing, and must not be told it is doing the
    wrong thing.
    """
    caller, callee = _write_pair(
        tmp_path,
        "name: Caller\n"
        "on:\n"
        "  workflow_dispatch:\n"
        "permissions:\n"
        "  contents: read\n"
        "jobs:\n"
        "  report-failure:\n"
        "    if: failure()\n"
        "    permissions:\n"
        "      contents: read\n"
        "      issues: write\n"
        "    uses: ./.github/workflows/_report-failure.yml\n",
    )

    test_a_caller_holds_every_permission_its_callee_requests(caller, callee)


def test_a_scope_granted_nowhere_is_still_a_shortfall(tmp_path: Path) -> None:
    """The original defect must survive the fix: unheld scope still fails startup.

    Without this, the cheapest way to make the case above pass -- stop checking
    -- would look like a fix.
    """
    caller, callee = _write_pair(
        tmp_path,
        "name: Caller\n"
        "on:\n"
        "  workflow_dispatch:\n"
        "permissions:\n"
        "  contents: read\n"
        "jobs:\n"
        "  report-failure:\n"
        "    if: failure()\n"
        "    permissions:\n"
        "      contents: read\n"
        "    uses: ./.github/workflows/_report-failure.yml\n",
    )

    with pytest.raises(AssertionError):
        test_a_caller_holds_every_permission_its_callee_requests(caller, callee)


def test_a_job_level_grant_does_not_leak_to_a_job_that_did_not_ask(tmp_path: Path) -> None:
    """Scope narrowed onto one job is the point; reading it as file-wide throws that away.

    Here the network-facing job holds the wide grant and the calling job holds
    nothing, which is the arrangement the contract-drift workflow must never
    drift into. A parser that unioned every job's block would call this covered.
    """
    caller, callee = _write_pair(
        tmp_path,
        "name: Caller\n"
        "on:\n"
        "  workflow_dispatch:\n"
        "permissions:\n"
        "  contents: read\n"
        "jobs:\n"
        "  fetch-from-the-public-internet:\n"
        "    permissions:\n"
        "      contents: read\n"
        "      issues: write\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        "      - run: curl https://example.invalid/contract.json\n"
        "  report-failure:\n"
        "    if: failure()\n"
        "    uses: ./.github/workflows/_report-failure.yml\n",
    )

    with pytest.raises(AssertionError):
        test_a_caller_holds_every_permission_its_callee_requests(caller, callee)


def test_an_annotated_scope_is_still_read(tmp_path: Path) -> None:
    """A block whose lines carry `# why` must parse, or this whole guard goes quiet.

    Found by perturbation: reverting the job-level lookup should have failed the
    real callers and did not, because the shared reporter annotates each of its
    scopes with the reason it needs it. The block parsed to an empty map, every
    requirement was vacuously satisfied, and the check reported success while
    reading nothing at all.
    """
    annotated = tmp_path / "annotated.yml"
    annotated.write_text(
        "permissions:\n"
        "  contents: read   # checkout\n"
        "  issues: write    # open or comment on the tracking issue\n"
        "  actions: read    # read the failing run's log\n"
        "jobs:\n  work:\n    runs-on: ubuntu-latest\n"
    )

    assert _permissions(annotated) == {
        "contents": "read",
        "issues": "write",
        "actions": "read",
    }


def test_the_real_shared_reporter_declares_scopes_this_parser_can_see() -> None:
    """The guard is only worth anything if it reads the callee every caller now uses."""
    reporter = _WORKFLOWS / "_report-failure.yml"

    assert _permissions(reporter), (
        f"{reporter.name} declares no readable top-level permissions, so every "
        "caller of it passes this check without being checked"
    )
