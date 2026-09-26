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
import re
from pathlib import Path

from limits import parse

import rate_limit
from middleware import rate_limit as rate_limit_middleware

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEPLOYMENT_GUIDE = _REPO_ROOT / "DEPLOYMENT.md"

_WORKER_VARIABLE = "WEB_CONCURRENCY"
_PER_WORKER_MULTIPLICATION = "`WEB_CONCURRENCY` x"

# A rate written beside the word "ceiling", on either side, without crossing a
# sentence end or a table cell. Case-insensitive, so ``CLIENT_CEILING_LIMIT``
# counts as naming it.
_RATE = r"(\d[\d,]*/minute)"
_CEILING_RATE_AFTER = re.compile(r"ceiling[^.|]*?" + _RATE, re.IGNORECASE)
_CEILING_RATE_BEFORE = re.compile(_RATE + r"\s+ceiling", re.IGNORECASE)

# How many times each document states the ceiling's value, so the guard below
# cannot pass vacuously by finding none: twice in the quick-reference
# TRUSTED_PROXY_CIDRS row, once in the variable reference, once in the 429
# troubleshooting row, and once in the module's closed residual.
_GUIDE_CEILING_MENTIONS = 4
_MODULE_CEILING_MENTIONS = 1


def _ceiling_rates(text: str) -> list[str]:
    """Return every rate a document states for the per-client ceiling."""
    flat = " ".join(text.split())
    return _CEILING_RATE_AFTER.findall(flat) + _CEILING_RATE_BEFORE.findall(flat)


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

    assert f"site-wide {rate_limit.CLIENT_CEILING_LIMIT}" in guide


def test_every_stated_ceiling_value_is_the_shipped_constant() -> None:
    """The docs write the ceiling out by hand, so each copy is held to the constant.

    Retuning ``CLIENT_CEILING_LIMIT`` is meant to be a one-constant change; a
    guide that kept the old number would tell an operator chasing 429s the
    wrong budget.
    """
    shipped = parse(rate_limit.CLIENT_CEILING_LIMIT)
    guide_rates = _ceiling_rates(_DEPLOYMENT_GUIDE.read_text(encoding="utf-8"))
    module_rates = _ceiling_rates(_middleware_docstring())

    assert len(guide_rates) == _GUIDE_CEILING_MENTIONS
    assert len(module_rates) == _MODULE_CEILING_MENTIONS
    for stated in guide_rates + module_rates:
        assert parse(stated.replace(",", "")) == shipped, stated


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
