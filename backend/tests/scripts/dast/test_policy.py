"""The allow-list is an opt-out with a stated reason, not a place to hide routes.

Every route the matrix cannot probe has to be named, categorised, and justified
in ``allowlist.toml``, and the loader refuses anything less. That refusal is the
whole value: an entry with a blank reason, an invented category, or a stray key
is how "we'll come back to this" becomes permanent, and how a shrinking matrix
keeps reporting clean.

The one carve-out is ``known_leak``, the only category allowed to carry a
``tracking_issue``. It records a leak we have accepted for now and points at
where the work is tracked, which is why every other category is forbidden that
field — nothing may be quietly parked under ``no_seed_strategy``.

The classification tests pin the precedence that follows from all of this: an
allow-list entry wins over a seed strategy. Removing a route from the allow-list
must be a deliberate act, so its presence there is the answer even when the
harness could have probed it.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from scripts.dast.discovery import RouteSpec
from scripts.dast.policy import (
    ALLOWLIST_CATEGORIES,
    DEFAULT_ALLOWLIST_PATH,
    KNOWN_LEAK_CATEGORY,
    AllowlistEntry,
    AllowlistError,
    Coverage,
    classify_reference,
    classify_references,
    classify_route,
    classify_routes,
    load_allowlist,
)
from scripts.dast.references import (
    EvidenceStrategy,
    ObjectReference,
    ReferenceLocation,
    ReferenceProbe,
)
from scripts.dast.seeds import SeedSpec

EXPECTED_CATEGORIES = frozenset(
    {
        "shared_catalog",
        "not_object_scoped",
        "admin_only",
        "capability_token",
        "no_seed_strategy",
        "known_leak",
    },
)

TRACKED_ISSUE_NUMBER = 4242

SEEDED_REGISTRY: dict[str, SeedSpec] = {
    "habit_id": SeedSpec(
        create_method="POST",
        create_path="/habits/",
        payload={"name": "Drink Water"},
        id_pointer=("id",),
    ),
}

HABIT_ROUTE = RouteSpec(
    method="GET",
    path="/habits/{habit_id}",
    params=("habit_id",),
    requires_auth=True,
)
CATALOG_ROUTE = RouteSpec(
    method="GET",
    path="/course/content/{content_id}",
    params=("content_id",),
    requires_auth=True,
)
SLUG_ROUTE = RouteSpec(
    method="GET",
    path="/course/{slug}",
    params=("slug",),
    requires_auth=True,
)
COLLECTION_ROUTE = RouteSpec(method="GET", path="/habits/", params=(), requires_auth=True)

CATALOG_ENTRY = AllowlistEntry(
    method="GET",
    path="/course/content/{content_id}",
    category="shared_catalog",
    reason="global course catalog; no per-user owner",
)


def write_allowlist(tmp_path: Path, body: str) -> Path:
    """Write a dedented ``allowlist.toml`` under ``tmp_path`` and return its path."""
    path = tmp_path / "allowlist.toml"
    path.write_text(textwrap.dedent(body).lstrip("\n"), encoding="utf-8")
    return path


def test_a_complete_entry_loads_with_every_field_preserved(tmp_path: Path) -> None:
    """The four required keys are the whole contract for an ordinary opt-out."""
    path = write_allowlist(
        tmp_path,
        """
        [[route]]
        method   = "GET"
        path     = "/course/content/{content_id}"
        category = "shared_catalog"
        reason   = "global course catalog; no per-user owner"
        """,
    )

    assert load_allowlist(path) == (CATALOG_ENTRY,)


def test_an_allowlist_with_no_entries_loads_as_empty(tmp_path: Path) -> None:
    """Zero opt-outs is the goal state, so it must be expressible without error."""
    assert load_allowlist(write_allowlist(tmp_path, "\n")) == ()


@pytest.mark.parametrize("missing", ["method", "path", "category", "reason"])
def test_an_entry_missing_a_required_key_is_rejected(tmp_path: Path, missing: str) -> None:
    """Every key is load-bearing: without all four the entry cannot be reviewed."""
    fields = {
        "method": '"GET"',
        "path": '"/course/content/{content_id}"',
        "category": '"shared_catalog"',
        "reason": '"global course catalog"',
    }
    del fields[missing]
    body = "[[route]]\n" + "".join(f"{key} = {value}\n" for key, value in fields.items())

    with pytest.raises(AllowlistError, match=missing):
        load_allowlist(write_allowlist(tmp_path, body))


def test_an_empty_reason_is_rejected(tmp_path: Path) -> None:
    """A blank justification is worse than none: it looks reviewed and is not."""
    path = write_allowlist(
        tmp_path,
        """
        [[route]]
        method   = "GET"
        path     = "/course/content/{content_id}"
        category = "shared_catalog"
        reason   = ""
        """,
    )

    with pytest.raises(AllowlistError, match="reason"):
        load_allowlist(path)


def test_an_unrecognised_category_is_rejected_and_named(tmp_path: Path) -> None:
    """Free-text categories defeat the point; the vocabulary is closed."""
    path = write_allowlist(
        tmp_path,
        """
        [[route]]
        method   = "GET"
        path     = "/course/content/{content_id}"
        category = "we_will_fix_it_later"
        reason   = "not now"
        """,
    )

    with pytest.raises(AllowlistError, match="we_will_fix_it_later"):
        load_allowlist(path)


def test_an_unknown_key_is_rejected(tmp_path: Path) -> None:
    """A typo'd key would otherwise be silently ignored and change nothing."""
    path = write_allowlist(
        tmp_path,
        """
        [[route]]
        method   = "GET"
        path     = "/course/content/{content_id}"
        category = "shared_catalog"
        reason   = "global course catalog"
        resaon   = "typo"
        """,
    )

    with pytest.raises(AllowlistError, match="resaon"):
        load_allowlist(path)


