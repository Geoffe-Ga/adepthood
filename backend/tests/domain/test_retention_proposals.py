"""The owner's ratified retention periods are the registry's rules (#3063 AC15).

The registry (:mod:`domain.retention`) and the store inventory
(:mod:`domain.retention_stores`) once carried a *proposal* next to every
lifetime the owner had not decided. On 2026-10-13 the owner ratified every
proposed row as written, conditions included (PR #3155, comment 6151018235),
and the ratification was carried out by the doc's own procedure: the value
was written into the rule or store, the proposal's ``exempt_states`` and
``redact_columns`` copied onto the rule, ``ratified`` set, and the proposal
deleted. ``docs/privacy/retention-proposal.md`` records the decision.

These tests hold four properties:

* **ratified** -- every ratified row carries exactly the owner's value and
  conditions, no proposal is left, and nothing is unratified;
* **guarded** -- the machinery still bites for the next undecided lifetime: an
  unratified rule without a proposal, a ratified rule that keeps one, and a
  sweeping rule that drops a condition its table requires are each reported,
  and a proposal's declared comparison with today is still checked;
* **honest** -- open obligations are never eligible, a shorter backup
  retention cannot lower the purge floor while older dumps are still held, the
  existing sweeps run on the ratified windows, and the doc table carries
  exactly the code's numbers;
* **inert proposals** -- a future proposal stays a value for review: no module
  outside the two registries may read one.
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
    RetentionKind,
    RetentionProposal,
    RetentionRule,
    TodayComparison,
    conditional,
    fixed_days,
    implied_comparison,
    proposal_findings,
    proposed,
    retention_report,
    swept_by,
    unratified_rules,
    until_account_deletion,
)
from domain.retention_stores import (
    BACKUP_LEGS,
    HELD_BACKUP_BOUND_DAYS,
    HELD_OFFHOST_DUMP_INTERVAL_DAYS,
    HELD_OFFHOST_DUMP_RETENTION_DAYS,
    OLDEST_LIVE_BACKUP_DAYS,
    RAILWAY_PLATFORM_BACKUP_DAYS,
    RAILWAY_PLATFORM_BACKUP_INTERVAL_DAYS,
    STORES,
    Days,
    Hours,
    RatifiedPeriod,
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
from services.journal_retention import PURGE_DEFAULT_RETENTION_DAYS, PURGE_MIN_RETENTION_DAYS

_BACKEND_SRC = Path(__file__).resolve().parents[2] / "src"
_REPO_ROOT = Path(__file__).resolve().parents[3]
_PROPOSAL_DOC = _REPO_ROOT / "docs" / "privacy" / "retention-proposal.md"

# The owner's decision, as ratified on 2026-10-13: each row's kind and period.
# A row an operator sweep already serves is ``swept_by`` with the ratified
# window as its default; every other row is a ``fixed_days`` period that no
# sweep applies yet (#3063 AC18).
_RATIFIED_RULES: dict[str, tuple[RetentionKind, int]] = {
    "accountdeletionaudit": (RetentionKind.FIXED_DAYS, 365),
    "energyplan": (RetentionKind.SWEPT_BY, 7),
    "gumroadsale": (RetentionKind.FIXED_DAYS, 180),
    "journalentry (soft-deleted)": (RetentionKind.SWEPT_BY, 97),
    "journalwithdrawalobligation": (RetentionKind.FIXED_DAYS, 30),
    "llmusagelog": (RetentionKind.FIXED_DAYS, 90),
    "loginattempt": (RetentionKind.FIXED_DAYS, 30),
    "practicesharelink": (RetentionKind.FIXED_DAYS, 30),
    "restoremarker": (RetentionKind.FIXED_DAYS, 365),
    "revokedtoken": (RetentionKind.FIXED_DAYS, 1),
    "vaultteardownreceipt": (RetentionKind.FIXED_DAYS, 90),
    "voicedraftretraction": (RetentionKind.FIXED_DAYS, 30),
}

# The store periods ratified the same day; ``None`` is "no fixed period".
_RATIFIED_STORES: dict[str, Days | None] = {
    "railway_platform_backup": Days(6),
    "application_logs": Days(30),
    "fly_volume_snapshots": Days(1),
    "creek_vault_volume": None,
    "creek_embeddings_cache": None,
    "creek_ledger": None,
    "client_device_cache": None,
    "manual_vaults": None,
    "model_vendor_copies": None,
}

# Only the two registries may name a proposal or a proposed constant. A sweep,
# purge or route that read one would start deleting on a value nobody ratified.
_PROPOSAL_NAMES = frozenset({"proposal", "RetentionProposal", "StoreProposal"})
_PROPOSED_PREFIX = "PROPOSED_"
_PROPOSAL_HOMES = frozenset({"domain/retention.py", "domain/retention_stores.py"})

_TABLE_ROW = re.compile(r"^\|(?P<cells>.+)\|\s*$")
_LEADING_COUNT = re.compile(r"^(?P<count>\d+) (?P<unit>day|days|hour|hours)\b")
_NO_PERIOD = "no fixed period"
_SEPARATOR_CHARS = frozenset("- :")
_HEADER_FIRST_CELL = "Store"
_FIRST_CELL = 0
_PERIOD_CELL = 2
_COMPARISON_CELL = 3
_DOC_COLUMNS = 6
_DECISION = "2026-10-13"
_DECISION_LINK = "6151018235"

# A proposal that would keep an obligation 90 days past its account's erasure:
# the case the decision record leaves open (AC21-22) as a longer-than-today one.
_AFTER_ERASURE_DAYS = 90


def _all_rules() -> list[tuple[str, RetentionRule]]:
    """Top-level rules plus every nested soft-delete rule."""
    rules: list[tuple[str, RetentionRule]] = []
    for name, rule in RETENTION.items():
        rules.append((name, rule))
        if rule.soft_deleted is not None:
            rules.append((f"{name} (soft-deleted)", rule.soft_deleted))
    return rules


def _patch_rule(monkeypatch: pytest.MonkeyPatch, name: str, rule: RetentionRule) -> None:
    """Swap one top-level rule in the live registry for the test's duration."""
    monkeypatch.setattr(retention, "RETENTION", {**RETENTION, name: rule})


