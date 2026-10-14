"""Every privacy claim names its forbidden-effect tests, and every sink is registered (#3158).

Two artifacts, held to the code rather than to themselves:

* the **sink registry** (:mod:`privacy.sinks`) must mirror all five
  inventories -- the recipient register, the store inventory, the encrypted
  columns, the telemetry transports and the detached egress entry points -- so
  a sink planted in any of them with no registry row fails here;
* the **claim coverage manifest** (``privacy/claim_coverage.json``) must carry
  each claim ``C03`` to ``C24`` once, cite only tests that exist and sinks that
  are registered, and name an owning issue and a gap for anything not
  ``covered``.

Structure only: no claim's tests run from this gate. They run in the normal
backend lane. Each rule has a negative control below -- a planted bogus node
id, a fake sink, a planted recipient, store, column, transport and door -- because
a gate that cannot fail proves nothing.
"""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Final

import pytest
from sqlalchemy import Column, Integer, MetaData, Table

from domain.privacy_tier import DENIED_TIERS, EGRESS_ELIGIBLE_TIERS
from domain.retention_stores import STORES, Controller, Days, Store
from models.journal_entry import JournalClassification
from privacy.claim_coverage import (
    MANIFEST_CLAIMS,
    MANIFEST_PATH,
    MAX_GAP_LENGTH,
    ClaimCoverage,
    CoverageStatus,
    ManifestError,
    NodeState,
    load_manifest,
    manifest_findings,
    parse_manifest,
)
from privacy.recipients import RECIPIENTS, RecipientId
from privacy.sinks import (
    ALL_TIERS,
    EGRESS_TIERS,
    INTIMATE,
    NO_TIERS,
    SINKS,
    Inventory,
    Sink,
    SinkId,
    SinkKind,
    SourceRef,
    registry_gaps,
)
from security.secret_shapes import redact_secret_shapes
from services.journal_encryption import EncryptedString
from tests.helpers.telemetry_canaries import SENTINELS, assert_no_canary
from tests.support.pytest_node_ids import node_state
from tests.support.sink_inventories import (
    TELEMETRY_INVENTORY,
    detached_egress_keys,
    encrypted_column_keys,
    recipient_keys,
    shipped_inventories,
    store_keys,
    telemetry_transport_keys,
)

KNOWN_SINKS: Final = frozenset(sink.value for sink in SinkId)
REAL_TEST: Final = (
    "backend/tests/security/test_telemetry_sentinels.py"
    "::test_route_raising_a_canary_ships_a_clean_but_diagnosable_event"
)
XFAIL_TEST: Final = (
    "backend/tests/test_privacy_lineage.py"
    "::test_folded_intimate_quote_never_reaches_resonance_prompt"
)
BOGUS_TEST: Final = (
    "backend/tests/security/test_telemetry_sentinels.py::test_that_was_never_written"
)
FAKE_SINK: Final = "telemetry.a_beacon_nobody_registered"
PLANTED: Final = "planted_by_the_negative_control"


# ── The shipped artifacts ─────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def inventories() -> Mapping[Inventory, frozenset[str]]:
    """Every inventory, read once from the tree."""
    return shipped_inventories()


def test_the_shipped_manifest_has_no_findings() -> None:
    """Every claim once, every test real, every sink registered, every gap owned."""
    rows = load_manifest()

    findings = manifest_findings(rows, known_sinks=KNOWN_SINKS, node_state=node_state)

    assert findings == ()
    assert tuple(row.claim for row in rows) == MANIFEST_CLAIMS


def test_no_shipped_claim_is_covered_without_a_test_at_every_sink() -> None:
    """``covered`` is earned per sink; the seed claims nothing it cannot show."""
    for row in load_manifest():
        if row.status is CoverageStatus.COVERED:
            assert set(row.by_sink) == set(row.sinks), row.claim


def test_the_registry_mirrors_every_inventory(
    inventories: Mapping[Inventory, frozenset[str]],
) -> None:
    """No inventory row lacks a sink, and no sink cites a row that is gone."""
    gaps = registry_gaps(SINKS.values(), inventories)

    assert gaps.unregistered == frozenset()
    assert gaps.stale == frozenset()
    assert gaps.clean


