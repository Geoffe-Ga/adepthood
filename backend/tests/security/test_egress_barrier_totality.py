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

from contextlib import nullcontext
from typing import TYPE_CHECKING

from fastapi.routing import APIRoute
from starlette.routing import BaseRoute

from dependencies.creek_vault import get_creek_vault_client
from main import app

# The private name is bound by import rather than reached by attribute access:
# the indirection's return type is the premise of a check below, and binding it
# here is how the neighbouring concurrency suites reach the same kind of seam.
from services.creek_vault_pipeline import _ordered_dial as ordered_dial
from tests.support.egress_call_graph import (
    INDIRECT_BARRIER_HOLDERS,
    Site,
    SourceGraph,
    egress_paths,
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

#: Egress entry points that belong to no route. Each opens its own session and
#: dials outside any request, so no route-table walk and no request-scoped guard
#: can reach them; they are checked here with the routes because the property is
#: the same one. ``resume_vault_pipeline_runs`` is the boot-time replay of
#: durable runs, which reaches the ladder by a different door than a request
#: does -- naming it separately is what keeps that door from being covered only
#: by accident.
DETACHED_ENTRY_POINTS: Mapping[str, Site] = {
    "the detached ontologization ladder": Site(
        "services.creek_vault_pipeline", "_continue_ladder_body"
    ),
    "the boot-time resume of durable pipeline runs": Site(
        "services.creek_vault_pipeline", "resume_vault_pipeline_runs"
    ),
}

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


def test_every_detached_entry_point_takes_the_barrier() -> None:
    """The egress paths that belong to no route are checked the same way.

    No request-scoped guard can reach either of them: both run outside a
    request, open their own session, and dial after whatever scheduled them has
    finished. Each must also actually reach a dial -- an entry point that
    reached none would pass the bare-path check for the wrong reason.
    """
    for description, entry in sorted(DETACHED_ENTRY_POINTS.items()):
        assert egress_paths(entry), f"{description} ({entry}) no longer reaches any dial"
        # ``detached=True``: these are the entry points that install the ordering
        # ``_ordered_dial`` reads, so the indirection is real here and only here.
        bare = unbarriered_egress_paths(entry, detached=True)
        assert bare == (), f"{description} reaches a dial with no barrier held: {bare}"


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


# ---------------------------------------------------------------------------
# Positive controls.
#
# Every check above reports *nothing* when its own machinery breaks: no gaps,
# no unbarriered paths, no stale entries. That is indistinguishable from a clean
# tree. :func:`test_the_derivation_is_not_silently_empty` puts a floor under the
# half that enumerates routes; nothing put one under the half that makes
# :data:`BARRIERED` a checked claim, and three separate sabotages of it --
# ``_unbarriered_calls`` returning early, ``_holds_account`` returning ``True``,
# and the walk stopping at an import spelling it cannot resolve -- each left the
# whole file green. So the walker is driven here over source whose gaps are known
# in advance, and over the one live route that really does dial unbarriered.
# ---------------------------------------------------------------------------

#: A tiny tree with one dial and four ways of reaching it. Source text rather
#: than fixture files because the answers have to be stated here, next to the
#: assertions, and because a file under ``tests/`` that looked like production
#: code would be read as production code.
_FIXTURE_SOURCES: Mapping[str, str] = {
    "services.botmason": '''
"""The one model seam, as the leaf set names it."""


async def generate_response(body: str) -> str:
    """Dial the provider."""
    return body
''',
    "services.account_egress_barrier": '''
"""The barrier, under the name every call site spells it with."""


def hold_account(session: object, user_id: int) -> object:
    """Order this account's egress."""
    return session or user_id
''',
    "services.dialling": '''
"""One function that dials, reached three different ways."""

from services.botmason import generate_response


async def dials(body: str) -> str:
    """Hand the body to the provider."""
    return await generate_response(body)
''',
    "routers.fixture": '''
"""Four handlers: barriered, bare, module-qualified, and falsely ordered."""

from services import dialling
from services.account_egress_barrier import hold_account
from services.creek_vault_pipeline import _ordered_dial
from services.dialling import dials


async def barriered(session: object, user_id: int, body: str) -> str:
    """Dial inside the hold."""
    async with hold_account(session, user_id):
        return await dials(body)


async def bare(body: str) -> str:
    """Dial with no hold anywhere."""
    return await dials(body)


async def module_qualified(body: str) -> str:
    """Dial through the import idiom this tree actually uses, with no hold."""
    return await dialling.dials(body)


async def detached_only(body: str) -> str:
    """Dial inside the indirection that orders nothing on a request path."""
    async with _ordered_dial():
        return await dials(body)
''',
    "services.creek_vault_pipeline": '''
"""The indirection, stubbed: what it returns is the point, not what it is."""


def _ordered_dial() -> object:
    """Order this dial when a detached ladder asked for it, and otherwise not."""
    return None
''',
}

#: The leaf every fixture trail ends at, spelled the way the walk reports it.
_FIXTURE_LEAF = "services.botmason.generate_response"


def _fixture_graph() -> SourceGraph:
    """The fixture tree, parsed fresh: nothing here shares the cached real graph."""
    return SourceGraph.from_sources(_FIXTURE_SOURCES)


def _fixture_paths(handler: str, *, detached: bool = False) -> tuple[tuple[str, ...], ...]:
    """Every unbarriered path from one fixture handler."""
    return unbarriered_egress_paths(
        Site("routers.fixture", handler), detached=detached, graph=_fixture_graph()
    )


def test_the_walk_reports_a_dial_that_no_hold_encloses() -> None:
    """The control the whole ``BARRIERED`` claim rests on.

    ``_unbarriered_calls`` returning ``()`` as its first statement, and
    ``_holds_account`` returning ``True``, both leave every other check in this
    file passing: a walker that finds nothing reports no gaps. This is the one
    assertion that fails under either.
    """
    assert _fixture_paths("bare") == (
        ("routers.fixture.bare", "services.dialling.dials", _FIXTURE_LEAF),
    ), "the walk cannot see a dial with no barrier anywhere near it"


def test_the_walk_reports_nothing_when_a_hold_encloses_the_dial() -> None:
    """The other direction: a real hold really does end the descent.

    Without this, a walker that reported *everything* -- ``_holds_account``
    returning ``False`` -- would satisfy the control above while making the gate
    useless in the opposite way.
    """
    assert _fixture_paths("barriered") == ()


def test_a_dial_reached_by_the_module_import_idiom_is_followed() -> None:
    """``from services import x`` then ``x.f(...)`` is a call, not a dead end.

    The name table recorded only the alias bindings of an ``ImportFrom``, so this
    spelling resolved to nothing and the walk stopped -- reporting the paths
    beyond it as absent rather than as unfollowed. ``routers/journal.py``,
    ``routers/botmason.py`` and ``main.py`` all import this way, so moving a dial
    out of its hold *and* spelling the call through the module was enough to keep
    the gate green.
    """
    assert _fixture_paths("module_qualified") == (
        ("routers.fixture.module_qualified", "services.dialling.dials", _FIXTURE_LEAF),
    ), "the walk stops at the import idiom the files it guards actually use"


def test_the_detached_indirection_is_no_barrier_on_a_request_path() -> None:
    """``_ordered_dial`` certifies nothing for a handler that runs in a request.

    It returns a ``nullcontext`` unless the detached ladder installed its
    ordering, which only ``_continue_ladder_body`` does. Credited on a request
    path it certified 48 paths at once: a handler could hand this account's whole
    corpus to Creek with no ``hold_account`` anywhere and be declared barriered.
    """
    assert _fixture_paths("detached_only") == (
        ("routers.fixture.detached_only", "services.dialling.dials", _FIXTURE_LEAF),
    ), "a nullcontext was accepted as this account's egress barrier"
    assert _fixture_paths("detached_only", detached=True) == (), (
        "the indirection is real on the path that installs it, and must still count there"
    )


def test_the_detached_indirection_really_is_a_nullcontext_off_the_ladder() -> None:
    """The premise of the check above, read off the implementation rather than assumed.

    If ``_ordered_dial`` ever began ordering unconditionally, refusing to credit
    it on a request path would become over-strict rather than honest -- and this
    is the assertion that would say so instead of leaving the reason in a
    comment.
    """
    assert isinstance(ordered_dial(), nullcontext)


def test_a_live_route_that_dials_unbarriered_is_still_reported() -> None:
    """The same floor, on the real tree rather than on fixture source.

    ``POST /journal/transcribe-page`` is excluded from the barrier with a written
    reason -- the bytes are caller-supplied in the same request -- and it is
    therefore the one live handler whose dial no ``hold_account`` encloses. That
    makes it the real tree's own positive control: a walker that had stopped
    working would report it as clean, exactly as it would report every barriered
    route as clean.
    """
    handler = call_graph_egress_routes()[("POST", "/journal/transcribe-page")]
    bare = unbarriered_egress_paths(handler)

    assert bare, "the walk no longer sees the one live route that dials unbarriered"
    assert {trail[-1] for trail in bare} == {"services.botmason.generate_response"}


#: One entry-serializer hold that reaches the account barrier through a helper,
#: and the same code with the two nested the right way round. The inversion is a
#: deadlock and the static check that catches it could only ever see a single
#: ``async with``, so a refactor that moved the inner hold one frame down turned a
#: caught inversion into an invisible one without changing what runs.
_NESTING_SOURCES: Mapping[str, str] = {
    "services.account_egress_barrier": '''
"""The barrier, under the name every call site spells it with."""


def hold_account(session: object, user_id: int) -> object:
    """Order this account's egress."""
    return session or user_id
''',
    "routers.nesting": '''
"""Two orderings of the same two locks, one of which deadlocks."""

from services.account_egress_barrier import hold_account

voice_draft_privacy = object()


async def takes_the_account_barrier(session: object, user_id: int) -> None:
    """The account barrier, one frame down from its caller."""
    async with hold_account(session, user_id):
        pass


async def inverted(session: object, user_id: int, entry_id: int) -> None:
    """Entry serializer first, account barrier second: the deadlock."""
    async with voice_draft_privacy.hold(session, entry_id):
        await takes_the_account_barrier(session, user_id)


async def correct(session: object, user_id: int, entry_id: int) -> None:
    """Account barrier outermost, entry serializer innermost."""
    async with hold_account(session, user_id), voice_draft_privacy.hold(session, entry_id):
        pass
''',
}


def test_an_inversion_hidden_behind_a_call_is_still_an_inversion() -> None:
    """The lock order is a property of what runs, not of what one statement shows.

    Only the caller of the helper can see this: the helper itself is an ordinary
    ``async with hold_account``, and the entry-serializer hold it runs inside is
    in another function entirely.
    """
    inverted = inverted_nesting_sites(graph=SourceGraph.from_sources(_NESTING_SOURCES))

    assert len(inverted) == 1, f"expected exactly the one inversion, got: {inverted}"
    assert "takes_the_account_barrier" in inverted[0]
    assert "entry-serializer hold" in inverted[0]


def test_the_right_order_through_a_call_is_not_reported() -> None:
    """The control the check above needs, or it would fire on the fixed nesting too.

    The inverted function is cut out rather than renamed: the check walks every
    ``async with`` in the module, so a rename would leave the same inversion in
    the tree under a different name and prove nothing.
    """
    module = _NESTING_SOURCES["routers.nesting"]
    correct_only = dict(_NESTING_SOURCES) | {
        "routers.nesting": module[: module.index("async def inverted")]
        + module[module.index("async def correct") :]
    }

    assert inverted_nesting_sites(graph=SourceGraph.from_sources(correct_only)) == ()