def _soft_deleted() -> RetentionRule:
    nested = RETENTION["journalentry"].soft_deleted
    assert nested is not None
    return nested


def _patch_soft_deleted(monkeypatch: pytest.MonkeyPatch, nested: RetentionRule) -> None:
    """Swap the journal entry's soft-delete rule for the test's duration."""
    entry = replace(RETENTION["journalentry"], soft_deleted=nested)
    _patch_rule(monkeypatch, "journalentry", entry)


def _proposal(
    days: int,
    *,
    clock: ProposalClock = ProposalClock.ROW_CREATED,
    compared: TodayComparison = TodayComparison.SHORTER,
    exempt: frozenset[str] = frozenset(),
) -> RetentionProposal:
    """A synthetic proposal: none is live now that every row is ratified."""
    return RetentionProposal(
        days=days,
        clock=clock,
        trigger="t",
        rationale="r",
        compared_to_today=compared,
        exempt_states=exempt,
    )


def _undecided(name: str, proposal: RetentionProposal | None) -> RetentionRule:
    """``name``'s rule as it would read before a decision: unratified, carrying ``proposal``."""
    return replace(RETENTION[name], ratified=False, proposal=proposal)


def _store(key: str) -> Store:
    return next(s for s in STORES if s.key == key)


def _patch_store(monkeypatch: pytest.MonkeyPatch, edited: Store) -> None:
    """Swap one store (matched by key) in the live inventory for the test's duration."""
    stores = tuple(edited if s.key == edited.key else s for s in STORES)
    monkeypatch.setattr(retention_stores, "STORES", stores)


# --------------------------------------------------------------------------
# Ratified
# --------------------------------------------------------------------------


def test_every_ratified_row_carries_the_owners_value() -> None:
    """Each row the owner ratified is ratified, proposal-free, and has its period."""
    rules = dict(_all_rules())
    for name, (kind, days) in _RATIFIED_RULES.items():
        rule = rules[name]
        assert rule.ratified, name
        assert rule.proposal is None, name
        assert rule.kind is kind, name
        assert rule.days == days, name


