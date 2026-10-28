"""The app provider is reached only in boundary-gated places, so the vault cannot be skipped.

Behavioural tests prove each route honours the boundary today; this proves the
next route does too, structurally (#3061). Two rules, one per way of reaching
the provider:

* **The adapter.** Every ``BotmasonResonanceLLM(...)`` in ``backend/src`` sits
  inside :func:`services.reflection_boundary.app_provider_llm`, which consults
  the boundary. There is no allowlist: a construction anywhere else fails here
  before it can dial the app provider for a vault-bound writer.
* **The bare dial.** Every direct ``generate_response(...)`` call is either the
  adapter's own method -- reachable only through an adapter the rule above
  admits -- or sits in a function that first calls
  :func:`services.reflection_boundary.require_app_provider_boundary` with a
  boundary it was handed (never a hard-coded ``APP_PROVIDER``). And every call
  of the classifier, :func:`services.frequency_classification.classify_frequencies`,
  passes the caller's boundary the same way. Without this half the classifier
  was invisible to the guard: it never constructs the adapter.

Each rule's scanner is also run over deliberately violating source, so a
scanner that silently stopped seeing anything would fail here rather than pass.

Also pinned: neither vault-reflection entry point accepts another source, so a
vault-then-app-provider composite cannot be built by passing one in.
"""

from __future__ import annotations

import ast
import inspect
import textwrap
from pathlib import Path

from services.creek_vault_reflect import VaultResonanceLLM, select_reflection_llm
from services.frequency_classification import classify_frequencies

_SRC = Path(__file__).resolve().parents[2] / "src"
_ADAPTER = "BotmasonResonanceLLM"
_CHOKEPOINT = ("services/reflection_boundary.py", "app_provider_llm")

# Call sites that construct the adapter outside the chokepoint, each with the
# issue that owns its boundary decision. Empty since #3156 closed the essay
# path; keep it empty. A new entry needs an owning issue and a reason.
_ALLOWLIST: dict[tuple[str, str], str] = {}

_DIAL = "generate_response"
_GATE = "require_app_provider_boundary"
_CLASSIFIER = "classify_frequencies"
_BOUNDARY_KEYWORD = "boundary"
_FORGED_BOUNDARY = "APP_PROVIDER"
# The adapter's own dial: admitted because the adapter it belongs to is only
# ever built at the chokepoint, which the first rule pins.
_ADAPTER_DIAL = ("services/marginalia.py", "complete")


def _sources() -> list[tuple[str, str]]:
    """Every module under ``backend/src`` as (relative path, source text)."""
    return [
        (path.relative_to(_SRC).as_posix(), path.read_text(encoding="utf-8"))
        for path in sorted(_SRC.rglob("*.py"))
    ]


