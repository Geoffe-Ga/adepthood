"""Every undecided lifetime carries a concrete proposal, and nothing acts on one (#3063 AC15).

The registry (:mod:`domain.retention`) and the store inventory
(:mod:`domain.retention_stores`) mark lifetimes the owner has not decided as
``ratified=False`` or as an :class:`~domain.retention_stores.Unknown`. The owner
asked for proposed values to review, so each such row now carries a proposal:
a day count, a structured clock it counts from, a declared comparison with
today, and a one-line rationale. The owner reviews them in
``docs/privacy/retention-proposal.md``.

These tests hold three properties:

* **complete** -- every unratified rule, every store whose deadline is unknown,
  and every backup leg carries a proposal with a rationale, and each detector is
  proven to fire;
* **honest** -- each proposal's declared comparison with today is checked
  against what the rule and its clock imply (so a proposal that keeps rows past
  their account's erasure must say ``longer``); open obligations are never
  eligible; a lowered backup retention cannot lower the purge floor while older
  dumps are still held; the doc table carries exactly the code's numbers;
* **inert** -- a proposal is a value for review, not a window. No module
  outside the two registries reads one, the sweeps still run on today's
  windows, and nothing was ratified along the way.
"""

from __future__ import annotations

import ast
import importlib.abc
import importlib.util
import inspect
import re
import sys
from dataclasses import replace
from pathlib import Path
from types import ModuleType

import pytest
from sqlmodel import SQLModel

from domain import retention, retention_stores
from domain.retention import (
    ENTRY_PURGE_BLOCKERS,
    NEVER_ELIGIBLE_STATES,
    REDACT_INSTEAD_OF_DELETE,
    RETENTION,
    ProposalClock,
    RetentionProposal,
    RetentionRule,
    TodayComparison,
    fixed_days,
    implied_comparison,
    proposal_findings,
    proposed,
    retention_report,
    swept_by,
    unratified_rules,
)
from domain.retention_stores import (
    BACKUP_LEGS,
    HELD_BACKUP_BOUND_DAYS,
    HELD_OFFHOST_DUMP_RETENTION_DAYS,
    OFFHOST_DUMP_INTERVAL_DAYS,
    OFFHOST_DUMP_RETENTION_DAYS,
    OLDEST_LIVE_BACKUP_DAYS,
    PROPOSED_OFFHOST_DUMP_DAYS,
    STORES,
    Days,
    Hours,
    Store,
    StoreProposal,
    Unknown,
    inventory_findings,
    oldest_live_backup_days,
)
from models.journal_withdrawal_obligation import OPEN_STATES
from models.restore_marker import RestoreState
from models.vault_activation import TEARDOWN_STATES, VaultActivationState
from models.voice_draft_retraction import VoiceDraftRetractionState
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
_LEADING_COUNT = re.compile(r"^(?P<count>\d+) (?P<unit>day|days|hour|hours)\b")
_NO_PERIOD = "no fixed period"
_FIRST_CELL = 0
_PERIOD_CELL = 2
_COMPARISON_CELL = 3
_DOC_COLUMNS = 6

# A proposal that would keep an obligation 90 days past its account's erasure:
# the case the review table raises as a separate, longer-than-today question.
_AFTER_ERASURE_DAYS = 90


def _all_rules() -> list[tuple[str, RetentionRule]]:
    """Top-level rules plus every nested soft-delete rule."""
    rules: list[tuple[str, RetentionRule]] = []
    for name, rule in RETENTION.items():
        rules.append((name, rule))
        if rule.soft_deleted is not None:
            rules.append((f"{name} (soft-deleted)", rule.soft_deleted))
    return rules


def _proposal(name: str) -> RetentionProposal:
    """The live proposal on a top-level rule."""
    proposal = RETENTION[name].proposal
    assert proposal is not None, name
    return proposal


def _with_proposal(
    monkeypatch: pytest.MonkeyPatch, name: str, proposal: RetentionProposal | None
) -> None:
    """Swap one rule's proposal in the live registry for the test's duration."""
    patched = dict(RETENTION)
    patched[name] = replace(RETENTION[name], proposal=proposal)
    monkeypatch.setattr(retention, "RETENTION", patched)


