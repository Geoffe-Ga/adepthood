"""Every undecided lifetime carries a concrete proposal, and nothing acts on one (#3063 AC15).

The registry (:mod:`domain.retention`) and the store inventory
(:mod:`domain.retention_stores`) mark lifetimes the owner has not decided as
``ratified=False`` or as an :class:`~domain.retention_stores.Unknown`. The owner
asked for proposed values to review, so each such row now carries a proposal:
a day count, the event it counts from, and a one-line rationale. The owner
reviews them in ``docs/privacy/retention-proposal.md``.

These tests hold three properties:

* **complete** -- every unratified rule, every store whose deadline is unknown,
  and every backup leg carries a proposal with a rationale, and the
  detector is proven to fire on a row without one;
* **honest** -- a proposal longer than what happens today must say so, and a
  ratified rule cannot keep a stale proposal; the doc table lists the same
  numbers the code holds;
* **inert** -- a proposal is a value for review, not a window. No module
  outside the two registries reads one, the sweeps still run on today's
  windows, and nothing was ratified along the way.
"""

from __future__ import annotations

import ast
import inspect
import re
from dataclasses import replace
from pathlib import Path

import pytest

from domain import retention, retention_stores
from domain.retention import (
    RETENTION,
    RetentionProposal,
    RetentionRule,
    proposal_findings,
    proposed,
    retention_report,
    swept_by,
    unratified_rules,
)
from domain.retention_stores import (
    BACKUP_LEGS,
    OFFHOST_DUMP_INTERVAL_DAYS,
    OFFHOST_DUMP_RETENTION_DAYS,
    OLDEST_LIVE_BACKUP_DAYS,
    STORES,
    Days,
    Hours,
    Store,
    StoreProposal,
    Unknown,
    inventory_findings,
)
from routers.admin import cleanup_energy_plans, purge_journal_entries
from services.energy import ENERGY_PLAN_RETENTION_DAYS
from services.journal_retention import PURGE_MIN_RETENTION_DAYS

_BACKEND_SRC = Path(__file__).resolve().parents[2] / "src"
_REPO_ROOT = Path(__file__).resolve().parents[3]
_PROPOSAL_DOC = _REPO_ROOT / "docs" / "privacy" / "retention-proposal.md"

# The exact set of lifetimes still awaiting the owner. Proposing values must
# not ratify any of them; ratifying one is the owner's edit, and it shrinks
# this set in the same change.
_UNRATIFIED = frozenset(
    {
        "accountdeletionaudit",
        "energyplan",
        "gumroadsale",
        "journalentry (soft-deleted)",
        "journalwithdrawalobligation",
        "llmusagelog",
        "loginattempt",
        "practicesharelink",
        "restoremarker",
        "revokedtoken",
        "vaultteardownreceipt",
        "voicedraftretraction",
    }
)

# Only the two registries may name a proposal or a proposed constant. A sweep,
# purge or route that read one would start deleting on a value nobody ratified.
_PROPOSAL_NAMES = frozenset({"proposal", "RetentionProposal", "StoreProposal"})
_PROPOSED_PREFIX = "PROPOSED_"
_PROPOSAL_HOMES = frozenset({"domain/retention.py", "domain/retention_stores.py"})

_TABLE_ROW = re.compile(r"^\|(?P<cells>.+)\|\s*$")
_FIRST_CELL = 0
_PERIOD_CELL = 2
_DOC_COLUMNS = 5


def _all_rules() -> list[tuple[str, RetentionRule]]:
    """Top-level rules plus every nested soft-delete rule."""
    rules: list[tuple[str, RetentionRule]] = []
    for name, rule in RETENTION.items():
        rules.append((name, rule))
        if rule.soft_deleted is not None:
            rules.append((f"{name} (soft-deleted)", rule.soft_deleted))
    return rules


# --------------------------------------------------------------------------
# Complete
# --------------------------------------------------------------------------


def test_nothing_was_ratified_by_proposing() -> None:
    """The owner ratifies; proposing values leaves every placeholder unratified."""
    assert set(unratified_rules()) == _UNRATIFIED


