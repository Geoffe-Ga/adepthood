"""The DAST-only override of the application's global default rate limit.

The contract-fuzz job sends thousands of requests from one loopback address. The
authorization matrix solves that by varying ``X-Forwarded-For`` per request, but
the Schemathesis CLI sends one fixed header set for a whole run, so the fuzzer
would spend its budget collecting 429s -- responses that violate none of the
enabled checks and would let a run that exercised nothing report a clean gate.
The override exists for that one job, which is why the resolver below refuses an
unparseable value outright: a limiter that silently fell back to *no* limit
because somebody fat-fingered a deployment variable is the failure this must not
have.

Both halves are here rather than split across two modules because they are one
claim: the resolver decides, and the module constant is wired to it. The wiring
half runs in a subprocess because the constant is computed at import time and
the limiter is built from it on the next line -- reloading the module in-process
would leave every router holding the old limiter while the module held a new one.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from rate_limit import (
    DEFAULT_RATE_LIMIT,
    DEFAULT_RATE_LIMIT_ENV_VAR,
    FALLBACK_RATE_LIMIT,
    resolve_default_rate_limit,
)

_BACKEND_ROOT = Path(__file__).resolve().parents[3]

# Roomy enough that a bounded fuzz run never meets it, and still a limit: an
# unlimited default would make the DAST instance behave unlike any deployment.
_OVERRIDE = "6000/minute"

_READ_CONSTANT = "import rate_limit; print(rate_limit.DEFAULT_RATE_LIMIT)"

_SUBPROCESS_TIMEOUT_SECONDS = 60


def _import_rate_limit_with(value: str | None) -> subprocess.CompletedProcess[str]:
    """Import the module in a fresh interpreter under one environment.

    Args:
        value: What to set the override variable to, or ``None`` to unset it.

    Returns:
        The finished child process, with its output captured.
    """
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(_BACKEND_ROOT / "src")
    if value is None:
        environment.pop(DEFAULT_RATE_LIMIT_ENV_VAR, None)
    else:
        environment[DEFAULT_RATE_LIMIT_ENV_VAR] = value
    return subprocess.run(
        [sys.executable, "-c", _READ_CONSTANT],
        check=False,
        capture_output=True,
        text=True,
        cwd=_BACKEND_ROOT,
        env=environment,
        timeout=_SUBPROCESS_TIMEOUT_SECONDS,
    )


def test_the_default_is_unchanged_when_the_environment_is_silent() -> None:
    """Nothing about production moves because this override exists."""
    assert resolve_default_rate_limit(None) == FALLBACK_RATE_LIMIT
    assert FALLBACK_RATE_LIMIT == "60/minute"


@pytest.mark.parametrize("blank", ["", "   "])
def test_a_blank_value_is_treated_as_unset(blank: str) -> None:
    """An empty variable is how a shell passes "I did not set this"."""
    assert resolve_default_rate_limit(blank) == FALLBACK_RATE_LIMIT


def test_a_configured_limit_replaces_the_default() -> None:
    """The whole point: the DAST instance runs with a budget a fuzzer can spend."""
    assert resolve_default_rate_limit(_OVERRIDE) == _OVERRIDE


def test_an_unparseable_limit_is_refused_rather_than_ignored() -> None:
    """Fail closed. Falling back would hand a typo an unlimited endpoint.

    The message has to name the variable, because the only person who will ever
    read it is looking at a container that refused to boot.
    """
    with pytest.raises(ValueError, match=DEFAULT_RATE_LIMIT_ENV_VAR) as raised:
        resolve_default_rate_limit("sixty per minute")
    assert "sixty per minute" in str(raised.value)


def test_the_module_constant_is_the_documented_default_in_this_process() -> None:
    """The test suite itself must be running against the production default."""
    assert DEFAULT_RATE_LIMIT == FALLBACK_RATE_LIMIT


def test_an_unset_environment_leaves_the_imported_constant_at_the_default() -> None:
    """The control for the wiring test below."""
    completed = _import_rate_limit_with(None)
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == FALLBACK_RATE_LIMIT


def test_the_environment_reaches_the_constant_the_limiter_is_built_from() -> None:
    """A resolver nothing calls is a gate that reports it did something.

    This is the only assertion that proves the DAST job's env block actually
    changes the running application rather than merely setting a variable.
    """
    completed = _import_rate_limit_with(_OVERRIDE)
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == _OVERRIDE


def test_an_unparseable_environment_value_refuses_to_start() -> None:
    """The refusal has to happen at import, before a request is ever served."""
    completed = _import_rate_limit_with("sixty per minute")
    assert completed.returncode != 0, completed.stdout
    assert DEFAULT_RATE_LIMIT_ENV_VAR in completed.stderr, completed.stderr
