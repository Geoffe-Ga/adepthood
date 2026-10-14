"""The claim coverage manifest: which forbidden-effect tests back each privacy claim (#3158).

``claim_coverage.json`` beside this module has one entry per claim ``C03`` to
``C24`` of the claim ledger (#3076). Each entry says:

* ``status`` -- ``covered``, ``partial`` or ``uncovered``;
* ``tests`` -- pytest node ids, relative to the repository root;
* ``sinks`` -- the :class:`~privacy.sinks.SinkId` values the claim constrains;
* ``issue`` and a one-line ``gap`` -- required unless ``covered``: who owns
  what is missing;
* ``by_sink`` -- optional; required when ``covered``. For each constrained
  sink, the listed tests that assert absence there.

Declaring a gap is expected. Hiding one is not: ``covered`` needs a test
asserting absence at *every* sink the claim names, and no cited test may be a
strict xfail.

:func:`parse_manifest` checks the shape and :func:`manifest_findings` checks
the meaning. Whether a node id names a real test is a question about the test
tree, so the caller passes that in (``tests/support/pytest_node_ids.py``
answers it by AST, without running anything). This module never runs a test.

How to register a claim test: ``docs/privacy/claim-coverage.md``.

Stdlib-only, like the rest of :mod:`privacy`.
"""

from __future__ import annotations

import enum
import json
from collections.abc import Callable, Collection, Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Final, cast

#: The shipped manifest.
MANIFEST_PATH: Final = Path(__file__).with_name("claim_coverage.json")

_FIRST_CLAIM: Final = 3
_LAST_CLAIM: Final = 24
#: Every claim the manifest must carry, exactly once.
MANIFEST_CLAIMS: Final[tuple[str, ...]] = tuple(
    f"C{n:02d}" for n in range(_FIRST_CLAIM, _LAST_CLAIM + 1)
)

#: A gap is a line, not a paragraph.
MAX_GAP_LENGTH: Final = 200

_REQUIRED_FIELDS: Final = frozenset({"status", "tests", "sinks"})
_OPTIONAL_FIELDS: Final = frozenset({"issue", "gap", "by_sink"})


class CoverageStatus(enum.StrEnum):
    """How much of a claim its forbidden-effect tests prove."""

    COVERED = "covered"
    PARTIAL = "partial"
    UNCOVERED = "uncovered"


class NodeState(enum.StrEnum):
    """What a pytest node id resolves to in the test tree."""

    MISSING = "missing"
    PRESENT = "present"
    #: A test marked ``xfail``: it records a gap, it does not close one.
    XFAIL = "xfail"


class ManifestError(ValueError):
    """The manifest is not shaped like a manifest."""


@dataclass(frozen=True, slots=True)
class ClaimCoverage:
    """One claim's row of the manifest."""

    claim: str
    status: CoverageStatus
    tests: tuple[str, ...]
    sinks: tuple[str, ...]
    issue: int | None = None
    gap: str | None = None
    by_sink: Mapping[str, tuple[str, ...]] = field(default_factory=lambda: MappingProxyType({}))


# ── Shape ─────────────────────────────────────────────────────────────────────


def _no_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """``json`` keeps the last of two equal keys; a manifest must refuse them."""
    seen: dict[str, object] = {}
    for key, value in pairs:
        if key in seen:
            msg = f"duplicate key {key!r}"
            raise ManifestError(msg)
        seen[key] = value
    return seen