def test_nothing_is_left_undecided() -> None:
    """No rule is unratified, so no proposal is owed, and none lingers."""
    assert unratified_rules() == ()
    assert proposal_findings() == ()
    assert all(rule.proposal is None for _, rule in _all_rules())


def test_each_conditional_row_carries_its_conditions_onto_the_rule() -> None:
    """The proposals' conditions survive ratification as data on the rule itself."""
    for table, states in NEVER_ELIGIBLE_STATES.items():
        assert RETENTION[table].exempt_states == states, table
    for table, columns in REDACT_INSTEAD_OF_DELETE.items():
        assert RETENTION[table].redact_columns == columns, table
    conditional = set(NEVER_ELIGIBLE_STATES) | set(REDACT_INSTEAD_OF_DELETE)
    for name, rule in _all_rules():
        if name not in conditional:
            assert rule.exempt_states == frozenset(), name
            assert rule.redact_columns == (), name


def test_the_sale_rule_counts_from_the_built_anonymisation_stamp() -> None:
    """Gumroad: the clock is a real column, and an unlinked sale is said to keep its email."""
    sale = RETENTION["gumroadsale"]
    columns = SQLModel.metadata.tables["gumroadsale"].c
    assert "anonymised_at" in columns
    assert "anonymised_at" in sale.trigger
    assert all(column in columns for column in sale.redact_columns)
    assert "never linked" in sale.rationale
    assert "re-matched" in sale.rationale


def test_every_store_row_carries_the_owners_period() -> None:
    """Each ratified store carries its period and no proposal; none is undecided."""
    assert inventory_findings() == ()
    for key, deadline in _RATIFIED_STORES.items():
        store = _store(key)
        assert store.ratified is not None, key
        assert store.ratified.deadline == deadline, key
        assert store.ratified.rationale.strip(), key
    for store in STORES:
        assert store.proposal is None, store.key


def test_application_logs_keep_the_shorter_vendor_setting() -> None:
    """Ratified as written: 30 days *or the vendor's current setting, whichever is shorter*."""
    logs = _store("application_logs")
    assert logs.ratified is not None
    assert "whichever is shorter" in logs.ratified.rationale
    assert isinstance(logs.deadline, Unknown), "today's vendor retention is still unverified"


# --------------------------------------------------------------------------
# Guarded: the detectors still fire for the next undecided lifetime
# --------------------------------------------------------------------------


def test_an_unratified_rule_without_a_proposal_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The completeness check fires: an undecided lifetime must carry a proposal."""
    _patch_rule(monkeypatch, "loginattempt", _undecided("loginattempt", None))
    assert proposal_findings() == ("loginattempt is unratified but carries no proposal",)


def test_an_unproposed_soft_delete_rule_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nested soft-delete rules are held to the same standard as top-level ones."""
    _patch_soft_deleted(monkeypatch, replace(_soft_deleted(), ratified=False))
    assert any("journalentry (soft-deleted)" in f for f in proposal_findings())


