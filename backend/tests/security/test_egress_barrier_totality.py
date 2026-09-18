"""Every path that can transmit stored account content is classified, and checked.

What the first version of this gate did, and why it was not enough
=================================================================

It walked FastAPI's route table for
``dependencies.creek_vault.get_creek_vault_client`` and required each route it
found to be named in :data:`BARRIERED` or :data:`EXCLUSIONS`. Two things were
wrong with that, and they compounded:

* **It could only see vault egress.** ``POST /journal/{entry_id}/suggestions/detect``
  and ``POST /journal/marginalia/{marginalia_id}/essay`` hand this account's
  stored journal body to a cloud language model and resolve no vault client, so
  the walk never saw them -- while :data:`BARRIERED` named the essay route
  anyway. The gate asserted a *name*.
* **It measured membership, not behaviour.** A route listed in
  :data:`BARRIERED` passed whether or not it took the barrier. Four sites could
  be stripped simultaneously with the whole suite green.

Both are fixed here by deriving rather than declaring. The site list is the
union of two derivations that see different halves --
:func:`tests.support.egress_call_graph.egress_reaching_routes`, a call graph
that finds the model dials, and the route-table walk below, which finds the
routes that can resolve a vault client -- and every route named
:data:`BARRIERED` must then survive
:func:`~tests.support.egress_call_graph.unbarriered_egress_paths`, which reports
any path from that handler to a dial that no ``hold_account`` encloses.

The two derivations are kept side by side deliberately. Each is a lower bound of
a different kind, and the test that compares them is what would catch either one
quietly breaking.

What is still outside
=====================

A lexically present barrier is not proof that anything is ordered; that is what
the concurrency tests at the HTTP seam are for
(``tests/test_account_egress_barrier.py``,
``tests/test_account_egress_barrier_llm.py``,
``tests/integration/test_completion_detection_concurrency.py``). This file is
total and shallow; those are deep and drive one path each. Neither substitutes
for the other, which is why the mutation table in the PR body lists both columns.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi.routing import APIRoute
from starlette.routing import BaseRoute

from dependencies.creek_vault import get_creek_vault_client
from main import app
from tests.support.egress_call_graph import (
    INDIRECT_BARRIER_HOLDERS,
    Site,
    egress_reaching_routes,
    inverted_nesting_sites,
    takes_barrier_lexically,
    unbarriered_egress_paths,
)

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping, Sequence

    from fastapi import FastAPI
    from fastapi.dependencies.models import Dependant

_Route = tuple[str, str]

#: The detached ontologization ladder: an egress path that belongs to no route,
#: opens its own session, and dials after the request that scheduled it has
#: answered. Checked here with the routes because it is the same property.
CONTINUATION: Site = Site("services.creek_vault_pipeline", "_continue_ladder_body")

#: A floor under the derivation itself. If the call graph or the route walk ever
#: silently stops finding anything, every check below passes on an empty set --
#: the exact failure mode this gate exists to make impossible. The number is the
#: measured site count, and it is meant to be raised when a real site is added,
#: never lowered to make a run go green.
_MINIMUM_DERIVED_ROUTES = 9

#: Routes that hand this account's *stored* content outward -- to a vault, to a
#: language model, or to both -- and therefore take the per-account egress
#: barrier. Membership here is a claim that
#: :func:`unbarriered_egress_paths` checks; it is not the check.
BARRIERED: frozenset[_Route] = frozenset(
    {
        ("POST", "/journal/"),
        ("PATCH", "/journal/{entry_id}"),
        ("DELETE", "/journal/{entry_id}"),
        ("POST", "/journal/{entry_id}/resonance"),
        ("POST", "/journal/{entry_id}/suggestions/detect"),
        ("POST", "/journal/marginalia/{marginalia_id}/essay"),
        ("POST", "/corpus/import"),
        ("PUT", "/corpus/consent/{source}"),
    }
)

#: Routes either derivation finds and that deliberately do **not** take the
#: barrier, each with the reason, so an omission is a decision somebody wrote
#: down rather than a route nobody looked at.
EXCLUSIONS: Mapping[_Route, str] = {
    ("GET", "/stages/wheel"): (
        "read-only dial: select_wheel_balance fetches a wheel and transmits no "
        "stored adepthood content, so a late call after erasure exposes nothing"
    ),
    ("GET", "/invitations"): (
        "read-only dial: generate_invitation_signals reads signals and transmits "
        "no stored adepthood content, and it is a parallel app-load fetch that a "
        "per-account exclusive lock would serialize for no confidentiality gain"
    ),
    ("POST", "/journal/transcribe-page"): (
        "the bytes are caller-supplied in the same request: nothing of the "
        "account is stored or re-sent, and there is no row an erasure could "
        "orphan. It is also census row 9's strict-xfail path, whose state "
        "tests/security/test_connection_never_held_across_an_outbound_call.py "
        "pins, so including it is a decision about that row rather than about "
        "this barrier"
    ),
}


def _flatten_routers(routes: Sequence[BaseRoute]) -> Iterator[BaseRoute]:
    """Yield leaf routes, descending through FastAPI's included-router wrappers."""
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is None:
            yield route
        else:
            yield from _flatten_routers(included.routes)


