"""The gate: every connection held across an outbound call is one the census names.

Report-only, in the only sense of the phrase that survives contact with a
repository. Not "print a list and pass" -- a printed list is read once, by its
author. This asserts set equality against the written census, which makes it
green at HEAD on the day it lands, red the moment a route reaches a new outbound
call with its connection held, and red again when a site is fixed and its row is
left standing. There is no mode to switch. Enforcement is simply the state in
which every remaining row is ``ALLOWED``, and the assertion that gets there is
the one already written: rows leave by being fixed.

Every assertion here guards its own observation before it makes it. A walk
pointed at the wrong directory reads nothing, finds nothing, and agrees with an
empty census -- so the floors come first, derived from what the tree actually
measures rather than set low enough to never complain.
"""

from __future__ import annotations

import ast
from collections.abc import Iterable
from functools import cache
from pathlib import Path

from main import app
from tests.architecture.pool_hold import (
    DIAL_METHODS,
    TRANSPORT_LIBRARIES,
    PoolHoldAnalysis,
    analyse_tree,
    backend_source_root,
)
from tests.architecture.pool_hold_census import (
    CLEAR,
    DEAD_MODULES,
    HELD,
    Verdict,
    evidence_problems,
    expected_findings,
)

# Measured against this tree: 242 modules, 1535 functions, 130 routes. The
# floors sit just under each, so a path change that dropped a directory fails
# here rather than reading as a clean tree, while ordinary pruning does not.
# Setting them far below the real count -- the mistake this replaces used a
# floor of 50 against 242 -- means a walk can lose most of the source and still
# pass.
_FEWEST_MODULES_WORTH_TRUSTING = 230
_FEWEST_FUNCTIONS_WORTH_TRUSTING = 1450
_FEWEST_ROUTES_WORTH_TRUSTING = 120

# Every module that imports a library capable of opening a socket. Named for
# what it measures rather than for what it is about: importing is checkable and
# reaching the network is not, and the two are not the same set. ``routers.auth``
# is here because it imports ``jwt`` to encode and decode tokens locally, and it
# never fetches anything; the three OIDC modules below are here because they
# reach a provider through the same library. Overstating the name is how the set
# came to be asserted complete while three modules that genuinely dial were
# missing from it.
#
# Frozen so a new import arrives as a question -- is this a transport the
# analysis must model? -- rather than as silence.
_MODULES_IMPORTING_A_TRANSPORT = frozenset(
    {
        "domain.entitlements",
        "integrations.gumroad",
        "services.botmason",
        "services.creek_vault_client",
        "services.creek_vault_pinned_transport",
        "services.creek_vault_url_resolution",
        "services.email",
        # These three reach a provider through PyJWKClient rather than through an
        # obvious HTTP client, so they read as local signature checks. They were
        # missing while this set was asserted to name every module that reaches
        # the network -- an assertion that was simply false.
        "services.oauth_apple",
        "services.oauth_google",
        "services.oidc",
        # Encodes and decodes tokens with the same library; never fetches.
        "routers.auth",
    }
)

# Methods declared on a watched protocol that do not dial: both read cached
# handshake state and neither takes a coroutine. Listed so that a verb added to
# one of those protocols later belongs to exactly one of two sets, and adding it
# to neither is a red test asking which.
_PROTOCOL_METHODS_THAT_DO_NOT_DIAL = frozenset({"is_available", "supports"})

_WATCHED_PROTOCOLS = frozenset(DIAL_METHODS.values())

# Every class in the tree that implements a watched protocol. Frozen because the
# analysis treats a dial verb as a dial on *any* receiver -- it cannot name the
# injected client from the call site -- and that is only sound while each verb
# belongs to one family. A new class defining ``complete`` or ``handshake`` fails
# here, asking whether it is a member or a collision.
_CLASSES_IMPLEMENTING = {
    "domain.creek_vault.CreekVaultClient": frozenset(
        {
            "domain.creek_vault.CreekVaultClient",
            "services.creek_vault_client.HttpCreekVaultClient",
            "services.creek_vault_client.LocalFallbackCreekVaultClient",
        }
    ),
    "services.email.EmailSender": frozenset(
        {
            "services.email.ConsoleEmailSender",
            "services.email.EmailSender",
            "services.email.RecordingEmailSender",
            "services.email.ResendEmailSender",
            "services.email.SmtpEmailSender",
        }
    ),
    "domain.resonance.ResonanceLLM": frozenset(
        {
            "domain.resonance.ResonanceLLM",
            "services.creek_vault_reflect.VaultResonanceLLM",
            "services.marginalia.BotmasonResonanceLLM",
        }
    ),
}

