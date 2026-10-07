"""The non-database store inventory is complete, honest about unknowns, and in sync.

The ORM registry covers every table, but a deleted account's writing also lives
in places no ``MetaData`` can enumerate: two backup legs, logs, client caches,
the Creek vault and its provider's snapshots. :mod:`domain.retention_stores`
lists them as data. These tests hold it to three properties:

* every store whose deadline nobody knows says so with an open-question marker
  that points at an issue, rather than an empty "unknown";
* the backup legs' day counts are the same numbers ``DEPLOYMENT.md`` states, so
  a runbook edit cannot silently diverge from what the code inventories;
* the drift parser reads rows by their *label*, so unrelated edits that shift
  lines do not break it -- and a changed value does.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from domain import retention_stores
from domain.retention_stores import (
    BACKUP_LEGS,
    OFFHOST_DUMP_INTERVAL_DAYS,
    OFFHOST_DUMP_RETENTION_DAYS,
    RAILWAY_PLATFORM_BACKUP_DAYS,
    RAILWAY_PLATFORM_BACKUP_INTERVAL_DAYS,
    STORES,
    Days,
    Store,
    Unknown,
    inventory_findings,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_DEPLOYMENT_DOC = _REPO_ROOT / "DEPLOYMENT.md"
_BACKUP_HEADING = "### What is backed up"
_NEXT_HEADING = re.compile(r"^#{2,3} ", re.MULTILINE)
_RETENTION_CELL = re.compile(r"^(\d+) days?$")

# Columns of the backup table: Leg | Mechanism | Schedule | Retention | Survives.
_LEG_COLUMN = 0
_SCHEDULE_COLUMN = 2
_RETENTION_COLUMN = 3
# The runbook names a schedule; the inventory needs it as days between copies.
_SCHEDULE_DAYS = {"Daily": 1, "Weekly": 7}
_DUMP_HEADING = "### Taking an off-host dump"
_BASH_BLOCK = re.compile(r"```bash\n(.*?)```", re.DOTALL)
_DRAFT_MARKER = "DRAFT for owner review (#3063)"

_EXPECTED_STORES = frozenset(
    {
        "railway_platform_backup",
        "offhost_pg_dump",
        "application_logs",
        "invalid_license_throttle",
        "client_device_cache",
        "creek_vault_volume",
        "fly_volume_snapshots",
        "creek_embeddings_cache",
        "creek_ledger",
        "model_vendor_copies",
        "manual_vaults",
    }
)


def _backup_rows(text: str) -> dict[str, list[str]]:
    """Rows of the 'What is backed up' table, keyed by their first cell."""
    start = text.find(_BACKUP_HEADING)
    assert start != -1, f"{_DEPLOYMENT_DOC} has no '{_BACKUP_HEADING}' section"
    rest = text[start + len(_BACKUP_HEADING) :]
    end = _NEXT_HEADING.search(rest)
    section = rest[: end.start()] if end else rest
    rows: dict[str, list[str]] = {}
    for line in section.splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        rows[cells[_LEG_COLUMN]] = cells
    return rows


def _days_in(rows: dict[str, list[str]], leg: str) -> int:
    """The retention day count the runbook states for one backup leg."""
    assert leg in rows, f"the backup table has no {leg!r} row"
    match = _RETENTION_CELL.match(rows[leg][_RETENTION_COLUMN])
    assert match, f"{leg!r} retention cell is not a day count: {rows[leg][_RETENTION_COLUMN]!r}"
    return int(match.group(1))


def test_deployment_backup_table_matches_inventory() -> None:
    """The runbook's backup retention values are the inventory's constants."""
    rows = _backup_rows(_DEPLOYMENT_DOC.read_text(encoding="utf-8"))
    assert _days_in(rows, "Platform") == RAILWAY_PLATFORM_BACKUP_DAYS
    assert _days_in(rows, "Off-host") == OFFHOST_DUMP_RETENTION_DAYS


def test_drift_parser_notices_a_changed_value() -> None:
    """The parser is not vacuous: a runbook saying 7 days disagrees with 6."""
    text = _DEPLOYMENT_DOC.read_text(encoding="utf-8")
    edited = text.replace(
        f"| Daily | {RAILWAY_PLATFORM_BACKUP_DAYS} days |",
        f"| Daily | {RAILWAY_PLATFORM_BACKUP_DAYS + 1} days |",
    )
    assert edited != text
    assert _days_in(_backup_rows(edited), "Platform") != RAILWAY_PLATFORM_BACKUP_DAYS


def test_inventory_names_every_known_store() -> None:
    """The inventory is non-empty and covers every store the audit found."""
    assert {store.key for store in STORES} == _EXPECTED_STORES


def test_backup_legs_carry_the_constants() -> None:
    """The two backup stores are bounded by the same constants the drift test pins."""
    by_key = {store.key: store for store in STORES}
    assert by_key["railway_platform_backup"].deadline == Days(RAILWAY_PLATFORM_BACKUP_DAYS)
    assert by_key["offhost_pg_dump"].deadline == Days(OFFHOST_DUMP_RETENTION_DAYS)


def test_every_unknown_deadline_carries_an_open_question() -> None:
    """An unknown deadline is a tracked question, never a silent blank."""
    assert inventory_findings() == ()
    snapshots = next(store for store in STORES if store.key == "fly_volume_snapshots")
    assert isinstance(snapshots.deadline, Unknown)
    assert "AC19" in snapshots.deadline.open_question


def test_findings_fire_on_a_blank_question(monkeypatch: pytest.MonkeyPatch) -> None:
    """The detector is proven to fire, not merely to be silent."""
    blank = Store(
        key="synthetic",
        description="a store nobody has asked about",
        controller=retention_stores.Controller.ADEPTHOOD,
        deadline=Unknown(open_question="we should check this sometime"),
        evidence="nowhere",
    )
    monkeypatch.setattr(retention_stores, "STORES", (*STORES, blank))
    findings = inventory_findings()
    assert len(findings) == 1
    assert "synthetic" in findings[0]


def test_findings_fire_on_duplicate_keys_and_missing_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A duplicated key or an evidence-free row is a finding too."""
    first = STORES[0]
    duplicate = Store(
        key=first.key,
        description=first.description,
        controller=first.controller,
        deadline=first.deadline,
        evidence="  ",
    )
    monkeypatch.setattr(retention_stores, "STORES", (*STORES, duplicate))
    findings = inventory_findings()
    assert any("duplicate" in finding for finding in findings)
    assert any("evidence" in finding for finding in findings)


