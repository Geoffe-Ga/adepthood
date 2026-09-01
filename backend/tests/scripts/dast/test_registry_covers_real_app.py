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

from collections.abc import Mapping

from main import app
from scripts.dast.discovery import carries_reference, discover_routes, is_object_scoped
from scripts.dast.policy import (
    DEFAULT_ALLOWLIST_PATH,
    classify_references,
    classify_routes,
    load_allowlist,
)
from scripts.dast.references import REFERENCE_REGISTRY, EvidenceStrategy
from scripts.dast.runner import (
    DEFAULT_MAX_ALLOWLIST_FRACTION,
    DEFAULT_MIN_REFERENCES,
    DEFAULT_MIN_ROUTES,
)
from scripts.dast.seeds import REPLAY_BODIES, SEED_REGISTRY
from scripts.dast.verdict import require_allowlist_bounded, require_allowlist_is_live

MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Reading a response schema out of the document: the media type whose body is a
# named object, the status codes that carry one, and the wrapper a listing uses.
_JSON_MEDIA_TYPE = "application/json"
_SUCCESS_PREFIX = "2"
_ARRAY_TYPE = "array"
_REF_KEY = "$ref"


def _as_mapping(value: object) -> Mapping[str, object]:
    """Return ``value`` when it is a mapping, otherwise an empty one."""
    return value if isinstance(value, Mapping) else {}


def _resolve(node: object, schemas: Mapping[str, object]) -> Mapping[str, object]:
    """Follow a ``$ref`` into ``components.schemas``, or return the node as it stands."""
    resolved = _as_mapping(node)
    reference = resolved.get(_REF_KEY)
    if not isinstance(reference, str):
        return resolved
    return _as_mapping(schemas.get(reference.rsplit("/", maxsplit=1)[-1]))


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


def test_every_seed_spec_is_reachable_from_a_path_parameter_or_a_reference() -> None:
    """A seed spec nothing can ask for is dead weight that still costs a request.

    It also hides a rename: the old parameter keeps its spec, the new one has
    none, and the route silently becomes uncovered. A spec may now earn its keep
    either way -- named by a path parameter, or named as the seed key of a body
    or query reference the harness probes.
    """
    live_params = {param for spec in discover_routes(app.openapi()) for param in spec.params}
    reference_keys = {
        reference.seed_key
        for probe in REFERENCE_REGISTRY.values()
        for reference in probe.references
    }

    orphans = sorted(set(SEED_REGISTRY) - live_params - reference_keys)
    assert orphans == [], f"seed specs nothing declares or references: {orphans}"


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


# --- The same obligation for ids carried in a body or a query string ---------
#
# A field named ``*_id`` landing in a request schema is exactly as much a new
# object reference as a new ``/{thing_id}`` route, and exactly as easy to miss.
# The contract is the same one: seedable, or written down with a reason.


def all_references() -> list[tuple[str, str, str]]:
    """Return every ``(method, path, field)`` reference the real document publishes."""
    return [
        (spec.method, spec.path, field)
        for spec in discover_routes(app.openapi())
        if carries_reference(spec)
        for field in (*spec.body_id_refs, *spec.query_id_refs)
    ]


def test_the_real_document_publishes_enough_references_to_mean_anything() -> None:
    """A floor under the reference dimension, so a garbled document cannot read as clean."""
    references = all_references()

    assert len(references) >= DEFAULT_MIN_REFERENCES, (
        f"only {len(references)} body or query references were discovered; "
        "the document is probably not being generated correctly"
    )


def test_every_body_or_query_reference_is_either_probed_or_allowlisted() -> None:
    """A new id in a request schema is covered the day it lands, or the build stops."""
    classification = classify_references(
        discover_routes(app.openapi()),
        reference_registry=REFERENCE_REGISTRY,
        seed_registry=SEED_REGISTRY,
        allowlist=load_allowlist(DEFAULT_ALLOWLIST_PATH),
    )

    uncovered = sorted(
        f"{target.route.method} {target.route.path} {target.field}"
        for target in classification.uncovered
    )
    assert uncovered == [], (
        f"these references have neither a probe nor an allow-list entry: {uncovered}"
    )


def test_every_reference_seed_key_names_a_real_seed_spec() -> None:
    """A seed key the registry cannot resolve would fail at run time, not at review."""
    for (method, path), probe in REFERENCE_REGISTRY.items():
        missing = sorted(
            reference.seed_key
            for reference in probe.references
            if reference.seed_key not in SEED_REGISTRY
        )
        assert missing == [], f"{method} {path} references unseedable keys: {missing}"


def test_every_reference_probe_targets_a_live_route_of_this_app() -> None:
    """A probe keyed to a renamed route silently stops being sent, and nobody notices."""
    live = {(spec.method, spec.path) for spec in discover_routes(app.openapi())}

    stale = sorted(
        f"{method} {path}" for method, path in REFERENCE_REGISTRY if (method, path) not in live
    )
    assert stale == [], f"reference probes for routes this app no longer has: {stale}"


