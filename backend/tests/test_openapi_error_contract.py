"""The document must declare the errors the application actually sends.

Two thirds of the fuzzable operations on this API answer with a status they
never declared, and every one of those bodies is the same shape: a ``detail``
holding one snake_case refusal code. The 422 is worse than undeclared, because
it is declared *wrongly* -- FastAPI's auto-generated ``HTTPValidationError``
says ``detail`` is an array, and a domain refusal raised through
``errors.unprocessable`` puts a plain string there.

The correction runs one way only. The wire is right and the paper is wrong, so
nothing here asks a refusal code to change; it asks the declaration to admit
what already travels. Each refusal code this file names is asserted verbatim
for that reason: a client reads those strings, and a contract fix that renamed
one would be a breaking change wearing the costume of a documentation fix.

Three groups of assertions:

* the two operations a real Schemathesis run failed on declare a 422 that
  admits a string ``detail``, and the entry model inside the array branch keeps
  the redaction ``errors._VALIDATION_ENTRY_KEYS`` performs;
* three representative routes -- authenticated, ownership-resolving, and
  rate-limited -- declare the statuses their own machinery can produce;
* and two meta-assertions that make the above the default for a route nobody
  has written yet, rather than something each author must remember.

The source of truth is the live ``app.openapi()`` render, never the committed
``backend/openapi.json``: that file is derived, its freshness is a separate
gate's problem, and reading it here would let a stale export hide a live break.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any, Final

import pytest

from dependencies.ownership import require_owned_habit
from rate_limit import limiter
from routers.auth import get_current_user
from tests.helpers.openapi_errors import (
    api_route,
    declared_response_schema,
    declared_status_codes,
    dependency_callables,
    detail_entry_forbids_extra_properties,
    detail_entry_properties,
    live_document,
    response_validator,
    route_index,
)

_ROUTERS_DIR: Final = Path(__file__).resolve().parents[1] / "src" / "routers"
_ERRORS_MODULE: Final = "errors"

# The class a router module must not build for itself.
_API_ROUTER: Final = "APIRouter"

# The decorator names that turn a function into an operation.
_HTTP_VERBS: Final = frozenset({"get", "post", "put", "patch", "delete", "head", "options"})

# The three keys a sanitised validation entry keeps, mirroring
# ``errors._VALIDATION_ENTRY_KEYS``. Restated rather than imported so this file
# pins what the document *publishes* independently of the module that produces
# it. What the wire actually carries is pinned separately, by the live-body
# test that reads a real rejection back off a real response.
_PERMITTED_ENTRY_KEYS: Final = frozenset({"type", "loc", "msg"})

# The two keys whose presence is the disclosure. ``input`` is a verbatim copy of
# what failed validation -- and for a *missing* required field it is the whole
# request body, credentials included. ``ctx`` restates the violated bound and
# sometimes embeds the offending value a second time. Declaring either would
# publish a promise this application deliberately does not keep.
_DISCLOSING_ENTRY_KEYS: Final = frozenset({"input", "ctx"})

# Every refusal helper in ``errors`` that a router raises, and the status it
# sends. A router importing one of these can answer with that status, so an
# operation of that router that does not declare it is undocumented by
# construction.
# The callable a module invokes to build a refusal by hand, and the shape of
# the ``status`` constants it names when it does.
_HTTP_EXCEPTION: Final = "HTTPException"
_STATUS_CONSTANT: Final = re.compile(r"HTTP_(\d{3})_[A-Z_]+")

# The one status this API never promises: a 500 is a bug, and the fuzzer's own
# server-error check owns it. Declaring it would document the failure mode.
_UNDECLARABLE_STATUS: Final = "500"

_HELPER_STATUSES: Final = {
    "bad_request": "400",
    "forbidden": "403",
    "not_found": "404",
    "conflict": "409",
    "payment_required": "402",
    "payload_too_large": "413",
    "unprocessable": "422",
    "bad_gateway": "502",
    "service_unavailable": "503",
}

# The refusal ``GET /reflections/sources`` answers a malformed scope key with,
# and the one ``PUT /vault/connection`` answers a URL with neither scheme nor
# host with. Both are string details under a declaration that says array.
_INVALID_SCOPE: Final = "invalid_scope"
_MALFORMED_VAULT_URL: Final = "vault_url_malformed"

_STRING_DETAIL_OPERATIONS: Final = (
    ("get", "/reflections/sources", _INVALID_SCOPE),
    ("put", "/vault/connection", _MALFORMED_VAULT_URL),
)

# Chosen for what they are, not for what they declare. ``GET /habits/`` resolves
# the caller from their JWT and nothing else, so 401 is its whole failure
# surface beside the ambient throttle. ``PUT /habits/{habit_id}`` resolves a
# path id through ``dependencies.ownership.require_owned_habit``, which is the
# helper that draws the 404-missing / 403-not-owner split this API is built on.
# ``GET /journal/`` carries an explicit ``@limiter.limit`` on top of the global
# default, so its 429 is a decision somebody made rather than ambient weather.
_AUTHENTICATED_ROUTE: Final = ("get", "/habits/")
_OWNERSHIP_ROUTE: Final = ("put", "/habits/{habit_id}")
_RATE_LIMITED_ROUTE: Final = ("get", "/journal/")


@pytest.fixture(scope="module")
def document() -> dict[str, Any]:
    """The application's own OpenAPI render, built once for the module."""
    return live_document()


