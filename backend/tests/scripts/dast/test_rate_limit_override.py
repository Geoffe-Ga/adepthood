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
claim: the resolver decides, and the limiter is built from what it decided. The
wiring half runs in a subprocess because the constant is computed at import time
and the limiter is built from it on the next line -- reloading the module
in-process would leave every router holding the old limiter while the module
held a new one.

The wiring is proved by *throttling*, not by reading a constant back. Printing
``rate_limit.DEFAULT_RATE_LIMIT`` proves only that a module-level name holds the
value; it stays green if the very next line builds the limiter from
``FALLBACK_RATE_LIMIT`` instead, which would make this whole override inert
while every test still passed. So the child process stands the limiter up behind
``SlowAPIMiddleware`` exactly as ``main.py`` does, sets a deliberately tiny
override, and asserts that requests past it are actually refused.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from rate_limit import (
    DEFAULT_RATE_LIMIT,
    FALLBACK_RATE_LIMIT,
    RATE_LIMIT_OVERRIDE_ENV_VAR,
    resolve_default_rate_limit,
)

_BACKEND_ROOT = Path(__file__).resolve().parents[3]

# Roomy enough that a bounded fuzz run never meets it, and still a limit: an
# unlimited default would make the DAST instance behave unlike any deployment.
_OVERRIDE = "6000/minute"

_READ_CONSTANT = "import rate_limit; print(rate_limit.DEFAULT_RATE_LIMIT)"

# Small enough that a handful of requests crosses it, so a run can tell an
# enforced limit from a decorative one. The production default (60/minute) is
# not usable for that: no short probe reaches it, which is exactly why reading
# the constant back could never prove the limiter was built from it.
_THROTTLING_OVERRIDE = "2/minute"
_THROTTLING_OVERRIDE_ALLOWANCE = 2
_PROBE_REQUESTS = 4

# Stands the shared limiter up the way ``main.py`` does -- ``app.state.limiter``
# plus ``SlowAPIMiddleware``, which is what applies the *default* limits to a
# route that declares none -- and spends more requests than the override allows.
# A limiter built from anything but the resolved override answers 200 throughout
# and turns the assertion below red.
_ENFORCE_DEFAULT_LIMIT = f"""
from fastapi import FastAPI
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.testclient import TestClient

import rate_limit

app = FastAPI()
app.state.limiter = rate_limit.limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)


@app.get("/probe")
def probe() -> dict[str, bool]:
    return {{"ok": True}}


with TestClient(app) as client:
    statuses = [client.get("/probe").status_code for _ in range({_PROBE_REQUESTS})]
print(",".join(str(status) for status in statuses))
"""

_OK = 200
_TOO_MANY_REQUESTS = 429

_SUBPROCESS_TIMEOUT_SECONDS = 60

# Every variable this application invents for itself carries this prefix, so a
# name collision with an unrelated tool in the same environment is impossible.
_APPLICATION_PREFIX = "ADEPTHOOD_"
_NAMESPACED_VARIABLE = "ADEPTHOOD_DEFAULT_RATE_LIMIT"


def _child_process(payload: str, value: str | None) -> subprocess.CompletedProcess[str]:
    """Run one payload in a fresh interpreter under one environment.

    Args:
        payload: Source for the child to execute.
        value: What to set the override variable to, or ``None`` to unset it.

    Returns:
        The finished child process, with its output captured.
    """
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(_BACKEND_ROOT / "src")
    if value is None:
        environment.pop(RATE_LIMIT_OVERRIDE_ENV_VAR, None)
    else:
        environment[RATE_LIMIT_OVERRIDE_ENV_VAR] = value
    return subprocess.run(
        [sys.executable, "-c", payload],
        check=False,
        capture_output=True,
        text=True,
        cwd=_BACKEND_ROOT,
        env=environment,
        timeout=_SUBPROCESS_TIMEOUT_SECONDS,
    )


def _import_rate_limit_with(value: str | None) -> subprocess.CompletedProcess[str]:
    """Import the module in a fresh interpreter and print the resolved constant.

    Args:
        value: What to set the override variable to, or ``None`` to unset it.

    Returns:
        The finished child process, with its output captured.
    """
    return _child_process(_READ_CONSTANT, value)


def _probe_statuses_with(value: str | None) -> list[int]:
    """Spend several requests against a limiter built under one environment.

    Args:
        value: What to set the override variable to, or ``None`` to unset it.

    Returns:
        One status code per request, in order.
    """
    completed = _child_process(_ENFORCE_DEFAULT_LIMIT, value)
    assert completed.returncode == 0, completed.stderr
    return [int(status) for status in completed.stdout.strip().split(",")]


def test_the_override_variable_is_namespaced_to_this_application() -> None:
    """A generic name is one some other tool in the same environment may own.

    This variable fails closed -- an unparseable value refuses to boot -- and it
    loosens a global limit. A deployment already setting a bare
    ``DEFAULT_RATE_LIMIT`` for something unrelated would silently be read by
    this application, and its operator would have no way to know.
    """
    assert RATE_LIMIT_OVERRIDE_ENV_VAR == _NAMESPACED_VARIABLE
    assert RATE_LIMIT_OVERRIDE_ENV_VAR.startswith(_APPLICATION_PREFIX)


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
    with pytest.raises(ValueError, match=RATE_LIMIT_OVERRIDE_ENV_VAR) as raised:
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


def test_the_environment_reaches_the_module_constant() -> None:
    """A resolver nothing calls is a gate that reports it did something.

    Necessary but not sufficient: this shows the value survives import, and says
    nothing about whether the limiter was built from it. That is the next test.
    """
    completed = _import_rate_limit_with(_OVERRIDE)
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == _OVERRIDE


def test_an_unset_environment_throttles_nobody_over_a_short_probe() -> None:
    """The control: at the production default this probe is nowhere near the cap."""
    assert _probe_statuses_with(None) == [_OK] * _PROBE_REQUESTS


def test_the_configured_limit_is_the_one_the_limiter_actually_enforces() -> None:
    """The assertion the DAST job's env block rests on: it changes behaviour.

    A limiter built from ``FALLBACK_RATE_LIMIT`` rather than from the resolved
    override would leave the job silently capped at 60/minute, answering most of
    a fuzz run with 429 -- not a 5xx, undeclared on every operation, so all three
    enabled checks pass and the gate reports clean having reached no handler.
    Reading the constant back cannot see that; being refused can.
    """
    statuses = _probe_statuses_with(_THROTTLING_OVERRIDE)
    allowed = _THROTTLING_OVERRIDE_ALLOWANCE
    assert statuses[:allowed] == [_OK] * allowed, statuses
    assert set(statuses[allowed:]) == {_TOO_MANY_REQUESTS}, statuses


def test_an_unparseable_environment_value_refuses_to_start() -> None:
    """The refusal has to happen at import, before a request is ever served."""
    completed = _import_rate_limit_with("sixty per minute")
    assert completed.returncode != 0, completed.stdout
    assert RATE_LIMIT_OVERRIDE_ENV_VAR in completed.stderr, completed.stderr
