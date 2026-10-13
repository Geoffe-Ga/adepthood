"""Resolve a pytest node id against the test tree by reading it, never by running it (#3158).

The claim coverage manifest (:mod:`privacy.claim_coverage`) names the tests
behind each privacy claim as node ids relative to the repository root --
``backend/tests/security/test_x.py::test_y``, ``...::TestGroup::test_y`` or a
parametrised ``...::test_y[case]``. This module answers whether each one names
a real test, and whether that test is marked ``xfail``, by parsing the file
with :mod:`ast`. Collection would import every module the manifest cites (and
the app with them); parsing keeps the gate structural and fast.
"""

from __future__ import annotations

import ast
from functools import cache
from pathlib import Path, PurePosixPath
from typing import Final

from privacy.claim_coverage import NodeState

REPO_ROOT: Final = Path(__file__).resolve().parents[3]

_SEPARATOR: Final = "::"
_TEST_PREFIX: Final = "test"
_CLASS_PREFIX: Final = "Test"
_MAX_PARTS: Final = 3
_XFAIL: Final = "xfail"

_Function = ast.FunctionDef | ast.AsyncFunctionDef


@cache
def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _test_file(root: Path, relative: str) -> Path | None:
    """The file a node id's first part names, if it is a test module inside ``root``."""
    pure = PurePosixPath(relative)
    if pure.is_absolute() or ".." in pure.parts or pure.suffix != ".py":
        return None
    path = root.joinpath(*pure.parts)
    return path if path.is_file() else None


def _child(body: list[ast.stmt], name: str) -> ast.stmt | None:
    return next((node for node in body if getattr(node, "name", None) == name), None)


def _is_xfail(decorator: ast.expr) -> bool:
    """``@pytest.mark.xfail`` or ``@pytest.mark.xfail(...)``."""
    target = decorator.func if isinstance(decorator, ast.Call) else decorator
    return isinstance(target, ast.Attribute) and target.attr == _XFAIL


def _function(tree: ast.Module, names: list[str]) -> _Function | None:
    """The test function ``names`` reaches: ``[func]`` or ``[TestClass, method]``."""
    *classes, leaf = names
    body = tree.body
    for name in classes:
        owner = _child(body, name)
        if not isinstance(owner, ast.ClassDef) or not name.startswith(_CLASS_PREFIX):
            return None
        body = owner.body
    found = _child(body, leaf.split("[", 1)[0])
    if isinstance(found, _Function) and found.name.startswith(_TEST_PREFIX):
        return found
    return None


def node_state(node_id: str, root: Path = REPO_ROOT) -> NodeState:
    """Whether ``node_id`` names a test under ``root``, and whether it is an xfail."""
    parts = node_id.split(_SEPARATOR)
    if not 1 < len(parts) <= _MAX_PARTS:
        return NodeState.MISSING
    path = _test_file(root, parts[0])
    found = None if path is None else _function(_parse(path), parts[1:])
    if found is None:
        return NodeState.MISSING
    if any(_is_xfail(decorator) for decorator in found.decorator_list):
        return NodeState.XFAIL
    return NodeState.PRESENT