def test_a_tracking_issue_on_a_non_leak_category_is_rejected(tmp_path: Path) -> None:
    """Only an accepted leak may cite tracked work; nothing else gets to look tracked."""
    path = write_allowlist(
        tmp_path,
        f"""
        [[route]]
        method         = "GET"
        path           = "/course/content/{{content_id}}"
        category       = "shared_catalog"
        reason         = "global course catalog"
        tracking_issue = {TRACKED_ISSUE_NUMBER}
        """,
    )

    with pytest.raises(AllowlistError, match="tracking_issue"):
        load_allowlist(path)


def test_a_known_leak_may_carry_a_tracking_issue(tmp_path: Path) -> None:
    """An accepted leak is allowed exactly once: named, categorised, and pointed at work."""
    path = write_allowlist(
        tmp_path,
        f"""
        [[route]]
        method         = "GET"
        path           = "/widgets/{{widget_id}}"
        category       = "known_leak"
        reason         = "accepted for now; remediation tracked"
        tracking_issue = {TRACKED_ISSUE_NUMBER}
        """,
    )

    entries = load_allowlist(path)

    assert entries == (
        AllowlistEntry(
            method="GET",
            path="/widgets/{widget_id}",
            category=KNOWN_LEAK_CATEGORY,
            reason="accepted for now; remediation tracked",
            tracking_issue=TRACKED_ISSUE_NUMBER,
        ),
    )


def test_the_category_vocabulary_is_exactly_the_documented_set() -> None:
    """Adding a category is a design decision, so it has to be made here first."""
    assert ALLOWLIST_CATEGORIES == EXPECTED_CATEGORIES
    assert KNOWN_LEAK_CATEGORY in ALLOWLIST_CATEGORIES


def test_a_seedable_object_scoped_route_is_covered() -> None:
    """Every path parameter has a seed strategy, so the route can be probed for real."""
    coverage = classify_route(HABIT_ROUTE, seed_registry=SEEDED_REGISTRY, allowlist=())

    assert coverage is Coverage.COVERED


def test_a_route_whose_parameter_has_no_seed_strategy_is_uncovered() -> None:
    """A missing seed spec must surface as uncovered rather than as a silent skip."""
    coverage = classify_route(CATALOG_ROUTE, seed_registry=SEEDED_REGISTRY, allowlist=())

    assert coverage is Coverage.UNCOVERED


def test_a_templated_route_that_is_not_object_scoped_is_uncovered() -> None:
    """``{slug}`` is not an id, so it needs a stated reason rather than a quiet pass."""
    coverage = classify_route(SLUG_ROUTE, seed_registry=SEEDED_REGISTRY, allowlist=())

    assert coverage is Coverage.UNCOVERED