def _with_store_proposal(
    monkeypatch: pytest.MonkeyPatch, key: str, proposal: StoreProposal | None
) -> None:
    """Swap one store's proposal in the live inventory for the test's duration."""
    stores = tuple(replace(s, proposal=proposal) if s.key == key else s for s in STORES)
    monkeypatch.setattr(retention_stores, "STORES", stores)


def _store(key: str) -> Store:
    return next(s for s in STORES if s.key == key)


# --------------------------------------------------------------------------
# Complete
# --------------------------------------------------------------------------


def test_nothing_was_ratified_by_proposing() -> None:
    """The owner ratifies; proposing values leaves every placeholder unratified."""
    assert set(unratified_rules()) == _UNRATIFIED


def test_every_unratified_rule_carries_a_proposal_and_a_rationale() -> None:
    """Each undecided lifetime has a day count, a structured clock, a comparison and why."""
    assert proposal_findings() == ()
    rules = dict(_all_rules())
    for name in _UNRATIFIED:
        proposal = rules[name].proposal
        assert proposal is not None, name
        assert proposal.days > 0, name
        assert isinstance(proposal.clock, ProposalClock), name
        assert isinstance(proposal.compared_to_today, TodayComparison), name
        assert proposal.trigger.strip(), name
        assert proposal.rationale.strip(), name


def test_an_unratified_rule_without_a_proposal_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The completeness check fires: dropping one proposal is a named finding."""
    _with_proposal(monkeypatch, "gumroadsale", None)
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

    def bare(days: int, trigger: str, rationale: str) -> RetentionProposal:
        return RetentionProposal(
            days=days,
            clock=ProposalClock.ROW_CREATED,
            trigger=trigger,
            rationale=rationale,
            compared_to_today=TodayComparison.SHORTER,
        )

    with pytest.raises(ValueError, match="positive"):
        bare(0, "t", "r")
    with pytest.raises(ValueError, match="rationale"):
        bare(1, "t", "  ")
    with pytest.raises(ValueError, match="trigger"):
        bare(1, " ", "r")


def test_every_undecided_store_and_backup_leg_carries_a_proposal() -> None:
    """Unknown store deadlines and both backup legs (AC15) carry a proposal."""
    assert inventory_findings() == ()
    backup_keys = {leg.key for leg in BACKUP_LEGS}
    proposed_stores = [s for s in STORES if isinstance(s.deadline, Unknown) or s.key in backup_keys]
    assert len(proposed_stores) > len(backup_keys), "no unknown store is proposed -- vacuous"
    for store in proposed_stores:
        assert store.proposal is not None, store.key
        assert store.proposal.rationale.strip(), store.key


def test_an_unknown_store_without_a_proposal_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The store-side completeness check fires on an undecided deadline."""
    _with_store_proposal(monkeypatch, "application_logs", None)
    findings = inventory_findings()
    assert len(findings) == 1
    assert "application_logs" in findings[0]
    assert "undecided deadline" in findings[0]


def test_a_backup_leg_without_a_proposal_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    """A backup leg's deadline is known, but its retention is still AC15's to decide."""
    _with_store_proposal(monkeypatch, "offhost_pg_dump", None)
    findings = inventory_findings()
    assert len(findings) == 1
    assert "backup leg 'offhost_pg_dump'" in findings[0]


def test_a_store_proposal_needs_a_rationale() -> None:
    """A blank store rationale cannot be constructed, so the report never shows one."""
    with pytest.raises(ValueError, match="rationale"):
        StoreProposal(deadline=None, rationale="  ", compared_to_today=TodayComparison.SAME)


# --------------------------------------------------------------------------
# Honest: declared comparisons are checked against the rule
# --------------------------------------------------------------------------


