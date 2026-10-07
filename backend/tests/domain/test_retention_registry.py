"""The retention registry must cover the schema and agree with the deletion policy.

The deletion policy (:mod:`domain.account_deletion`) answers *what happens to a
table when an account is erased*. It says nothing about *how long* a row lives
before that, or after it for the tables that survive. The registry
(:mod:`domain.retention`) answers that second question, and it is held to the
same standard: total over the ORM metadata, so a new model is a failing test
rather than a lifetime nobody decided (#3063).

The pins below are deliberately structural:

* totality is checked against a *copy* of the metadata with an extra table, so
  the detector is proven to fire and not merely to be silent;
* the anti-inheritance pin adds that extra table to a patched deletion policy as
  ERASE and asserts it is **still** a retention gap -- a registry that derived
  its rules from the deletion policy would quietly pass every new table;
* the ERASE/INDEFINITE contradiction is proven to be reported by flipping one
  real rule, not by reading the code.
"""

from __future__ import annotations

import pytest
from sqlalchemy import Column, ForeignKey, Integer, MetaData, Table
from sqlmodel import SQLModel

from domain import retention
from domain.account_deletion import POLICY, Disposition, TablePolicy
from domain.retention import (
    ENTRY_PURGE_BLOCKERS,
    RETENTION,
    RetentionKind,
    RetentionRule,
    entry_dependant_gaps,
    entry_dependants,
    indefinite,
    retention_conflicts,
    retention_gaps,
    retention_report,
    swept_by,
    unratified_rules,
)
from models.feedback import FEEDBACK_RETENTION_DAYS
from models.voice_draft_retraction import VoiceDraftRetractionState
from services.energy import ENERGY_PLAN_RETENTION_DAYS
from tests.helpers.openapi_errors import route_index

_NEW_TABLE = "zz_new"
# Rules whose lifetime is an open owner/legal decision (#3063 AC15); each must
# be surfaced as unratified until the owner says otherwise.
_KNOWN_UNRATIFIED = frozenset({"gumroadsale", "loginattempt", "llmusagelog"})
_FORBIDDEN_FOR_ERASE = frozenset({RetentionKind.INDEFINITE, RetentionKind.SHARED_CATALOGUE})


def _metadata_with_new_table() -> MetaData:
    """A copy of the live schema plus one table nobody has declared a rule for."""
    copied = MetaData()
    for table in SQLModel.metadata.tables.values():
        table.to_metadata(copied)
    Table(_NEW_TABLE, copied, Column("id", Integer, primary_key=True))
    return copied


def test_every_table_has_a_retention_rule() -> None:
    """The registry is total over the live schema."""
    assert retention_gaps(SQLModel.metadata) == ()


def test_unregistered_table_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    """A new table is a gap, even when the deletion policy already erases it."""
    copied = _metadata_with_new_table()
    gaps = retention_gaps(copied)
    assert any(_NEW_TABLE in gap for gap in gaps)

    patched_policy = {
        **POLICY,
        _NEW_TABLE: TablePolicy(disposition=Disposition.ERASE, rationale="synthetic"),
    }
    monkeypatch.setattr("domain.account_deletion.POLICY", patched_policy)
    monkeypatch.setattr(retention, "POLICY", patched_policy)
    assert any(_NEW_TABLE in gap for gap in retention_gaps(copied))


def test_rule_for_a_table_that_no_longer_exists_is_reported() -> None:
    """A stale rule is a gap too: it describes a lifetime nobody stores any more."""
    trimmed = MetaData()
    for name, table in SQLModel.metadata.tables.items():
        if name != "habit":
            table.to_metadata(trimmed)
    assert any("habit" in gap for gap in retention_gaps(trimmed))


def test_erased_tables_cannot_outlive_the_account(monkeypatch: pytest.MonkeyPatch) -> None:
    """An ERASE table's top-level lifetime is bounded by the account."""
    for name, policy in POLICY.items():
        if policy.disposition is Disposition.ERASE:
            assert RETENTION[name].kind not in _FORBIDDEN_FOR_ERASE, name
    assert retention_conflicts() == ()

    flipped = {**RETENTION, "habit": indefinite("synthetic contradiction", ratified=False)}
    monkeypatch.setattr(retention, "RETENTION", flipped)
    conflicts = retention_conflicts()
    assert len(conflicts) == 1
    assert "habit" in conflicts[0]