def test_an_allowlist_entry_wins_over_a_working_seed_strategy() -> None:
    """Opting out is deliberate, so it is never overridden by the harness's ability to probe.

    The inverse precedence would let a route quietly re-enter the matrix and
    leave a stale entry behind, which the liveness guard would then flag.
    """
    entry = AllowlistEntry(
        method="GET",
        path="/habits/{habit_id}",
        category="admin_only",
        reason="probed by the in-process suite instead",
    )

    coverage = classify_route(HABIT_ROUTE, seed_registry=SEEDED_REGISTRY, allowlist=(entry,))

    assert coverage is Coverage.ALLOWLISTED


def test_classify_routes_splits_the_document_into_three_disjoint_buckets() -> None:
    """The three counts in the report must add up to the routes considered."""
    classification = classify_routes(
        (HABIT_ROUTE, CATALOG_ROUTE, SLUG_ROUTE, COLLECTION_ROUTE),
        seed_registry=SEEDED_REGISTRY,
        allowlist=(CATALOG_ENTRY,),
    )

    assert classification.covered == (HABIT_ROUTE,)
    assert classification.allowlisted == (CATALOG_ROUTE,)
    assert classification.uncovered == (SLUG_ROUTE,)


def test_routes_with_no_path_parameters_are_not_classified_at_all() -> None:
    """A collection route carries no object reference, so it is neither probed nor excused."""
    classification = classify_routes(
        (COLLECTION_ROUTE,),
        seed_registry=SEEDED_REGISTRY,
        allowlist=(),
    )

    assert classification.covered == ()
    assert classification.allowlisted == ()
    assert classification.uncovered == ()


def test_the_shipped_allowlist_lives_beside_the_harness_and_loads() -> None:
    """The file the CLI defaults to must exist and satisfy its own schema."""
    assert DEFAULT_ALLOWLIST_PATH.name == "allowlist.toml"
    assert DEFAULT_ALLOWLIST_PATH.parent.name == "dast"
    assert DEFAULT_ALLOWLIST_PATH.is_file()

    load_allowlist(DEFAULT_ALLOWLIST_PATH)


def test_the_shipped_allowlist_accepts_no_known_leaks() -> None:
    """Landing with an accepted BOLA would make the whole gate advisory.

    The category exists so a deliberate, tracked exception is possible without
    disabling the check; using it here at landing would defeat the point.
    """
    entries = load_allowlist(DEFAULT_ALLOWLIST_PATH)

    accepted = [entry for entry in entries if entry.category == KNOWN_LEAK_CATEGORY]
    assert accepted == [], f"known leaks are allow-listed: {accepted}"


# --- The parallel dimension: ids carried in a body or a query string ---------
#
# The same three outcomes, decided the same way, over ``(route, field)`` pairs
# instead of over routes. The allow-list gains one optional key, ``field``, so a
# single awkward reference can be excused without excusing the route it sits on.

JOURNAL_CREATE_ROUTE = RouteSpec(
    method="POST",
    path="/journal/",
    params=(),
    requires_auth=True,
    body_id_refs=("practice_session_id",),
)
# The same operation as above, spelled the way the real one is: two ids in one
# request. A route carrying exactly one reference cannot tell an entry that
# excuses the right field from one that excuses any field at all.
JOURNAL_CREATE_ROUTE_WITH_TWO_REFERENCES = RouteSpec(
    method="POST",
    path="/journal/",
    params=(),
    requires_auth=True,
    body_id_refs=("practice_session_id",),
    query_id_refs=("user_practice_id",),
)
SESSION_LISTING_ROUTE = RouteSpec(
    method="GET",
    path="/practice-sessions/",
    params=(),
    requires_auth=True,
    query_id_refs=("user_practice_id",),
)
PRESET_ROUTE = RouteSpec(
    method="POST",
    path="/user-practices/",
    params=(),
    requires_auth=True,
    body_id_refs=("practice_id",),
)

SESSION_REFERENCE = ObjectReference(
    field="practice_session_id",
    location=ReferenceLocation.BODY,
    seed_key="habit_id",
    evidence=EvidenceStrategy.ECHO,
)
UNSEEDABLE_REFERENCE = ObjectReference(
    field="user_practice_id",
    location=ReferenceLocation.QUERY,
    seed_key="nothing_seeds_this_id",
    evidence=EvidenceStrategy.LISTING,
)
PRESET_REFERENCE = ObjectReference(
    field="practice_id",
    location=ReferenceLocation.BODY,
    seed_key="habit_id",
    evidence=EvidenceStrategy.ECHO,
)