# How the census divides today. Written down so that reclassifying a row --
# calling a defect deliberate, or calling the analyser wrong -- is a number that
# changes in the diff rather than a word that changes inside a paragraph.
_ROWS_BY_VERDICT = {Verdict.KNOWN: 9, Verdict.ALLOWED: 1, Verdict.MISMODELLED: 0}

# Mapping writes that reach the storage without calling ``__setitem__`` in
# CPython, and so slip a dependency override past the runtime observer's hook.
# ``pop`` and ``clear`` are absent deliberately: they remove providers rather
# than install unwrapped ones.
_MAPPING_WRITES_THAT_SKIP_SETITEM = frozenset({"update", "setdefault"})

# The backend test tree, and how much of it the sweep above must read. Measured
# at 362 modules; the floor sits under that for the same reason every other floor
# in this file does.
_TEST_ROOT = Path(__file__).resolve().parents[1]
_FEWEST_TEST_MODULES_WORTH_TRUSTING = 340


@cache
def _analysis() -> PoolHoldAnalysis:
    """Return an analysis of the application's own source tree.

    Cached because the tree does not change while the file runs and every test
    below asks it something: reparsing 242 modules a dozen times would make this
    file the slowest thing in the suite for no answer it does not already have.
    """
    return analyse_tree(backend_source_root())


def _routes_the_application_serves() -> set[str]:
    """Return every route in the application's own schema, as ``VERB /path``."""
    return {
        f"{method.upper()} {path}"
        for path, operations in app.openapi()["paths"].items()
        for method in operations
    }


def _methods_declared_on(analysis: PoolHoldAnalysis, protocols: Iterable[str]) -> set[str]:
    """Return the method names declared on the named classes."""
    owners = set(protocols)
    return {
        qualified.rpartition(".")[2]
        for qualified in analysis.tree.functions
        if qualified.rpartition(".")[0] in owners
    }


def _modules_importing_a_transport(analysis: PoolHoldAnalysis) -> set[str]:
    """Return every module that imports a library able to open a socket."""
    found = set()
    for module, tree in analysis.tree.modules.items():
        for node in ast.walk(tree):
            if _imports_a_transport(node):
                found.add(module)
                break
    return found


def _imports_a_transport(node: ast.AST) -> bool:
    """Report whether one import statement brings in a transport library."""
    if isinstance(node, ast.Import):
        return any(alias.name.partition(".")[0] in TRANSPORT_LIBRARIES for alias in node.names)
    if isinstance(node, ast.ImportFrom) and node.module:
        return node.module.partition(".")[0] in TRANSPORT_LIBRARIES
    return False


def test_the_analyser_reads_the_whole_tree_before_it_says_anything() -> None:
    """A walk that read nothing agrees with any census, so measure it first.

    This is the assertion that makes every other one in the file mean something.
    An empty answer from a walk pointed at a directory that no longer exists is
    indistinguishable from a clean codebase, and the difference is exactly these
    three numbers.
    """
    analysis = _analysis()

    assert analysis.tree.modules_read >= _FEWEST_MODULES_WORTH_TRUSTING, (
        f"read only {analysis.tree.modules_read} modules under {backend_source_root()}"
    )
    assert analysis.tree.functions_read >= _FEWEST_FUNCTIONS_WORTH_TRUSTING, (
        f"indexed only {analysis.tree.functions_read} functions"
    )
    assert len(analysis.route_handlers()) >= _FEWEST_ROUTES_WORTH_TRUSTING, (
        f"found only {len(analysis.route_handlers())} routes"
    )


def test_every_route_the_application_serves_is_one_this_analysis_examined() -> None:
    """The population must be the application's, not a parallel one of the analyser's own.

    A census over 'the routes a decorator sweep happened to find' can be complete
    and still be about the wrong set. Comparing against the schema the
    application publishes is what turns the sweep's answer into a claim about the
    running service -- and it is what catches a router prefix read wrongly, which
    would otherwise show up only as census rows nobody could locate.
    """
    served = _routes_the_application_serves()
    examined = {entry.route for entry in _analysis().route_handlers()}

    assert served, "the application published no routes; this comparison proves nothing"
    assert examined == served


