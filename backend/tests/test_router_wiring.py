"""Static guard: every router module is actually mounted on the app.

A router module can be written, tested in isolation, and shipped without ever
being passed to ``app.include_router`` -- its endpoints then answer 404 in
production while its own unit tests stay green.  This guard derives both sides
mechanically: the expected set from ``pkgutil.iter_modules`` over the
``routers`` package, and the mounted set by walking the app's live route tree.
Neither side is hand-written, so deleting an ``include_router`` call turns this
red.

The tree walk follows two shapes on purpose.  Older FastAPI flattened included
routers into ``app.routes`` as ``APIRoute`` objects; 0.141 includes them lazily,
so ``app.routes`` holds wrapper objects that keep the source router under
``original_router``.  Reading that attribute with ``getattr`` rather than
importing the private wrapper class keeps the guard working across an upgrade in
either direction.
"""

from __future__ import annotations

import importlib
import pkgutil
from typing import TYPE_CHECKING

from fastapi import APIRouter

import routers
from main import app

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence
    from types import ModuleType

    from starlette.routing import BaseRoute

# Justifications are DATA, not comments: an inert ``# because ...`` next to an
# entry cannot fail anything, so the excuse is a required non-empty string that
# the self-lint test below asserts on.  Entries are also checked for staleness,
# which makes this allowlist a ratchet that can only shrink.
ROUTER_ALLOWLIST: dict[str, str] = {}

MIN_JUSTIFICATION_LENGTH = 20


def _child_routes(route: object) -> list[object]:
    """Return the nested routes of ``route`` across both FastAPI shapes."""
    original = getattr(route, "original_router", None)
    nested: list[object] = list(getattr(original, "routes", None) or [])
    nested.extend(getattr(route, "routes", None) or [])
    return nested


def _walk_routes(
    routes: Iterable[object],
    visited: set[int],
    endpoints: set[object],
) -> None:
    """Collect every endpoint callable reachable from ``routes``."""
    for route in routes:
        if id(route) in visited:
            continue
        visited.add(id(route))
        endpoint = getattr(route, "endpoint", None)
        if endpoint is not None:
            endpoints.add(endpoint)
        _walk_routes(_child_routes(route), visited, endpoints)


def _mounted_endpoints() -> set[object]:
    """Return the endpoint callables the running app serves."""
    endpoints: set[object] = set()
    _walk_routes(app.routes, set(), endpoints)
    return endpoints


def _router_module_names() -> list[str]:
    """List the router modules on disk (``__init__`` is excluded by pkgutil)."""
    return sorted(info.name for info in pkgutil.iter_modules(routers.__path__))


def _module_routers(module: ModuleType) -> list[APIRouter]:
    """Return the module-level ``APIRouter`` values a router module exports."""
    return [value for value in vars(module).values() if isinstance(value, APIRouter)]


def _declared_routes(module_routers: Sequence[APIRouter]) -> list[BaseRoute]:
    """Flatten the routes declared across a module's routers."""
    return [route for router in module_routers for route in router.routes]


def _any_mounted(routes: Sequence[BaseRoute], mounted: set[object]) -> bool:
    """Report whether any declared route's endpoint is served by the app."""
    return any(getattr(route, "endpoint", None) in mounted for route in routes)


def _wiring_violation(name: str, mounted: set[object]) -> str | None:
    """Explain why router module ``name`` is unwired, or ``None`` if it is wired."""
    module = importlib.import_module(f"routers.{name}")
    module_routers = _module_routers(module)
    if not module_routers:
        return f"{name}: module exports no APIRouter"
    routes = _declared_routes(module_routers)
    if not routes:
        return f"{name}: its APIRouter declares no routes"
    if _any_mounted(routes, mounted):
        return None
    return f"{name}: routes are not mounted (missing app.include_router)"


def _unwired_modules() -> dict[str, str]:
    """Map each unwired router module name to the reason it is unwired."""
    mounted = _mounted_endpoints()
    unwired: dict[str, str] = {}
    for name in _router_module_names():
        reason = _wiring_violation(name, mounted)
        if reason is not None:
            unwired[name] = reason
    return unwired


def _allowlist_problems(name: str, justification: str, unwired: dict[str, str]) -> list[str]:
    """Report what is wrong with one allowlist entry, if anything."""
    problems: list[str] = []
    if len(justification.strip()) < MIN_JUSTIFICATION_LENGTH:
        problems.append(
            f"allowlist entry '{name}' needs a justification of at least "
            f"{MIN_JUSTIFICATION_LENGTH} characters"
        )
    if name not in unwired:
        problems.append(f"stale allowlist entry '{name}' -- remove it")
    return problems


def test_every_router_module_is_mounted() -> None:
    """Every module under ``routers`` contributes a route the app serves."""
    # Non-emptiness first: an enumeration that finds nothing would report zero
    # violations forever, and the guard would pass by doing nothing.
    assert _router_module_names(), "no router modules discovered under routers/"
    unwired = _unwired_modules()
    violations = [reason for name, reason in unwired.items() if name not in ROUTER_ALLOWLIST]
    assert not violations, "Unmounted router modules: " + "; ".join(violations)


def test_router_allowlist_entries_are_justified_and_current() -> None:
    """Allowlist entries carry a real justification and never outlive their cause."""
    unwired = _unwired_modules()
    problems = [
        problem
        for name, justification in ROUTER_ALLOWLIST.items()
        for problem in _allowlist_problems(name, justification, unwired)
    ]
    assert not problems, "; ".join(problems)
