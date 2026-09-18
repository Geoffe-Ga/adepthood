"""Derive, from the source, every path that hands stored account content outward.

Why this exists
===============

The first site list for the per-account egress barrier was produced by walking
FastAPI's route table for ``dependencies.creek_vault.get_creek_vault_client``.
That walk can only ever find **vault** egress. Two routes hand this account's
stored journal body to a cloud language model and resolve no vault client at
all, so they were invisible to it -- and therefore invisible to the totality
gate built on top of it, which listed them as covered while nothing checked
that they were. A census that names a site it does not cover is worse than one
that omits it, because the omission at least reads as a gap.

So the site list is derived here instead, by two complementary methods, because
the two transports need different ones:

* **The model dial** is an ordinary function call, so it is found with a call
  graph over ``backend/src``: names are resolved through each module's own
  imports, and the search runs from every route handler down to a leaf.
* **The vault dial** is a method call on an injected client, which no name-based
  graph can resolve. Those are recognised at the leaf instead, by the protocol's
  own transmitting method names (:data:`VAULT_EGRESS_METHODS`) -- and the route
  table walk in ``tests/security/test_egress_barrier_totality.py`` remains as
  the independent second opinion on which routes can resolve one at all.

What it answers
===============

Two questions, and the second is the one no previous artefact could ask:

1. :func:`egress_reaching_routes` -- which routes can transmit at all. This is
   the input to the totality gate: every one of them is barriered or excluded
   with a written reason.
2. :func:`unbarriered_egress_paths` -- whether a given entry point reaches a
   dial along a path that is *not* inside ``hold_account``. This is what makes
   the claim "this route is barriered" checkable rather than merely written
   down. Deleting the barrier from any one site makes this function report that
   site's path, which is the whole point: the previous gate measured route-table
   membership and would have stayed green.

And one more, because the nesting order is a deadlock and prose cannot enforce
it: :func:`inverted_nesting_sites` finds any site where the per-entry serializer
is taken *outside* the account barrier. Account outermost, entry innermost,
everywhere.

What it does not answer
=======================

It is a static over-approximation of reachability and an under-approximation of
nothing: a call it cannot resolve is a call it does not follow. Dynamic
dispatch through an object it cannot type is invisible, which is exactly why
the vault side is recognised by method name at the leaf rather than by
following the receiver. It also knows nothing about whether a barrier that is
lexically present actually orders anything -- that is what the concurrency
tests at the HTTP seam are for. The two are complements: this one is total and
shallow, those are deep and drive one path each.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Final

_SRC_ROOT: Final = Path(__file__).resolve().parents[2] / "src"

#: The barrier's context manager, by the name every call site spells it with.
HOLD_ACCOUNT: Final = "hold_account"

#: Context managers that take the barrier on the caller's behalf, mapped to the
#: function that actually takes it.
#:
#: One entry, and it is not a convenience. The detached ontologization ladder
#: installs its ordering through a :class:`~contextvars.ContextVar` so that each
#: dial is ordered separately -- a background ladder holding one account's
#: barrier for a whole multi-stage climb would make that account's own next
#: journal write, and its own deletion, wait out a ladder nobody asked for. The
#: indirection is therefore load-bearing, and it is also exactly the shape that
#: lets a registry lie: ``_ordered_dial`` could stop taking the barrier and this
#: mapping would go on claiming it does. So the mapping is *asserted* -- see
#: ``test_egress_barrier_totality.py``'s check that each named implementation
#: really does take ``hold_account`` lexically, in the same module.
INDIRECT_BARRIER_HOLDERS: Final[dict[str, tuple[str, str]]] = {
    "_ordered_dial": ("services.creek_vault_pipeline", "_order_one_detached_dial"),
}

#: The per-entry serializer's, under both names it is reachable by. Taking one
#: of these *outside* :data:`HOLD_ACCOUNT` is the inversion that deadlocks.
ENTRY_SERIALIZER_HOLDERS: Final[frozenset[str]] = frozenset(
    {"voice_draft_privacy", "journal_vault_mutations"}
)

#: Function-shaped egress leaves, as ``(module, name)``. The single cloud
#: language-model seam in the tree: every provider SDK call is behind it.
EGRESS_FUNCTIONS: Final[frozenset[tuple[str, str]]] = frozenset(
    {("services.botmason", "generate_response")}
)

#: Method-shaped egress leaves, recognised by attribute name because their
#: receiver is an injected client no static pass can type.
#:
#: ``complete`` is the ``domain.resonance.ResonanceLLM`` protocol's only verb --
#: the seam both the cloud adapter and the vault-backed adapter implement. The
#: rest are ``domain.creek_vault.CreekVaultClient``'s *transmitting* verbs.
#: ``handshake``, ``wheel``, ``is_available`` and ``supports`` are deliberately
#: absent: they send nothing of the account's, which is the same reason
#: ``GET /stages/wheel`` and ``GET /invitations`` are excluded from the barrier.
#:
#: The two withdrawal verbs -- ``withdraw_journal_entry`` and
#: ``delete_voice_draft`` -- are present although they only ever *reduce* what
#: Creek holds. They carry an identifier derived from this account's rows, they
#: are already inside the holds their routes take, and a leaf set that admitted
#: judgement calls about which writes "count" is a leaf set somebody will argue
#: with. Every write verb, no exceptions.
VAULT_EGRESS_METHODS: Final[frozenset[str]] = frozenset(
    {
        "complete",
        "ingest",
        "upload",
        "withdraw_journal_entry",
        "upsert_voice_draft",
        "delete_voice_draft",
        "classify",
        "classify_corpus",
        "link_corpus",
        "reflect",
        "pipeline_job",
    }
)

_HTTP_VERBS: Final[frozenset[str]] = frozenset({"get", "post", "put", "patch", "delete"})


@dataclass(frozen=True, slots=True)
class Site:
    """One resolvable function in the tree, as ``services.foo`` plus ``bar``."""

    module: str
    name: str

    def __str__(self) -> str:
        """``module.name``, the spelling every assertion message uses."""
        return f"{self.module}.{self.name}"


@dataclass(frozen=True, slots=True)
class Route:
    """One HTTP operation, as the route table spells it."""

    method: str
    path: str

    def __str__(self) -> str:
        """``POST /journal/``, the spelling every assertion message uses."""
        return f"{self.method} {self.path}"


def _module_name(path: Path) -> str:
    """The dotted name ``path`` is imported under, relative to ``src``."""
    relative = path.relative_to(_SRC_ROOT).with_suffix("")
    parts = [part for part in relative.parts if part != "__init__"]
    return ".".join(parts)


def _source_modules() -> dict[str, ast.Module]:
    """Every module under ``src``, parsed once and keyed by dotted name."""
    return {
        _module_name(path): ast.parse(path.read_text(encoding="utf-8"))
        for path in sorted(_SRC_ROOT.rglob("*.py"))
    }


def _function_defs(tree: ast.Module) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    """Top-level function definitions in one module, by name.

    Methods are deliberately not indexed. Nothing needs to descend into one: the
    two method-shaped seams that matter -- the language-model adapter's
    ``complete`` and the vault client's verbs -- are leaves, recognised by name
    at the call rather than followed into a body.
    """
    return {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _imported_names(tree: ast.Module) -> dict[str, Site]:
    """Where each name this module imported actually comes from."""
    bindings: dict[str, Site] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom) or node.module is None:
            continue
        for alias in node.names:
            bindings[alias.asname or alias.name] = Site(node.module, alias.name)
    return bindings


class SourceGraph:
    """A name-resolved call graph over ``backend/src``.

    Built once per process (see :func:`source_graph`) because parsing the tree
    is the expensive part and nothing here mutates.
    """

    def __init__(self) -> None:
        """Parse every module and index its functions and imported names."""
        self._modules = _source_modules()
        self._functions = {module: _function_defs(tree) for module, tree in self._modules.items()}
        self._imports = {module: _imported_names(tree) for module, tree in self._modules.items()}

    @property
    def modules(self) -> dict[str, ast.Module]:
        """Every parsed module, keyed by the dotted name it is imported under."""
        return self._modules

    def body_of(self, site: Site) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
        """The definition ``site`` names, or ``None`` when it is not a function here."""
        return self._functions.get(site.module, {}).get(site.name)

    def resolve(self, module: str, name: str) -> Site | None:
        """Where ``name``, as written inside ``module``, is defined.

        Local definitions win over imports, which is Python's own rule and the
        one that keeps a module's private helper from being mistaken for a
        same-named import somewhere else.
        """
        if name in self._functions.get(module, {}):
            return Site(module, name)
        imported = self._imports.get(module, {}).get(name)
        if imported is None:
            return None
        if self.body_of(imported) is not None:
            return imported
        return imported if (imported.module, imported.name) in EGRESS_FUNCTIONS else None

    def route_handlers(self) -> dict[Route, Site]:
        """Every ``@router.<verb>`` operation in ``routers``, by route.

        Paths are assembled from the router's own ``prefix=`` so they read the
        way the route table spells them, which is how the totality gate's
        classification is keyed.
        """
        found: dict[Route, Site] = {}
        for module, tree in self._modules.items():
            if not module.startswith("routers."):
                continue
            prefix = _router_prefix(tree)
            for node in tree.body:
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                for method, path in _route_decorations(node):
                    found[Route(method, f"{prefix}{path}")] = Site(module, node.name)
        return found


def _router_prefix(tree: ast.Module) -> str:
    """The ``prefix=`` this module's router was built with, or the empty string."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        for keyword in node.keywords:
            if keyword.arg == "prefix" and isinstance(keyword.value, ast.Constant):
                return str(keyword.value.value)
    return ""