def test_every_inventory_is_read_and_is_not_empty(
    inventories: Mapping[Inventory, frozenset[str]],
) -> None:
    """A reader that silently found nothing would make the reconciliation vacuous."""
    assert set(inventories) == set(Inventory)
    assert all(inventories.values()), inventories


def test_every_sink_id_has_exactly_one_row() -> None:
    """The enum and the table cannot drift apart."""
    assert set(SINKS) == set(SinkId)
    assert all(sink_id is row.id for sink_id, row in SINKS.items())


def test_the_registry_tiers_are_the_journal_tiers() -> None:
    """The registry's tier words are ``domain.privacy_tier``'s, not a parallel spelling."""
    assert frozenset(EGRESS_ELIGIBLE_TIERS) == EGRESS_TIERS
    assert frozenset(EGRESS_ELIGIBLE_TIERS) | DENIED_TIERS == ALL_TIERS
    assert {tier.value for tier in JournalClassification} == ALL_TIERS
    assert INTIMATE in DENIED_TIERS


def test_no_sink_outside_the_primary_boundary_admits_intimate() -> None:
    """C07, as data: Intimate content may only rest inside the primary boundary."""
    for sink in SINKS.values():
        if not sink.in_primary_boundary:
            assert INTIMATE not in sink.tiers, sink.id


def test_a_recipient_the_register_sends_no_content_admits_no_tier() -> None:
    """The registry may not promise a recipient content the register says it never gets."""
    for sink in SINKS.values():
        for source in sink.sources:
            if source.inventory is Inventory.RECIPIENT_REGISTER:
                recipient = RECIPIENTS[RecipientId(source.key)]
                assert recipient.carries_content or sink.tiers == NO_TIERS, sink.id


def test_registry_and_manifest_carry_no_content_or_secrets() -> None:
    """Neither artifact is a place to paste a canary, a key or a document."""
    text = MANIFEST_PATH.read_text(encoding="utf-8") + repr(tuple(SINKS.values()))

    for canary in SENTINELS:
        assert_no_canary(text, canary)
    assert redact_secret_shapes(text) == text


# ── Sink registry: rows refuse contradictions ─────────────────────────────────


_OPENAI_SOURCE: Final = (SourceRef(Inventory.RECIPIENT_REGISTER, RecipientId.OPENAI.value),)


def _sink(
    *,
    sources: tuple[SourceRef, ...] = _OPENAI_SOURCE,
    tiers: frozenset[str] = EGRESS_TIERS,
    in_primary_boundary: bool = False,
) -> Sink:
    return Sink(SinkId.OPENAI, SinkKind.NETWORK_RECIPIENT, sources, tiers, in_primary_boundary)


def test_a_sink_outside_the_boundary_that_admits_intimate_is_refused() -> None:
    """The C07 contradiction cannot be written down."""
    with pytest.raises(ValueError, match="outside the primary boundary"):
        _sink(tiers=ALL_TIERS)


def test_a_sink_no_inventory_backs_is_refused() -> None:
    """Every row mirrors at least one inventory row."""
    with pytest.raises(ValueError, match="mirrors no inventory row"):
        _sink(sources=())


def test_a_sink_naming_an_unknown_tier_is_refused() -> None:
    """A misspelt tier is not a new tier."""
    with pytest.raises(ValueError, match="tier that does not exist"):
        _sink(tiers=frozenset({"Personal"}))


def test_a_sink_inside_the_boundary_may_hold_intimate() -> None:
    """Positive control: the primary database is where Intimate entries live."""
    assert INTIMATE in _sink(tiers=ALL_TIERS, in_primary_boundary=True).tiers


# ── Sink registry: a planted sink in any inventory fails ──────────────────────


def _unregistered_after(inventory: Inventory, keys: frozenset[str]) -> frozenset[SourceRef]:
    planted = {**shipped_inventories(), inventory: keys}
    return registry_gaps(SINKS.values(), planted).unregistered


def test_a_planted_recipient_with_no_sink_fails() -> None:
    """A new register row is a new sink until someone decides its tiers and boundary."""
    keys = recipient_keys((*RECIPIENTS, PLANTED))

    gaps = _unregistered_after(Inventory.RECIPIENT_REGISTER, keys)

    assert gaps == {SourceRef(Inventory.RECIPIENT_REGISTER, PLANTED)}


