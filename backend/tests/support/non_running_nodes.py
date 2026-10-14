"""Whether a pytest node actually runs, read from its markers rather than by running it (#3076).

:func:`tests.support.pytest_node_ids.node_state` answers whether a node id names
a real test and whether *its own* decorators mark it ``xfail``. A certificate
needs a stronger answer: a test that never asserts anything cannot support a
claim. A test is skipped or expected to fail in more places than its own
decorator list:

* its own ``@pytest.mark.skip``/``skipif``/``xfail``;
* a decorator on any enclosing ``Test*`` class;
* the module's ``pytestmark``.

:func:`run_state` wraps ``node_state`` without changing it (the claim coverage
manifest gate depends on its exact semantics) and reports any of those as
:attr:`NodeState.XFAIL`, the non-supporting state. It is deliberately
conservative: a marker anywhere in a decorator expression counts, including a
``skipif`` whose condition is false, and a ``pytest.param(..., marks=...)``
inside a parametrize. Refusing a test that might run is safe here; accepting
one that might not is the failure this module exists to prevent. Imperative
``pytest.skip()`` and ``pytest.xfail()`` calls inside a body remain invisible,
and the reviewer protocol (docs/qa/claim-certification.md) covers them.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Final

from privacy.claim_coverage import NodeState
from tests.support.pytest_node_ids import REPO_ROOT, node_state

#: Marks after which a test asserts nothing a certificate could rely on.
NON_RUNNING_MARKS: Final = frozenset({"xfail", "skip", "skipif"})
_MODULE_MARK: Final = "pytestmark"
_SEPARATOR: Final = "::"

_Definition = ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef


def _carries_mark(expression: ast.expr) -> bool:
    """Any ``*.xfail``, ``*.skip`` or ``*.skipif`` anywhere in ``expression``."""
    return any(
        isinstance(node, ast.Attribute) and node.attr in NON_RUNNING_MARKS
        for node in ast.walk(expression)
    )


def _module_marks(tree: ast.Module) -> list[ast.expr]:
    """The values assigned to a top-level ``pytestmark``."""
    return [
        statement.value
        for statement in tree.body
        if isinstance(statement, ast.Assign) and any(map(_is_module_mark, statement.targets))
    ]


def _is_module_mark(target: ast.expr) -> bool:
    return isinstance(target, ast.Name) and target.id == _MODULE_MARK


def _enclosing_decorators(tree: ast.Module, names: list[str]) -> list[ast.expr]:
    """Decorators of every class on the path to the test, and of the test itself."""
    decorators: list[ast.expr] = []
    body: list[ast.stmt] = tree.body
    for name in names:
        found = _definition(body, name)
        if found is None:
            break
        decorators.extend(found.decorator_list)
        body = found.body
    return decorators


def _definition(body: list[ast.stmt], name: str) -> _Definition | None:
    found = next((node for node in body if getattr(node, "name", None) == name), None)
    return found if isinstance(found, _Definition) else None


def _never_runs(node_id: str, root: Path) -> bool:
    file_part, *names = node_id.split(_SEPARATOR)
    path = root.joinpath(*file_part.split("/"))
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    leaf = [*names[:-1], names[-1].split("[", 1)[0]]
    expressions = _module_marks(tree) + _enclosing_decorators(tree, leaf)
    return any(_carries_mark(expression) for expression in expressions)


def run_state(node_id: str, root: Path = REPO_ROOT) -> NodeState:
    """``node_state``, except a test any marker keeps from running is ``XFAIL``."""
    state = node_state(node_id, root)
    if state is not NodeState.PRESENT:
        return state
    return NodeState.XFAIL if _never_runs(node_id, root) else NodeState.PRESENT