def _flatten_dependants(dependant: Dependant) -> Iterator[Dependant]:
    """Yield a route's dependant and every dependant nested beneath it."""
    yield dependant
    for sub in dependant.dependencies:
        yield from _flatten_dependants(sub)


def vault_resolving_routes(application: FastAPI) -> frozenset[_Route]:
    """Every ``(method, path)`` whose dependency tree resolves a vault client.

    Derived from the live route table rather than from a list in a document, so
    the answer cannot go stale while the document still reads as current. It is
    the half of the derivation that sees vault egress; it is blind to a route
    that dials only a language model.
    """
    found: set[_Route] = set()
    for route in _flatten_routers(application.routes):
        if not isinstance(route, APIRoute):
            continue
        calls = {dependant.call for dependant in _flatten_dependants(route.dependant)}
        if get_creek_vault_client not in calls:
            continue
        methods = route.methods or set()
        found.update((method, route.path) for method in methods - {"HEAD", "OPTIONS"})
    return frozenset(found)


def call_graph_egress_routes() -> dict[_Route, Site]:
    """Every route the source call graph shows reaching a dial, by either transport."""
    return {(route.method, route.path): site for route, site in egress_reaching_routes().items()}


def transmitting_routes(application: FastAPI) -> frozenset[_Route]:
    """The union of both derivations: everything that might transmit."""
    return vault_resolving_routes(application) | frozenset(call_graph_egress_routes())


def stored_content_egress_gaps(application: FastAPI) -> tuple[_Route, ...]:
    """Every route either derivation finds that is neither barriered nor excluded."""
    classified = BARRIERED | frozenset(EXCLUSIONS)
    return tuple(sorted(transmitting_routes(application) - classified))


def test_the_derivation_is_not_silently_empty() -> None:
    """A broken derivation would make every other check in this file vacuous.

    Both halves are machinery -- an AST walk over ``src`` and a walk over
    FastAPI's route table -- and machinery that stops finding anything reports
    no gaps, no unbarriered paths and no stale entries. That is indistinguishable
    from a clean tree unless something puts a floor under it.
    """
    derived = call_graph_egress_routes()

    assert len(derived) >= _MINIMUM_DERIVED_ROUTES, (
        f"the call graph found only {len(derived)} transmitting routes; it is not "
        f"reading the tree it is supposed to be reading: {sorted(derived)}"
    )
    assert ("POST", "/journal/") in derived, "the call graph lost the canonical egress route"
    assert vault_resolving_routes(app), "the route-table walk found no vault-resolving route"


def test_every_stored_content_egress_route_is_classified() -> None:
    """A route added to either egress seam must be decided about, not merely added."""
    gaps = stored_content_egress_gaps(app)

    assert gaps == (), f"unclassified stored-content egress route: {gaps}"


def test_every_barriered_route_actually_takes_the_barrier() -> None:
    """The claim in :data:`BARRIERED` is checked against the source, not trusted.

    This is the check whose absence produced this whole round: four sites could
    have their ``hold_account`` removed simultaneously with the suite green,
    because the gate measured route-table membership and nothing measured
    behaviour. Removing the barrier from any one site now names that site's path
    here.
    """
    handlers = call_graph_egress_routes()
    bare = {
        route: unbarriered_egress_paths(handlers[route])
        for route in sorted(BARRIERED)
        if route in handlers and unbarriered_egress_paths(handlers[route])
    }

    assert bare == {}, (
        "these routes are declared barriered and reach a dial along a path no "
        f"hold_account encloses: { {str(k): v for k, v in bare.items()} }"
    )