def _router_modules() -> tuple[Path, ...]:
    """Every module under ``src/routers`` except the package marker."""
    return tuple(sorted(p for p in _ROUTERS_DIR.glob("*.py") if p.name != "__init__.py"))


def _module_ids(modules: tuple[Path, ...]) -> list[str]:
    """Stem names for ``modules``, used as parametrize ids."""
    return [p.stem for p in modules]


def _parsed(module_path: Path) -> ast.Module:
    """Parse one router module's source."""
    return ast.parse(module_path.read_text(encoding="utf-8"))


def _declares_routes(tree: ast.Module) -> bool:
    """Whether the module attaches at least one operation to a router.

    Keyed on a verb decorator rather than on any mention of ``router``, so the
    shared factory -- which builds routers and declares no operation of its own
    -- is outside the rule it exists to enforce.
    """
    return any(
        isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id == "router"
        and node.attr in _HTTP_VERBS
        for node in ast.walk(tree)
    )


def _called_name(func: ast.expr) -> str:
    """The trailing name of a call target, so ``fastapi.APIRouter`` reads as ``APIRouter``."""
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def _direct_api_router_calls(tree: ast.Module) -> int:
    """How many times the module builds an ``APIRouter`` itself.

    Counts a qualified ``fastapi.APIRouter(...)`` as well as a bare one, and any
    alias the module imported the class under, so the guard cannot be stepped
    around by changing how the name is spelled.
    """
    aliases = {
        alias.asname or alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        for alias in node.names
        if alias.name == _API_ROUTER
    }
    names = aliases | {_API_ROUTER}
    return sum(
        1
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and _called_name(node.func) in names
    )