def test_every_unratified_rule_carries_a_proposal_and_a_rationale() -> None:
    """Each undecided lifetime has a concrete day count, its trigger, and why."""
    assert proposal_findings() == ()
    rules = dict(_all_rules())
    for name in _UNRATIFIED:
        proposal = rules[name].proposal
        assert proposal is not None, name
        assert proposal.days > 0, name
        assert proposal.trigger.strip(), name
        assert proposal.rationale.strip(), name


def test_an_unratified_rule_without_a_proposal_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The completeness check fires: dropping one proposal is a named finding."""
    stripped = dict(RETENTION)
    stripped["gumroadsale"] = replace(RETENTION["gumroadsale"], proposal=None)
    monkeypatch.setattr(retention, "RETENTION", stripped)
    findings = proposal_findings()
    assert len(findings) == 1
    assert "gumroadsale" in findings[0]


def test_an_unproposed_soft_delete_rule_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nested soft-delete rules are held to the same standard as top-level ones."""
    entry = RETENTION["journalentry"]
    assert entry.soft_deleted is not None
    stripped = dict(RETENTION)
    stripped["journalentry"] = replace(
        entry, soft_deleted=replace(entry.soft_deleted, proposal=None)
    )
    monkeypatch.setattr(retention, "RETENTION", stripped)
    assert any("journalentry (soft-deleted)" in f for f in proposal_findings())


def test_a_proposal_needs_a_positive_period_and_a_reason() -> None:
    """A proposal that cannot be reviewed cannot even be constructed."""
    with pytest.raises(ValueError, match="positive"):
        RetentionProposal(days=0, trigger="t", rationale="r")
    with pytest.raises(ValueError, match="rationale"):
        RetentionProposal(days=1, trigger="t", rationale="  ")
    with pytest.raises(ValueError, match="trigger"):
        RetentionProposal(days=1, trigger=" ", rationale="r")


def test_every_undecided_store_and_backup_leg_carries_a_proposal() -> None:
    """Unknown store deadlines and both backup legs (AC15) carry a proposal."""
    assert inventory_findings() == ()
    backup_keys = {leg.key for leg in BACKUP_LEGS}
    proposed = [s for s in STORES if isinstance(s.deadline, Unknown) or s.key in backup_keys]
    assert len(proposed) > len(backup_keys), "no unknown store is proposed -- vacuous"
    for store in proposed:
        assert store.proposal is not None, store.key
        assert store.proposal.rationale.strip(), store.key


def test_an_unknown_store_without_a_proposal_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The store-side completeness check fires on a missing proposal."""
    stores = tuple(replace(s, proposal=None) if s.key == "application_logs" else s for s in STORES)
    monkeypatch.setattr(retention_stores, "STORES", stores)
    findings = inventory_findings()
    assert len(findings) == 1
    assert "application_logs" in findings[0]


# --------------------------------------------------------------------------
# Honest
# --------------------------------------------------------------------------


def test_a_proposal_longer_than_today_must_say_so(monkeypatch: pytest.MonkeyPatch) -> None:
    """A proposal may lengthen a known window only when it is flagged as doing so."""
    today = 30
    longer = RetentionProposal(days=today + 1, trigger="creation", rationale="r")
    rule = proposed(
        swept_by("POST /x", trigger="creation", rationale="r", days=today, ratified=False),
        longer,
    )
    monkeypatch.setattr(retention, "RETENTION", {"zz_rule": rule})
    findings = proposal_findings()
    assert len(findings) == 1
    assert "longer than today" in findings[0]

    flagged = replace(rule, proposal=replace(longer, exceeds_today=True))
    monkeypatch.setattr(retention, "RETENTION", {"zz_rule": flagged})
    assert proposal_findings() == ()


def test_a_ratified_rule_cannot_keep_a_proposal(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ratifying means the proposal became the rule; a leftover one is reported."""
    ratified = replace(RETENTION["gumroadsale"], ratified=True)
    monkeypatch.setattr(retention, "RETENTION", {"gumroadsale": ratified})
    findings = proposal_findings()
    assert len(findings) == 1
    assert "ratified" in findings[0]


