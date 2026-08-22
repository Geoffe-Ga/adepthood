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

_WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"

# `uses: ./.github/workflows/<file>` -- a call to a reusable workflow in this
# repo. Calls to third-party workflows are out of scope: their permission needs
# are not readable from here.
_LOCAL_CALL = re.compile(r"^\s*uses:\s*\./(\.github/workflows/[\w.-]+)\s*$", re.MULTILINE)

# A top-level block opens at column zero; its entries are indented and its end
# is the next line that is neither indented nor blank.
_TOP_LEVEL_PERMISSIONS = re.compile(r"^permissions:\s*\n((?:[ \t]+.*\n|\n)*)", re.MULTILINE)
_SCOPE = re.compile(r"^\s+([a-z-]+):\s*([a-z-]+)\s*$")

# Ranked weakest to strongest: holding `write` satisfies a callee asking `read`,
# but not the reverse, and `none` satisfies nothing.
_RANK = {"none": 0, "read": 1, "write": 2}


def _permissions(workflow: Path) -> dict[str, str]:
    """The workflow's top-level permission scopes, or ``{}`` if it declares none."""
    match = _TOP_LEVEL_PERMISSIONS.search(workflow.read_text())
    if match is None:
        return {}
    scopes: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        entry = _SCOPE.match(line)
        if entry is not None:
            scopes[entry.group(1)] = entry.group(2)
    return scopes


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
    held = _permissions(caller)
    short = {
        scope: f"callee needs {need}, caller has {held.get(scope, 'nothing')}"
        for scope, need in required.items()
        if _RANK.get(held.get(scope, "none"), 0) < _RANK.get(need, 0)
    }
    assert not short, (
        f"{caller.name} calls {callee.name} but grants less than it asks: {short}. "
        "GitHub rejects this file before creating any job -- the run ends as "
        "startup_failure with no log to read."
    )