def test_the_census_accounts_for_every_connection_held_across_an_outbound_call() -> None:
    """Every route reaching a dial with its connection held is a row somebody wrote down.

    Red in two directions, and the second is the one that keeps this a census
    rather than a suppression file. A new site that no row names fails here. So
    does a row that names a site the analyser no longer finds -- which is what
    happens when somebody fixes a hold and leaves its paragraph behind, and it is
    the only mechanism that makes the list shrink.
    """
    found = _analysis().findings()

    assert found, "the analysis found no outbound call anywhere; it is measuring nothing"
    assert found == expected_findings()


def test_the_routes_the_census_calls_clear_hold_nothing_across_a_dial() -> None:
    """A census listing only failures cannot say whether an unlisted site was examined.

    So the clear rows are asserted rather than described. Four of them were fixed
    by changes that live in a shared helper rather than in the handler, which
    means a reader of the handler cannot tell they are safe -- and a reader of a
    prose list cannot tell whether the prose is still true.
    """
    analysis = _analysis()

    still_holding = {
        entry.route: [(site.holder, site.dial) for site in analysis.dials_held_open(entry.handler)]
        for entry in CLEAR
        if analysis.dials_held_open(entry.handler)
    }

    assert {(entry.route, entry.handler) for entry in CLEAR} <= {
        (entry.route, entry.handler) for entry in analysis.route_handlers()
    }, "a clear row names a route its handler does not serve, or a handler that has gone"
    assert not still_holding


def test_the_module_the_census_calls_dead_is_reached_by_no_route() -> None:
    """Dead code is carried as dead, not as an exemption.

    An exemption implies a site that runs. This one has no production caller and
    takes no session, so it could not hold a connection if it had one -- and
    saying so here is what stops it being quietly re-added to the live population
    if something ever imports it.
    """
    analysis = _analysis()

    reached = {
        module
        for module in DEAD_MODULES
        for entry in analysis.route_handlers()
        if any(
            site.holder.startswith(f"{module}.") for site in analysis.dials_held_open(entry.handler)
        )
    }

    assert DEAD_MODULES, "the census names no dead module; this check read nothing"
    assert analysis.route_handlers(), "no routes were examined, so nothing could have reached it"
    assert set(DEAD_MODULES) <= set(analysis.tree.modules), (
        "the census names a dead module that is no longer in the tree; strike the row"
    )
    assert not reached


def test_every_census_row_backs_its_verdict_with_the_evidence_it_claims() -> None:
    """An exemption is bought with a passing assertion, never with prose.

    The rule that matters is the last one the checker applies: a row calling the
    analyser wrong must name a runtime test at the same dial that carries no
    expected-failure marker. Anyone can write a paragraph explaining why a site
    is fine. Only a green test at the seam says so.
    """
    assert HELD, "there is nothing to check; the census is empty"
    assert evidence_problems() == []


def test_the_census_divides_as_it_says_it_does() -> None:
    """Reclassifying a row is a number in the diff, not a word inside a paragraph.

    The soft spot in any census is that silencing a site costs one line. It
    cannot be made impossible, but it can be made visible: moving a row from
    defect to deliberate changes a count here, in a place a reviewer reads,
    rather than only a word in prose they skim.
    """
    tally = {verdict: sum(row.verdict is verdict for row in HELD) for verdict in Verdict}

    assert tally == _ROWS_BY_VERDICT
    assert sum(tally.values()) == len(HELD)


def test_no_module_takes_up_a_transport_without_a_decision_about_it() -> None:
    """A new transport must arrive as a decision, because inference cannot find it.

    The dial model is a finite table. A module that imports a socket library the
    table does not cover can reach the network invisibly, and no amount of call
    graph fixes that. Freezing the set turns the invisible case into a red test
    naming the module and asking what it does with it.

    What this proves is narrow and worth stating: that no module has quietly
    picked up a library able to dial. It does not prove the members dial, nor
    that a member which dials is modelled -- ``services.oidc`` reaches its
    provider through a callable this analysis cannot follow, and is in the set
    all the same.
    """
    touching = _modules_importing_a_transport(_analysis())

    assert touching, "no module imports a transport library; this check read nothing"
    assert touching == _MODULES_IMPORTING_A_TRANSPORT