def _imported_error_helpers(tree: ast.Module) -> frozenset[str]:
    """Refusal helpers the module imports from ``errors``."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == _ERRORS_MODULE:
            names.update(alias.name for alias in node.names if alias.name in _HELPER_STATUSES)
    return frozenset(names)


# Selected once, at collection, so a module with nothing to check is absent from
# the report rather than present as a skip. A skipped case reads like a decision
# somebody made about that module; an absent one reads like what it is.
_ROUTE_DECLARING_MODULES: Final = tuple(
    path for path in _router_modules() if _declares_routes(_parsed(path))
)
_REFUSING_MODULES: Final = tuple(
    path for path in _router_modules() if _imported_error_helpers(_parsed(path))
)


def test_every_declared_operation_is_reachable_through_the_route_walk(
    document: dict[str, Any],
) -> None:
    """The walk backing these assertions must see every operation the document has.

    A walk that stopped finding endpoints would make the per-router assertions
    below report an empty world, which is indistinguishable from a clean one.
    """
    index = route_index()
    unreachable = sorted(
        f"{method.upper()} {path}"
        for path, verbs in document["paths"].items()
        for method in verbs
        if (method.upper(), path) not in index
    )
    assert unreachable == []


def _statuses_by_router(document: dict[str, Any]) -> dict[str, frozenset[str]]:
    """Group every declared status by the router module whose endpoint owns it.

    Grouped through the mounted route rather than through the URL prefix,
    because the module a handler lives in is the thing the import check below is
    about; a prefix is only a naming convention.
    """
    grouped: dict[str, set[str]] = {}
    for path, verbs in document["paths"].items():
        for method, operation in verbs.items():
            module = api_route(method, path).endpoint.__module__
            stem = module.removeprefix("routers.")
            grouped.setdefault(stem, set()).update(operation["responses"])
    return {stem: frozenset(codes) for stem, codes in grouped.items()}


@pytest.fixture(scope="module")
def statuses_by_router(document: dict[str, Any]) -> dict[str, frozenset[str]]:
    """Declared statuses per router module, computed once for the module."""
    return _statuses_by_router(document)


@pytest.mark.parametrize(
    ("method", "path", "refusal"),
    _STRING_DETAIL_OPERATIONS,
    ids=[f"{m}{p}" for m, p, _ in _STRING_DETAIL_OPERATIONS],
)
def test_declared_422_admits_a_string_detail(
    document: dict[str, Any], method: str, path: str, refusal: str
) -> None:
    """A refusal this operation genuinely sends must validate against its own 422.

    Driven against a synthetic body rather than a live one so the declaration is
    checked with no database in the way; the live counterpart lives in
    ``tests/test_error_contract_live_bodies.py``.
    """
    schema = declared_response_schema(document, method, path, 422)
    response_validator(document, schema).validate({"detail": refusal})


@pytest.mark.parametrize(
    ("method", "path"),
    [(m, p) for m, p, _ in _STRING_DETAIL_OPERATIONS],
    ids=[f"{m}{p}" for m, p, _ in _STRING_DETAIL_OPERATIONS],
)
def test_declared_422_entry_model_keeps_only_the_three_client_keys(
    document: dict[str, Any], method: str, path: str
) -> None:
    """The array branch of a 422 must publish exactly type, loc and msg.

    A security assertion, not a tidiness one. The stock FastAPI entry model
    declares ``input`` and ``ctx``; the application's own handler strips both
    before answering, so declaring them would publish a promise to hand back
    material -- for a missing required field, the entire request body -- that
    this application refuses to hand back.
    """
    schema = declared_response_schema(document, method, path, 422)
    properties = detail_entry_properties(document, schema)
    assert properties == _PERMITTED_ENTRY_KEYS
    assert not properties & _DISCLOSING_ENTRY_KEYS
    # Naming the three keys only describes the entry; closing it is what makes
    # the omission binding, so the closure is asserted rather than assumed.
    assert detail_entry_forbids_extra_properties(document, schema)


def test_authenticated_route_declares_unauthorized_and_throttled(
    document: dict[str, Any],
) -> None:
    """A route behind the JWT dependency publishes the two refusals it can send."""
    method, path = _AUTHENTICATED_ROUTE
    assert get_current_user in dependency_callables(api_route(method, path))
    assert {"401", "429"} <= declared_status_codes(document, method, path)


def test_ownership_route_declares_forbidden_and_not_found(document: dict[str, Any]) -> None:
    """A route resolving a path id through the ownership helpers publishes both halves."""
    method, path = _OWNERSHIP_ROUTE
    assert require_owned_habit in dependency_callables(api_route(method, path))
    assert {"403", "404"} <= declared_status_codes(document, method, path)


def test_rate_limited_route_declares_too_many_requests(document: dict[str, Any]) -> None:
    """A route carrying its own limiter decorator publishes the 429 it can send."""
    method, path = _RATE_LIMITED_ROUTE
    endpoint = api_route(method, path).endpoint
    assert f"{endpoint.__module__}.{endpoint.__name__}" in limiter._route_limits  # noqa: SLF001 -- slowapi exposes its route table nowhere else
    assert "429" in declared_status_codes(document, method, path)


@pytest.mark.parametrize(
    "module_path", _ROUTE_DECLARING_MODULES, ids=_module_ids(_ROUTE_DECLARING_MODULES)
)
def test_router_module_does_not_construct_an_api_router_itself(module_path: Path) -> None:
    """Every route-declaring module takes its router from the shared factory.

    A module that builds its own ``APIRouter`` starts with an empty
    ``responses``, which is precisely how a new route arrives undeclared. Going
    through one factory is what makes the common error contract the default
    instead of a thing each author has to remember.
    """
    assert _direct_api_router_calls(_parsed(module_path)) == 0, (
        f"{module_path.name} calls APIRouter() directly; use the shared router factory "
        "so its operations inherit the common error responses"
    )


@pytest.mark.parametrize("module_path", _REFUSING_MODULES, ids=_module_ids(_REFUSING_MODULES))
def test_router_declares_every_status_its_error_helpers_can_send(
    statuses_by_router: dict[str, frozenset[str]], module_path: Path
) -> None:
    """A refusal helper a router imports must correspond to a status it declares.

    This is the guard that stops the next route being wrong by default: the
    import is the evidence that the status is reachable, so a declaration that
    omits it is a documented contract the application already violates.
    """
    helpers = _imported_error_helpers(_parsed(module_path))
    reachable = {_HELPER_STATUSES[name] for name in helpers}
    declared = statuses_by_router.get(module_path.stem, frozenset())
    missing = sorted(reachable - declared)
    assert not missing, (
        f"{module_path.name} raises errors that produce {missing} but declares none of them"
    )


def _bare_http_exception_statuses(tree: ast.Module) -> frozenset[str]:
    """Statuses the module names in an ``HTTPException`` it builds itself.

    The companion to :func:`_imported_error_helpers`, and the reason that one is
    not enough on its own. A module is free to raise ``HTTPException`` directly
    rather than through an ``errors`` helper, and a local wrapper around one --
    ``practice_share._gone`` is the live example -- is invisible to an
    import-based check while sending a status like any other.

    Only ``status.HTTP_<code>_<name>`` attribute reads are counted, which is how
    every such raise in this application spells its status.
    """
    found: set[str] = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
            continue
        if node.func.id != _HTTP_EXCEPTION:
            continue
        for argument in ast.walk(node):
            if isinstance(argument, ast.Attribute):
                match = _STATUS_CONSTANT.fullmatch(argument.attr)
                if match:
                    found.add(match.group(1))
    return frozenset(found)


_BARE_RAISING_MODULES: Final = tuple(
    path for path in _router_modules() if _bare_http_exception_statuses(_parsed(path))
)


@pytest.mark.parametrize(
    "module_path", _BARE_RAISING_MODULES, ids=_module_ids(_BARE_RAISING_MODULES)
)
def test_router_declares_every_status_it_raises_by_hand(
    statuses_by_router: dict[str, frozenset[str]], module_path: Path
) -> None:
    """A status a router builds an ``HTTPException`` for must be one it declares.

    A refusal reached only by state no generated input can construct -- a share
    link that resolved but is spent -- is invisible to a contract fuzzer, so the
    fuzzer's silence is not evidence the declaration is complete. Reading the
    raise is.

    The 500 a service raises deliberately is excluded: a server error is a bug
    the fuzzer's own server-error check owns, and declaring it would document
    the one outcome this API never promises.
    """
    reachable = {
        code
        for code in _bare_http_exception_statuses(_parsed(module_path))
        if code != _UNDECLARABLE_STATUS
    }
    declared = statuses_by_router.get(module_path.stem, frozenset())
    missing = sorted(reachable - declared)
    assert not missing, (
        f"{module_path.name} raises HTTPException with {missing} but declares none of them"
    )