def _route_decorations(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
) -> list[tuple[str, str]]:
    """The ``(METHOD, path)`` pairs one function is registered under."""
    found: list[tuple[str, str]] = []
    for decorator in node.decorator_list:
        if not isinstance(decorator, ast.Call):
            continue
        target = decorator.func
        if not isinstance(target, ast.Attribute) or target.attr not in _HTTP_VERBS:
            continue
        if not isinstance(target.value, ast.Name) or target.value.id != "router":
            continue
        if decorator.args and isinstance(decorator.args[0], ast.Constant):
            found.append((target.attr.upper(), str(decorator.args[0].value)))
    return found


@cache
def source_graph() -> SourceGraph:
    """The one parsed graph, shared by every check in this module."""
    return SourceGraph()


def _holds_account(item: ast.withitem) -> bool:
    """Whether this ``with`` item establishes the account egress barrier.

    Either directly, or through one of the asserted indirections in
    :data:`INDIRECT_BARRIER_HOLDERS`.
    """
    expression = item.context_expr
    if not isinstance(expression, ast.Call):
        return False
    name = _called_name(expression.func)
    return name == HOLD_ACCOUNT or name in INDIRECT_BARRIER_HOLDERS


def takes_barrier_lexically(site: Site) -> bool:
    """Whether ``site``'s own body opens an ``async with hold_account(...)``.

    Direct only -- no indirection is followed -- because this is the check that
    keeps :data:`INDIRECT_BARRIER_HOLDERS` honest, and a check that accepted the
    indirection it is verifying would accept anything.
    """
    body = source_graph().body_of(site)
    if body is None:
        return False
    return any(
        isinstance(node, ast.AsyncWith)
        and any(
            isinstance(item.context_expr, ast.Call)
            and _called_name(item.context_expr.func) == HOLD_ACCOUNT
            for item in node.items
        )
        for node in ast.walk(body)
    )