def test_the_detached_continuation_takes_the_barrier() -> None:
    """The one egress path that belongs to no route is checked the same way.

    No request-scoped guard can reach it: it runs on a detached task, opens its
    own session, and dials after the request that scheduled it has answered.
    """
    bare = unbarriered_egress_paths(CONTINUATION)

    assert bare == (), f"the detached ladder reaches a dial with no barrier held: {bare}"


def test_every_indirect_barrier_holder_really_takes_the_barrier() -> None:
    """A registry that names a holder which does not hold is the defect pattern itself.

    ``_ordered_dial`` is accepted as a barrier boundary by the static analysis,
    which is a claim about a function in another module. If that function ever
    stopped taking ``hold_account``, the analysis would keep reporting every
    detached dial as covered -- so the claim is asserted here rather than
    assumed.
    """
    for spelling, (module, name) in sorted(INDIRECT_BARRIER_HOLDERS.items()):
        implementation = Site(module, name)
        assert takes_barrier_lexically(implementation), (
            f"{spelling} is trusted as a barrier boundary, but {implementation} does "
            f"not take hold_account"
        )


def test_the_account_barrier_is_always_the_outer_lock() -> None:
    """Account outermost, entry innermost -- everywhere the two meet.

    Prose alone enforced this before, and prose does not run. Inverting the two
    at a single site left the whole suite green and hung two live routes: the
    deletion path takes only the account barrier, so a site that takes the entry
    serializer first can wait for an account barrier held by somebody waiting
    for that entry.
    """
    inverted = inverted_nesting_sites()

    assert inverted == (), f"the account barrier is not the outer lock at: {inverted}"


def test_the_classification_names_no_route_that_no_longer_exists() -> None:
    """The other direction: a stale entry here would hide a real gap.

    Without this, deleting a barriered route would leave its name in
    :data:`BARRIERED` and the gap check would keep passing while a replacement
    route went unclassified under a different path.
    """
    live = transmitting_routes(app)
    classified = BARRIERED | frozenset(EXCLUSIONS)

    assert classified - live == frozenset(), (
        f"classified routes that no longer transmit anything: {sorted(classified - live)}"
    )


def test_every_exclusion_carries_a_reason() -> None:
    """An exclusion with an empty reason is an undocumented decision."""
    unexplained = tuple(sorted(route for route, reason in EXCLUSIONS.items() if not reason.strip()))

    assert unexplained == (), f"excluded without a written reason: {unexplained}"


def test_the_two_derivations_disagree_only_where_the_reasons_say_they_should() -> None:
    """The route-table walk and the call graph see different halves, on purpose.

    A vault-resolving route the call graph does *not* place on an egress path is
    a route that resolves a client and only ever reads from it. Those are the two
    hottest authenticated reads in the app and the reason they are excluded, so
    the disagreement is expected -- but an *unexplained* one would mean one of
    the two derivations has quietly stopped working.
    """
    resolving = vault_resolving_routes(app)
    transmitting = frozenset(call_graph_egress_routes())
    reads_only = sorted(resolving - transmitting)

    assert all(route in EXCLUSIONS for route in reads_only), (
        "a route resolves a vault client but no dial was derived from it, and it "
        f"carries no written exclusion: {[r for r in reads_only if r not in EXCLUSIONS]}"
    )


def test_the_route_spellings_match_between_the_derivations() -> None:
    """A path spelled differently in the two walks would silently split a route.

    The call graph assembles ``prefix + decorator path`` from the source; the
    route walk reads FastAPI's own table. A drift between them would let one
    derivation classify ``POST /journal/`` while the other saw an unclassified
    ``POST /journal`` -- so every route the call graph claims a vault client for
    must be spelled the same way in the live table.
    """
    live = frozenset(_live_routes(app))
    derived = frozenset(call_graph_egress_routes())

    assert derived <= live, (
        f"the call graph named routes the live table does not have: {sorted(derived - live)}"
    )


def _live_routes(application: FastAPI) -> Iterator[_Route]:
    """Every ``(method, path)`` in the live route table."""
    for route in _flatten_routers(application.routes):
        if not isinstance(route, APIRoute):
            continue
        for method in (route.methods or set()) - {"HEAD", "OPTIONS"}:
            yield (method, route.path)
