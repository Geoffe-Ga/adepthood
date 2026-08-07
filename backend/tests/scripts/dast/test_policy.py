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
    classify_route,
    classify_routes,
    load_allowlist,
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