def _strings(value: object, where: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        msg = f"{where} must be a list of strings"
        raise ManifestError(msg)
    return tuple(cast("list[str]", value))


def _optional_issue(value: object, where: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        msg = f"{where}.issue must be an issue number"
        raise ManifestError(msg)
    return value


def _optional_gap(value: object, where: str) -> str | None:
    if value is None or isinstance(value, str):
        return value
    msg = f"{where}.gap must be a string"
    raise ManifestError(msg)


def _by_sink(value: object, where: str) -> Mapping[str, tuple[str, ...]]:
    if value is None:
        return MappingProxyType({})
    if not isinstance(value, dict):
        msg = f"{where}.by_sink must be an object"
        raise ManifestError(msg)
    items = cast("dict[str, object]", value).items()
    return MappingProxyType(
        {sink: _strings(tests, f"{where}.by_sink.{sink}") for sink, tests in items}
    )


def _status(value: object, where: str) -> CoverageStatus:
    try:
        return CoverageStatus(cast("str", value))
    except ValueError:
        msg = f"{where}.status must be one of {[s.value for s in CoverageStatus]}"
        raise ManifestError(msg) from None


def _entry(claim: str, value: object) -> ClaimCoverage:
    """One claim's object, checked field by field."""
    if not isinstance(value, dict):
        msg = f"{claim} must be an object"
        raise ManifestError(msg)
    raw = cast("dict[str, object]", value)
    fields = set(raw)
    if not _REQUIRED_FIELDS <= fields <= _REQUIRED_FIELDS | _OPTIONAL_FIELDS:
        msg = f"{claim} needs {sorted(_REQUIRED_FIELDS)} and may add {sorted(_OPTIONAL_FIELDS)}"
        raise ManifestError(msg)
    return ClaimCoverage(
        claim=claim,
        status=_status(raw["status"], claim),
        tests=_strings(raw["tests"], f"{claim}.tests"),
        sinks=_strings(raw["sinks"], f"{claim}.sinks"),
        issue=_optional_issue(raw.get("issue"), claim),
        gap=_optional_gap(raw.get("gap"), claim),
        by_sink=_by_sink(raw.get("by_sink"), claim),
    )


def parse_manifest(text: str) -> tuple[ClaimCoverage, ...]:
    """Parse manifest JSON into rows, refusing anything not shaped like one.

    Raises:
        ManifestError: not JSON, not an object of objects, a duplicate key, an
            unknown or missing field, or a field of the wrong type.
    """
    try:
        document: object = json.loads(text, object_pairs_hook=_no_duplicate_keys)
    except json.JSONDecodeError as exc:
        msg = f"the manifest is not JSON: {exc.msg}"
        raise ManifestError(msg) from None
    if not isinstance(document, dict):
        msg = "the manifest must be an object keyed by claim id"
        raise ManifestError(msg)
    claims = cast("dict[str, object]", document)
    return tuple(_entry(claim, value) for claim, value in claims.items())


def load_manifest(path: Path = MANIFEST_PATH) -> tuple[ClaimCoverage, ...]:
    """Read and parse the manifest at ``path``."""
    return parse_manifest(path.read_text(encoding="utf-8"))


# ── Meaning ───────────────────────────────────────────────────────────────────


def _duplicates(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    repeated: list[str] = []
    for value in values:
        if value in seen:
            repeated.append(value)
        seen.add(value)
    return repeated


def _not_in(values: Iterable[str], allowed: Collection[str]) -> list[str]:
    return [value for value in values if value not in allowed]


def _say(claim: str, template: str, values: Iterable[str]) -> list[str]:
    """One finding per value: ``template`` with ``{}`` standing for the value."""
    return [f"{claim} " + template.format(value) for value in values]


def _claim_set_findings(rows: tuple[ClaimCoverage, ...]) -> list[str]:
    present = {row.claim for row in rows}
    missing = _not_in(MANIFEST_CLAIMS, present)
    unknown = sorted(_not_in(present, MANIFEST_CLAIMS))
    return [
        *(f"{claim} has no manifest entry" for claim in missing),
        *(f"{claim} is not a claim this manifest tracks" for claim in unknown),
    ]


def _issue_findings(row: ClaimCoverage) -> list[str]:
    """``partial`` and ``uncovered`` name the issue that owns the rest."""
    if row.issue is None or row.issue <= 0:
        return [f"{row.claim} is {row.status} but names no owning issue"]
    return []


def _gap_line_findings(row: ClaimCoverage) -> list[str]:
    """``partial`` and ``uncovered`` say what the rest is, in one short line."""
    gap = row.gap or ""
    if not gap.strip():
        return [f"{row.claim} is {row.status} but states no gap"]
    if "\n" in gap or len(gap) > MAX_GAP_LENGTH:
        return [f"{row.claim} gap must be one line of at most {MAX_GAP_LENGTH} characters"]
    return []


def _covered_owes_nothing(row: ClaimCoverage) -> list[str]:
    """A covered claim carries no gap, and constrains at least one sink."""
    findings: list[str] = []
    if row.issue is not None or row.gap is not None:
        findings.append(f"{row.claim} is covered, so it carries no issue or gap")
    if not row.sinks:
        findings.append(f"{row.claim} is covered but constrains no sink")
    return findings


def _covered_proof(row: ClaimCoverage, states: Mapping[str, NodeState]) -> list[str]:
    """``covered`` is a strong word: every sink has an absence test, none an xfail."""
    unproven = [sink for sink in row.sinks if not row.by_sink.get(sink)]
    xfails = [test for test in row.tests if states.get(test) is NodeState.XFAIL]
    return [
        *_say(row.claim, "is covered but no test asserts at {}", unproven),
        *_say(row.claim, "is covered but cites an xfail: {}", xfails),
    ]


def _status_findings(row: ClaimCoverage, states: Mapping[str, NodeState]) -> list[str]:
    findings: list[str] = []
    if row.status is not CoverageStatus.UNCOVERED and not row.tests:
        findings.append(f"{row.claim} is {row.status} but lists no test")
    if row.status is CoverageStatus.COVERED:
        findings.extend(_covered_owes_nothing(row) + _covered_proof(row, states))
    else:
        findings.extend(_issue_findings(row) + _gap_line_findings(row))
    return findings


def _by_sink_findings(row: ClaimCoverage) -> list[str]:
    """``by_sink`` may only refine the row's own sinks and tests."""
    findings: list[str] = []
    for sink, tests in row.by_sink.items():
        if sink not in row.sinks:
            findings.append(f"{row.claim}.by_sink names {sink}, which the claim does not list")
        strays = _not_in(tests, row.tests)
        findings.extend(_say(f"{row.claim}.by_sink.{sink}", "cites unlisted {}", strays))
    return findings


def _reference_findings(
    row: ClaimCoverage, known_sinks: frozenset[str], states: Mapping[str, NodeState]
) -> list[str]:
    """Every test resolves, every sink exists, and neither is listed twice."""
    missing = [test for test in row.tests if states[test] is NodeState.MISSING]
    return [
        *_say(row.claim, "cites a test that does not exist: {}", missing),
        *_say(row.claim, "names an unregistered sink: {}", _not_in(row.sinks, known_sinks)),
        *_say(row.claim, "lists twice: {}", _duplicates(row.tests)),
        *_say(row.claim, "lists twice: {}", _duplicates(row.sinks)),
    ]


def manifest_findings(
    rows: tuple[ClaimCoverage, ...],
    *,
    known_sinks: frozenset[str],
    node_state: Callable[[str], NodeState],
) -> tuple[str, ...]:
    """Everything wrong with ``rows``, or nothing.

    Args:
        rows: The parsed manifest.
        known_sinks: Every registered sink id -- the values of
            :data:`privacy.sinks.SINKS`.
        node_state: Resolves a node id against the test tree, without running it.
    """
    findings = _claim_set_findings(rows)
    for row in rows:
        states = {test: node_state(test) for test in row.tests}
        findings.extend(_reference_findings(row, known_sinks, states))
        findings.extend(_status_findings(row, states))
        findings.extend(_by_sink_findings(row))
    return tuple(findings)
