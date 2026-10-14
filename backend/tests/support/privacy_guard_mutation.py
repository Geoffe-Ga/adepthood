"""A pytest plugin that replaces one privacy guard with a permissive no-op, for one run (#3163).

A guard that no test notices is unprotected. This plugin is how
``tests/security/test_privacy_guard_mutations.py`` proves each guard is noticed:
it runs a claim's suite in a **subprocess** with ``-p`` naming this module and
:data:`MUTATION_ENV` naming one row of
:data:`tests.support.privacy_guards.PRIVACY_GUARDS`, and expects the run to fail.

**Why it cannot reach production.** It lives under ``backend/tests/`` and does
nothing unless pytest loads it with ``-p`` *and* :data:`MUTATION_ENV` is set.
``backend/src`` never imports it; the meta-test asserts that by parsing every
module there. It imports nothing from ``backend/src`` itself: ``-p`` loads it
before ``conftest.py`` has set the environment the app reads, so the guard
table (which does import the app's modules) is imported only at session start.

**What the run reports.** With :data:`RECEIPT_ENV` naming a path, the session
writes a JSON receipt there: the guard that was replaced (``null`` for an
unmutated run) and the node ids that failed. The meta-test reads the receipt
rather than pytest's output, and reruns exactly the failing node ids unmutated
as the positive control.
"""

from __future__ import annotations

import importlib
import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Final

import pytest

#: Names the guard this run replaces. Unset: the plugin is inert.
MUTATION_ENV: Final = "PRIVACY_GUARD_MUTATION"

#: Where the run writes its receipt. Unset: no receipt.
RECEIPT_ENV: Final = "PRIVACY_GUARD_MUTATION_RECEIPT"

#: The ``-p`` spelling that loads this plugin.
PLUGIN: Final = "tests.support.privacy_guard_mutation"

#: The guard table, imported only once the session's conftests have run.
GUARD_TABLE: Final = "tests.support.privacy_guards"

#: What this session did: the guard it replaced, if any, and every failed node id.
_APPLIED: Final[list[str]] = []
_FAILED: Final[list[str]] = []


def pytest_sessionstart(session: pytest.Session) -> None:
    """Apply the named mutation once every ``conftest.py`` has set the app's environment."""
    del session
    name = os.environ.get(MUTATION_ENV, "").strip()
    if not name:
        return
    apply_named_mutation: Callable[[str], None] = importlib.import_module(
        GUARD_TABLE
    ).apply_named_mutation
    apply_named_mutation(name)
    _APPLIED.append(name)


def pytest_runtest_logreport(report: pytest.TestReport) -> None:
    """Record every node id that failed, in any phase."""
    if report.failed and report.nodeid not in _FAILED:
        _FAILED.append(report.nodeid)


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """Write the receipt the meta-test reads."""
    del session, exitstatus
    path = os.environ.get(RECEIPT_ENV, "").strip()
    if path:
        document = {"guard": _APPLIED[0] if _APPLIED else None, "failed": _FAILED}
        Path(path).write_text(json.dumps(document), encoding="utf-8")