def _construction_sites() -> set[tuple[str, str]]:
    """Every (module path, enclosing function) that calls the adapter's constructor."""
    sites: set[tuple[str, str]] = set()
    for relative, source in _sources():
        tree = ast.parse(source)
        for function in ast.walk(tree):
            if not isinstance(function, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            for node in ast.walk(function):
                if isinstance(node, ast.Call) and _names(node.func, _ADAPTER):
                    sites.add((relative, function.name))
        sites.update((relative, "<module>") for node in tree.body if _calls_adapter(node))
    return sites


def _names(func: ast.expr, name: str) -> bool:
    """Whether a call's target is ``name``, by bare name or attribute."""
    if isinstance(func, ast.Name):
        return func.id == name
    return isinstance(func, ast.Attribute) and func.attr == name


def _calls_adapter(statement: ast.stmt) -> bool:
    """Whether a module-level (non-function) statement constructs the adapter."""
    if isinstance(statement, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
        return False
    return _calls(statement, _ADAPTER)


def _calls(node: ast.AST, name: str) -> bool:
    """Whether anything under ``node`` calls ``name``."""
    return any(isinstance(sub, ast.Call) and _names(sub.func, name) for sub in ast.walk(node))


def _calls_of(node: ast.AST, name: str) -> list[ast.Call]:
    """Every call of ``name`` under ``node``, in source order."""
    calls = [sub for sub in ast.walk(node) if isinstance(sub, ast.Call) and _names(sub.func, name)]
    return sorted(calls, key=lambda call: (call.lineno, call.col_offset))


def _is_forged(boundary: ast.expr) -> bool:
    """Whether a boundary argument is a hard-coded ``APP_PROVIDER`` rather than the caller's."""
    return isinstance(boundary, ast.Attribute) and boundary.attr == _FORGED_BOUNDARY


def _boundary_argument(call: ast.Call) -> ast.expr | None:
    """The boundary a call passes: its ``boundary=`` keyword, else its first positional."""
    for keyword in call.keywords:
        if keyword.arg == _BOUNDARY_KEYWORD:
            return keyword.value
    return call.args[0] if call.args else None


def _passes_the_callers_boundary(call: ast.Call, *, keyword_only: bool) -> bool:
    """Whether ``call`` hands on a boundary it was given rather than none or a forged one."""
    if keyword_only:
        boundary = next((kw.value for kw in call.keywords if kw.arg == _BOUNDARY_KEYWORD), None)
    else:
        boundary = _boundary_argument(call)
    return boundary is not None and not _is_forged(boundary)


def _gated_before(function: ast.AST, dial: ast.Call) -> bool:
    """Whether ``function`` calls the gate with a real boundary before ``dial``."""
    return any(
        (gate.lineno, gate.col_offset) < (dial.lineno, dial.col_offset)
        and _passes_the_callers_boundary(gate, keyword_only=False)
        for gate in _calls_of(function, _GATE)
    )


def _module_level(tree: ast.Module) -> list[ast.stmt]:
    """Statements outside any function or class: where a dial would have no gate at all."""
    return [
        node
        for node in tree.body
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef)
    ]


def _ungated_dials(sources: list[tuple[str, str]]) -> set[tuple[str, str]]:
    """Every (module, function) that dials the provider directly without the gate in front."""
    stray: set[tuple[str, str]] = set()
    for relative, source in sources:
        tree = ast.parse(source)
        for function in ast.walk(tree):
            if not isinstance(function, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            if (relative, function.name) == _ADAPTER_DIAL:
                continue
            for dial in _calls_of(function, _DIAL):
                if not _gated_before(function, dial):
                    stray.add((relative, function.name))
        stray.update((relative, "<module>") for node in _module_level(tree) if _calls(node, _DIAL))
    return stray


def _aliased_dials(sources: list[tuple[str, str]]) -> set[tuple[str, str]]:
    """Every import that renames the dial or the classifier, which would hide it from the scan."""
    renamed: set[tuple[str, str]] = set()
    for relative, source in sources:
        for node in ast.walk(ast.parse(source)):
            if not isinstance(node, ast.ImportFrom):
                continue
            for alias in node.names:
                if alias.name in {_DIAL, _CLASSIFIER} and alias.asname not in {None, alias.name}:
                    renamed.add((relative, alias.name))
    return renamed


def _unbounded_classifier_calls(sources: list[tuple[str, str]]) -> set[tuple[str, int]]:
    """Every classifier call that does not hand on the caller's own boundary."""
    stray: set[tuple[str, int]] = set()
    for relative, source in sources:
        for call in _calls_of(ast.parse(source), _CLASSIFIER):
            if not _passes_the_callers_boundary(call, keyword_only=True):
                stray.add((relative, call.lineno))
    return stray


def test_the_adapter_is_constructed_only_at_the_chokepoint_or_an_owned_exception() -> None:
    """Every construction site is the boundary-aware factory or an allowlisted, owned site."""
    sites = _construction_sites()

    assert _CHOKEPOINT in sites, "the chokepoint itself no longer constructs the adapter"
    stray = sites - {_CHOKEPOINT} - set(_ALLOWLIST)
    assert stray == set(), f"app-provider adapter constructed outside the boundary: {stray}"


def test_the_allowlist_names_only_live_sites_and_owners() -> None:
    """A stale or unexplained exception is as bad as a stray site: it hides the next one."""
    sites = _construction_sites()

    assert set(_ALLOWLIST) <= sites, f"stale allowlist entries: {set(_ALLOWLIST) - sites}"
    assert all(reason.strip() for reason in _ALLOWLIST.values())


def test_the_allowlist_is_empty() -> None:
    """Every AI operation now owns its boundary decision; none is excused (#3156)."""
    assert _ALLOWLIST == {}


def test_every_direct_dial_is_the_adapter_or_gated_by_the_boundary() -> None:
    """A bare ``generate_response`` with no boundary gate in front fails here (#3156)."""
    sources = _sources()

    assert _ungated_dials(sources) == set()
    assert _aliased_dials(sources) == set()
    dialling = {
        (relative, function.name)
        for relative, source in sources
        for function in ast.walk(ast.parse(source))
        if isinstance(function, ast.FunctionDef | ast.AsyncFunctionDef) and _calls(function, _DIAL)
    }
    assert _ADAPTER_DIAL in dialling, "the adapter no longer dials; re-point _ADAPTER_DIAL"


def test_every_classifier_call_hands_on_the_callers_boundary() -> None:
    """The classifier never runs without the boundary its caller resolved (#3156)."""
    assert _unbounded_classifier_calls(_sources()) == set()
    parameter = inspect.signature(classify_frequencies).parameters[_BOUNDARY_KEYWORD]
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert parameter.default is inspect.Parameter.empty, "a default boundary is a silent fallback"


# --- the scanners must see a violation when there is one --------------------

_UNGATED = textwrap.dedent(
    """
    async def leak(body, api_key):
        return await generate_response(body, [], system_prompt="", api_key=api_key)
    """
)
_GATED_AFTER_THE_DIAL = textwrap.dedent(
    """
    async def late(body, boundary):
        reply = await generate_response(body, [], system_prompt="", api_key=None)
        require_app_provider_boundary(boundary)
        return reply
    """
)
_FORGED_GATE = textwrap.dedent(
    """
    async def forged(body):
        require_app_provider_boundary(ReflectionBoundary.APP_PROVIDER)
        return await botmason.generate_response(body, [], system_prompt="", api_key=None)
    """
)
_MODULE_LEVEL = "REPLY = asyncio.run(generate_response('x', [], system_prompt='', api_key=None))\n"
_GATED = textwrap.dedent(
    """
    async def honest(body, boundary):
        require_app_provider_boundary(boundary)
        return await generate_response(body, [], system_prompt="", api_key=None)
    """
)
_ALIASED = "from services.botmason import generate_response as ask\n"
_CLASSIFIER_CALLS = textwrap.dedent(
    """
    async def callers(body, boundary):
        await classify_frequencies(body, classification="personal")
        await classify_frequencies(
            body, classification="personal", boundary=ReflectionBoundary.APP_PROVIDER
        )
        await classify_frequencies(body, classification="personal", boundary=boundary)
    """
)


def test_the_dial_scanner_flags_every_violating_fixture() -> None:
    """Ungated, gated too late, forged and module-level dials are all caught; a gated one is not."""
    flagged = _ungated_dials(
        [
            ("fixture/ungated.py", _UNGATED),
            ("fixture/late.py", _GATED_AFTER_THE_DIAL),
            ("fixture/forged.py", _FORGED_GATE),
            ("fixture/module.py", _MODULE_LEVEL),
            ("fixture/honest.py", _GATED),
        ]
    )

    assert flagged == {
        ("fixture/ungated.py", "leak"),
        ("fixture/late.py", "late"),
        ("fixture/forged.py", "forged"),
        ("fixture/module.py", "<module>"),
    }
    assert _aliased_dials([("fixture/alias.py", _ALIASED)]) == {
        ("fixture/alias.py", "generate_response")
    }


def test_the_classifier_scanner_flags_a_missing_or_forged_boundary() -> None:
    """A classifier call with no boundary or a hard-coded one is caught; a handed-on one is not."""
    flagged = _unbounded_classifier_calls([("fixture/classify.py", _CLASSIFIER_CALLS)])

    assert {line for _, line in flagged} == {3, 4}


def test_no_vault_reflection_entry_point_accepts_another_source() -> None:
    """No ``fallback`` parameter anywhere a vault reflection is bound."""
    assert "fallback" not in inspect.signature(VaultResonanceLLM.__init__).parameters
    assert "fallback" not in inspect.signature(select_reflection_llm).parameters
