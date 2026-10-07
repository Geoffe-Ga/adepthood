"""Find inline privacy-tier comparisons in source, so one egress predicate stays the only one.

Every model, index and vault sink decides whether a journal tier may leave the
primary boundary through :mod:`domain.privacy_tier` (#3059). The comparisons
that predicate replaced were *deny-lists* -- ``== JournalClassification.INTIMATE``
-- and two of them were *identity* checks a plain ``str`` ``"intimate"`` walked
straight past. A deny-list fails open on any tier it does not name, so the
property worth locking is not "these twelve sites were migrated" but "no new
deny-list can appear". :func:`find_inline_tier_comparisons` is that lock.

What it flags
=============

A :class:`ast.Compare` (``==``, ``!=``, ``is``, ``is not``, ``in``, ``not in``)
-- or a SQL column operator call (``.in_``, ``.not_in``, ``.notin_``, ``.is_``,
``.is_not``, ``.isnot``) -- with any operand that names the denied tier:

* any ``<base>.INTIMATE`` attribute -- bare, qualified or aliased -- except on
  a vault-ceiling enum;
* the string constant ``"intimate"`` in any case;
* the name or attribute ``EXCLUDED_TIER`` or ``DENIED_TIERS``;
* a call whose argument is one of these (``JournalClassification("intimate")``);
* a set, tuple or list literal containing any of the above.

What it deliberately does not flag
==================================

* An assignment (``EXCLUDED_TIER = JournalClassification.INTIMATE``) or a dict
  key (``{"intimate": ...}``): neither decides anything.
* ``VaultTierCeiling.INTIMATE`` / ``WireTierCeiling.*``: Creek's ceiling
  vocabulary, checked *after* the egress predicate as a second gate on the
  resolved tier.

B15's privacy regression suite reuses this scanner; keep it free of test-only
assumptions about which files exist.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path
from typing import TypeGuard

#: The tier spelled as a literal. Compared case-insensitively, because the
#: point is that *any* spelling of a deny-list is a deny-list.
DENIED_TIER_LITERAL = "intimate"

#: Names whose mention in a comparison is a deny-list on the Intimate tier --
#: the corpus model's ``EXCLUDED_TIER`` and the policy module's own
#: ``DENIED_TIERS``, which is for drift tests and must never become a sink's
#: deny-list.
_DENIED_TIER_NAMES = frozenset({"EXCLUDED_TIER", "DENIED_TIERS"})

#: Enums whose ``INTIMATE`` member is a *vault ceiling*, not a journal tier.
#: Comparing against one is the second gate after the egress predicate, so it is
#: the one ``.INTIMATE`` attribute that is not a deny-list.
_CEILING_ENUMS = frozenset({"VaultTierCeiling", "WireTierCeiling"})

#: SQL column operators that are comparisons in all but syntax.
_SQL_COMPARISON_METHODS = frozenset({"in_", "not_in", "notin_", "is_", "is_not", "isnot"})

_COMPARISON_OPERATORS = (ast.Eq, ast.NotEq, ast.Is, ast.IsNot, ast.In, ast.NotIn)


@dataclass(frozen=True, slots=True)
class InlineTierComparison:
    """One deny-list site: where it is, rendered as ``path:line`` for a failure message."""

    path: str
    line: int

    def __str__(self) -> str:
        """Render as ``path:line``."""
        return f"{self.path}:{self.line}"


def _base_name(node: ast.expr) -> str | None:
    """The last dotted segment ``node`` names: ``JC`` for ``JC``, ``Enum`` for ``a.b.Enum``."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _names_denied_tier(node: ast.expr) -> bool:
    """Whether ``node`` is, constructs, or is a literal collection containing, the Intimate tier.

    Any ``<base>.INTIMATE`` counts unless ``<base>`` is a vault-ceiling enum, so
    a qualified (``models.journal_entry.JournalClassification.INTIMATE``) or
    aliased (``JC.INTIMATE``) spelling is caught as well as the bare one. A call
    whose argument names the tier (``JournalClassification("intimate")``) is the
    tier too.
    """
    if isinstance(node, ast.Constant):
        return isinstance(node.value, str) and node.value.lower() == DENIED_TIER_LITERAL
    if isinstance(node, ast.Name):
        return node.id in _DENIED_TIER_NAMES
    if isinstance(node, ast.Attribute):
        return node.attr in _DENIED_TIER_NAMES or (
            node.attr == "INTIMATE" and _base_name(node.value) not in _CEILING_ENUMS
        )
    return any(_names_denied_tier(child) for child in _operands_within(node))


def _operands_within(node: ast.expr) -> list[ast.expr]:
    """A call's positional arguments or a literal collection's elements; nothing otherwise."""
    if isinstance(node, ast.Call):
        return list(node.args)
    if isinstance(node, ast.Set | ast.Tuple | ast.List):
        return list(node.elts)
    return []


def _is_tier_comparison(node: ast.AST) -> TypeGuard[ast.Compare | ast.Call]:
    """Whether ``node`` compares something against the Intimate tier."""
    if isinstance(node, ast.Compare):
        if not all(isinstance(op, _COMPARISON_OPERATORS) for op in node.ops):
            return False
        return any(_names_denied_tier(operand) for operand in (node.left, *node.comparators))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        if node.func.attr not in _SQL_COMPARISON_METHODS:
            return False
        return any(_names_denied_tier(argument) for argument in node.args)
    return False


def inline_tier_comparisons_in_source(source: str, path: str) -> list[InlineTierComparison]:
    """Every deny-list comparison in one module's ``source``, labelled with ``path``."""
    tree = ast.parse(source, filename=path)
    return [
        InlineTierComparison(path=path, line=node.lineno)
        for node in ast.walk(tree)
        if _is_tier_comparison(node)
    ]


def find_inline_tier_comparisons(
    src_root: Path, *, exempt: frozenset[str]
) -> list[InlineTierComparison]:
    """Every deny-list comparison under ``src_root``, skipping the ``exempt`` relative paths.

    Paths are reported relative to ``src_root`` with forward slashes, sorted, so
    a failure message is stable across machines.
    """
    hits: list[InlineTierComparison] = []
    for module in sorted(src_root.rglob("*.py")):
        relative = module.relative_to(src_root).as_posix()
        if relative in exempt:
            continue
        hits.extend(inline_tier_comparisons_in_source(module.read_text(encoding="utf-8"), relative))
    return hits
