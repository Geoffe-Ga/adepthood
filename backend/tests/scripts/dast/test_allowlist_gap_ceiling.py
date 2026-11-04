"""The allow-list ceiling counts real coverage gaps, and nothing else.

The ceiling exists so that a green matrix cannot sit on top of an unprobed
application. What makes a surface unprobed is an entry that says "this route
needs an ownership probe and does not get one" -- ``no_seed_strategy``, or the
``known_leak`` that is the same hole with a finding attached. An entry that says
"an ownership probe would be meaningless here" (a shared catalog, a curriculum
position, an admin-gated route, a bearer capability) removes nothing the matrix
could have proven, so counting it against the same 50% only punished the
application for being honest about its shape.

Every test below pins one half of that bargain. The guard must still fire on a
deliberately violating fixture, it must ignore any number of by-design entries,
the boundary must stay inclusive, and by-design entries must not dilute the
share either -- otherwise declaring a dozen catalog routes would buy room for a
dozen more gaps, which is the loosening the change is not allowed to be.
"""

from __future__ import annotations

from collections.abc import Sequence

from scripts.dast.discovery import RouteSpec
from scripts.dast.policy import (
    ALLOWLIST_CATEGORIES,
    BY_DESIGN_CATEGORIES,
    COVERAGE_GAP_CATEGORIES,
    KNOWN_LEAK_CATEGORY,
    AllowlistEntry,
    GapShare,
    classify_references,
    classify_routes,
    reference_gap_share,
    route_gap_share,
)
from scripts.dast.runner import DEFAULT_MAX_ALLOWLIST_FRACTION
from scripts.dast.seeds import SeedSpec
from scripts.dast.verdict import require_allowlist_bounded, require_reference_allowlist_bounded

NO_SEED = "no_seed_strategy"
SEEDED_PARAM = "widget_id"
UNSEEDED_PARAM = "orphan_id"
SEED_REGISTRY = {
    SEEDED_PARAM: SeedSpec(
        create_method="POST",
        create_path="/widgets/",
        payload={},
        id_pointer=("id",),
    ),
}

# Far more by-design entries than the whole probe-worthy surface, so the old
# rule -- every entry over every route -- would fail these fixtures outright.
MANY_BY_DESIGN = 40
REFERENCE_FIELD = "gadget_id"


def _route(name: str, param: str = SEEDED_PARAM) -> RouteSpec:
    """Build one object-scoped GET route whose path parameter is ``param``."""
    return RouteSpec(
        method="GET",
        path=f"/{name}/{{{param}}}",
        params=(param,),
        requires_auth=True,
    )


def _entry(spec: RouteSpec, category: str, field: str | None = None) -> AllowlistEntry:
    """Excuse ``spec`` -- or one field of it -- under ``category``."""
    return AllowlistEntry(
        method=spec.method,
        path=spec.path,
        category=category,
        reason=f"excused as {category} for this fixture",
        field=field,
    )


def _by_design_category(index: int) -> str:
    """Cycle through every by-design category, so none of them is left untested."""
    ordered = sorted(BY_DESIGN_CATEGORIES)
    return ordered[index % len(ordered)]


def _route_share(
    *,
    covered: int,
    gaps: int,
    by_design: int = 0,
    uncovered: int = 0,
    gap_category: str = NO_SEED,
) -> GapShare:
    """Classify a synthetic document and measure its path-dimension gap share."""
    covered_routes = [_route(f"covered{index}") for index in range(covered)]
    gap_routes = [_route(f"gap{index}") for index in range(gaps)]
    design_routes = [_route(f"design{index}") for index in range(by_design)]
    uncovered_routes = [_route(f"open{index}", UNSEEDED_PARAM) for index in range(uncovered)]
    allowlist = (
        *(_entry(spec, gap_category) for spec in gap_routes),
        *(_entry(spec, _by_design_category(i)) for i, spec in enumerate(design_routes)),
    )
    classification = classify_routes(
        (*covered_routes, *gap_routes, *design_routes, *uncovered_routes),
        seed_registry=SEED_REGISTRY,
        allowlist=allowlist,
    )
    return route_gap_share(classification, allowlist)