def test_a_store_proposal_longer_than_today_must_say_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A store proposal may not quietly lengthen a known deadline."""
    longer = StoreProposal(deadline=Days(OFFHOST_DUMP_RETENTION_DAYS + 1), rationale="r")
    stores = tuple(replace(s, proposal=longer) if s.key == "offhost_pg_dump" else s for s in STORES)
    monkeypatch.setattr(retention_stores, "STORES", stores)
    findings = inventory_findings()
    assert len(findings) == 1
    assert "longer than today" in findings[0]


def test_no_live_proposal_lengthens_a_known_window() -> None:
    """Every real proposal is at most today's window (none is flagged as longer)."""
    for name, rule in _all_rules():
        if rule.proposal is None:
            continue
        assert not rule.proposal.exceeds_today, name
        if rule.days is not None:
            assert rule.proposal.days <= rule.days, name
    for store in STORES:
        if store.proposal is None:
            continue
        assert not store.proposal.exceeds_today, store.key
        if isinstance(store.deadline, Days) and isinstance(store.proposal.deadline, Days):
            assert store.proposal.deadline.count <= store.deadline.count, store.key


def test_tombstone_bearing_proposals_outlive_the_backup_bound() -> None:
    """A soft-deleted page and an erasure receipt are restore tombstones (AC9-10).

    Each must outlive the oldest live backup copy, or a restore could resurrect
    a deletion nobody can re-apply. The soft-delete proposal is also the purge's
    own floor, so the purge would refuse anything shorter.
    """
    entry = RETENTION["journalentry"].soft_deleted
    assert entry is not None
    assert entry.proposal is not None
    assert entry.proposal.days >= PURGE_MIN_RETENTION_DAYS
    audit = RETENTION["accountdeletionaudit"].proposal
    assert audit is not None
    assert audit.days >= OLDEST_LIVE_BACKUP_DAYS


def test_withdrawal_obligation_proposal_never_drops_an_open_obligation() -> None:
    """Only a confirmed row gets a clock; an open one outlives the copy it tracks."""
    for name in ("journalwithdrawalobligation", "voicedraftretraction"):
        proposal = RETENTION[name].proposal
        assert proposal is not None
        assert "confirm" in proposal.trigger, name
        assert "until" in proposal.rationale, name


def test_report_shows_each_proposal() -> None:
    """The on-demand worklist puts the proposal next to each unratified rule."""
    report = retention_report()
    gumroad = next(line for line in report.splitlines() if line.startswith("gumroadsale"))
    proposal = RETENTION["gumroadsale"].proposal
    assert proposal is not None
    assert f"proposed: {proposal.days} days" in gumroad
    ratified = next(line for line in report.splitlines() if line.startswith("habit:"))
    assert "proposed" not in ratified


def _doc_rows() -> dict[str, list[str]]:
    """The proposal doc's table rows, keyed by their first cell (backticks stripped)."""
    rows: dict[str, list[str]] = {}
    for line in _PROPOSAL_DOC.read_text(encoding="utf-8").splitlines():
        match = _TABLE_ROW.match(line)
        if match is None:
            continue
        cells = [cell.strip() for cell in match.group("cells").split("|")]
        if len(cells) == _DOC_COLUMNS:
            rows[cells[_FIRST_CELL].strip("`")] = cells
    return rows


def _count(count: int, unit: str) -> str:
    """``1 day`` / ``30 days``: how the doc writes a period."""
    return f"{count} {unit}" if count == 1 else f"{count} {unit}s"


def _period(deadline: Days | Hours | None) -> str:
    """How the doc writes a store proposal's period."""
    if isinstance(deadline, Days):
        return _count(deadline.count, "day")
    if isinstance(deadline, Hours):
        return _count(deadline.count, "hour")
    return "no fixed period"