def test_every_reference_probe_names_a_field_the_route_still_declares() -> None:
    """A renamed field leaves its probe behind, injecting an id nothing reads."""
    published = {
        (spec.method, spec.path): {*spec.body_id_refs, *spec.query_id_refs}
        for spec in discover_routes(app.openapi())
    }

    for (method, path), probe in REFERENCE_REGISTRY.items():
        declared = published.get((method, path), set())
        missing = sorted(
            reference.field for reference in probe.references if reference.field not in declared
        )
        assert missing == [], f"{method} {path} probes fields it no longer declares: {missing}"


def test_every_reference_probe_declares_the_path_parameters_it_interpolates() -> None:
    """A probe on a templated route must seed its own path ids, or the request 404s."""
    for (method, path), probe in REFERENCE_REGISTRY.items():
        interpolated = {piece.split("}")[0] for piece in path.split("{")[1:]}
        undeclared = sorted(interpolated - set(probe.path_seeds))
        assert undeclared == [], (
            f"{method} {path} interpolates {undeclared} without declaring them in path_seeds"
        )
        unseedable = sorted(set(probe.path_seeds) - set(SEED_REGISTRY))
        assert unseedable == [], f"{method} {path} declares unseedable path seeds: {unseedable}"


def _success_properties(document: Mapping[str, object], method: str, path: str) -> set[str]:
    """Return the property names one operation's success response declares.

    FastAPI spells every response schema as a ``$ref``, and a listing wraps its
    rows in an array, so both indirections are followed before the properties
    can be read. Anything that will not resolve yields an empty set, which fails
    the assertions that use it rather than erroring out of them.
    """
    schemas = _as_mapping(_as_mapping(document.get("components")).get("schemas"))
    operation = _as_mapping(
        _as_mapping(_as_mapping(document.get("paths")).get(path)).get(method.lower()),
    )
    responses = _as_mapping(operation.get("responses"))
    codes = sorted(code for code in responses if str(code).startswith(_SUCCESS_PREFIX))
    if not codes:
        return set()
    content = _as_mapping(_as_mapping(responses[codes[0]]).get("content"))
    schema = _resolve(_as_mapping(content.get(_JSON_MEDIA_TYPE)).get("schema"), schemas)
    if schema.get("type") == _ARRAY_TYPE:
        schema = _resolve(schema.get("items"), schemas)
    return set(_as_mapping(schema.get("properties")))


def test_every_witness_points_at_a_property_its_route_still_declares() -> None:
    """A witness naming a renamed field would go quiet on the control as well.

    That is caught at run time -- the positive-control guard fails the run -- but
    only when somebody runs the matrix against a live server. Reading the app's
    own document here catches it in the fast suite, on the pull request that
    renames the field.
    """
    document = app.openapi()

    for (method, path), probe in REFERENCE_REGISTRY.items():
        declared = _success_properties(document, method, path)
        for reference in probe.references:
            witness = reference.witness
            if witness is None:
                continue
            assert witness.pointer[0] in declared, (
                f"{method} {path} field {reference.field}: witness reads "
                f"{'.'.join(witness.pointer)}, which the success response no longer declares "
                f"(it declares {sorted(declared)})"
            )


def test_every_echoing_reference_is_graded_on_something_its_response_carries() -> None:
    """An echo that echoes nothing is a cell graded on its status, which is no grade.

    Two of these routes answer with no id at all: a check-in reports a streak
    and a fold reports whether the quote is still pending. Without a witness
    their evidence is empty on both cells, the control proves nothing, and the
    cross cell's 2xx is decided by the status alone -- exactly the reading this
    dimension exists to replace. So a reference whose response does not carry
    its own field has to declare the fact that stands in for it.
    """
    document = app.openapi()

    for (method, path), probe in REFERENCE_REGISTRY.items():
        declared = _success_properties(document, method, path)
        echoing = [
            reference
            for reference in probe.references
            if reference.evidence is EvidenceStrategy.ECHO
        ]
        for reference in echoing:
            assert reference.field in declared or reference.witness is not None, (
                f"{method} {path} field {reference.field} is graded by scanning a response "
                f"that never carries it; declare a witness or a read-back instead"
            )


def test_a_read_back_strategy_declares_where_to_read_back_and_nothing_else_does() -> None:
    """The follow-up GET is what makes a silent route gradeable; nothing else needs one.

    A read-back without a path would grade every silent response as inconclusive
    forever, and a path on an echoing reference is a request nobody reads.
    """
    for (method, path), probe in REFERENCE_REGISTRY.items():
        for reference in probe.references:
            needs_path = reference.evidence is EvidenceStrategy.READ_BACK
            has_path = reference.read_back_path is not None
            assert has_path is needs_path, (
                f"{method} {path} field {reference.field}: "
                f"evidence={reference.evidence.name} read_back_path={reference.read_back_path!r}"
            )
