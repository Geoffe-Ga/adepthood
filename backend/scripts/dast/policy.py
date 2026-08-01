"""Decide, for each route, whether the matrix probes it, excuses it, or fails on it.

Three outcomes and no fourth. A route is COVERED when the harness can create the
objects its path names, ALLOWLISTED when somebody wrote down why it cannot be,
and UNCOVERED otherwise -- which fails the build. There is deliberately no
implicit skip: an implicit skip is how a shrinking matrix keeps reporting clean.

The allow-list is data, validated on load, and the validation is the point. An
entry with a blank reason, an invented category, or a typo'd key is how "we'll
come back to this" becomes permanent, so each of those is a hard error rather
than a shrug. ``known_leak`` is the single category permitted a
``tracking_issue``, which is how a deliberately accepted finding stays visible
instead of being parked under a vaguer heading.

An allow-list entry wins over a working seed strategy. The inverse precedence
would let a route quietly re-enter the matrix and leave a stale entry behind,
so opting out stays a deliberate act that has to be deliberately undone.

Everything here is pure: a file path or a route list in, a decision out.
"""

from __future__ import annotations

import tomllib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import Enum, auto
from pathlib import Path

from scripts.dast.discovery import RouteSpec, is_object_scoped
from scripts.dast.seeds import SeedSpec

# The shipped opt-out list sits beside the harness so the two are reviewed and
# moved together.
DEFAULT_ALLOWLIST_PATH = Path(__file__).resolve().parent / "allowlist.toml"

KNOWN_LEAK_CATEGORY = "known_leak"

# A closed vocabulary: free text would let every awkward route acquire its own
# bespoke excuse, and the set of excuses is exactly what a reviewer scans.
ALLOWLIST_CATEGORIES = frozenset(
    {
        "shared_catalog",
        "not_object_scoped",
        "admin_only",
        "capability_token",
        "no_seed_strategy",
        KNOWN_LEAK_CATEGORY,
    },
)

_ROUTE_TABLE = "route"
_REQUIRED_KEYS = ("method", "path", "category", "reason")
_TRACKING_ISSUE_KEY = "tracking_issue"
_PERMITTED_KEYS = frozenset({*_REQUIRED_KEYS, _TRACKING_ISSUE_KEY})


class AllowlistError(Exception):
    """An allow-list file that cannot be trusted to mean what it says."""


class Coverage(Enum):
    """What the matrix will do with one route."""

    COVERED = auto()
    ALLOWLISTED = auto()
    UNCOVERED = auto()


@dataclass(frozen=True)
class AllowlistEntry:
    """One route the matrix deliberately does not probe, and the reason why.

    Attributes:
        method: The upper-cased HTTP verb.
        path: The templated path, exactly as the document spells it.
        category: One of :data:`ALLOWLIST_CATEGORIES`.
        reason: A sentence a reviewer can disagree with.
        tracking_issue: Where the remediation is tracked. Permitted only on a
            ``known_leak`` entry, so nothing else can be made to look tracked.
    """

    method: str
    path: str
    category: str
    reason: str
    tracking_issue: int | None = None


@dataclass(frozen=True)
class Classification:
    """The routes of one document, split into three disjoint buckets.

    Attributes:
        covered: Routes the matrix will probe for real.
        allowlisted: Routes with a written opt-out.
        uncovered: Routes with neither, which fail the build.
    """

    covered: tuple[RouteSpec, ...]
    allowlisted: tuple[RouteSpec, ...]
    uncovered: tuple[RouteSpec, ...]


def _reject(index: int, problem: str) -> AllowlistError:
    """Build the error for one bad entry, citing its position in the file."""
    return AllowlistError(f"allowlist entry {index}: {problem}")


def _require_text(raw: Mapping[str, object], index: int) -> None:
    """Check that every required key is present and carries real text.

    Args:
        raw: One ``[[route]]`` table as TOML parsed it.
        index: The entry's 1-based position, for the error message.

    Raises:
        AllowlistError: When a key is absent, is not a string, or is blank. A
            blank justification is worse than none: it looks reviewed and is not.
    """
    for key in _REQUIRED_KEYS:
        if key not in raw:
            raise _reject(index, f"missing required key '{key}'")
        value = raw[key]
        if not isinstance(value, str) or not value.strip():
            raise _reject(index, f"'{key}' must be a non-empty string")


