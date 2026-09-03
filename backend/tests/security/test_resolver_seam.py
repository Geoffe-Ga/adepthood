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

And resolved rather than parsed-and-compared. Reading the syntax is not enough on
its own: this guard first matched the name written at the call site, which
``from ... import classify_resolved_user_vault_url as _judge`` walks straight
past, because the offending module never writes the guarded name near the call.
The callee is now resolved through the importing module's own binding table --
the one the pool-hold analysis builds for every module in the tree -- so an alias
and the original reduce to one qualified target, which is what they are.
"""

from __future__ import annotations

import ast
from pathlib import Path

from tests.architecture.pool_hold import SourceTree

# The classifier that resolves under whatever transaction it inherits. Correct
# to call, and only from the module that defines the seam wrapping it. Named by
# where it lives rather than by how it is written, because how it is written at
# the call site is precisely what a caller controls.
_GUARDED_MODULE = "services.creek_vault_url_resolution"
_GUARDED_CALLEE = "classify_resolved_user_vault_url"
_GUARDED_TARGET = f"{_GUARDED_MODULE}.{_GUARDED_CALLEE}"

# The one module allowed to call it, relative to ``src`` -- the module that owns
# it, and therefore the module where a call cannot be the mistake this file is
# about.
_OWNING_MODULE = "services/creek_vault_url_resolution.py"

# How many modules the walk must read before its answer means anything. A walk
# pointed at the wrong directory finds no callers at all, which is
# indistinguishable from a clean tree; this floor is what tells the two apart.
# Measured: 242 modules under ``src``. The floor sits just under that, because a
# floor set far below the real count -- this one was 50 -- would keep passing
# after a path change that dropped four fifths of the tree, which is the failure
# it exists to catch.
_FEWEST_MODULES_WORTH_TRUSTING = 230

# Where ``src`` sits relative to this file: ``backend/tests/security/`` up three
# to ``backend/``, then down into the tree the guard walks.
_STEPS_UP_TO_BACKEND = 2


def _backend_source_root() -> Path:
    """Return the ``src`` tree this guard reads."""
    return Path(__file__).resolve().parents[_STEPS_UP_TO_BACKEND] / "src"


def _is_the_guarded_call(node: ast.AST, module: str, tree: SourceTree) -> bool:
    """Report whether ``node`` calls the unguarded classifier, however it is written.

    The union of two rules, because each catches what the other misses.
    Resolving the callee through the module's imports catches every renaming --
    ``import ... as``, a module-qualified attribute, a bare name -- which a match
    on the written spelling walks past. But resolution answers nothing when the
    receiver is a parameter or an attribute this walk does not type, and
    ``dep.classify_resolved_user_vault_url(host)`` is exactly that shape; there
    the written name is the only evidence there is, and it is enough, because no
    other function in this tree carries the name.

    Exact equality on the final attribute, so the seam that wraps this
    classifier -- whose name begins with it -- is not mistaken for the thing it
    exists to protect callers from.
    """
    if not isinstance(node, ast.Call):
        return False
    if tree.qualify(node.func, module) == _GUARDED_TARGET:
        return True
    callee = node.func
    return isinstance(callee, ast.Attribute) and callee.attr == _GUARDED_CALLEE


def _modules_calling_the_guarded_classifier(root: Path) -> tuple[set[str], int]:
    """Return every module under ``root`` that calls the classifier, and how many were read.

    Resolution, not spelling. Each module's own imports say what the name at a
    call site refers to, so ``from ... import x as y`` and a module-qualified
    ``m.x`` and a bare ``x`` all reduce to one qualified target -- which is the
    leak the previous exact-equality matcher had, proven by running it against an
    aliased call and watching it report nothing.

    The count comes back beside the answer so the caller can tell an empty
    result that means "nobody does this" from an empty result that means "this
    walk read nothing".
    """
    tree = SourceTree(root)
    callers = {
        module
        for module, parsed in tree.modules.items()
        if any(_is_the_guarded_call(node, module, tree) for node in ast.walk(parsed))
    }
    named = {tree.paths[module].relative_to(root).as_posix() for module in callers}
    return named, tree.modules_read


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


def test_a_call_reached_through_an_aliased_import_does_not_walk_past_this_guard(
    tmp_path: Path,
) -> None:
    """Renaming the classifier on the way in must not exempt the module that renamed it.

    A guard that compares the name written at the call site is defeated by
    ``import ... as``, and defeated silently: the caller never spells the guarded
    name anywhere, so the walk reports a clean tree. The remedy is to resolve the
    callee through the importing module's own binding table, which makes the
    alias and the original one name, because they are one function.

    Asserted against a fixture tree rather than against ``src``, because the case
    this covers is the one that is *not* in ``src`` -- and would be invisible if
    it were.
    """
    module = tmp_path / "sneaky.py"
    module.write_text(
        "from services.creek_vault_url_resolution import (\n"
        f"    {_GUARDED_CALLEE} as _judge,\n"
        ")\n"
        "\n"
        "\n"
        "async def ask(host: str) -> object:\n"
        "    return await _judge(host)\n",
        encoding="utf-8",
    )

    callers, modules_read = _modules_calling_the_guarded_classifier(tmp_path)

    assert modules_read == 1
    assert callers == {"sneaky.py"}


def test_an_attribute_call_on_a_receiver_the_walk_cannot_name_is_still_caught(
    tmp_path: Path,
) -> None:
    """Resolving the callee must not lose the spellings a plain name match caught.

    Swapping an exact-name matcher for a resolving one closes ``import ... as``
    and opens something else: ``await dep.classify_resolved_user_vault_url(h)``
    resolves to nothing, because the receiver is a parameter whose type this walk
    does not track. The old matcher caught it by name. So the rule is the union
    of the two -- resolve the callee, and fall back to the written name when the
    receiver cannot be resolved -- rather than a trade of one hole for another.
    """
    module = tmp_path / "indirect.py"
    module.write_text(
        "async def ask(dep: object, host: str) -> object:\n"
        f"    return await dep.{_GUARDED_CALLEE}(host)\n",
        encoding="utf-8",
    )

    callers, modules_read = _modules_calling_the_guarded_classifier(tmp_path)

    assert modules_read == 1
    assert callers == {"indirect.py"}


def test_a_longer_name_that_merely_starts_with_the_guarded_one_is_not_it(
    tmp_path: Path,
) -> None:
    """The seam itself ends in the guarded name's prefix and must not be mistaken for it.

    The fallback matches a written name, so it has to match the whole of it: the
    wrapper this guard exists to funnel callers *through* is spelled
    ``classify_resolved_user_vault_url_off_the_pool``, and flagging every module
    that calls the safe seam would invert the rule.
    """
    module = tmp_path / "polite.py"
    module.write_text(
        "async def ask(dep: object, host: str) -> object:\n"
        f"    return await dep.{_GUARDED_CALLEE}_off_the_pool(host)\n",
        encoding="utf-8",
    )

    callers, _modules_read = _modules_calling_the_guarded_classifier(tmp_path)

    assert callers == set()
