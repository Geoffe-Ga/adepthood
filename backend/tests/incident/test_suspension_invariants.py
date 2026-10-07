"""The suspension switches cannot be routed around by the next change (#3075).

The behavioural tests in ``test_privacy_suspension.py`` prove the switches hold
for the routes and verbs that exist today. These prove they hold for the ones
somebody adds tomorrow, structurally:

* a provider client is built in exactly two places, both reachable only through
  :func:`services.botmason.generate_response`, whose first statement is the
  external-AI guard;
* the vault adapter sends from exactly one place, whose first statement is the
  vault-send guard;
* every route that can reach a language model admits through the switch, or is
  named here with the reason it need not.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Final

from tests.support.egress_call_graph import (
    Route,
    Site,
    SourceGraph,
    egress_paths,
    egress_reaching_routes,
    source_graph,
)

_SRC: Final = Path(__file__).resolve().parents[2] / "src"
_BOTMASON: Final = _SRC / "services" / "botmason.py"
_VAULT_CLIENT: Final = _SRC / "services" / "creek_vault_client.py"
_PROVIDER_CONSTRUCTORS: Final = ("AsyncOpenAI", "AsyncAnthropic")
_CALL_LEAVES: Final = frozenset({"_call_openai", "_call_anthropic"})
_AI_LEAVES: Final = frozenset({"services.botmason.generate_response", ".complete()"})
_ADMISSION: Final = "require_external_ai_available"
_EXPECTED_CONSTRUCTION_SITES: Final = 2
_MIN_GUARDED_ROUTES: Final = 4

_CLASSIFICATION_DEGRADES: Final = (
    "classification degrades on LLMProviderError (frequency_classification); "
    "the writing is saved and never lost (AC3)"
)
#: AI-reaching routes that deliberately do not admit through the switch. Each
#: reaches the model only through frequency classification, which the leaf
#: guard refuses and the classifier degrades on, so the request still succeeds
#: with nothing sent. Shrink this; never grow it without reading the route.
AI_EXCLUSIONS: Final[dict[Route, str]] = {
    Route("POST", "/journal/"): _CLASSIFICATION_DEGRADES,
    Route("PATCH", "/journal/{entry_id}"): _CLASSIFICATION_DEGRADES,
    Route("PUT", "/corpus/consent/{source}"): _CLASSIFICATION_DEGRADES,
}


def _dotted(node: ast.expr) -> str:
    """``a.b.c`` for a plain attribute chain, else the empty string."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{_dotted(node.value)}.{node.attr}"
    return ""


def _enclosing_functions(tree: ast.Module) -> dict[int, str]:
    """Map each node id to the name of the innermost function that contains it."""
    owner: dict[int, str] = {}

    def _visit(node: ast.AST, current: str) -> None:
        for child in ast.iter_child_nodes(node):
            name = (
                child.name if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef) else current
            )
            owner[id(child)] = name
            _visit(child, name)

    _visit(tree, "<module>")
    return owner


def _first_statement(function: ast.FunctionDef | ast.AsyncFunctionDef) -> ast.stmt:
    """The first statement of ``function`` after its docstring."""
    body = function.body
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    return body[0]


def _calls_named(node: ast.AST, name: str) -> bool:
    """Whether ``node`` contains a call to something spelled ``name``."""
    return any(
        isinstance(child, ast.Call) and _dotted(child.func).rsplit(".", 1)[-1] == name
        for child in ast.walk(node)
    )


def _find_function(tree: ast.AST, name: str) -> ast.FunctionDef | ast.AsyncFunctionDef:
    """The (possibly nested or method) definition named ``name``; exactly one."""
    found = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.name == name
    ]
    assert len(found) == 1, f"expected one definition of {name}, found {len(found)}"
    return found[0]


def test_provider_clients_constructed_only_in_call_leaves() -> None:
    """Every SDK client is built inside a ``_call_*`` leaf, behind the guard."""
    sites: list[tuple[str, str]] = []
    for path in sorted(_SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        owner = _enclosing_functions(tree)
        sites.extend(
            (path.relative_to(_SRC).as_posix(), owner[id(node)])
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and _dotted(node.func).endswith(_PROVIDER_CONSTRUCTORS)
        )

    assert len(sites) == _EXPECTED_CONSTRUCTION_SITES, sites
    assert {site[0] for site in sites} == {"services/botmason.py"}, sites
    assert {site[1] for site in sites} == _CALL_LEAVES, sites

    generate = _find_function(ast.parse(_BOTMASON.read_text(encoding="utf-8")), "generate_response")
    first = _first_statement(generate)
    assert isinstance(first, ast.If), ast.dump(first)
    assert _calls_named(first.test, "external_ai_suspended")


def test_vault_adapter_has_one_request_site() -> None:
    """Every vault request leaves through ``_authorized_request``, guard first."""
    tree = ast.parse(_VAULT_CLIENT.read_text(encoding="utf-8"))
    owner = _enclosing_functions(tree)
    sites = [
        owner[id(node)]
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "request"
    ]

    assert sites, "no request site found: the walk itself is broken"
    assert set(sites) == {"_authorized_request"}, sites

    first = _first_statement(_find_function(tree, "_authorized_request"))
    assert isinstance(first, ast.If), ast.dump(first)
    assert _calls_named(first.test, "vault_send_suspended")
    assert _calls_named(first.test, "carries_content")


def _ai_trails(handler: Site) -> list[tuple[str, ...]]:
    """Every static path from ``handler`` that ends at a language-model dial."""
    return [trail for trail in egress_paths(handler) if trail[-1] in _AI_LEAVES]


def _admits(graph: SourceGraph, trail: tuple[str, ...]) -> bool:
    """Whether any function on ``trail`` lexically calls the admission check."""
    for step in trail[:-1]:
        module, _, name = step.rpartition(".")
        body = graph.body_of(Site(module, name))
        if body is not None and _calls_named(body, _ADMISSION):
            return True
    return False


def test_every_ai_reaching_route_admits_through_the_switch() -> None:
    """A new AI route that skips the admission fails here, before it can dial."""
    graph = source_graph()
    reaching = egress_reaching_routes()
    ai_routes = {route: site for route, site in reaching.items() if _ai_trails(site)}

    unguarded = sorted(
        str(route)
        for route, site in ai_routes.items()
        if route not in AI_EXCLUSIONS
        and not all(_admits(graph, trail) for trail in _ai_trails(site))
    )
    guarded = [route for route in ai_routes if route not in AI_EXCLUSIONS]

    assert unguarded == [], f"AI-reaching routes with no switch admission: {unguarded}"
    assert len(guarded) >= _MIN_GUARDED_ROUTES, guarded
    stale = sorted(str(route) for route in AI_EXCLUSIONS if route not in ai_routes)
    assert stale == [], f"exclusions naming no live AI route: {stale}"
    assert all(reason.strip() for reason in AI_EXCLUSIONS.values())