def test_surviving_tables_cannot_claim_to_die_with_the_account(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A RETAIN/ANONYMISE row outlives the account, so 'until deletion' is a lie."""
    assert POLICY["gumroadsale"].disposition is Disposition.ANONYMISE
    flipped = {
        **RETENTION,
        "gumroadsale": RetentionRule(
            kind=RetentionKind.UNTIL_ACCOUNT_DELETION,
            trigger="account deletion",
            rationale="synthetic contradiction",
        ),
    }
    monkeypatch.setattr(retention, "RETENTION", flipped)
    conflicts = retention_conflicts()
    assert len(conflicts) == 1
    assert "gumroadsale" in conflicts[0]


def test_retained_and_anonymised_tables_declare_bound_or_reason() -> None:
    """Every surviving table's lifetime is bounded, or an explicit unratified reason."""
    assert set(unratified_rules()) >= _KNOWN_UNRATIFIED
    for name, policy in POLICY.items():
        if policy.disposition is Disposition.ERASE:
            continue
        rule = RETENTION[name]
        if rule.kind is RetentionKind.INDEFINITE:
            assert rule.rationale.strip(), name
            assert not rule.ratified, f"{name}: an indefinite lifetime is the owner's to ratify"


def test_indefinite_requires_a_reason() -> None:
    """An indefinite lifetime with no stated reason cannot even be constructed."""
    with pytest.raises(ValueError, match="reason"):
        indefinite("   ", ratified=False)


def test_swept_by_requires_method_and_path() -> None:
    """A sweep route is named exactly as the router serves it."""
    with pytest.raises(ValueError, match="METHOD /path"):
        swept_by("/admin/maintenance/energy-plans", trigger="t", rationale="r")


def _all_rules() -> list[tuple[str, RetentionRule]]:
    """Top-level rules plus every nested soft-delete rule."""
    rules: list[tuple[str, RetentionRule]] = []
    for name, rule in RETENTION.items():
        rules.append((name, rule))
        if rule.soft_deleted is not None:
            rules.append((f"{name} (soft-deleted)", rule.soft_deleted))
    return rules


def test_swept_by_rules_name_a_live_route() -> None:
    """A rule that says 'a sweep removes these' names a sweep the app really serves."""
    served = set(route_index())
    swept = [(name, rule) for name, rule in _all_rules() if rule.kind is RetentionKind.SWEPT_BY]
    assert swept, "no swept_by rule exists -- this guard is vacuous"
    for name, rule in swept:
        assert rule.sweep_route is not None
        method, path = rule.sweep_route.split(" ", 1)
        assert (method, path) in served, f"{name}: {rule.sweep_route} is not served"

    assert RETENTION["energyplan"].days == ENERGY_PLAN_RETENTION_DAYS
    assert RETENTION["feedbackreport"].days == FEEDBACK_RETENTION_DAYS


def test_report_names_every_table_and_flags_the_unratified() -> None:
    """The generated report is the owner's ratification worklist."""
    report = retention_report()
    for name in SQLModel.metadata.tables:
        assert name in report
    assert "UNRATIFIED" in report
    gumroad_line = next(line for line in report.splitlines() if line.startswith("gumroadsale"))
    assert "UNRATIFIED" in gumroad_line


def _triples() -> set[tuple[str, str, str]]:
    return {
        (dependant.table, dependant.column, dependant.action.value)
        for dependant in entry_dependants(SQLModel.metadata)
    }


def test_every_entry_foreign_key_has_a_purge_action() -> None:
    """Purging an entry acts on every row that points at it, with a stated action."""
    assert entry_dependant_gaps(SQLModel.metadata) == ()
    triples = _triples()
    assert ("llmusagelog", "journal_entry_id", "null") in triples
    assert ("promotedquote", "included_in_entry_id", "null") in triples
    for deleted in (
        ("marginalia", "journal_entry_id"),
        ("completionsuggestion", "journal_entry_id"),
        ("corpusfragment", "source_entry_id"),
        ("promotedquote", "source_entry_id"),
        ("voicedraftretraction", "journal_entry_id"),
    ):
        assert (*deleted, "delete") in triples


def test_a_new_entry_reference_without_ondelete_is_a_gap() -> None:
    """A foreign key into an entry with no cascade and no override is a decision owed."""
    copied = _metadata_with_new_table()
    copied.tables[_NEW_TABLE].append_column(
        Column("entry_id", Integer, ForeignKey("journalentry.id")),
    )
    gaps = entry_dependant_gaps(copied)
    assert len(gaps) == 1
    assert f"{_NEW_TABLE}.entry_id" in gaps[0]


def test_dependants_are_walked_through_deleted_children() -> None:
    """A row pointing at a deleted dependant is reached too, never left dangling."""
    copied = _metadata_with_new_table()
    copied.tables[_NEW_TABLE].append_column(
        Column("note_id", Integer, ForeignKey("marginalia.id", ondelete="CASCADE")),
    )
    grandchild = next(d for d in entry_dependants(copied) if d.table == _NEW_TABLE)
    assert grandchild.action.value == "delete"
    assert grandchild.parent is not None
    assert grandchild.parent.table == "marginalia"


def test_the_withdrawal_obligation_blocks_the_purge() -> None:
    """An unconfirmed remote withdrawal keeps its entry out of the purge (B04 / #3060)."""
    blocker = ENTRY_PURGE_BLOCKERS["voicedraftretraction"]
    assert blocker.cleared_states == (VoiceDraftRetractionState.CONFIRMED.value,)
    unsettled = {state.value for state in VoiceDraftRetractionState} - set(blocker.cleared_states)
    assert unsettled == {"mirror_intent", "pending"}