REFERENCE_REGISTRY_FIXTURE: dict[tuple[str, str], ReferenceProbe] = {
    ("POST", "/journal/"): ReferenceProbe(
        method="POST",
        path="/journal/",
        body={"message": "seeded by the authorization matrix"},
        references=(SESSION_REFERENCE,),
    ),
    ("GET", "/practice-sessions/"): ReferenceProbe(
        method="GET",
        path="/practice-sessions/",
        body={},
        references=(UNSEEDABLE_REFERENCE,),
    ),
    ("POST", "/user-practices/"): ReferenceProbe(
        method="POST",
        path="/user-practices/",
        body={},
        references=(PRESET_REFERENCE,),
    ),
}

PRESET_FIELD_ENTRY = AllowlistEntry(
    method="POST",
    path="/user-practices/",
    category="shared_catalog",
    reason="every authenticated user may adopt any approved preset by design",
    field="practice_id",
)


def test_a_reference_whose_seed_key_is_registered_is_covered() -> None:
    """A body id the harness can create an object for is probed for real."""
    coverage = classify_reference(
        JOURNAL_CREATE_ROUTE,
        SESSION_REFERENCE,
        seed_registry=SEEDED_REGISTRY,
        allowlist=(),
    )

    assert coverage is Coverage.COVERED


def test_a_reference_whose_seed_key_is_unknown_is_uncovered() -> None:
    """A missing seed strategy must surface as uncovered rather than as a quiet skip."""
    coverage = classify_reference(
        SESSION_LISTING_ROUTE,
        UNSEEDABLE_REFERENCE,
        seed_registry=SEEDED_REGISTRY,
        allowlist=(),
    )

    assert coverage is Coverage.UNCOVERED


def test_an_allowlist_entry_naming_the_field_excuses_that_reference() -> None:
    """Opting out one reference is possible without opting out its whole route."""
    coverage = classify_reference(
        PRESET_ROUTE,
        PRESET_REFERENCE,
        seed_registry=SEEDED_REGISTRY,
        allowlist=(PRESET_FIELD_ENTRY,),
    )

    assert coverage is Coverage.ALLOWLISTED


def test_an_entry_for_a_different_field_on_the_same_route_excuses_nothing() -> None:
    """Field granularity has to cut both ways, or one entry silently covers the rest.

    The route declares both ids and the entry names the other one, so nothing
    but the field comparison itself can produce this answer: the route is the
    entry's route, and the field it excuses is live.
    """
    other = AllowlistEntry(
        method="POST",
        path="/journal/",
        category="no_seed_strategy",
        reason="a different field entirely",
        field="practice_session_id",
    )

    coverage = classify_reference(
        JOURNAL_CREATE_ROUTE_WITH_TWO_REFERENCES,
        UNSEEDABLE_REFERENCE,
        seed_registry=SEEDED_REGISTRY,
        allowlist=(other,),
    )

    assert coverage is Coverage.UNCOVERED


def test_an_entry_naming_a_field_the_route_no_longer_declares_excuses_nothing() -> None:
    """A field-scoped excuse must not outlive the field it was written for.

    A renamed property leaves its entry behind, and an entry that keeps
    excusing a field nobody publishes is permanent by accident -- the same
    graveyard the route-level liveness guard exists to prevent. It has to stop
    excusing, so the reference is reported instead.
    """
    renamed_away = AllowlistEntry(
        method="GET",
        path="/practice-sessions/",
        category="no_seed_strategy",
        reason="the property this excused has since been renamed",
        field="retired_practice_id",
    )
    reference = ObjectReference(
        field="retired_practice_id",
        location=ReferenceLocation.QUERY,
        seed_key="nothing_seeds_this_id",
        evidence=EvidenceStrategy.LISTING,
    )

    coverage = classify_reference(
        SESSION_LISTING_ROUTE,
        reference,
        seed_registry=SEEDED_REGISTRY,
        allowlist=(renamed_away,),
    )

    assert coverage is Coverage.UNCOVERED


def test_classify_references_splits_the_document_into_three_disjoint_buckets() -> None:
    """Every discovered reference lands in exactly one bucket, as routes do."""
    classification = classify_references(
        (JOURNAL_CREATE_ROUTE, SESSION_LISTING_ROUTE, PRESET_ROUTE, COLLECTION_ROUTE),
        reference_registry=REFERENCE_REGISTRY_FIXTURE,
        seed_registry=SEEDED_REGISTRY,
        allowlist=(PRESET_FIELD_ENTRY,),
    )

    assert [(target.route.path, target.field) for target in classification.covered] == [
        ("/journal/", "practice_session_id"),
    ]
    assert [(target.route.path, target.field) for target in classification.allowlisted] == [
        ("/user-practices/", "practice_id"),
    ]
    assert [(target.route.path, target.field) for target in classification.uncovered] == [
        ("/practice-sessions/", "user_practice_id"),
    ]


