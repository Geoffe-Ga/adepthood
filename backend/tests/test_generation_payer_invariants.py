"""The payer gate and the stub seam cannot be routed around by the next change (#3096).

``test_generation_payer.py`` proves the routes that exist today refuse without
credits or a key, and never hand out canned stub text. These prove it
structurally, for the routes and call sites somebody adds tomorrow:

* the stub's answer is built from exactly one call site, in the helper only
  :func:`services.botmason.generate_response` calls, under an ``if`` that asks
  :func:`services.botmason.stub_seam_armed` -- nothing else in ``src`` can reach
  it, and nothing in ``src`` arms the seam;
* the canned completions module is imported by the stub alone;
* every route that can reach a language model admits through the payer gate,
  beside the operator's suspension switch, or is named here with the reason it
  need not.
"""

from __future__ import annotations

import ast
from functools import cache
from pathlib import Path
from typing import Final

from tests.incident.test_suspension_invariants import (
    AI_EXCLUSIONS,
    _ai_trails,
    _calls_named,
    _dotted,
    _enclosing_functions,
)
from tests.support.egress_call_graph import Site, SourceGraph, egress_reaching_routes, source_graph

_SRC: Final = Path(__file__).resolve().parents[1] / "src"
_STUB_ENTRY: Final = "_stub_answer"
_STUB_GATE: Final = "_unconfigured_answer"
_STUB_BUILDERS: Final = frozenset({"_stub_response", "_stub_vision_response"})
_SEAM_CHECK: Final = "stub_seam_armed"
_SEAM_ENV_NAME: Final = "STUB_SEAM_ENV_VAR"
_PAYER_GATE: Final = "require_ai_payer"
#: The gate run so its 402 is handed back rather than raised (resonance care).
_PAYER_GATE_RETURNING: Final = "payer_refusal"
_MIN_GATED_ROUTES: Final = 4
#: Where the seam's variable may be named: its definition and reader, and the
#: production boot refusal. Nothing else in ``src`` may touch it.
_SEAM_ENV_READERS: Final = frozenset({"services/botmason.py", "main.py"})


@cache
def _trees() -> dict[str, ast.Module]:
    """Every source module under ``src``, parsed once, keyed by its relative path.

    Parsed once so a call node found in one walk is the same object a later
    walk of the same module compares against.
    """
    return {
        path.relative_to(_SRC).as_posix(): ast.parse(path.read_text(encoding="utf-8"))
        for path in sorted(_SRC.rglob("*.py"))
    }


def _call_sites(name: str) -> list[tuple[str, str, ast.Call]]:
    """Every ``(module, enclosing function, call)`` that calls something spelled ``name``."""
    sites: list[tuple[str, str, ast.Call]] = []
    for module, tree in _trees().items():
        owner = _enclosing_functions(tree)
        sites.extend(
            (module, owner[id(node)], node)
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and _dotted(node.func).rsplit(".", 1)[-1] == name
        )
    return sites


def _guarding_ifs(tree: ast.Module, target: ast.AST) -> list[ast.If]:
    """The ``if`` statements whose *body* (not ``else``) lexically contains ``target``."""
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.If)
        and any(child is target for stmt in node.body for child in ast.walk(stmt))
    ]


def test_the_stub_answer_has_one_call_site_behind_the_seam() -> None:
    """Only ``generate_response`` reaches a stub answer, and only when the seam is armed."""
    sites = _call_sites(_STUB_ENTRY)
    gate_callers = {(module, owner) for module, owner, _ in _call_sites(_STUB_GATE)}

    assert [(module, owner) for module, owner, _ in sites] == [
        ("services/botmason.py", _STUB_GATE)
    ], sites
    assert gate_callers == {("services/botmason.py", "generate_response")}, gate_callers
    tree = _trees()["services/botmason.py"]
    guards = _guarding_ifs(tree, sites[0][2])
    assert any(_calls_named(guard.test, _SEAM_CHECK) for guard in guards), [
        ast.unparse(guard.test) for guard in guards
    ]


def test_the_canned_builders_are_reached_only_through_the_stub_entry() -> None:
    """``_stub_response`` and ``_stub_vision_response`` are called from ``_stub_answer`` alone."""
    for builder in _STUB_BUILDERS:
        owners = {(module, owner) for module, owner, _ in _call_sites(builder)}
        assert owners == {("services/botmason.py", _STUB_ENTRY)}, (builder, owners)


def test_canned_completions_are_imported_by_the_stub_alone() -> None:
    """No route or service can serve ``stub_completions`` text except through the stub."""
    importers = sorted(
        module
        for module, tree in _trees().items()
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module == "services.stub_completions"
    )

    assert importers == ["services/botmason.py"]


def test_nothing_in_src_arms_the_seam() -> None:
    """The seam's variable is read by the stub and refused at boot; no module sets it."""
    named = sorted(
        module
        for module, tree in _trees().items()
        if any(
            isinstance(node, ast.Name | ast.Attribute) and _SEAM_ENV_NAME in ast.unparse(node)
            for node in ast.walk(tree)
        )
    )
    writes = [
        (module, ast.unparse(node))
        for module, tree in _trees().items()
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and _dotted(node.func).endswith(("environ.__setitem__", "putenv", "environ.setdefault"))
    ]
    subscript_writes = [
        (module, ast.unparse(node))
        for module, tree in _trees().items()
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Subscript) and _dotted(target.value).endswith("environ")
            for target in node.targets
        )
    ]

    assert set(named) <= _SEAM_ENV_READERS, named
    assert "services/botmason.py" in named
    assert "main.py" in named
    assert writes == [], writes
    assert subscript_writes == [], subscript_writes


def _admits_through_gate(graph: SourceGraph, module: str, body: ast.AST) -> bool:
    """Whether ``body`` calls the payer gate, directly or through a same-module helper.

    ``payer_refusal`` is the gate with its 402 handed back, so a refused
    distressed writer still gets care. One level of same-module helper is
    followed too, so the check stays lexical.
    """
    if _calls_named(body, _PAYER_GATE) or _calls_named(body, _PAYER_GATE_RETURNING):
        return True
    for node in ast.walk(body):
        if not isinstance(node, ast.Call):
            continue
        helper = graph.body_of(Site(module, _dotted(node.func).rsplit(".", 1)[-1]))
        if helper is not None and _calls_named(helper, _PAYER_GATE):
            return True
    return False


def _gated(graph: SourceGraph, trail: tuple[str, ...]) -> bool:
    """Whether any function on ``trail`` admits through the payer gate."""
    for step in trail[:-1]:
        module, _, name = step.rpartition(".")
        body = graph.body_of(Site(module, name))
        if body is not None and _admits_through_gate(graph, module, body):
            return True
    return False


def test_every_ai_reaching_route_admits_through_the_payer_gate() -> None:
    """A new AI route that forgets the gate fails here, before it can hand out a stub.

    The exclusions are the suspension test's own: routes that reach a model
    only through frequency classification, which degrades on any provider
    failure -- including the unarmed stub's refusal -- and stores nothing a
    writer reads as a generated artefact.
    """
    graph = source_graph()
    ai_routes = {
        route: site for route, site in egress_reaching_routes().items() if _ai_trails(site)
    }

    ungated = sorted(
        str(route)
        for route, site in ai_routes.items()
        if route not in AI_EXCLUSIONS and not all(_gated(graph, t) for t in _ai_trails(site))
    )
    gated = [route for route in ai_routes if route not in AI_EXCLUSIONS]

    assert ungated == [], f"AI-reaching routes with no payer gate: {ungated}"
    assert len(gated) >= _MIN_GATED_ROUTES, gated