def test_a_planted_store_with_no_sink_fails() -> None:
    """A store added to the retention inventory needs a sink row too."""
    store = Store(PLANTED, "a synthetic store", Controller.ADEPTHOOD, Days(1), "this test")

    gaps = _unregistered_after(Inventory.RETENTION_STORES, store_keys((*STORES, store)))

    assert gaps == {SourceRef(Inventory.RETENTION_STORES, PLANTED)}


def test_a_planted_encrypted_column_with_no_sink_fails() -> None:
    """A column typed ``EncryptedString`` is found from the schema, not from a list."""
    metadata = MetaData()
    Table(
        PLANTED,
        metadata,
        Column("id", Integer, primary_key=True),
        Column("body", EncryptedString()),
    )
    keys = encrypted_column_keys() | encrypted_column_keys(metadata)

    gaps = _unregistered_after(Inventory.ENCRYPTED_COLUMNS, keys)

    assert gaps == {SourceRef(Inventory.ENCRYPTED_COLUMNS, f"{PLANTED}.body")}


def test_a_planted_telemetry_transport_with_no_sink_fails() -> None:
    """A row added to the telemetry inventory's table is a sink the registry must name."""
    doc = TELEMETRY_INVENTORY.read_text(encoding="utf-8")
    row = "| 12 | **`planted.beacon`** (synthetic) | nothing | none | none | n/a | n/a |"
    planted = doc.replace("\n\n## Open rows", f"\n{row}\n\n## Open rows", 1)
    assert planted != doc, "the inventory table moved; re-anchor the plant"

    keys = telemetry_transport_keys(planted)
    gaps = _unregistered_after(Inventory.TELEMETRY_TRANSPORTS, keys)

    assert gaps == {SourceRef(Inventory.TELEMETRY_TRANSPORTS, "planted.beacon")}


def test_a_planted_detached_entry_point_with_no_sink_fails() -> None:
    """A new detached egress door names the queue it drains."""
    keys = detached_egress_keys((*detached_egress_keys(), PLANTED))

    gaps = _unregistered_after(Inventory.DETACHED_EGRESS, keys)

    assert gaps == {SourceRef(Inventory.DETACHED_EGRESS, PLANTED)}


def test_a_sink_citing_a_removed_inventory_row_is_stale(
    inventories: Mapping[Inventory, frozenset[str]],
) -> None:
    """A row mirroring something the inventory dropped is reported, not kept quietly."""
    removed = RecipientId.GUMROAD.value
    register = inventories[Inventory.RECIPIENT_REGISTER] - {removed}
    shrunk = {**inventories, Inventory.RECIPIENT_REGISTER: register}

    gaps = registry_gaps(SINKS.values(), shrunk)

    assert gaps.stale == {SourceRef(Inventory.RECIPIENT_REGISTER, removed)}
    assert not gaps.clean


def test_an_inventory_nobody_read_makes_every_citation_stale(
    inventories: Mapping[Inventory, frozenset[str]],
) -> None:
    """A gatherer that stopped reading an inventory fails rather than passing over nothing."""
    unread: dict[Inventory, frozenset[str]] = {
        k: v for k, v in inventories.items() if k is not Inventory.DETACHED_EGRESS
    }

    gaps = registry_gaps(SINKS.values(), unread)

    assert {ref.inventory for ref in gaps.stale} == {Inventory.DETACHED_EGRESS}


# ── Manifest: the validator rejects what it must ──────────────────────────────

_BASE_ROW: Final = ClaimCoverage(
    claim="C12",
    status=CoverageStatus.PARTIAL,
    tests=(REAL_TEST,),
    sinks=(SinkId.SENTRY_ENVELOPE.value,),
    issue=3064,
    gap="a synthetic gap",
)


_COVERED_ROW: Final = dataclasses.replace(
    _BASE_ROW,
    status=CoverageStatus.COVERED,
    issue=None,
    gap=None,
    by_sink={SinkId.SENTRY_ENVELOPE.value: (REAL_TEST,)},
)


def _findings(*rows: ClaimCoverage) -> tuple[str, ...]:
    """Findings for ``rows`` alone, minus the claims they leave out of the set."""
    found = manifest_findings(rows, known_sinks=KNOWN_SINKS, node_state=node_state)
    return tuple(f for f in found if not f.endswith("has no manifest entry"))