def test_a_proposal_keeping_an_obligation_past_erasure_is_longer_than_today(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reviewer's case: 90 days after erasure on a table erased with the account.

    Declared ``shorter`` it is a finding; only an explicit ``longer`` passes.
    """
    after_erasure = replace(
        _proposal("journalwithdrawalobligation"),
        days=_AFTER_ERASURE_DAYS,
        clock=ProposalClock.AFTER_ACCOUNT_DELETION,
        trigger="account deletion",
    )
    _with_proposal(monkeypatch, "journalwithdrawalobligation", after_erasure)
    findings = proposal_findings()
    assert len(findings) == 1
    assert "journalwithdrawalobligation" in findings[0]
    assert "longer" in findings[0]

    declared = replace(after_erasure, compared_to_today=TodayComparison.LONGER)
    _with_proposal(monkeypatch, "journalwithdrawalobligation", declared)
    assert proposal_findings() == ()


def test_a_proposal_longer_than_a_known_window_must_say_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A sweep with a known window is compared number to number."""
    today = 30
    longer = RetentionProposal(
        days=today + 1,
        clock=ProposalClock.ROW_CREATED,
        trigger="creation",
        rationale="r",
        compared_to_today=TodayComparison.SHORTER,
    )
    rule = proposed(
        swept_by("POST /x", trigger="creation", rationale="r", days=today, ratified=False),
        longer,
    )
    monkeypatch.setattr(retention, "RETENTION", {"zz_rule": rule})
    findings = proposal_findings()
    assert len(findings) == 1
    assert "longer" in findings[0]

    declared = replace(rule, proposal=replace(longer, compared_to_today=TodayComparison.LONGER))
    monkeypatch.setattr(retention, "RETENTION", {"zz_rule": declared})
    assert proposal_findings() == ()


def test_an_after_erasure_clock_on_a_windowed_table_is_longer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Energy plans have a 30-day window, but a clock from erasure outlives the account.

    energyplan is erased with its account (an ERASE table that is not
    'until account deletion'), so 7 days after erasure is longer than today
    whatever the window says.
    """
    after_erasure = replace(
        _proposal("energyplan"), clock=ProposalClock.AFTER_ACCOUNT_DELETION, trigger="erasure"
    )
    _with_proposal(monkeypatch, "energyplan", after_erasure)
    findings = proposal_findings()
    assert len(findings) == 1
    assert "energyplan" in findings[0]
    assert "longer" in findings[0]

    declared = replace(after_erasure, compared_to_today=TodayComparison.LONGER)
    _with_proposal(monkeypatch, "energyplan", declared)
    assert proposal_findings() == ()


def test_an_after_erasure_clock_on_a_soft_deleted_entry_is_longer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ERASE-disposition branch: a sweep with no window on an erased table."""
    entry = RETENTION["journalentry"]
    nested = entry.soft_deleted
    assert nested is not None
    assert nested.proposal is not None
    after_erasure = replace(nested.proposal, clock=ProposalClock.AFTER_ACCOUNT_DELETION)
    patched = dict(RETENTION)
    patched["journalentry"] = replace(entry, soft_deleted=replace(nested, proposal=after_erasure))
    monkeypatch.setattr(retention, "RETENTION", patched)
    findings = proposal_findings()
    assert len(findings) == 1
    assert "journalentry (soft-deleted)" in findings[0]
    assert "longer" in findings[0]


def test_a_proposal_on_another_clock_than_the_window_cannot_be_compared(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A creation-keyed window and an event-keyed proposal are not comparable numbers."""
    other_clock = replace(_proposal("energyplan"), clock=ProposalClock.ROW_EVENT)
    assert (
        implied_comparison("energyplan", RETENTION["energyplan"], other_clock)
        is TodayComparison.UNKNOWN
    )
    _with_proposal(monkeypatch, "energyplan", other_clock)
    findings = proposal_findings()
    assert len(findings) == 1
    assert "unknown" in findings[0]


def test_a_ratified_obligation_rule_must_keep_its_exemption(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ratifying the 30-day proposal as a plain fixed_days rule would expire open rows."""
    plain = fixed_days(
        _proposal("journalwithdrawalobligation").days,
        trigger="vault confirmation",
        rationale="ratified",
        ratified=True,
    )
    monkeypatch.setattr(retention, "RETENTION", {"journalwithdrawalobligation": plain})
    findings = proposal_findings()
    assert len(findings) == 1
    assert "pending_delete" in findings[0]

    kept = replace(plain, exempt_states=NEVER_ELIGIBLE_STATES["journalwithdrawalobligation"])
    monkeypatch.setattr(retention, "RETENTION", {"journalwithdrawalobligation": kept})
    assert proposal_findings() == ()


def test_a_ratified_sale_rule_must_keep_its_redaction(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ratifying the sale proposal as row deletion would drop the receipt itself."""
    plain = fixed_days(
        _proposal("gumroadsale").days, trigger="anonymisation", rationale="r", ratified=True
    )
    monkeypatch.setattr(retention, "RETENTION", {"gumroadsale": plain})
    findings = proposal_findings()
    assert len(findings) == 1
    assert "redact" in findings[0]

    kept = replace(plain, redact_columns=REDACT_INSTEAD_OF_DELETE["gumroadsale"])
    monkeypatch.setattr(retention, "RETENTION", {"gumroadsale": kept})
    assert proposal_findings() == ()


def test_the_sale_proposal_redacts_exactly_the_required_columns() -> None:
    """The proposal and the table-level constraint name the same columns."""
    assert _proposal("gumroadsale").redact_columns == REDACT_INSTEAD_OF_DELETE["gumroadsale"]


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
    longer = StoreProposal(
        deadline=Days(OFFHOST_DUMP_RETENTION_DAYS + 1),
        rationale="r",
        compared_to_today=TodayComparison.SHORTER,
    )
    _with_store_proposal(monkeypatch, "offhost_pg_dump", longer)
    findings = inventory_findings()
    assert len(findings) == 1
    assert "longer" in findings[0]


def test_a_proposal_against_an_unknown_deadline_cannot_claim_to_be_shorter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Application logs: today's vendor retention is unverified, so 30 days is 'unknown'.

    Claiming ``shorter`` (or ``same``) is a finding; the live row says ``unknown``.
    """
    logs = _store("application_logs")
    assert logs.proposal is not None
    assert logs.proposal.compared_to_today is TodayComparison.UNKNOWN
    assert "whichever is shorter" in logs.proposal.rationale
    claimed = replace(logs.proposal, compared_to_today=TodayComparison.SHORTER)
    _with_store_proposal(monkeypatch, "application_logs", claimed)
    findings = inventory_findings()
    assert len(findings) == 1
    assert "unknown" in findings[0]


def test_no_live_proposal_is_longer_than_today() -> None:
    """Every real proposal is shorter, the same, or explicitly not comparable."""
    for name, rule in _all_rules():
        if rule.proposal is not None:
            assert rule.proposal.compared_to_today is not TodayComparison.LONGER, name
    for store in STORES:
        if store.proposal is not None:
            assert store.proposal.compared_to_today is not TodayComparison.LONGER, store.key


# --------------------------------------------------------------------------
# Honest: conditions are data, not prose
# --------------------------------------------------------------------------


def test_never_eligible_states_match_the_models() -> None:
    """The registry's literal state names are each model's open lifecycle states."""
    blocker = ENTRY_PURGE_BLOCKERS["voicedraftretraction"]
    expected = {
        "journalwithdrawalobligation": frozenset(OPEN_STATES),
        "voicedraftretraction": frozenset(
            state.value
            for state in VoiceDraftRetractionState
            if state.value not in blocker.cleared_states
        ),
        # Every teardown state but the confirmed one, and every restore state
        # but the finished one: a new state in either lifecycle forces a decision.
        "vaultteardownreceipt": frozenset(TEARDOWN_STATES) - {VaultActivationState.DELETED.value},
        "restoremarker": frozenset(state.value for state in RestoreState)
        - {RestoreState.COMPLETE.value},
    }
    assert dict(NEVER_ELIGIBLE_STATES) == expected


def test_open_obligations_are_never_eligible() -> None:
    """Each conditional proposal exempts exactly its table's open states."""
    for table, states in NEVER_ELIGIBLE_STATES.items():
        assert _proposal(table).exempt_states == states, table


def test_a_proposal_that_drops_open_obligations_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A confirmed-only proposal without its exemption would expire open rows."""
    unconditional = replace(_proposal("journalwithdrawalobligation"), exempt_states=frozenset())
    _with_proposal(monkeypatch, "journalwithdrawalobligation", unconditional)
    findings = proposal_findings()
    assert len(findings) == 1
    assert "pending_delete" in findings[0]
    assert "unconfirmed" in findings[0]


def test_the_sale_proposal_redacts_real_columns_and_names_the_schema_it_needs() -> None:
    """Gumroad: the clock's anonymisation stamp is built, so no schema is still required.

    The proposal redacts existing columns rather than deleting the receipt,
    its clock column now exists, and it states the trade-off.
    """
    sale = _proposal("gumroadsale")
    columns = SQLModel.metadata.tables["gumroadsale"].c
    assert sale.clock is ProposalClock.AFTER_ACCOUNT_DELETION
    assert sale.redact_columns == ("email", "raw_payload")
    assert all(column in columns for column in sale.redact_columns)
    assert "anonymised_at" in columns
    assert sale.requires_schema is None
    assert "re-matched" in sale.rationale
    assert "to confirm" in sale.rationale


def test_tombstone_bearing_proposals_outlive_the_backup_bound() -> None:
    """A soft-deleted page and an erasure receipt are restore tombstones (AC9-10)."""
    entry = RETENTION["journalentry"].soft_deleted
    assert entry is not None
    assert entry.proposal is not None
    assert entry.proposal.days >= PURGE_MIN_RETENTION_DAYS
    assert _proposal("accountdeletionaudit").days >= OLDEST_LIVE_BACKUP_DAYS


def test_a_shorter_backup_retention_cannot_lower_the_purge_floor_while_old_dumps_are_held() -> None:
    """Ratifying 30-day dumps must not drop the floor to 37 while 90-day dumps exist.

    The floor is the maximum of today's legs and the bound of copies still held
    under the older retention, so lowering the leg alone leaves it at 97.
    """
    ratified = tuple(
        replace(leg, retention_days=PROPOSED_OFFHOST_DUMP_DAYS)
        if leg.key == "offhost_pg_dump"
        else leg
        for leg in BACKUP_LEGS
    )
    assert oldest_live_backup_days(ratified, HELD_BACKUP_BOUND_DAYS) == HELD_BACKUP_BOUND_DAYS
    assert HELD_BACKUP_BOUND_DAYS == (HELD_OFFHOST_DUMP_RETENTION_DAYS + OFFHOST_DUMP_INTERVAL_DAYS)
    # HELD may only be lowered in a separate, later change, once every dump kept
    # under the older (longer) retention has been pruned -- never to match a
    # freshly lowered OFFHOST in the same change.
    assert HELD_OFFHOST_DUMP_RETENTION_DAYS >= OFFHOST_DUMP_RETENTION_DAYS
    assert OLDEST_LIVE_BACKUP_DAYS >= HELD_BACKUP_BOUND_DAYS
    assert PURGE_MIN_RETENTION_DAYS == OLDEST_LIVE_BACKUP_DAYS


class _EditedSource(importlib.abc.SourceLoader):
    """Load a module from its real file with one line edited."""

    def __init__(self, path: Path, replace_from: str, replace_to: str) -> None:
        self._path = path
        self._from = replace_from
        self._to = replace_to

    def get_filename(self, fullname: str) -> str:
        del fullname
        return str(self._path)

    def get_data(self, path: str) -> bytes:
        source = Path(path).read_text(encoding="utf-8")
        assert source.count(self._from) == 1, f"{self._from!r} not found once in {path}"
        return source.replace(self._from, self._to).encode("utf-8")


def _load_variant(
    monkeypatch: pytest.MonkeyPatch, name: str, path: Path, edit: tuple[str, str]
) -> ModuleType:
    """Import a copy of a source module, with one line edited, under another name.

    Registered in ``sys.modules`` for the test only (dataclasses resolve their
    module there while the class body runs).
    """
    loader = _EditedSource(path, *edit)
    spec = importlib.util.spec_from_loader(name, loader, origin=str(path))
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, name, module)
    loader.exec_module(module)
    return module


def test_ratifying_thirty_day_dumps_keeps_the_floor_at_the_held_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ratification edit itself: OFFHOST lowered to 30, HELD left at 90.

    Both the oldest-live-copy bound and the journal purge floor built on it stay
    at the held bound (97), not the 37 the new retention alone would give.
    """
    stores_path = _BACKEND_SRC / "domain" / "retention_stores.py"
    ratified = _load_variant(
        monkeypatch,
        "retention_stores_ratified",
        stores_path,
        (
            f"\nOFFHOST_DUMP_RETENTION_DAYS: Final = {OFFHOST_DUMP_RETENTION_DAYS}\n",
            f"\nOFFHOST_DUMP_RETENTION_DAYS: Final = {PROPOSED_OFFHOST_DUMP_DAYS}\n",
        ),
    )
    assert ratified.OFFHOST_DUMP_RETENTION_DAYS == PROPOSED_OFFHOST_DUMP_DAYS
    assert ratified.OLDEST_LIVE_BACKUP_DAYS == HELD_BACKUP_BOUND_DAYS

    monkeypatch.setitem(sys.modules, "domain.retention_stores", ratified)
    purge = _load_variant(
        monkeypatch,
        "journal_retention_ratified",
        _BACKEND_SRC / "services" / "journal_retention.py",
        ("PURGE_BATCH_SIZE: Final = 200\n", "PURGE_BATCH_SIZE: Final = 200\n"),
    )
    assert purge.PURGE_MIN_RETENTION_DAYS == HELD_BACKUP_BOUND_DAYS


def test_report_shows_each_proposal_and_its_comparison() -> None:
    """The on-demand worklist puts the proposal next to each unratified rule."""
    report = retention_report()
    gumroad = next(line for line in report.splitlines() if line.startswith("gumroadsale"))
    assert f"proposed: {_proposal('gumroadsale').days} days" in gumroad
    assert "[shorter than today]" in gumroad
    ratified = next(line for line in report.splitlines() if line.startswith("habit:"))
    assert "proposed" not in ratified


# --------------------------------------------------------------------------
# Honest: the owner's table carries exactly the code's values
# --------------------------------------------------------------------------


def _doc_rows(text: str) -> dict[str, list[str]]:
    """The proposal doc's table rows, keyed by their first cell (backticks stripped)."""
    rows: dict[str, list[str]] = {}
    for line in text.splitlines():
        match = _TABLE_ROW.match(line)
        if match is None:
            continue
        cells = [cell.strip() for cell in match.group("cells").split("|")]
        if len(cells) == _DOC_COLUMNS:
            rows[cells[_FIRST_CELL].strip("`")] = cells
    return rows


def _leading_period(cell: str) -> tuple[int, str] | None:
    """The count and unit a period cell *starts* with, or None for no fixed period."""
    if cell.startswith(_NO_PERIOD):
        return None
    match = _LEADING_COUNT.match(cell)
    assert match, f"period cell does not start with a count: {cell!r}"
    return int(match.group("count")), match.group("unit").rstrip("s")


def _store_period(deadline: Days | Hours | None) -> tuple[int, str] | None:
    if isinstance(deadline, Days):
        return deadline.count, "day"
    if isinstance(deadline, Hours):
        return deadline.count, "hour"
    return None


def test_the_period_parser_rejects_a_longer_number_containing_the_right_one() -> None:
    """'97 days' is not '7 days', '130 days' is not '30 days', '31 days' is not '1 day'."""
    assert _leading_period("97 days after the plan is created") != (7, "day")
    assert _leading_period("130 days") != (30, "day")
    assert _leading_period("31 days after expiry") != (1, "day")
    assert _leading_period("7 days after the plan is created") == (7, "day")
    assert _leading_period("no fixed period") is None


def test_the_owner_doc_lists_every_proposal_with_the_codes_values() -> None:
    """The review table and the registry cannot drift apart."""
    text = _PROPOSAL_DOC.read_text(encoding="utf-8")
    assert "DRAFT" in text
    assert "not ratified" in text.lower()
    rows = _doc_rows(text)
    for name, rule in _all_rules():
        if rule.proposal is None:
            continue
        assert name in rows, f"{name} has a proposal but no row in {_PROPOSAL_DOC.name}"
        assert _leading_period(rows[name][_PERIOD_CELL]) == (rule.proposal.days, "day"), name
        assert rows[name][_COMPARISON_CELL] == rule.proposal.compared_to_today.value, name
    for store in STORES:
        if store.proposal is None:
            continue
        assert store.key in rows, f"{store.key} has a proposal but no row"
        cells = rows[store.key]
        assert _leading_period(cells[_PERIOD_CELL]) == _store_period(store.proposal.deadline)
        assert cells[_COMPARISON_CELL] == store.proposal.compared_to_today.value, store.key


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
    the journal purge keeps no default at all, and the off-host leg still
    carries today's 90 days, not the proposed 30.
    """
    assert _proposal("energyplan").days < ENERGY_PLAN_RETENTION_DAYS
    default = inspect.signature(cleanup_energy_plans).parameters["older_than_days"].default
    assert default == ENERGY_PLAN_RETENTION_DAYS

    purge_window = inspect.signature(purge_journal_entries).parameters["older_than_days"]
    assert purge_window.default is inspect.Parameter.empty

    offhost = _store("offhost_pg_dump")
    assert offhost.proposal is not None
    assert offhost.proposal.deadline == Days(PROPOSED_OFFHOST_DUMP_DAYS)
    assert PROPOSED_OFFHOST_DUMP_DAYS < OFFHOST_DUMP_RETENTION_DAYS
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
