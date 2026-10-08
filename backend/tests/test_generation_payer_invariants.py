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

import pytest

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


def _refusal_binding(node: ast.AST) -> str | None:
    """The name ``x`` when ``node`` is ``x = [await] payer_refusal(...)``, else ``None``."""
    if not (isinstance(node, ast.Assign) and len(node.targets) == 1):
        return None
    target, value = node.targets[0], node.value
    if isinstance(value, ast.Await):
        value = value.value
    if not (
        isinstance(target, ast.Name)
        and isinstance(value, ast.Call)
        and _dotted(value.func).rsplit(".", 1)[-1] == _PAYER_GATE_RETURNING
    ):
        return None
    return target.id


def _acts_on(body: ast.AST, name: str) -> bool:
    """Whether ``body`` has ``if <name> is not None:`` whose branch returns or raises."""
    for node in ast.walk(body):
        if not isinstance(node, ast.If):
            continue
        test = node.test
        if not (
            isinstance(test, ast.Compare)
            and isinstance(test.left, ast.Name)
            and test.left.id == name
            and len(test.ops) == 1
            and isinstance(test.ops[0], ast.IsNot)
            and isinstance(test.comparators[0], ast.Constant)
            and test.comparators[0].value is None
        ):
            continue
        if any(isinstance(child, ast.Return | ast.Raise) for child in node.body):
            return True
    return False


def _admits_through_gate(body: ast.AST) -> bool:
    """Whether ``body`` admits through the payer gate.

    Either it calls ``require_ai_payer``, which raises its refusal, or it binds
    ``payer_refusal``'s handed-back 402 and returns or raises when there is one.
    A ``payer_refusal`` whose result is ignored admits everything, so it does
    not count.
    """
    if _calls_named(body, _PAYER_GATE):
        return True
    names = [name for node in ast.walk(body) if (name := _refusal_binding(node))]
    return any(_acts_on(body, name) for name in names)


def _gated(graph: SourceGraph, trail: tuple[str, ...]) -> bool:
    """Whether any function on ``trail`` admits through the payer gate."""
    for step in trail[:-1]:
        module, _, name = step.rpartition(".")
        body = graph.body_of(Site(module, name))
        if body is not None and _admits_through_gate(body):
            return True
    return False


#: A handler that binds the gate's handed-back refusal, for the rule's own cases.
_BIND: Final = "async def r(s):\n    refusal = await payer_refusal(s, 1, None)\n"


@pytest.mark.parametrize(
    ("source", "admits"),
    [
        ("async def r(s):\n    await require_ai_payer(s, 1, None)\n", True),
        (_BIND + "    if refusal is not None:\n        return refusal\n", True),
        (_BIND + "    if refusal is not None:\n        raise refusal\n", True),
        ("async def r(s):\n    await payer_refusal(s, 1, None)\n", False),
        (
            "async def r(s):\n    refusal = await payer_refusal(s, 1, None)\n    log(refusal)\n",
            False,
        ),
        (_BIND + "    if refusal is not None:\n        log(refusal)\n", False),
        ("async def r(s):\n    await _helper(s)\n", False),
    ],
    ids=[
        "require-raises",
        "refusal-returned",
        "refusal-raised",
        "refusal-ignored",
        "refusal-bound-unused",
        "refusal-branch-falls-through",
        "helper-not-followed",
    ],
)
def test_the_gate_check_accepts_only_an_acted_on_refusal(source: str, *, admits: bool) -> None:
    """Non-vacuity for the rule: an ignored or unacted ``payer_refusal`` is no gate."""
    assert _admits_through_gate(ast.parse(source)) is admits


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
