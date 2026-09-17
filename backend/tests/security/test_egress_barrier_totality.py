"""Every route that resolves a vault client is classified, not merely counted.

**This gate bounds routes, not egress.** It walks FastAPI's own route table for
``dependencies.creek_vault.get_creek_vault_client`` and requires each route it
finds to be classified -- barriered, or excluded with a written reason. A route
added tomorrow fails the build as *unclassified*, which is the property worth
having; a path that egresses without resolving that dependency is invisible to
it, which is the property it does not have.

The most important such path is the detached pipeline continuation
(:func:`services.creek_vault_pipeline._continue_ladder_body`): it belongs to no
route, opens its own session, and dials after the request has answered. It is
covered separately, by
``tests/test_account_egress_barrier_continuation.py``.

Two barriered paths are absent from the lists below because the walk cannot see
them: ``PUT /corpus/consent/{source}``, whose grant sweeps existing writing back
out through a provider rather than through a vault client, and the continuation
above. That asymmetry is why this is a lower bound on *routes* and is described
as one.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi.routing import APIRoute
from starlette.routing import BaseRoute

from dependencies.creek_vault import get_creek_vault_client
from main import app

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping, Sequence

    from fastapi import FastAPI
    from fastapi.dependencies.models import Dependant

_Route = tuple[str, str]

#: Routes that hand this account's *stored* content outward and therefore take
#: the per-account egress barrier.
BARRIERED: frozenset[_Route] = frozenset(
    {
        ("POST", "/journal/"),
        ("PATCH", "/journal/{entry_id}"),
        ("DELETE", "/journal/{entry_id}"),
        ("POST", "/journal/{entry_id}/resonance"),
        ("POST", "/journal/marginalia/{marginalia_id}/essay"),
        ("POST", "/corpus/import"),
    }
)

#: Routes that resolve a vault client and deliberately do **not** take the
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
    the answer cannot go stale while the document still reads as current.
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


def stored_content_egress_gaps(application: FastAPI) -> tuple[_Route, ...]:
    """Every vault-resolving route that is neither barriered nor excluded."""
    classified = BARRIERED | frozenset(EXCLUSIONS)
    return tuple(sorted(vault_resolving_routes(application) - classified))


def test_every_stored_content_egress_route_is_classified() -> None:
    """A route added to the vault seam must be decided about, not merely added."""
    gaps = stored_content_egress_gaps(app)

    assert gaps == (), f"unclassified stored-content egress route: {gaps}"


def test_the_classification_names_no_route_that_no_longer_exists() -> None:
    """The other direction: a stale entry here would hide a real gap.

    Without this, deleting a barriered route would leave its name in
    :data:`BARRIERED` and the gap check would keep passing while a replacement
    route went unclassified under a different path.
    """
    live = vault_resolving_routes(app)
    classified = BARRIERED | frozenset(EXCLUSIONS)

    assert classified - live == frozenset(), (
        f"classified routes that no longer resolve a vault client: {sorted(classified - live)}"
    )


def test_every_exclusion_carries_a_reason() -> None:
    """An exclusion with an empty reason is an undocumented decision."""
    unexplained = tuple(sorted(route for route, reason in EXCLUSIONS.items() if not reason.strip()))

    assert unexplained == (), f"excluded without a written reason: {unexplained}"