def _bounded(share: GapShare) -> bool:
    """Report whether the path ceiling stays silent on this share."""
    return require_allowlist_bounded(share, max_fraction=DEFAULT_MAX_ALLOWLIST_FRACTION) is None


# --- The vocabulary is split, and every category is on exactly one side -------


def test_every_category_is_decided_as_either_a_gap_or_by_design() -> None:
    """A new category must be placed on one side, or it cannot be loaded at all.

    The vocabulary is the union of the two sets, so adding a category means
    choosing which set it joins -- the decision this ceiling turns on cannot be
    skipped by accident.
    """
    assert COVERAGE_GAP_CATEGORIES.isdisjoint(BY_DESIGN_CATEGORIES)
    assert COVERAGE_GAP_CATEGORIES | BY_DESIGN_CATEGORIES == ALLOWLIST_CATEGORIES


def test_only_an_unprobed_route_and_a_known_leak_are_gaps() -> None:
    """Pinned outright, so moving a category across the line is a reviewed diff."""
    assert frozenset({NO_SEED, KNOWN_LEAK_CATEGORY}) == COVERAGE_GAP_CATEGORIES
    assert (
        frozenset({"shared_catalog", "not_object_scoped", "admin_only", "capability_token"})
        == BY_DESIGN_CATEGORIES
    )


# --- The path dimension -----------------------------------------------------


def test_the_ceiling_still_trips_when_most_probe_worthy_routes_are_gaps() -> None:
    """The violating fixture: three unprobed routes beside one probed one."""
    share = _route_share(covered=1, gaps=3)

    failure = require_allowlist_bounded(share, max_fraction=DEFAULT_MAX_ALLOWLIST_FRACTION)

    assert failure is not None
    assert failure.guard == "require_allowlist_bounded"


def test_the_failure_says_how_many_gaps_out_of_what() -> None:
    """An operator reading the report must not have to recount the file."""
    share = _route_share(covered=1, gaps=3, by_design=2)

    failure = require_allowlist_bounded(share, max_fraction=DEFAULT_MAX_ALLOWLIST_FRACTION)

    assert failure is not None
    assert "3 of 4 route(s)" in failure.detail
    assert "50%" in failure.detail
    assert "2 more excused by design" in failure.detail
    for category in COVERAGE_GAP_CATEGORIES:
        assert category in failure.detail


def test_a_known_leak_counts_against_the_ceiling_like_a_missing_seed() -> None:
    """An accepted finding is a route the matrix does not probe; it is not by design."""
    share = _route_share(covered=1, gaps=3, gap_category=KNOWN_LEAK_CATEGORY)

    assert share.gaps == 3
    assert not _bounded(share)


def test_the_ceiling_ignores_any_number_of_by_design_entries() -> None:
    """Forty honest catalog and admin entries over three probe-worthy routes pass.

    Under the old rule this was 41 excused out of 43 considered.
    """
    share = _route_share(covered=2, gaps=1, by_design=MANY_BY_DESIGN)

    assert share == GapShare(gaps=1, probe_worthy=3, by_design=MANY_BY_DESIGN)
    assert _bounded(share)


def test_by_design_entries_do_not_dilute_the_share_of_gaps() -> None:
    """Declaring more catalog routes must never buy room for more unprobed ones.

    Two gaps beside one probed route are two thirds of the surface that needed
    a probe, whatever else the file excuses. Were by-design routes left in the
    denominator, these forty would make the same two gaps look like 5%.
    """
    share = _route_share(covered=1, gaps=2, by_design=MANY_BY_DESIGN)

    assert share.probe_worthy == 3
    assert not _bounded(share)


def test_an_uncovered_route_is_probe_worthy_and_counts_in_the_denominator() -> None:
    """A route with no seed and no entry still needed a probe; it fails elsewhere too."""
    share = _route_share(covered=0, gaps=1, uncovered=1)

    assert share == GapShare(gaps=1, probe_worthy=2, by_design=0)


def test_the_boundary_is_inclusive() -> None:
    """Exactly half is permitted; one more gap is not."""
    assert _bounded(_route_share(covered=2, gaps=2))
    assert not _bounded(_route_share(covered=2, gaps=3))