def _full_manifest(replacement: ClaimCoverage) -> tuple[ClaimCoverage, ...]:
    rows = load_manifest()
    return tuple(replacement if row.claim == replacement.claim else row for row in rows)


def test_a_valid_partial_row_has_no_findings() -> None:
    """Positive control: the rejections below are about the plant, not the base row."""
    assert _findings(_BASE_ROW) == ()


def test_a_valid_covered_row_has_no_findings() -> None:
    """Positive control: ``covered`` is reachable, with an absence test at every sink."""
    assert _findings(_COVERED_ROW) == ()


def test_a_planted_bogus_node_id_fails() -> None:
    """A manifest cannot point a claim at a test that does not exist."""
    findings = _findings(dataclasses.replace(_BASE_ROW, tests=(REAL_TEST, BOGUS_TEST)))

    assert findings == (f"C12 cites a test that does not exist: {BOGUS_TEST}",)


def test_a_planted_fake_sink_fails() -> None:
    """A manifest cannot constrain a sink the registry does not hold."""
    findings = _findings(
        dataclasses.replace(_BASE_ROW, sinks=(SinkId.SENTRY_ENVELOPE.value, FAKE_SINK))
    )

    assert findings == (f"C12 names an unregistered sink: {FAKE_SINK}",)


def test_the_shipped_manifest_with_a_bogus_id_and_a_fake_sink_fails() -> None:
    """The negative control, run through the whole shipped manifest."""
    shipped = next(row for row in load_manifest() if row.claim == "C12")
    planted = dataclasses.replace(
        shipped, tests=(*shipped.tests, BOGUS_TEST), sinks=(*shipped.sinks, FAKE_SINK)
    )

    findings = manifest_findings(
        _full_manifest(planted), known_sinks=KNOWN_SINKS, node_state=node_state
    )

    assert set(findings) == {
        f"C12 cites a test that does not exist: {BOGUS_TEST}",
        f"C12 names an unregistered sink: {FAKE_SINK}",
    }


def test_a_missing_and_an_unknown_claim_are_reported() -> None:
    """Each of C03-C24 exactly once, and nothing else."""
    rows = tuple(row for row in load_manifest() if row.claim != "C07")

    findings = manifest_findings(
        (*rows, dataclasses.replace(_BASE_ROW, claim="C99")),
        known_sinks=KNOWN_SINKS,
        node_state=node_state,
    )

    assert set(findings) == {
        "C07 has no manifest entry",
        "C99 is not a claim this manifest tracks",
    }


@pytest.mark.parametrize("status", [CoverageStatus.PARTIAL, CoverageStatus.UNCOVERED])
def test_a_declared_gap_needs_an_owner_and_a_line(status: CoverageStatus) -> None:
    """Anything short of ``covered`` says which issue owns the rest, and what the rest is."""
    findings = _findings(dataclasses.replace(_BASE_ROW, status=status, issue=None, gap="  "))

    assert findings == (
        f"C12 is {status} but names no owning issue",
        f"C12 is {status} but states no gap",
    )


@pytest.mark.parametrize("gap", ["line one\nline two", "x" * (MAX_GAP_LENGTH + 1)])
def test_a_gap_is_one_short_line(gap: str) -> None:
    """A gap is a pointer, not a paragraph."""
    findings = _findings(dataclasses.replace(_BASE_ROW, gap=gap))

    assert findings == (f"C12 gap must be one line of at most {MAX_GAP_LENGTH} characters",)


def test_a_partial_row_lists_a_test() -> None:
    """``partial`` with nothing behind it is ``uncovered``."""
    assert _findings(dataclasses.replace(_BASE_ROW, tests=())) == (
        "C12 is partial but lists no test",
    )


def test_an_uncovered_row_may_list_xfail_reproducers() -> None:
    """A strict xfail records a gap honestly; ``uncovered`` may cite one."""
    row = dataclasses.replace(_BASE_ROW, status=CoverageStatus.UNCOVERED, tests=(XFAIL_TEST,))

    assert _findings(row) == ()