def test_the_owner_doc_lists_every_proposal_with_the_codes_numbers() -> None:
    """The review table and the registry cannot drift apart."""
    text = _PROPOSAL_DOC.read_text(encoding="utf-8")
    assert "DRAFT" in text
    assert "not ratified" in text.lower()
    rows = _doc_rows()
    for name, rule in _all_rules():
        if rule.proposal is None:
            continue
        assert name in rows, f"{name} has a proposal but no row in {_PROPOSAL_DOC.name}"
        assert _count(rule.proposal.days, "day") in rows[name][_PERIOD_CELL], name
    for store in STORES:
        if store.proposal is None:
            continue
        assert store.key in rows, f"{store.key} has a proposal but no row"
        assert _period(store.proposal.deadline) in rows[store.key][_PERIOD_CELL], store.key


# --------------------------------------------------------------------------
# Inert
# --------------------------------------------------------------------------


def _is_proposal_name(name: str) -> bool:
    """Whether ``name`` is a proposal type, the proposal field, or a ``PROPOSED_*`` constant."""
    return name in _PROPOSAL_NAMES or name.startswith(_PROPOSED_PREFIX)


def _node_name(node: ast.AST) -> str | None:
    """The identifier an attribute, name or import alias node refers to."""
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.alias):
        return node.name
    return None


def _proposal_reads(source: str) -> set[str]:
    """Proposal names, and ``PROPOSED_*`` constants, that ``source`` touches."""
    names = (_node_name(node) for node in ast.walk(ast.parse(source)))
    return {name for name in names if name is not None and _is_proposal_name(name)}


def test_the_proposal_scanner_is_not_vacuous() -> None:
    """The scan below would catch a sweep reading a proposal."""
    assert _proposal_reads("days = RETENTION['x'].proposal.days") == {"proposal"}
    assert _proposal_reads("from domain.retention import RetentionProposal") == {
        "RetentionProposal"
    }
    assert _proposal_reads("from domain.retention import PROPOSED_ENERGY_PLAN_DAYS") == {
        "PROPOSED_ENERGY_PLAN_DAYS"
    }
    assert _proposal_reads("floor = retention_stores.PROPOSED_OFFHOST_DUMP_DAYS") == {
        "PROPOSED_OFFHOST_DUMP_DAYS"
    }
    assert _proposal_reads("window = rule.days") == set()


def test_no_application_code_reads_a_proposal() -> None:
    """Until ratified, a proposal is never a window any sweep, purge or route uses."""
    offenders: dict[str, set[str]] = {}
    for path in sorted(_BACKEND_SRC.rglob("*.py")):
        relative = path.relative_to(_BACKEND_SRC).as_posix()
        if relative in _PROPOSAL_HOMES:
            continue
        reads = _proposal_reads(path.read_text(encoding="utf-8"))
        if reads:
            offenders[relative] = reads
    assert offenders == {}


def test_sweeps_still_run_on_todays_windows() -> None:
    """Proposing shorter values deletes nothing sooner today.

    The energy-plan sweep keeps its 30-day default (its proposal is shorter),
    the journal purge keeps no default at all, and the purge floor is still
    derived from today's backup retention, not from the proposed off-host one.
    """
    energy = RETENTION["energyplan"]
    assert energy.proposal is not None
    assert energy.proposal.days < ENERGY_PLAN_RETENTION_DAYS
    default = inspect.signature(cleanup_energy_plans).parameters["older_than_days"].default
    assert default == ENERGY_PLAN_RETENTION_DAYS

    purge_window = inspect.signature(purge_journal_entries).parameters["older_than_days"]
    assert purge_window.default is inspect.Parameter.empty

    offhost = next(s for s in STORES if s.key == "offhost_pg_dump")
    assert offhost.proposal is not None
    assert isinstance(offhost.proposal.deadline, Days)
    assert offhost.proposal.deadline.count < OFFHOST_DUMP_RETENTION_DAYS
    assert PURGE_MIN_RETENTION_DAYS == OFFHOST_DUMP_RETENTION_DAYS + OFFHOST_DUMP_INTERVAL_DAYS
    assert offhost.deadline == Days(OFFHOST_DUMP_RETENTION_DAYS)


def test_store_is_constructible_without_a_proposal() -> None:
    """A store whose deadline is known needs no proposal (the default is none)."""
    store = Store(
        key="k",
        description="d",
        controller=retention_stores.Controller.ADEPTHOOD,
        deadline=Hours(1),
        evidence="e",
    )
    assert store.proposal is None