def _holds_entry(item: ast.withitem) -> bool:
    """Whether this ``with`` item is the per-entry serializer's hold."""
    expression = item.context_expr
    if not isinstance(expression, ast.Call) or not isinstance(expression.func, ast.Attribute):
        return False
    receiver = expression.func.value
    return (
        expression.func.attr == "hold"
        and isinstance(receiver, ast.Name)
        and receiver.id in ENTRY_SERIALIZER_HOLDERS
    )


def _called_name(func: ast.expr) -> str:
    """The trailing name of a call target, so ``a.b.c()`` reads as ``c``."""
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def _is_egress_leaf(call: ast.Call) -> bool:
    """Whether this call is itself a dial, by either transport."""
    return isinstance(call.func, ast.Attribute) and call.func.attr in VAULT_EGRESS_METHODS


def _unbarriered_calls(node: ast.AST) -> list[ast.Call]:
    """Every call in ``node`` that is *not* inside an ``async with hold_account``.

    Descent stops at a barriered region rather than recursing into it, because
    the barrier is held for the whole dynamic extent of its body: anything that
    region reaches is covered, however deep.
    """
    found: list[ast.Call] = []
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.AsyncWith) and any(_holds_account(item) for item in child.items):
            # The items themselves still run outside the hold they establish.
            for item in child.items:
                found.extend(_unbarriered_calls(item))
            continue
        if isinstance(child, ast.Call):
            found.append(child)
        found.extend(_unbarriered_calls(child))
    return found