def test_a_discovered_reference_the_registry_never_declared_is_uncovered() -> None:
    """A new body id must fail the build until somebody decides what to do with it.

    This is the drift the whole dimension exists to catch: a field lands in a
    request schema, nobody writes a probe for it, and the matrix keeps reporting
    clean over an id it has never sent.
    """
    undeclared = RouteSpec(
        method="POST",
        path="/goal_completions/",
        params=(),
        requires_auth=True,
        body_id_refs=("goal_id",),
    )

    classification = classify_references(
        (undeclared,),
        reference_registry=REFERENCE_REGISTRY_FIXTURE,
        seed_registry=SEEDED_REGISTRY,
        allowlist=(),
    )

    assert [(target.route.path, target.field) for target in classification.uncovered] == [
        ("/goal_completions/", "goal_id"),
    ]
    assert classification.covered == ()


def test_routes_carrying_no_reference_are_not_classified_at_all() -> None:
    """A route with no body or query id has nothing to classify in this dimension."""
    classification = classify_references(
        (COLLECTION_ROUTE, HABIT_ROUTE),
        reference_registry=REFERENCE_REGISTRY_FIXTURE,
        seed_registry=SEEDED_REGISTRY,
        allowlist=(),
    )

    assert classification.covered == ()
    assert classification.allowlisted == ()
    assert classification.uncovered == ()


def test_an_entry_carrying_a_field_loads_with_that_field_preserved(tmp_path: Path) -> None:
    """``field`` is an ordinary optional key, validated like the other four."""
    path = write_allowlist(
        tmp_path,
        """
        [[route]]
        method   = "POST"
        path     = "/user-practices/"
        category = "shared_catalog"
        reason   = "every authenticated user may adopt any approved preset by design"
        field    = "practice_id"
        """,
    )

    assert load_allowlist(path) == (PRESET_FIELD_ENTRY,)


def test_an_entry_without_a_field_loads_with_none_and_still_excuses_its_route(
    tmp_path: Path,
) -> None:
    """The existing shape is untouched: no ``field`` means the whole route, as today."""
    path = write_allowlist(
        tmp_path,
        """
        [[route]]
        method   = "GET"
        path     = "/course/content/{content_id}"
        category = "shared_catalog"
        reason   = "global course catalog; no per-user owner"
        """,
    )

    entries = load_allowlist(path)

    assert entries == (CATALOG_ENTRY,)
    assert entries[0].field is None
    assert classify_route(CATALOG_ROUTE, seed_registry=SEEDED_REGISTRY, allowlist=entries) is (
        Coverage.ALLOWLISTED
    )


def test_an_entry_scoped_to_a_field_does_not_excuse_the_whole_route() -> None:
    """A narrow excuse must stay narrow, or one field would quietly cover the path too."""
    scoped = AllowlistEntry(
        method="GET",
        path="/habits/{habit_id}",
        category="no_seed_strategy",
        reason="only the body id is excused here",
        field="goal_group_id",
    )

    coverage = classify_route(HABIT_ROUTE, seed_registry={}, allowlist=(scoped,))

    assert coverage is Coverage.UNCOVERED


def test_a_typo_near_the_field_key_is_still_rejected(tmp_path: Path) -> None:
    """Widening the permitted keys must not blunt the unknown-key check."""
    path = write_allowlist(
        tmp_path,
        """
        [[route]]
        method   = "POST"
        path     = "/user-practices/"
        category = "shared_catalog"
        reason   = "every authenticated user may adopt any approved preset by design"
        feild    = "practice_id"
        """,
    )

    with pytest.raises(AllowlistError, match="feild"):
        load_allowlist(path)


def test_a_field_that_is_not_a_string_is_rejected(tmp_path: Path) -> None:
    """A number here would silently never match a field name."""
    path = write_allowlist(
        tmp_path,
        """
        [[route]]
        method   = "POST"
        path     = "/user-practices/"
        category = "shared_catalog"
        reason   = "every authenticated user may adopt any approved preset by design"
        field    = 7
        """,
    )

    with pytest.raises(AllowlistError, match="field"):
        load_allowlist(path)
