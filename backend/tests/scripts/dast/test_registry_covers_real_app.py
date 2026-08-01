"""A router added today is covered today, enforced in the fast suite with no server.

The way an authorization check like this dies is silent drift: a new router
lands, nobody adds a seed spec, and the matrix keeps reporting clean over a
shrinking share of the application. The DAST job itself cannot catch that — it
would need a database, a live instance, and two minutes — so the coverage
obligation is enforced here instead, in a plain unit test that reads the real
app's own OpenAPI document in-process.

The contract is deliberately blunt: every templated route is either seedable or
carries a written, categorised allow-list entry. There is no third option and no
implicit skip, so adding an endpoint with an id in its path fails this test until
somebody makes a decision about it.

The floor assertion below is what stops the test from congratulating itself. If
the document ever came back empty — a botched import, a lazily-mounted router —
"nothing uncovered" would be trivially true, so a run that discovers fewer routes
than the harness's own minimum is treated as a broken test rather than a pass.
"""

from __future__ import annotations

from main import app
from scripts.dast.discovery import discover_routes, is_object_scoped
from scripts.dast.policy import DEFAULT_ALLOWLIST_PATH, classify_routes, load_allowlist
from scripts.dast.runner import DEFAULT_MAX_ALLOWLIST_FRACTION, DEFAULT_MIN_ROUTES
from scripts.dast.seeds import REPLAY_BODIES, SEED_REGISTRY
from scripts.dast.verdict import require_allowlist_bounded, require_allowlist_is_live

MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def test_the_real_document_yields_enough_routes_for_the_assertions_to_mean_anything() -> None:
    """A floor under discovery, so an empty document cannot read as full coverage."""
    object_scoped = [spec for spec in discover_routes(app.openapi()) if is_object_scoped(spec)]

    assert len(object_scoped) >= DEFAULT_MIN_ROUTES, (
        f"only {len(object_scoped)} object-scoped routes were discovered; "
        "the document is probably not being generated correctly"
    )


def test_every_object_scoped_route_is_either_seeded_or_allowlisted() -> None:
    """The whole point: a new router is covered the day it is added, or the build stops."""
    classification = classify_routes(
        discover_routes(app.openapi()),
        seed_registry=SEED_REGISTRY,
        allowlist=load_allowlist(DEFAULT_ALLOWLIST_PATH),
    )

    uncovered = sorted(f"{spec.method} {spec.path}" for spec in classification.uncovered)
    assert uncovered == [], (
        f"these routes have neither a seed strategy nor an allow-list entry: {uncovered}"
    )


def test_no_allowlist_entry_has_outlived_the_route_it_excuses() -> None:
    """A renamed route must not leave a permanent excuse behind in the allow-list."""
    failure = require_allowlist_is_live(
        load_allowlist(DEFAULT_ALLOWLIST_PATH),
        discover_routes(app.openapi()),
    )

    assert failure is None, failure


def test_the_allowlist_covers_a_minority_of_the_application() -> None:
    """Excusing most of the app would leave a green check over an unchecked surface."""
    classification = classify_routes(
        discover_routes(app.openapi()),
        seed_registry=SEED_REGISTRY,
        allowlist=load_allowlist(DEFAULT_ALLOWLIST_PATH),
    )
    considered = (
        len(classification.covered)
        + len(classification.allowlisted)
        + len(classification.uncovered)
    )

    failure = require_allowlist_bounded(
        len(classification.allowlisted),
        considered,
        max_fraction=DEFAULT_MAX_ALLOWLIST_FRACTION,
    )

    assert failure is None, failure


def test_every_seed_spec_is_reachable_from_a_real_path_parameter() -> None:
    """A seed spec for a parameter no route uses is dead weight that still costs a request.

    It also hides a rename: the old parameter keeps its spec, the new one has
    none, and the route silently becomes uncovered.
    """
    live_params = {param for spec in discover_routes(app.openapi()) for param in spec.params}

    orphans = sorted(set(SEED_REGISTRY) - live_params)
    assert orphans == [], f"seed specs for parameters no route declares: {orphans}"


def test_every_seed_dependency_names_another_seed_spec() -> None:
    """A dependency the registry cannot satisfy would fail at run time, not at review."""
    for param, spec in SEED_REGISTRY.items():
        missing = sorted(set(spec.depends_on) - set(SEED_REGISTRY))
        assert missing == [], f"{param} depends on unregistered parameters: {missing}"


def test_every_templated_create_path_declares_its_dependencies() -> None:
    """A create path that interpolates a parameter must say so, or ordering is luck."""
    for param, spec in SEED_REGISTRY.items():
        interpolated = {piece.split("}")[0] for piece in spec.create_path.split("{")[1:]}
        undeclared = sorted(interpolated - set(spec.depends_on))
        assert undeclared == [], (
            f"{param} interpolates {undeclared} into its create path "
            "without declaring them in depends_on"
        )


def test_no_seed_spec_depends_on_itself() -> None:
    """A self-referential spec would deadlock the topological resolution."""
    for param, spec in SEED_REGISTRY.items():
        assert param not in spec.depends_on, f"{param} depends on itself"


def test_every_replay_body_targets_a_real_mutating_route() -> None:
    """A body keyed to a route that no longer exists silently stops being sent.

    The replay then goes out empty, gets a 422 before the ownership check runs,
    and the positive control turns the whole route inconclusive.
    """
    live = {(spec.method, spec.path) for spec in discover_routes(app.openapi())}

    for method, path in REPLAY_BODIES:
        assert method in MUTATING_METHODS, f"{method} {path} takes no request body"
        assert (method, path) in live, f"{method} {path} is not a route of this app"
