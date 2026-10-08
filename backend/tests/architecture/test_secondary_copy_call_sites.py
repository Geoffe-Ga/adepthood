"""Secondary-copy mutations go through the obligation-keeping services only (#3060).

The defect this guards against was a router discarding the result of an essay
retraction (``await _retract_entry_voice_drafts(...)`` as a bare statement) and
answering 200 while the vault still held the copy. Two narrow AST checks keep it
from returning:

* the raw Creek mutations -- the Voice Draft PUT and DELETE and the journal
  withdrawal -- are called only from the services that record and settle the
  durable obligation for them, and
* nothing under ``src`` awaits a withdrawal helper as a bare expression
  statement, which is exactly how a confirmation gets thrown away.
"""

from __future__ import annotations

import ast
from pathlib import Path

_SRC = Path(__file__).resolve().parents[2] / "src"

#: Raw Creek mutations of a secondary copy.
_RAW_MUTATIONS = frozenset({"upsert_voice_draft", "delete_voice_draft", "withdraw_journal_entry"})

#: The only modules allowed to dial them: the two obligation services and the
#: transport adapter that implements them.
_ALLOWED_MODULES = frozenset(
    {
        "services/creek_vault_voice_drafts.py",
        "services/creek_vault_withdraw.py",
        "services/creek_vault_client.py",
    }
)

#: Helpers whose answer is "is the copy confirmed absent?"; never discardable.
_VERDICT_HELPERS = frozenset(
    {
        "retract_pending_voice_drafts",
        "retract_voice_draft",
        "retraction_failure",
        "withdraw_journal_copy",
        "withdraw_journal_from_vault",
        "_withdraw_remote_copies",
    }
)


#: The one module allowed to drop a verdict: the background sweep in the
#: obligation service, where the answer is already durable in the rows it
#: settled and there is no caller to report it to.
_SETTLES_ITS_OWN_ROWS = "services/creek_vault_voice_drafts.py"


def _called_name(call: ast.Call) -> str | None:
    function = call.func
    if isinstance(function, ast.Attribute):
        return function.attr
    if isinstance(function, ast.Name):
        return function.id
    return None


def _modules() -> list[tuple[str, ast.Module]]:
    return [
        (path.relative_to(_SRC).as_posix(), ast.parse(path.read_text(), filename=str(path)))
        for path in sorted(_SRC.rglob("*.py"))
    ]


def test_raw_secondary_copy_mutations_stay_inside_the_obligation_services() -> None:
    """A new call site for a raw PUT/DELETE/withdraw must go through a service instead."""
    offenders = [
        f"{module}:{node.lineno} {_called_name(node)}"
        for module, tree in _modules()
        if module not in _ALLOWED_MODULES
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and _called_name(node) in _RAW_MUTATIONS
    ]
    assert offenders == []


def test_no_withdrawal_verdict_is_discarded() -> None:
    """``await helper(...)`` as a bare statement throws away whether the copy is gone."""
    offenders = [
        f"{module}:{node.lineno} {_called_name(node.value.value)}"
        for module, tree in _modules()
        if module != _SETTLES_ITS_OWN_ROWS
        for node in ast.walk(tree)
        if isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Await)
        and isinstance(node.value.value, ast.Call)
        and _called_name(node.value.value) in _VERDICT_HELPERS
    ]
    assert offenders == []


def test_the_guard_sees_the_known_call_sites() -> None:
    """Non-vacuity: each raw mutation is found where it is actually dialled today."""
    found = {
        (module, _called_name(node))
        for module, tree in _modules()
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and _called_name(node) in _RAW_MUTATIONS
    }
    assert ("services/creek_vault_voice_drafts.py", "upsert_voice_draft") in found
    assert ("services/creek_vault_voice_drafts.py", "delete_voice_draft") in found
    assert ("services/creek_vault_withdraw.py", "withdraw_journal_entry") in found