def _all_calls(node: ast.AST) -> list[ast.Call]:
    """Every call anywhere in ``node``, barriered or not."""
    return [child for child in ast.walk(node) if isinstance(child, ast.Call)]


def _leaf_name(graph: SourceGraph, module: str, call: ast.Call) -> str | None:
    """The egress leaf this call *is*, or ``None`` when it is not one."""
    if isinstance(call.func, ast.Attribute) and call.func.attr in VAULT_EGRESS_METHODS:
        return f".{call.func.attr}()"
    resolved = graph.resolve(module, _called_name(call.func))
    if resolved is not None and (resolved.module, resolved.name) in EGRESS_FUNCTIONS:
        return str(resolved)
    return None


@dataclass(frozen=True, slots=True)
class _Walk:
    """One traversal's fixed settings and its accumulating result.

    A value object rather than five parameters threaded through the recursion:
    only ``site``, ``trail`` and ``seen`` change between frames, and the rest
    being visibly immutable is what makes the ``barriered_only`` switch readable
    at the two call sites that set it.
    """

    graph: SourceGraph
    barriered_only: bool
    found: list[tuple[str, ...]]


def _search(walk: _Walk, site: Site, trail: tuple[str, ...], seen: frozenset[Site]) -> None:
    """Depth-first walk from ``site`` to every egress leaf, recording each trail."""
    body = walk.graph.body_of(site)
    if body is None:
        return
    calls = _unbarriered_calls(body) if walk.barriered_only else _all_calls(body)
    for call in calls:
        leaf = _leaf_name(walk.graph, site.module, call)
        if leaf is not None:
            walk.found.append((*trail, leaf))
            continue
        target = walk.graph.resolve(site.module, _called_name(call.func))
        if target is None or target in seen or walk.graph.body_of(target) is None:
            continue
        _search(walk, target, (*trail, str(target)), seen | {target})


def _walked(entry: Site, *, barriered_only: bool) -> tuple[tuple[str, ...], ...]:
    """Every distinct trail from ``entry`` to a dial, under one traversal mode."""
    walk = _Walk(source_graph(), barriered_only, [])
    _search(walk, entry, (str(entry),), frozenset({entry}))
    return tuple(sorted(set(walk.found)))


def egress_paths(entry: Site) -> tuple[tuple[str, ...], ...]:
    """Every static path from ``entry`` to a dial, barriered or not."""
    return _walked(entry, barriered_only=False)


def unbarriered_egress_paths(entry: Site) -> tuple[tuple[str, ...], ...]:
    """Every path from ``entry`` to a dial that no ``hold_account`` encloses.

    Empty is the property worth having, and it is the one a docstring claiming
    "this route is barriered" is asserting. Removing the barrier from any single
    site makes that site's path appear here.
    """
    return _walked(entry, barriered_only=True)


def egress_reaching_routes() -> dict[Route, Site]:
    """Every route whose handler can reach a dial, by either transport."""
    graph = source_graph()
    return {
        route: handler for route, handler in graph.route_handlers().items() if egress_paths(handler)
    }


def inverted_nesting_sites() -> tuple[str, ...]:
    """Every place the per-entry serializer is taken outside the account barrier.

    Two shapes count, because both deadlock and both are one edit away from each
    other: the serializer listed *before* ``hold_account`` in one ``async with``,
    and an ``async with hold_account`` nested lexically inside a serializer hold.
    """
    found: list[str] = []
    for module, tree in source_graph().modules.items():
        for node in ast.walk(tree):
            if not isinstance(node, ast.AsyncWith):
                continue
            found.extend(_inversions_at(module, node))
    return tuple(sorted(set(found)))


def _inversions_at(module: str, node: ast.AsyncWith) -> list[str]:
    """Inversions visible at one ``async with``, by either shape."""
    found: list[str] = []
    names = [_holds_account(item) for item in node.items]
    entries = [_holds_entry(item) for item in node.items]
    if any(names) and any(entries) and entries.index(True) < names.index(True):
        found.append(
            f"{module}:{node.lineno} takes the entry serializer before the account barrier"
        )
    if any(entries) and not any(names):
        for inner in ast.walk(node):
            if inner is node or not isinstance(inner, ast.AsyncWith):
                continue
            if any(_holds_account(item) for item in inner.items):
                found.append(
                    f"{module}:{inner.lineno} takes the account barrier inside an "
                    f"entry-serializer hold opened at line {node.lineno}"
                )
    return found