def test_no_verb_is_added_to_a_watched_protocol_without_a_decision_about_it() -> None:
    """A new protocol method is a dial or it is not, and it may not be neither.

    This is the largest structural gap the design admits: a method is not a dial
    until somebody adds it to the table, so a vault client that grew a
    ``charge()`` would simply not be seen. Requiring every method on a watched
    protocol to be in one of two named sets does not close the gap for a *new*
    protocol -- nothing static can -- but it does close it for the protocols
    already known to dial, which is where this repository actually grows verbs.
    """
    analysis = _analysis()

    declared = _methods_declared_on(analysis, _WATCHED_PROTOCOLS)
    undecided = declared - set(DIAL_METHODS) - _PROTOCOL_METHODS_THAT_DO_NOT_DIAL

    assert declared, "found no methods on the watched protocols; this check read nothing"
    assert not undecided, (
        f"{sorted(undecided)} added to a protocol the analysis watches: say whether each dials"
    )


def test_no_dial_verb_is_defined_outside_the_family_that_declares_it() -> None:
    """A dial name is matched on any receiver, so the name has to belong to one family.

    ``handshake`` is treated as an outbound call wherever it is called, because
    the receiver is usually an injected client the analysis cannot name from the
    call site. That is only sound while every ``handshake`` in the tree is a vault
    client's. A second, unrelated ``handshake`` would turn the table into a source
    of false positives -- and false positives are what get a static gate deleted,
    so the tree is asked rather than assumed.
    """
    analysis = _analysis()

    strangers = {
        verb: sorted(
            owner
            for owner in analysis.tree.methods_by_name.get(verb, set())
            if owner.rpartition(".")[0] not in _CLASSES_IMPLEMENTING[protocol]
        )
        for verb, protocol in DIAL_METHODS.items()
    }

    assert all(analysis.tree.methods_by_name.get(verb) for verb in DIAL_METHODS), (
        "a dial verb is declared nowhere in the tree; the table names something that left"
    )
    assert {verb: owners for verb, owners in strangers.items() if owners} == {}


def test_every_class_the_dial_table_expects_is_still_in_the_tree() -> None:
    """The frozen implementation lists have to name real classes, or they guard nothing.

    A list of classes that no longer exist admits every stranger by accident,
    because a subset check against a set of ghosts is satisfied by anything that
    is also a ghost.
    """
    analysis = _analysis()

    missing = {
        implementation
        for family in _CLASSES_IMPLEMENTING.values()
        for implementation in family
        if implementation not in analysis.tree.classes
    }

    assert _CLASSES_IMPLEMENTING, "the implementation table is empty"
    assert not missing


def test_no_test_installs_a_dependency_override_by_a_route_the_observer_cannot_see() -> None:
    """The runtime observer wraps overrides on their way in, and only one way in is hooked.

    Its instrumenting mapping intercepts item assignment. ``dict.update`` and
    ``dict.setdefault`` reach the underlying storage without going through it in
    CPython, so a provider installed by either arrives unwrapped -- and an
    unwrapped vault client or email sender records nothing at all, which reads
    exactly like a site that released its connection.

    No test does this today. Saying so here is what keeps it true, and this is
    the natural place: the observer cannot notice its own blind spot from inside,
    and a reading of the source can.
    """
    offenders = sorted(
        f"{path.relative_to(_TEST_ROOT)}:{line}"
        for path in sorted(_TEST_ROOT.rglob("*.py"))
        for line in _lines_bypassing_the_override_hook(path)
    )
    read = sum(1 for _ in _TEST_ROOT.rglob("*.py"))

    assert read >= _FEWEST_TEST_MODULES_WORTH_TRUSTING, f"read only {read} test modules"
    assert not offenders, (
        f"{offenders} install a dependency override without passing the observer's hook; "
        "assign the item instead"
    )


def _lines_bypassing_the_override_hook(path: Path) -> list[int]:
    """Return the lines in one module that mutate ``dependency_overrides`` unhooked."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return [
        node.lineno
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and _skips_setitem(node.func)
    ]


def _skips_setitem(callee: ast.expr) -> bool:
    """Report whether a callee writes to ``dependency_overrides`` without item assignment."""
    if not isinstance(callee, ast.Attribute):
        return False
    if callee.attr not in _MAPPING_WRITES_THAT_SKIP_SETITEM:
        return False
    return isinstance(callee.value, ast.Attribute) and callee.value.attr == "dependency_overrides"
