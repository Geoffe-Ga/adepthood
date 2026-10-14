"""Removing any one privacy guard fails the suite of the claim it backs (#3163, B15).

The claim suites (#3159-#3162) assert forbidden effects. That proves the
product is clean today; it does not prove the suites would notice a guard
being deleted tomorrow. Each row of
:data:`~tests.support.privacy_guards.PRIVACY_GUARDS` names one guard,
a permissive no-op for it, and the claims it backs. For every (guard, claim)
pair this test:

1. reads the claim's node ids from the shipped manifest
   (``privacy/claim_coverage.json``) -- never a list kept here;
2. runs them in a **subprocess** with the guard replaced
   (:mod:`tests.support.privacy_guard_mutation`, loaded with ``-p`` and enabled
   only by its environment variable), stopping at the first failure, and
   asserts the run *failed* -- exit code 1, at least one failing node id, and a
   receipt naming the guard that was actually replaced;
3. reruns exactly the node ids that failed with nothing replaced, and asserts
   they *pass*: the positive control that the failure was the mutation's, not
   a suite that is red anyway.

**Which tests a row runs.** The claim's node ids outside ``tests/integration``
and outside this file. The first need a live Postgres and run in the
integration lane (this subprocess inherits no ``TEST_POSTGRES_URL``, so they
would only add skips); the second are these rows, which the manifest cites as
evidence and which must never rerun themselves.

**Lane.** This file runs in every whole-suite run -- ``check-all.sh``, the
pre-push hook and backend CI -- and in no targeted TDD run unless it is named.
Each row costs two subprocess runs. The mutated one runs the claim's tests
newest citation first and stops at the first failure (``-x``); the control
reruns only what failed.
"""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import pytest

from privacy.claim_coverage import load_manifest
from tests.support.privacy_guard_mutation import MUTATION_ENV, PLUGIN, RECEIPT_ENV
from tests.support.privacy_guards import (
    PRIVACY_GUARDS,
    GuardMutation,
    guard_function,
    unfit_reasons,
)

BACKEND: Final = Path(__file__).resolve().parents[2]
SRC: Final = BACKEND / "src"
_REPO_PREFIX: Final = "backend/"
_POSTGRES_LANE: Final = "tests/integration/"
#: The manifest cites this file's rows as evidence too; a row never reruns itself.
_THIS_FILE: Final = "tests/security/test_privacy_guard_mutations.py::"

#: Generous: the slowest claim suite takes a few minutes on a loaded runner.
_RUN_TIMEOUT_SECONDS: Final = 900

#: Environment a nested pytest must not inherit: xdist worker identity, the
#: parent's coverage plumbing and addopts, and the Postgres lane switches.
_STRIPPED_ENV_PREFIXES: Final = ("PYTEST_", "COV_CORE_", "PRIVACY_GUARD_MUTATION")
_STRIPPED_ENV: Final = frozenset({"TEST_POSTGRES_URL", "INTEGRATION_LANE_REQUIRE_POSTGRES"})

_OUTPUT_TAIL_CHARS: Final = 4000

#: The two modules that together can rewrite a guard.
_MUTATION_MODULES: Final = frozenset({"privacy_guard_mutation", "privacy_guards"})

_MANIFEST: Final = {row.claim: row for row in load_manifest()}

ROWS: Final = [(guard, claim) for guard in PRIVACY_GUARDS for claim in guard.claims]


def _row_id(row: tuple[GuardMutation, str]) -> str:
    guard, claim = row
    return f"{guard.name}-{claim}"


def sqlite_lane_tests(claim: str) -> list[str]:
    """The claim's manifest node ids this lane can run, relative to ``backend/``."""
    node_ids = [test.removeprefix(_REPO_PREFIX) for test in _MANIFEST[claim].tests]
    return [
        node_id
        for node_id in node_ids
        if not node_id.startswith(_POSTGRES_LANE) and not node_id.startswith(_THIS_FILE)
    ]


@dataclass(frozen=True, slots=True)
class SuiteRun:
    """What one nested pytest run did."""

    exit_code: int
    guard: str | None
    failed: tuple[str, ...]
    output: str


def _child_env(guard: str | None, receipt: Path) -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in _STRIPPED_ENV and not key.startswith(_STRIPPED_ENV_PREFIXES)
    }
    env[RECEIPT_ENV] = str(receipt)
    if guard is not None:
        env[MUTATION_ENV] = guard
    return env