def test_covered_without_a_test_at_every_sink_fails() -> None:
    """``covered`` needs an absence assertion at each constrained sink."""
    extra = SinkId.ROOT_LOG.value
    findings = _findings(
        dataclasses.replace(_COVERED_ROW, sinks=(SinkId.SENTRY_ENVELOPE.value, extra))
    )

    assert findings == (f"C12 is covered but no test asserts at {extra}",)


def test_covered_citing_an_xfail_fails() -> None:
    """An expected failure documents a gap; it cannot close one."""
    sink = SinkId.SENTRY_ENVELOPE.value
    row = dataclasses.replace(
        _COVERED_ROW, tests=(REAL_TEST, XFAIL_TEST), by_sink={sink: (REAL_TEST, XFAIL_TEST)}
    )

    assert _findings(row) == (f"C12 is covered but cites an xfail: {XFAIL_TEST}",)


def test_covered_with_a_leftover_gap_or_no_sink_fails() -> None:
    """A covered claim owes nothing, and constrains something."""
    assert _findings(dataclasses.replace(_COVERED_ROW, issue=3064)) == (
        "C12 is covered, so it carries no issue or gap",
    )
    assert _findings(dataclasses.replace(_COVERED_ROW, sinks=(), by_sink={})) == (
        "C12 is covered but constrains no sink",
    )


def test_covered_without_tests_fails() -> None:
    """``covered`` with no test is the claim the manifest exists to stop."""
    sink = SinkId.SENTRY_ENVELOPE.value
    findings = _findings(dataclasses.replace(_COVERED_ROW, tests=(), by_sink={sink: ()}))

    assert findings == (
        "C12 is covered but lists no test",
        f"C12 is covered but no test asserts at {sink}",
    )


def test_by_sink_refines_only_the_rows_own_sinks_and_tests() -> None:
    """A per-sink test map cannot smuggle in a sink or a test the row does not list."""
    other = SinkId.ROOT_LOG.value
    row = dataclasses.replace(_BASE_ROW, by_sink={other: (BOGUS_TEST,)})

    assert _findings(row) == (
        f"C12.by_sink names {other}, which the claim does not list",
        f"C12.by_sink.{other} cites unlisted {BOGUS_TEST}",
    )


def test_a_test_or_sink_listed_twice_is_reported() -> None:
    """Duplicates inflate a row without adding evidence."""
    sink = SinkId.SENTRY_ENVELOPE.value
    row = dataclasses.replace(_BASE_ROW, tests=(REAL_TEST, REAL_TEST), sinks=(sink, sink))

    assert _findings(row) == (
        f"C12 lists twice: {REAL_TEST}",
        f"C12 lists twice: {sink}",
    )


# ── Manifest: the parser refuses what is not a manifest ───────────────────────

_GOOD_ENTRY: Final = {"status": "uncovered", "tests": [], "sinks": [], "issue": 1, "gap": "g"}


def _parse_one(entry: object) -> tuple[ClaimCoverage, ...]:
    return parse_manifest(json.dumps({"C03": entry}))


def test_the_parser_reads_a_well_formed_entry() -> None:
    """Positive control for every rejection below."""
    by_sink = {"by_sink": {SinkId.ROOT_LOG.value: [REAL_TEST]}}
    (row,) = _parse_one({**_GOOD_ENTRY, **by_sink})

    assert row == ClaimCoverage(
        "C03",
        CoverageStatus.UNCOVERED,
        (),
        (),
        1,
        "g",
        {SinkId.ROOT_LOG.value: (REAL_TEST,)},
    )


def test_the_parser_reads_a_covered_entry_without_issue_or_gap() -> None:
    """``issue``, ``gap`` and ``by_sink`` are optional fields, absent when not owed."""
    (row,) = _parse_one({"status": "covered", "tests": [REAL_TEST], "sinks": []})

    assert (row.status, row.issue, row.gap, dict(row.by_sink)) == (
        CoverageStatus.COVERED,
        None,
        None,
        {},
    )


