"""Drift guards on what the rate-limit docs admit about their own reach (#2913).

Every limit in this application lives in one worker process's memory. That is
not a defect this change could fix -- it needs a shared store the deployment
does not have -- but it is one an operator has to be told, because a guide that
says "60/minute" on a deployment running two workers is off by a factor of two
in the direction that matters. So the statement is pinned, in the operator guide
and in the module that owns the floor, along with the rule any future shared
store has to follow, and the two claims #2913 made stale are pinned gone.
"""

from __future__ import annotations

import inspect
from pathlib import Path

import rate_limit
from middleware import rate_limit as rate_limit_middleware

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEPLOYMENT_GUIDE = _REPO_ROOT / "DEPLOYMENT.md"

_WORKER_VARIABLE = "WEB_CONCURRENCY"
_PER_WORKER_MULTIPLICATION = "`WEB_CONCURRENCY` x"


def _middleware_docstring() -> str:
    """Return the floor module's docstring with its line wrapping flattened."""
    doc = rate_limit_middleware.__doc__
    assert doc is not None
    return " ".join(doc.split())


def test_the_operator_guide_states_the_per_worker_multiplication() -> None:
    """``DEPLOYMENT.md`` says each limit is multiplied by the worker count."""
    guide = _DEPLOYMENT_GUIDE.read_text(encoding="utf-8")

    assert _PER_WORKER_MULTIPLICATION in guide


def test_the_operator_guide_warns_the_ceiling_goes_site_wide_without_trusted_proxies() -> None:
    """Unset ``TRUSTED_PROXY_CIDRS`` collapses every client onto one ceiling."""
    guide = _DEPLOYMENT_GUIDE.read_text(encoding="utf-8")

    assert "site-wide 600/minute" in guide


def test_the_floor_module_states_the_per_worker_budget_and_the_fail_open_rule() -> None:
    """The residual names the multiplication, and forbids a fail-open shared store."""
    doc = _middleware_docstring()

    assert _WORKER_VARIABLE in doc
    assert "x each limit" in doc
    assert "never fail open" in doc


def test_the_stale_residual_and_path_count_are_gone() -> None:
    """The enumeration residual is recorded closed, and the mounted-path count is current."""
    doc = _middleware_docstring()

    assert "draw no 429" not in doc
    assert "Closed by #2913" in doc
    assert "118 distinct paths" not in inspect.getsource(rate_limit)