def _run_in_backend(argv: Sequence[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """Run ``argv`` (starting with this interpreter) from ``backend/``, never raising on exit."""
    return subprocess.run(
        list(argv),
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=_RUN_TIMEOUT_SECONDS,
        check=False,
    )


def run_claim_suite(
    node_ids: list[str], receipt: Path, *, guard: str | None, stop_at_first: bool
) -> SuiteRun:
    """Run ``node_ids`` in a fresh interpreter, with ``guard`` replaced if named."""
    argv = [sys.executable, "-m", "pytest", "-p", PLUGIN, "-p", "no:cacheprovider", "-q"]
    if stop_at_first:
        argv.append("-x")
    completed = _run_in_backend([*argv, *node_ids], _child_env(guard, receipt))
    document = json.loads(receipt.read_text(encoding="utf-8")) if receipt.exists() else {}
    return SuiteRun(
        exit_code=completed.returncode,
        guard=document.get("guard"),
        failed=tuple(document.get("failed", ())),
        output=(completed.stdout + completed.stderr)[-_OUTPUT_TAIL_CHARS:],
    )


@pytest.mark.parametrize(("guard", "claim"), ROWS, ids=[_row_id(row) for row in ROWS])
def test_removing_a_guard_fails_its_claim_suite(
    guard: GuardMutation, claim: str, tmp_path: Path
) -> None:
    # Newest citations first: they are the most targeted, and with ``-x`` the
    # order changes only how soon the run stops, never whether it fails.
    node_ids = sqlite_lane_tests(claim)[::-1]

    mutated = run_claim_suite(
        node_ids, tmp_path / "mutated.json", guard=guard.name, stop_at_first=True
    )

    assert mutated.guard == guard.name, mutated.output
    assert mutated.exit_code == pytest.ExitCode.TESTS_FAILED, (
        f"{claim}'s suite did not notice {guard.module}.{guard.attribute} being replaced "
        f"by a permissive no-op (exit {mutated.exit_code}):\n{mutated.output}"
    )
    assert mutated.failed, mutated.output

    control = run_claim_suite(
        list(mutated.failed), tmp_path / "control.json", guard=None, stop_at_first=False
    )

    assert control.guard is None
    assert control.exit_code == pytest.ExitCode.OK, (
        f"the tests that failed under {guard.name} fail without it too:\n{control.output}"
    )
    assert not control.failed


#: The guards #3163 names. A row may be added; none of these may be dropped.
_REQUIRED_GUARDS: Final = frozenset(
    {
        ("domain.privacy_tier", "admits_egress"),
        ("services.reflection_boundary", "app_provider_llm"),
        ("services.reflection_boundary", "require_app_provider_llm"),
        ("services.account_egress_barrier", "hold_account"),
        ("services.account_egress_barrier", "ensure_account_live"),
        ("telemetry_safety", "exception_reason"),
        ("sentry", "scrub_event"),
        ("services.restore_suppression", "_reapply_account"),
        ("services.restore_suppression", "_reapply_entry"),
        ("services.creek_vault_withdraw", "_withdrawal_is_confirmed"),
    }
)


def test_every_named_guard_has_a_mutation_row() -> None:
    rows = {(guard.module, guard.attribute) for guard in PRIVACY_GUARDS}

    assert sorted(_REQUIRED_GUARDS - rows) == []


@pytest.mark.parametrize("guard", PRIVACY_GUARDS, ids=lambda guard: guard.name)
def test_every_replacement_fits_its_guard(guard: GuardMutation) -> None:
    """Same parameters, same sync/async kind, and every global it reads exists there.

    A replacement that misses any of these would fail its suite with a
    ``TypeError`` or ``NameError`` -- a red run that proves nothing about the guard.
    """
    assert unfit_reasons(guard, guard_function(guard)) == []


@pytest.mark.parametrize("guard", PRIVACY_GUARDS, ids=lambda guard: guard.name)
def test_every_row_has_a_runnable_claim_suite(guard: GuardMutation) -> None:
    for claim in guard.claims:
        assert sqlite_lane_tests(claim), f"{claim} cites no test this lane can run"


def _imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None and node.level == 0:
            found.add(node.module)
    return found


def _reaches_tests(module: str) -> bool:
    return module == "tests" or module.startswith("tests.")


def test_the_mutation_plugin_is_unreachable_from_src() -> None:
    """No module under ``backend/src`` imports the plugin, its table, or anything in ``tests``."""
    offenders = sorted(
        f"{path.relative_to(BACKEND)} imports {module}"
        for path in SRC.rglob("*.py")
        for module in _imported_modules(path)
        if _reaches_tests(module) or module.rpartition(".")[2] in _MUTATION_MODULES
    )

    assert offenders == []


def test_the_unreachability_scan_sees_a_planted_import(tmp_path: Path) -> None:
    """Negative control: the scan above would see an import of the plugin."""
    planted = tmp_path / "planted.py"
    planted.write_text(f"from {PLUGIN} import PRIVACY_GUARDS\n", encoding="utf-8")

    assert any(_reaches_tests(module) for module in _imported_modules(planted))
