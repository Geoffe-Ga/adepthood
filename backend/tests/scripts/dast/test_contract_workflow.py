"""Tripwires for the contract-fuzz job's CI wiring and its exclusion list.

The failure mode of a DAST job is not a red build -- it is a green one that
fuzzed nothing. Four ways that happens, each with a guard below: the job is
disarmed (``continue-on-error``, ``|| true``, a swallowed exit code), it reads a
checked-in ``openapi.json`` instead of the live document so the spec can drift
away from the app, its exclusion list quietly grows until nothing is left to
test, or an exclusion goes stale and excuses an operation that no longer exists
while the one it was written for is silently fuzzed again.

The exclusion assertions are the load-bearing ones. Every excluded name is
matched against the operations the *real* application publishes, so a renamed
route turns this red instead of leaving a dead line in a YAML file, and every
exclusion must carry its own reason comment so "we excluded it" can never be the
whole justification.

The workflow is parsed as plain text rather than with PyYAML on purpose. PyYAML
is absent from ``requirements.txt``, ``requirements-lock.txt`` and
``requirements-dev.txt``, so ``import yaml`` would turn this guard into a
collection error on the ``backend-compat`` job instead of a passing check.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from main import app

_REPO_ROOT = Path(__file__).resolve().parents[4]
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "dast-contract.yml"
_REQUIREMENTS = _REPO_ROOT / "backend" / "requirements-dast.txt"

_HTTP_METHODS = ("get", "put", "post", "delete", "patch")

# Text that would leave the job structurally present but toothless: a red run
# reported as success, a shell that swallows the exit code, a schema read from
# disk instead of the running instance, or a filter that excuses everything.
_DISARMING_FRAGMENTS = (
    "continue-on-error",
    "if: false",
    "if: ${{ false }}",
    "set +e",
    "|| true",
    "|| exit 0",
    "--exclude-path-regex '.*'",
)

# The checks the job must run. ``status_code_conformance`` is deliberately not
# here; see the workflow's own comment and the follow-up issue it names.
_REQUIRED_CHECKS = (
    "not_a_server_error",
    "content_type_conformance",
    "response_schema_conformance",
)

# Without this one the fuzzer deletes its own identity partway through and every
# later request is unauthenticated, which no enabled check would fail.
_MANDATORY_EXCLUSION = "DELETE /users/me"

_ARTIFACT_NAME = "dast-contract-report"

_USES = re.compile(r"^\s*(?:- )?uses:\s*(?P<action>\S+)\s*(?P<comment>#.*)?$", re.MULTILINE)
_SHA_PINNED = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")
_EXCLUDED_BLOCK = re.compile(
    r"^\s*EXCLUDED=\(\s*$(?P<body>.*?)^\s*\)\s*$", re.MULTILINE | re.DOTALL
)
_EXCLUSION_LINE = re.compile(r"^\s*'(?P<label>[^']+)'\s*#\s*(?P<reason>\S.*?)\s*$")
_EXACT_PIN = re.compile(r"^[A-Za-z0-9._-]+==[^\s;#]+$")


@pytest.fixture(scope="module")
def workflow() -> str:
    """Return the contract-fuzz workflow as text."""
    assert _WORKFLOW.is_file(), f"{_WORKFLOW} does not exist"
    return _WORKFLOW.read_text(encoding="utf-8")


def without_comment_lines(workflow_text: str) -> str:
    """Return the workflow with whole-line comments removed.

    The header explains at length why this job runs on ``pull_request`` and
    never ``pull_request_target``; a substring search over the raw file would
    read that explanation as the very thing it forbids.

    Args:
        workflow_text: The workflow file's contents.

    Returns:
        The same text with every comment-only line dropped.
    """
    return "\n".join(
        line for line in workflow_text.splitlines() if not line.strip().startswith("#")
    )


def live_operation_labels() -> set[str]:
    """Return every operation the real application publishes, as ``METHOD /path``.

    Read from the application's own generated document rather than the checked-in
    export, so an exclusion cannot be validated against a stale copy of the API.
    """
    document = app.openapi()
    return {
        f"{method.upper()} {path}"
        for path, operations in document["paths"].items()
        for method in operations
        if method in _HTTP_METHODS
    }


def excluded_operations(workflow_text: str) -> dict[str, str]:
    """Return the job's exclusion list, mapping each operation name to its reason.

    Args:
        workflow_text: The workflow file's contents.

    Returns:
        One entry per line of the shell array the job builds its
        ``--exclude-name`` arguments from.
    """
    block = _EXCLUDED_BLOCK.search(workflow_text)
    assert block is not None, "the workflow declares no EXCLUDED=( ... ) array"
    entries: dict[str, str] = {}
    for line in block.group("body").splitlines():
        if not line.strip():
            continue
        match = _EXCLUSION_LINE.match(line)
        assert match is not None, f"exclusion carries no reason comment: {line!r}"
        entries[match.group("label")] = match.group("reason")
    return entries


def test_the_job_runs_on_pull_request_and_never_on_pull_request_target(workflow: str) -> None:
    """A job that runs the head of a branch must not hold write-scoped credentials."""
    assert "pull_request_target" not in without_comment_lines(workflow)
    assert re.search(r"^  pull_request:$", workflow, re.MULTILINE), workflow
    assert re.search(r"^  push:$", workflow, re.MULTILINE), workflow
    # Once under ``push:`` and once under ``pull_request:``.
    assert workflow.count('- "backend/**"') >= 2


def test_every_action_is_sha_pinned(workflow: str) -> None:
    """A floating tag is a supply-chain hole in a job that holds a database."""
    actions = _USES.findall(workflow)
    assert actions, "the workflow uses no actions at all"
    for action, comment in actions:
        assert _SHA_PINNED.match(action), f"{action} is not pinned to a 40-character SHA"
        assert comment, f"{action} carries no version comment"


def test_the_job_stands_up_its_own_instance_against_postgres(workflow: str) -> None:
    """Dialect-specific behaviour is the gap this job exists to close."""
    assert "postgres:16" in workflow
    # Started the way the Dockerfile does -- module ``main`` with PYTHONPATH=src.
    assert "PYTHONPATH=src python -m uvicorn main:app" in workflow
    assert "src.main:app" not in workflow
    # ``/health/ready``, not ``/health``: the startup seeder must finish first.
    assert "/health/ready" in workflow


def test_the_fuzzer_reads_the_live_document_not_a_checked_in_copy(workflow: str) -> None:
    """A checked-in spec can drift away from the app; a live one cannot."""
    assert "schemathesis run" in workflow
    assert '"$BASE_URL/openapi.json"' in workflow
    assert "backend/openapi.json" not in workflow


def test_the_enabled_checks_are_named_explicitly(workflow: str) -> None:
    """``--checks all`` would silently change meaning with every upgrade."""
    assert "--checks" in workflow
    for check in _REQUIRED_CHECKS:
        assert check in workflow, f"{check} is not enabled"


def test_the_run_is_bounded_and_reproducible(workflow: str) -> None:
    """A gate that cannot be replayed cannot be trusted to have failed honestly."""
    assert "--seed" in workflow
    assert "--max-examples" in workflow
    assert re.search(r"^\s*timeout-minutes: \d+$", workflow, re.MULTILINE), workflow


def test_the_job_cannot_be_disarmed(workflow: str) -> None:
    """Each fragment below turns a failing run into a passing one."""
    for fragment in _DISARMING_FRAGMENTS:
        assert fragment not in workflow, f"{fragment!r} would disarm the gate"


def test_the_report_is_uploaded_even_when_the_run_fails(workflow: str) -> None:
    """The artifact is the only way to read a failure that happened on a runner."""
    assert f"name: {_ARTIFACT_NAME}" in workflow
    assert "if: always()" in workflow


def test_the_instance_is_started_with_the_dast_rate_limit_override(workflow: str) -> None:
    """Without it the global 60/minute limit answers most of the run with 429."""
    assert "DEFAULT_RATE_LIMIT:" in workflow


def test_the_job_installs_the_pinned_dast_tooling(workflow: str) -> None:
    """Schemathesis is pinned in a file of its own; see that file's own header."""
    assert "backend/requirements-dast.txt" in workflow


def test_every_exclusion_names_a_live_operation(workflow: str) -> None:
    """A stale exclusion excuses nothing and hides that its route is being fuzzed."""
    live = live_operation_labels()
    excluded = excluded_operations(workflow)
    assert excluded, "the workflow excludes nothing at all"
    unknown = sorted(set(excluded) - live)
    assert not unknown, f"these exclusions match no live operation: {unknown}"


def test_the_identity_destroying_operation_is_excluded(workflow: str) -> None:
    """Losing the fuzzing identity mid-run turns every later request vacuous."""
    assert _MANDATORY_EXCLUSION in excluded_operations(workflow)


def test_the_exclusion_list_stays_a_minority_of_the_api(workflow: str) -> None:
    """An exclusion list that grows without limit is a blanket skip in slow motion."""
    live = live_operation_labels()
    excluded = excluded_operations(workflow)
    assert len(excluded) * 2 < len(live), (
        f"{len(excluded)} of {len(live)} operations are excluded; that is not a fuzz run"
    )


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