def test_a_duplicate_claim_key_is_refused() -> None:
    """``json`` would silently keep the second; the manifest refuses both."""
    entry = json.dumps(_GOOD_ENTRY)
    with pytest.raises(ManifestError, match="duplicate key 'C03'"):
        parse_manifest(f'{{"C03": {entry}, "C03": {entry}}}')


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("{not json", "not JSON"),
        ("[]", "object keyed by claim id"),
        ('{"C03": []}', "C03 must be an object"),
    ],
)
def test_a_document_of_the_wrong_shape_is_refused(text: str, message: str) -> None:
    """Not JSON, not an object, or an entry that is not an object."""
    with pytest.raises(ManifestError, match=message):
        parse_manifest(text)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"reviewer": "x"}, "may add"),
        ({"status": "done"}, "status must be one of"),
        ({"tests": "one"}, "tests must be a list of strings"),
        ({"sinks": [1]}, "sinks must be a list of strings"),
        ({"issue": True}, "issue must be an issue number"),
        ({"issue": "3064"}, "issue must be an issue number"),
        ({"gap": 7}, "gap must be a string"),
        ({"by_sink": []}, "by_sink must be an object"),
        ({"by_sink": {"telemetry.root_log": "t"}}, "by_sink.telemetry.root_log must be a list"),
    ],
)
def test_a_field_of_the_wrong_type_is_refused(change: dict[str, object], message: str) -> None:
    """Every field is checked, so a typo cannot read as an absent value."""
    with pytest.raises(ManifestError, match=message):
        _parse_one({**_GOOD_ENTRY, **change})


def test_a_missing_required_field_is_refused() -> None:
    """``status``, ``tests`` and ``sinks`` are always present, even when empty."""
    entry = {k: v for k, v in _GOOD_ENTRY.items() if k != "sinks"}
    with pytest.raises(ManifestError, match="needs"):
        _parse_one(entry)


# ── Node ids resolve by reading the tree ──────────────────────────────────────

_FIXTURE: Final = """
import pytest

def helper():
    pass

def test_plain():
    pass

@pytest.mark.xfail(strict=True, reason="a recorded gap")
async def test_expected_to_fail():
    pass

@pytest.mark.xfail
def test_bare_xfail():
    pass

@pytest.mark.parametrize("n", [1])
def test_param(n):
    pass

class TestGroup:
    def test_method(self):
        pass

class Helper:
    def test_method(self):
        pass
"""


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    """A tiny repository with one test module."""
    module = tmp_path / "backend" / "tests" / "test_fixture.py"
    module.parent.mkdir(parents=True)
    module.write_text(_FIXTURE, encoding="utf-8")
    (tmp_path / "backend" / "tests" / "not_python.txt").write_text("", encoding="utf-8")
    return tmp_path


_MODULE: Final = "backend/tests/test_fixture.py"


@pytest.mark.parametrize(
    ("node_id", "expected"),
    [
        (f"{_MODULE}::test_plain", NodeState.PRESENT),
        (f"{_MODULE}::test_param[1]", NodeState.PRESENT),
        (f"{_MODULE}::TestGroup::test_method", NodeState.PRESENT),
        (f"{_MODULE}::test_expected_to_fail", NodeState.XFAIL),
        (f"{_MODULE}::test_bare_xfail", NodeState.XFAIL),
        (f"{_MODULE}::test_never_written", NodeState.MISSING),
        (f"{_MODULE}::helper", NodeState.MISSING),
        (f"{_MODULE}::Helper::test_method", NodeState.MISSING),
        (f"{_MODULE}::TestGroup::test_absent", NodeState.MISSING),
        (f"{_MODULE}::test_plain::too::deep", NodeState.MISSING),
        (_MODULE, NodeState.MISSING),
        ("backend/tests/test_absent.py::test_plain", NodeState.MISSING),
        ("backend/tests/not_python.txt::test_plain", NodeState.MISSING),
        ("backend/tests/../tests/test_fixture.py::test_plain", NodeState.MISSING),
        ("/backend/tests/test_fixture.py::test_plain", NodeState.MISSING),
    ],
)
def test_a_node_id_resolves_without_running_anything(
    tree: Path, node_id: str, expected: NodeState
) -> None:
    """Functions, methods, parameters and xfails are told apart; anything else is missing."""
    assert node_state(node_id, tree) is expected


def test_the_shipped_ids_resolve_against_the_real_tree() -> None:
    """Counterweight: the known-real and known-xfail ids resolve as such here."""
    assert node_state(REAL_TEST) is NodeState.PRESENT
    assert node_state(XFAIL_TEST) is NodeState.XFAIL
    assert node_state(BOGUS_TEST) is NodeState.MISSING