def test_an_empty_document_reports_rather_than_raises() -> None:
    """Zero gaps out of zero probe-worthy routes is a report, not a division by zero."""
    assert _bounded(_route_share(covered=0, gaps=0))


def test_a_route_excused_twice_is_a_gap_when_either_excuse_is() -> None:
    """A by-design entry cannot launder a gap entry naming the same route."""
    spec = _route("twice")
    allowlist = (_entry(spec, "shared_catalog"), _entry(spec, NO_SEED))
    classification = classify_routes((spec,), seed_registry=SEED_REGISTRY, allowlist=allowlist)

    assert route_gap_share(classification, allowlist) == GapShare(
        gaps=1,
        probe_worthy=1,
        by_design=0,
    )


# --- The reference dimension shares the vocabulary, so it shares the rule ----


def _reference_route(name: str) -> RouteSpec:
    """Build a collection route that carries one id in its body."""
    return RouteSpec(
        method="POST",
        path=f"/{name}/",
        params=(),
        requires_auth=True,
        body_id_refs=(REFERENCE_FIELD,),
    )


def _reference_share(routes: Sequence[RouteSpec], allowlist: Sequence[AllowlistEntry]) -> GapShare:
    """Classify reference-carrying routes and measure their gap share."""
    references = classify_references(
        routes,
        reference_registry={},
        seed_registry=SEED_REGISTRY,
        allowlist=allowlist,
    )
    return reference_gap_share(references, allowlist)


def test_the_reference_ceiling_trips_on_too_many_field_scoped_gaps() -> None:
    """Three unprobed body ids out of four is a majority, so the run must fail."""
    routes = [_reference_route(f"note{index}") for index in range(4)]
    allowlist = [_entry(spec, NO_SEED, REFERENCE_FIELD) for spec in routes[:3]]

    share = _reference_share(routes, allowlist)
    failure = require_reference_allowlist_bounded(
        share,
        max_fraction=DEFAULT_MAX_ALLOWLIST_FRACTION,
    )

    assert share == GapShare(gaps=3, probe_worthy=4, by_design=0)
    assert failure is not None
    assert failure.guard == "require_reference_allowlist_bounded"
    assert "3 of 4 body/query reference(s)" in failure.detail


def test_the_reference_ceiling_ignores_by_design_field_entries() -> None:
    """Every id excused as a shared catalog, bar one undeclared one, is no gap at all."""
    routes = [_reference_route(f"note{index}") for index in range(MANY_BY_DESIGN + 1)]
    allowlist = [
        _entry(spec, _by_design_category(index), REFERENCE_FIELD)
        for index, spec in enumerate(routes[:MANY_BY_DESIGN])
    ]

    share = _reference_share(routes, allowlist)

    assert share == GapShare(gaps=0, probe_worthy=1, by_design=MANY_BY_DESIGN)
    assert (
        require_reference_allowlist_bounded(share, max_fraction=DEFAULT_MAX_ALLOWLIST_FRACTION)
        is None
    )


def test_a_route_scoped_gap_entry_makes_its_references_gaps_too() -> None:
    """An entry without a field excuses everything the route carries, under its category."""
    spec = _reference_route("whole")

    share = _reference_share((spec,), (_entry(spec, NO_SEED),))

    assert share == GapShare(gaps=1, probe_worthy=1, by_design=0)


def test_the_reference_boundary_is_inclusive() -> None:
    """Exactly half of the probe-worthy references may be gaps; one more may not."""
    routes = [_reference_route(f"note{index}") for index in range(5)]
    at_limit = _reference_share(
        routes[:4],
        [_entry(spec, NO_SEED, REFERENCE_FIELD) for spec in routes[:2]],
    )
    over_limit = _reference_share(
        routes,
        [_entry(spec, NO_SEED, REFERENCE_FIELD) for spec in routes[:3]],
    )

    assert (
        require_reference_allowlist_bounded(at_limit, max_fraction=DEFAULT_MAX_ALLOWLIST_FRACTION)
        is None
    )
    assert (
        require_reference_allowlist_bounded(
            over_limit,
            max_fraction=DEFAULT_MAX_ALLOWLIST_FRACTION,
        )
        is not None
    )