def test_a_ratified_rule_cannot_keep_a_proposal(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ratifying means the proposal became the rule; a leftover one is reported."""
    # Otherwise faithful to the rule (same window and clock, same redaction),
    # so the leftover itself is the only finding.
    stale = replace(
        _proposal(180, compared=TodayComparison.SAME),
        redact_columns=REDACT_INSTEAD_OF_DELETE["gumroadsale"],
    )
    leftover = replace(RETENTION["gumroadsale"], proposal=stale)
    _patch_rule(monkeypatch, "gumroadsale", leftover)
    findings = proposal_findings()
    assert len(findings) == 1
    assert "ratified but still carries a proposal" in findings[0]


@pytest.mark.parametrize("table", sorted(NEVER_ELIGIBLE_STATES))
def test_a_ratified_rule_that_drops_its_exemption_is_reported(
    monkeypatch: pytest.MonkeyPatch, table: str
) -> None:
    """A rule without its exemption would expire open obligations; that is a finding."""
    _patch_rule(monkeypatch, table, replace(RETENTION[table], exempt_states=frozenset()))
    findings = proposal_findings()
    assert len(findings) == 1
    assert table in findings[0]
    for state in NEVER_ELIGIBLE_STATES[table]:
        assert state in findings[0]


def test_a_ratified_rule_that_exempts_only_some_open_states_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exempting ``pending_delete`` but not ``unconfirmed`` still expires open rows."""
    partial = replace(
        RETENTION["journalwithdrawalobligation"], exempt_states=frozenset({"pending_delete"})
    )
    _patch_rule(monkeypatch, "journalwithdrawalobligation", partial)
    findings = proposal_findings()
    assert len(findings) == 1
    assert "unconfirmed" in findings[0]
    assert "pending_delete" not in findings[0]


def test_a_ratified_sale_rule_that_deletes_instead_of_redacting_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Dropping the redaction would delete the receipt rather than blank the buyer."""
    _patch_rule(monkeypatch, "gumroadsale", replace(RETENTION["gumroadsale"], redact_columns=()))
    findings = proposal_findings()
    assert len(findings) == 1
    assert "redact" in findings[0]


def test_a_plain_fixed_days_rule_is_reported_for_a_conditional_table(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ratification edit done wrong: the constructor without the conditions."""
    plain = fixed_days(30, trigger="vault confirmation", rationale="r", ratified=True)
    monkeypatch.setattr(retention, "RETENTION", {"voicedraftretraction": plain})
    findings = proposal_findings()
    assert len(findings) == 1
    assert "mirror_intent" in findings[0]

    kept = conditional(plain, exempt_states=NEVER_ELIGIBLE_STATES["voicedraftretraction"])
    monkeypatch.setattr(retention, "RETENTION", {"voicedraftretraction": kept})
    assert proposal_findings() == ()


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


def test_a_proposal_keeping_an_obligation_past_erasure_is_longer_than_today(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The open question (AC21-22): 90 days after erasure on a table erased with the account.

    Declared ``shorter`` it is a finding; only an explicit ``longer`` passes.
    """
    before = until_account_deletion("synthetic", ratified=False)
    after_erasure = _proposal(
        _AFTER_ERASURE_DAYS,
        clock=ProposalClock.AFTER_ACCOUNT_DELETION,
        exempt=NEVER_ELIGIBLE_STATES["journalwithdrawalobligation"],
    )
    _patch_rule(monkeypatch, "journalwithdrawalobligation", replace(before, proposal=after_erasure))
    findings = proposal_findings()
    assert len(findings) == 1
    assert "journalwithdrawalobligation" in findings[0]
    assert "longer" in findings[0]

    declared = replace(after_erasure, compared_to_today=TodayComparison.LONGER)
    _patch_rule(monkeypatch, "journalwithdrawalobligation", replace(before, proposal=declared))
    assert proposal_findings() == ()


def test_a_proposal_longer_than_a_known_window_must_say_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A sweep with a known window is compared number to number."""
    today = 30
    longer = _proposal(today + 1)
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
    """Energy plans are erased with their account, so any clock from erasure outlives it."""
    after_erasure = _proposal(1, clock=ProposalClock.AFTER_ACCOUNT_DELETION)
    _patch_rule(monkeypatch, "energyplan", _undecided("energyplan", after_erasure))
    findings = proposal_findings()
    assert len(findings) == 1
    assert "energyplan" in findings[0]
    assert "longer" in findings[0]


def test_an_after_erasure_clock_on_a_soft_deleted_entry_is_longer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ERASE-disposition branch, on the nested soft-delete rule."""
    after_erasure = _proposal(1, clock=ProposalClock.AFTER_ACCOUNT_DELETION)
    _patch_soft_deleted(
        monkeypatch, replace(_soft_deleted(), ratified=False, proposal=after_erasure)
    )
    findings = proposal_findings()
    assert len(findings) == 1
    assert "journalentry (soft-deleted)" in findings[0]
    assert "longer" in findings[0]


def test_a_proposal_on_another_clock_than_the_window_cannot_be_compared(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A creation-keyed window and an event-keyed proposal are not comparable numbers."""
    other_clock = _proposal(1, clock=ProposalClock.ROW_EVENT)
    assert (
        implied_comparison("energyplan", RETENTION["energyplan"], other_clock)
        is TodayComparison.UNKNOWN
    )
    _patch_rule(monkeypatch, "energyplan", _undecided("energyplan", other_clock))
    findings = proposal_findings()
    assert len(findings) == 1
    assert "unknown" in findings[0]


def test_a_proposal_that_drops_open_obligations_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A future confirmed-only proposal without its exemption would expire open rows."""
    before = until_account_deletion("synthetic", ratified=False)
    _patch_rule(monkeypatch, "journalwithdrawalobligation", replace(before, proposal=_proposal(30)))
    findings = proposal_findings()
    assert len(findings) == 1
    assert "pending_delete" in findings[0]
    assert "unconfirmed" in findings[0]


def test_an_undecided_store_without_a_period_or_proposal_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unknown deadline owes a ratified period or a proposal."""
    _patch_store(monkeypatch, replace(_store("application_logs"), ratified=None))
    findings = inventory_findings()
    assert len(findings) == 1
    assert "application_logs" in findings[0]
    assert "undecided deadline" in findings[0]


def test_a_backup_leg_without_a_period_or_proposal_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A backup leg's retention is the owner's decision, so it must be ratified or proposed."""
    _patch_store(monkeypatch, replace(_store("railway_platform_backup"), ratified=None))
    findings = inventory_findings()
    assert len(findings) == 1
    assert "backup leg 'railway_platform_backup'" in findings[0]


def test_a_ratified_store_cannot_keep_a_proposal(monkeypatch: pytest.MonkeyPatch) -> None:
    """The store side of the ratification procedure: the proposal is deleted."""
    leftover = StoreProposal(
        deadline=Days(30), rationale="r", compared_to_today=TodayComparison.UNKNOWN
    )
    _patch_store(monkeypatch, replace(_store("application_logs"), proposal=leftover))
    findings = inventory_findings()
    assert len(findings) == 1
    assert "ratified but still carries a proposal" in findings[0]


def test_a_ratified_backup_leg_must_be_the_runbooks_retention(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A leg's ratified period is a live rule: it is the deadline the runbook prunes at."""
    drifted = RatifiedPeriod(deadline=Days(RAILWAY_PLATFORM_BACKUP_DAYS + 1), rationale="r")
    _patch_store(monkeypatch, replace(_store("railway_platform_backup"), ratified=drifted))
    findings = inventory_findings()
    assert len(findings) == 1
    assert "railway_platform_backup" in findings[0]
    assert "runbook" in findings[0]


def test_a_ratified_period_needs_a_rationale() -> None:
    """A blank ratified rationale cannot be constructed, so the report never shows one."""
    with pytest.raises(ValueError, match="rationale"):
        RatifiedPeriod(deadline=None, rationale="  ")


def test_a_store_proposal_longer_than_today_must_say_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A future store proposal may not quietly lengthen a known deadline."""
    longer = StoreProposal(
        deadline=Days(RAILWAY_PLATFORM_BACKUP_DAYS + 1),
        rationale="r",
        compared_to_today=TodayComparison.SHORTER,
    )
    _patch_store(
        monkeypatch, replace(_store("railway_platform_backup"), ratified=None, proposal=longer)
    )
    findings = inventory_findings()
    assert len(findings) == 1
    assert "longer" in findings[0]


def test_a_proposal_against_an_unknown_deadline_cannot_claim_to_be_shorter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Against an unverified vendor default, a period can only be 'unknown'."""
    claimed = StoreProposal(
        deadline=Days(30), rationale="r", compared_to_today=TodayComparison.SHORTER
    )
    _patch_store(monkeypatch, replace(_store("application_logs"), ratified=None, proposal=claimed))
    findings = inventory_findings()
    assert len(findings) == 1
    assert "unknown" in findings[0]


def test_a_store_proposal_needs_a_rationale() -> None:
    """A blank store rationale cannot be constructed, so the report never shows one."""
    with pytest.raises(ValueError, match="rationale"):
        StoreProposal(deadline=None, rationale="  ", compared_to_today=TodayComparison.SAME)


# --------------------------------------------------------------------------
# Honest: conditions are data, and the backup bound holds
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


def test_tombstone_bearing_rules_outlive_the_backup_bound() -> None:
    """A soft-deleted page and an erasure receipt are restore tombstones (AC9-10)."""
    soft_deleted_days = _soft_deleted().days
    assert soft_deleted_days is not None
    assert soft_deleted_days >= PURGE_MIN_RETENTION_DAYS
    receipt_days = RETENTION["accountdeletionaudit"].days
    assert receipt_days is not None
    assert receipt_days >= OLDEST_LIVE_BACKUP_DAYS


def test_retiring_the_offhost_leg_leaves_the_floor_at_the_held_bound() -> None:
    """The off-host leg is retired (#3260), and the floor is still 97, not 7.

    The floor is the maximum of today's legs and the bound of copies that may
    still be held from the retired leg, so retiring the leg alone leaves it at 97.
    """
    assert {leg.key for leg in BACKUP_LEGS} == {"railway_platform_backup"}
    assert "offhost_pg_dump" not in {store.key for store in STORES}
    assert HELD_BACKUP_BOUND_DAYS == (
        HELD_OFFHOST_DUMP_RETENTION_DAYS + HELD_OFFHOST_DUMP_INTERVAL_DAYS
    )
    assert oldest_live_backup_days(BACKUP_LEGS, HELD_BACKUP_BOUND_DAYS) == HELD_BACKUP_BOUND_DAYS
    assert max(leg.oldest_live_copy_days for leg in BACKUP_LEGS) < HELD_BACKUP_BOUND_DAYS
    assert OLDEST_LIVE_BACKUP_DAYS == HELD_BACKUP_BOUND_DAYS
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


def test_the_held_bound_alone_is_what_keeps_the_floor_at_97(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Dropping the held copies -- the separate, later change -- gives Railway's 7.

    Proves the 97 rests on the held copies and not on a leg, so the guard above
    is not vacuous: the day no retired-leg dump is held and the held bound is
    dropped, the floor and the purge's minimum fall to the platform leg's.
    """
    stores_path = _BACKEND_SRC / "domain" / "retention_stores.py"
    lowered = _load_variant(
        monkeypatch,
        "retention_stores_held_lowered",
        stores_path,
        (
            (
                "\nHELD_BACKUP_BOUND_DAYS: Final = HELD_OFFHOST_DUMP_RETENTION_DAYS + "
                "HELD_OFFHOST_DUMP_INTERVAL_DAYS\n"
            ),
            # No retired-leg dump held: nothing older than the platform leg survives.
            "\nHELD_BACKUP_BOUND_DAYS: Final = 0\n",
        ),
    )
    lowered_bound = RAILWAY_PLATFORM_BACKUP_DAYS + RAILWAY_PLATFORM_BACKUP_INTERVAL_DAYS
    assert lowered_bound == lowered.OLDEST_LIVE_BACKUP_DAYS

    monkeypatch.setitem(sys.modules, "domain.retention_stores", lowered)
    purge = _load_variant(
        monkeypatch,
        "journal_retention_held_lowered",
        _BACKEND_SRC / "services" / "journal_retention.py",
        ("PURGE_BATCH_SIZE: Final = 200\n", "PURGE_BATCH_SIZE: Final = 200\n"),
    )
    assert lowered_bound == purge.PURGE_MIN_RETENTION_DAYS


# --------------------------------------------------------------------------
# Honest: the existing sweeps run on the ratified windows
# --------------------------------------------------------------------------


def test_the_energy_plan_sweep_defaults_to_the_ratified_window() -> None:
    """The operator sweep that already existed now uses the owner's 7 days."""
    assert RETENTION["energyplan"].days == ENERGY_PLAN_RETENTION_DAYS
    default = inspect.signature(cleanup_energy_plans).parameters["older_than_days"].default
    assert default == ENERGY_PLAN_RETENTION_DAYS


def test_the_journal_purge_defaults_to_the_ratified_window() -> None:
    """The purge had no default because the window was undecided; now it is the bound."""
    assert _soft_deleted().days == PURGE_DEFAULT_RETENTION_DAYS == PURGE_MIN_RETENTION_DAYS
    default = inspect.signature(purge_journal_entries).parameters["older_than_days"].default
    assert default == PURGE_DEFAULT_RETENTION_DAYS


def test_report_marks_ratified_rules_and_unswept_periods() -> None:
    """The on-demand report shows each ratified period and that no sweep applies it yet."""
    lines = retention_report().splitlines()
    gumroad = next(line for line in lines if line.startswith("gumroadsale"))
    assert "fixed_days, 180 days" in gumroad
    assert "[ratified]" in gumroad
    assert "no sweep applies it yet" in gumroad
    assert not any("proposed" in line for line in lines)
    energy = next(line for line in lines if line.startswith("energyplan"))
    assert "no sweep applies it yet" not in energy


# --------------------------------------------------------------------------
# Honest: the owner's table carries exactly the code's values
# --------------------------------------------------------------------------


def _doc_rows(text: str) -> dict[str, list[str]]:
    """The doc's table rows, keyed by their first cell (backticks stripped)."""
    rows: dict[str, list[str]] = {}
    for line in text.splitlines():
        match = _TABLE_ROW.match(line)
        if match is None:
            continue
        cells = [cell.strip() for cell in match.group("cells").split("|")]
        first = cells[_FIRST_CELL]
        if len(cells) != _DOC_COLUMNS or set(first) <= _SEPARATOR_CHARS:
            continue
        if first == _HEADER_FIRST_CELL:
            continue
        rows[first.strip("`")] = cells
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


def test_the_owner_doc_records_every_ratified_row_with_the_codes_values() -> None:
    """The decision record and the registry cannot drift apart, in either direction."""
    text = _PROPOSAL_DOC.read_text(encoding="utf-8")
    assert "DRAFT" not in text
    assert _DECISION in text
    assert _DECISION_LINK in text
    rows = _doc_rows(text)
    rules = dict(_all_rules())
    stores = {store.key: store for store in STORES}
    assert set(rows) == set(_RATIFIED_RULES) | set(_RATIFIED_STORES)
    for name in _RATIFIED_RULES:
        assert rules[name].ratified, name
        assert _leading_period(rows[name][_PERIOD_CELL]) == (rules[name].days, "day"), name
    for key in _RATIFIED_STORES:
        ratified = stores[key].ratified
        assert ratified is not None, key
        assert _leading_period(rows[key][_PERIOD_CELL]) == _store_period(ratified.deadline), key
    for name, cells in rows.items():
        comparison = cells[_COMPARISON_CELL]
        assert comparison in {c.value for c in TodayComparison}, name
        assert comparison != TodayComparison.LONGER.value, f"{name}: ratified longer than before"


# --------------------------------------------------------------------------
# Inert proposals
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
    """A future proposal is never a window any sweep, purge or route uses."""
    offenders: dict[str, set[str]] = {}
    for path in sorted(_BACKEND_SRC.rglob("*.py")):
        relative = path.relative_to(_BACKEND_SRC).as_posix()
        if relative in _PROPOSAL_HOMES:
            continue
        reads = _proposal_reads(path.read_text(encoding="utf-8"))
        if reads:
            offenders[relative] = reads
    assert offenders == {}


def test_no_proposed_constant_survives_ratification() -> None:
    """Ratifying moved every PROPOSED_* value into a rule; none is left to drift."""
    for module in (retention, retention_stores):
        leftovers = [name for name in vars(module) if name.startswith(_PROPOSED_PREFIX)]
        assert leftovers == [], module.__name__


def test_store_is_constructible_without_a_decision() -> None:
    """A store whose deadline is known needs neither a period nor a proposal."""
    store = Store(
        key="k",
        description="d",
        controller=retention_stores.Controller.ADEPTHOOD,
        deadline=Hours(1),
        evidence="e",
    )
    assert store.proposal is None
    assert store.ratified is None
