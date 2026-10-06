"""The app-provider adapter is constructed in one place, so the vault boundary cannot be skipped.

Behavioural tests prove each route honours the boundary today; this proves the
next route does too, structurally. Every ``BotmasonResonanceLLM(...)`` in
``backend/src`` must sit inside
:func:`services.reflection_boundary.app_provider_llm`, which consults the
boundary, or be on the allowlist below with the issue that owns its own
boundary decision. A new call site anywhere else fails here before it can dial
the app provider for a vault-bound writer (#3061).

Also pinned: neither vault-reflection entry point accepts another source, so a
vault-then-app-provider composite cannot be built by passing one in.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

from services.creek_vault_reflect import VaultResonanceLLM, select_reflection_llm

_SRC = Path(__file__).resolve().parents[2] / "src"
_ADAPTER = "BotmasonResonanceLLM"
_CHOKEPOINT = ("services/reflection_boundary.py", "app_provider_llm")

# Call sites that construct the adapter outside the chokepoint, each with the
# issue that owns its boundary decision. Shrink this; never grow it without one.
_ALLOWLIST: dict[tuple[str, str], str] = {
    ("routers/journal.py", "_cache_essay"): "#3061 S2: essay expansion boundary",
}


def _construction_sites() -> set[tuple[str, str]]:
    """Every (module path, enclosing function) that calls the adapter's constructor."""
    sites: set[tuple[str, str]] = set()
    for path in sorted(_SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        relative = path.relative_to(_SRC).as_posix()
        for function in ast.walk(tree):
            if not isinstance(function, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            for node in ast.walk(function):
                if isinstance(node, ast.Call) and _names_adapter(node.func):
                    sites.add((relative, function.name))
        sites.update((relative, "<module>") for node in tree.body if _calls_adapter(node))
    return sites


def _names_adapter(func: ast.expr) -> bool:
    """Whether a call's target is the adapter, by bare name or attribute."""
    if isinstance(func, ast.Name):
        return func.id == _ADAPTER
    return isinstance(func, ast.Attribute) and func.attr == _ADAPTER


def _calls_adapter(statement: ast.stmt) -> bool:
    """Whether a module-level (non-function) statement constructs the adapter."""
    if isinstance(statement, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
        return False
    return any(
        isinstance(node, ast.Call) and _names_adapter(node.func) for node in ast.walk(statement)
    )


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


def test_no_vault_reflection_entry_point_accepts_another_source() -> None:
    """No ``fallback`` parameter anywhere a vault reflection is bound."""
    assert "fallback" not in inspect.signature(VaultResonanceLLM.__init__).parameters
    assert "fallback" not in inspect.signature(select_reflection_llm).parameters