def _require_tracking_issue_is_earned(raw: Mapping[str, object], index: int) -> int | None:
    """Return the entry's tracking issue, refusing it on any other category.

    Args:
        raw: One validated ``[[route]]`` table.
        index: The entry's 1-based position, for the error message.

    Returns:
        The issue number, or ``None`` when the entry does not cite one.

    Raises:
        AllowlistError: When a non-leak entry cites tracked work -- nothing may
            be quietly parked under a softer category -- or when the value is
            not a number.
    """
    tracking = raw.get(_TRACKING_ISSUE_KEY)
    if tracking is None:
        return None
    if raw["category"] != KNOWN_LEAK_CATEGORY:
        raise _reject(
            index,
            f"'{_TRACKING_ISSUE_KEY}' is permitted only on a '{KNOWN_LEAK_CATEGORY}' entry",
        )
    if not isinstance(tracking, int):
        raise _reject(index, f"'{_TRACKING_ISSUE_KEY}' must be an issue number")
    return tracking


def _parse_entry(raw: Mapping[str, object], index: int) -> AllowlistEntry:
    """Validate one ``[[route]]`` table and build its entry.

    Args:
        raw: The table as TOML parsed it.
        index: The entry's 1-based position, for the error message.

    Returns:
        The validated entry.

    Raises:
        AllowlistError: On an unknown key (a typo would otherwise be silently
            ignored and change nothing), a missing or blank required value, or
            a category outside the closed vocabulary.
    """
    unknown = sorted(set(raw) - _PERMITTED_KEYS)
    if unknown:
        raise _reject(index, f"unknown key(s): {', '.join(unknown)}")
    _require_text(raw, index)
    category = str(raw["category"])
    if category not in ALLOWLIST_CATEGORIES:
        known = ", ".join(sorted(ALLOWLIST_CATEGORIES))
        raise _reject(index, f"'{category}' is not a known category; use one of {known}")
    return AllowlistEntry(
        method=str(raw["method"]),
        path=str(raw["path"]),
        category=category,
        reason=str(raw["reason"]),
        tracking_issue=_require_tracking_issue_is_earned(raw, index),
    )


def load_allowlist(path: Path) -> tuple[AllowlistEntry, ...]:
    """Read and validate an allow-list file.

    Args:
        path: The file to read.

    Returns:
        The entries in file order. A file with no ``[[route]]`` tables loads as
        empty, because zero opt-outs is the goal state and has to be
        expressible.

    Raises:
        AllowlistError: When any entry fails validation.
    """
    with path.open("rb") as handle:
        document = tomllib.load(handle)
    raw_entries = document.get(_ROUTE_TABLE, [])
    return tuple(_parse_entry(raw, index) for index, raw in enumerate(raw_entries, start=1))


def _is_excused(spec: RouteSpec, allowlist: Sequence[AllowlistEntry]) -> bool:
    """Report whether an allow-list entry names exactly this operation."""
    return any(entry.method == spec.method and entry.path == spec.path for entry in allowlist)


def _is_probeable(spec: RouteSpec, seed_registry: Mapping[str, SeedSpec]) -> bool:
    """Report whether the route names an object the harness knows how to create."""
    return is_object_scoped(spec) and all(param in seed_registry for param in spec.params)


def classify_route(
    spec: RouteSpec,
    *,
    seed_registry: Mapping[str, SeedSpec],
    allowlist: Sequence[AllowlistEntry],
) -> Coverage:
    """Decide what the matrix does with one route.

    Args:
        spec: The route to classify.
        seed_registry: Seed strategies, keyed by path-parameter name.
        allowlist: The loaded opt-out entries.

    Returns:
        ``ALLOWLISTED`` when an entry names this route -- which wins even over a
        working seed strategy, so removing a route from the allow-list stays a
        deliberate act. Otherwise ``COVERED`` when the route addresses an object
        by id and every one of its parameters can be seeded, and ``UNCOVERED``
        for everything else, including templated routes that carry no id at all.
    """
    if _is_excused(spec, allowlist):
        return Coverage.ALLOWLISTED
    if _is_probeable(spec, seed_registry):
        return Coverage.COVERED
    return Coverage.UNCOVERED


def classify_routes(
    specs: Sequence[RouteSpec],
    *,
    seed_registry: Mapping[str, SeedSpec],
    allowlist: Sequence[AllowlistEntry],
) -> Classification:
    """Split a document's routes into the three buckets the report counts.

    Args:
        specs: Every route the document declares.
        seed_registry: Seed strategies, keyed by path-parameter name.
        allowlist: The loaded opt-out entries.

    Returns:
        The classification. Routes with no path parameters are left out
        entirely: a collection route carries no object reference, so it is
        neither probed nor excused, and counting it would inflate the
        denominator the allow-list bound is measured against.
    """
    buckets: dict[Coverage, list[RouteSpec]] = {coverage: [] for coverage in Coverage}
    for spec in specs:
        if not spec.params:
            continue
        buckets[classify_route(spec, seed_registry=seed_registry, allowlist=allowlist)].append(spec)
    return Classification(
        covered=tuple(buckets[Coverage.COVERED]),
        allowlisted=tuple(buckets[Coverage.ALLOWLISTED]),
        uncovered=tuple(buckets[Coverage.UNCOVERED]),
    )