def test_day_count_must_be_positive() -> None:
    """A zero-day deadline is a typo, not a store that deletes instantly."""
    with pytest.raises(ValueError, match="positive"):
        Days(0)


def _section(text: str, heading: str) -> str:
    start = text.find(heading)
    assert start != -1, f"{_DEPLOYMENT_DOC} has no '{heading}' section"
    rest = text[start + len(heading) :]
    end = _NEXT_HEADING.search(rest)
    return rest[: end.start()] if end else rest


def test_deployment_backup_schedule_matches_the_leg_intervals() -> None:
    """Each leg's interval is the schedule the runbook states for it."""
    rows = _backup_rows(_DEPLOYMENT_DOC.read_text(encoding="utf-8"))
    assert _SCHEDULE_DAYS[rows["Platform"][_SCHEDULE_COLUMN]] == (
        RAILWAY_PLATFORM_BACKUP_INTERVAL_DAYS
    )
    assert _SCHEDULE_DAYS[rows["Off-host"][_SCHEDULE_COLUMN]] == OFFHOST_DUMP_INTERVAL_DAYS


def test_backup_legs_are_the_backup_stores() -> None:
    """Every backup store is a leg with the same retention, and each leg cites evidence."""
    by_key = {store.key: store for store in STORES}
    assert {leg.key for leg in BACKUP_LEGS} == {"railway_platform_backup", "offhost_pg_dump"}
    for leg in BACKUP_LEGS:
        assert by_key[leg.key].deadline == Days(leg.retention_days)
        assert leg.interval_days > 0
        assert leg.evidence.strip()


def test_offhost_runbook_prunes_dumps_past_their_retention() -> None:
    """The 90 days is an operation someone performs, not a number on a page.

    The weekly dump procedure deletes dumps older than the retention the
    inventory states; the purge floor depends on that happening.
    """
    section = _section(_DEPLOYMENT_DOC.read_text(encoding="utf-8"), _DUMP_HEADING)
    assert _DRAFT_MARKER in section
    shell = "\n".join(_BASH_BLOCK.findall(section))
    prune = re.search(r"find\b[^\n]*\.dump\.gpg[^\n]*-mtime \+(\d+)[^\n]*-delete", shell)
    assert prune, "the off-host procedure never deletes expired .gpg dumps"
    assert int(prune.group(1)) == OFFHOST_DUMP_RETENTION_DAYS
