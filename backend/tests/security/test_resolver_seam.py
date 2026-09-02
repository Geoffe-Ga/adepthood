"""One way in, for the only vault question that touches the network.

The verdict a user's vault host earns is asked from two places in this
application, and both of them ask it with a database transaction already open. A
``Session`` autobegins on its first ``execute`` and holds the connection it
checked out there across every later ``await``, so a name lookup issued under an
open transaction rents one of fifteen pooled connections for as long as a
resolver takes to answer -- and the sixteenth request to *any* database-backed
endpoint blocks on checkout.

The remedy is one line per caller, which is exactly the shape of remedy that gets
left out of the next caller. This repository has already written that line twice,
inline and in prose, and then written a third caller without it. So the rule is
enforced structurally instead: the classifier that resolves under whatever
transaction it inherits is reached only from the module that owns it, and every
other module asks through the seam that frees the connection first.

**What this proves, and what it does not.** It proves *routing*: nothing outside
the owning module calls the unguarded classifier. It does not prove *release* --
an author could call the seam and then run another query before the network
await, and this file would stay green. That is why the endpoint-level
``in_transaction`` assertions in ``test_ssrf_vault_url.py`` exist beside it. The
two guards catch different mistakes: this one catches a new caller, those catch a
reordering inside an existing one.

Parsed rather than grepped, deliberately. Searching ``src`` for the classifier's
name finds five lines and only two of them are calls -- two are imports, and one
is the name written inside a docstring. A guard built on text would need to be
taught to ignore those, and a guard with an exception list grows one more
exception every time it fails.
"""

from __future__ import annotations

import ast
from pathlib import Path

# The classifier that resolves under whatever transaction it inherits. Correct
# to call, and only from the module that defines the seam wrapping it.
_GUARDED_CALLEE = "classify_resolved_user_vault_url"

# The one module allowed to call it, relative to ``src`` -- the module that owns
# it, and therefore the module where a call cannot be the mistake this file is
# about.
_OWNING_MODULE = "services/creek_vault_url_resolution.py"

# How many modules the walk must read before its answer means anything. A walk
# pointed at the wrong directory finds no callers at all, which is
# indistinguishable from a clean tree; this floor is what tells the two apart. It
# sits far below the real count, so it fails on a broken path rather than on
# ordinary growth of the source tree.
_FEWEST_MODULES_WORTH_TRUSTING = 50

# Where ``src`` sits relative to this file: ``backend/tests/security/`` up three
# to ``backend/``, then down into the tree the guard walks.
_STEPS_UP_TO_BACKEND = 2


def _backend_source_root() -> Path:
    """Return the ``src`` tree this guard reads."""
    return Path(__file__).resolve().parents[_STEPS_UP_TO_BACKEND] / "src"


def _calls_the_guarded_classifier(node: ast.AST) -> bool:
    """Report whether ``node`` is a call to the unguarded classifier, however spelled.

    Both spellings count: the bare name a ``from ... import`` leaves behind, and
    the attribute a module-qualified import produces. Importing the module
    instead of the function is otherwise the obvious way past a guard like this,
    and it is not a meaningful difference to the connection being held.

    Matched on exact equality, so a longer name that merely begins with the
    guarded one -- the seam itself, for instance -- is not mistaken for it.
    """
    if not isinstance(node, ast.Call):
        return False
    callee = node.func
    if isinstance(callee, ast.Name):
        return callee.id == _GUARDED_CALLEE
    return isinstance(callee, ast.Attribute) and callee.attr == _GUARDED_CALLEE


def _modules_calling_the_guarded_classifier(root: Path) -> tuple[set[str], int]:
    """Return every module under ``root`` that calls the classifier, and how many were read.

    The count comes back beside the answer so the caller can tell an empty
    result that means "nobody does this" from an empty result that means "this
    walk read nothing".
    """
    callers: set[str] = set()
    modules_read = 0
    for module in sorted(root.rglob("*.py")):
        modules_read += 1
        tree = ast.parse(module.read_text(encoding="utf-8"))
        if any(_calls_the_guarded_classifier(node) for node in ast.walk(tree)):
            callers.add(module.relative_to(root).as_posix())
    return callers, modules_read


def test_the_resolver_verdict_is_only_asked_through_the_seam_that_frees_the_connection() -> None:
    """No module but the resolver's own may ask a question that costs a DNS round trip.

    Both current callers -- the write path in ``routers/vault_config.py`` and the
    per-request dial-time dependency in ``dependencies/creek_vault.py`` -- reach
    this lookup holding a transaction somebody else opened for them, one in a
    dependency the handler never mentions and one on the line above. Neither
    author had to do anything wrong to get there, which is the reason a rule
    written down in three docstrings has not been enough.

    The failure message names the offending module, because the useful half of
    this assertion is *which* file acquired the call rather than that some file
    did.
    """
    root = _backend_source_root()

    callers, modules_read = _modules_calling_the_guarded_classifier(root)

    assert modules_read >= _FEWEST_MODULES_WORTH_TRUSTING, (
        f"walked only {modules_read} modules under {root}; this guard read nothing"
    )
    assert callers == {_OWNING_MODULE}
