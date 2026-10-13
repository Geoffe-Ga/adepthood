"""Meta-test for ``backend/scripts/retention_report.py`` (#3063).

The script prints the retention registry and the owner's ratification worklist.
It is an operator and reviewer aid, not a gate, but it must still run cleanly
and list the rules nobody has ratified -- ``gumroadsale`` above all, whose
lifetime is a legal question.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from domain import retention
from domain.retention import (
    RETENTION,
    ProposalClock,
    RetentionProposal,
    TodayComparison,
)
from scripts.retention_report import main


def test_report_exits_zero_and_shows_the_ratified_periods(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The report runs; every lifetime is ratified, and each store shows its period."""
    assert main([]) == 0
    out = capsys.readouterr().out
    assert "gumroadsale" in out
    unratified = out.split("Unratified", 1)[1].split("Stores outside", 1)[0]
    assert unratified.splitlines()[1:] == ["  none", ""]
    snapshots = next(line for line in out.splitlines() if "fly_volume_snapshots" in line)
    assert "ratified: 1 days" in snapshots
    creek = next(line for line in out.splitlines() if "creek_ledger" in line)
    assert "ratified: no fixed period" in creek


def test_report_lists_an_undecided_rule_with_its_proposal(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The worklist still names the next undecided lifetime, with what is proposed."""
    proposal = RetentionProposal(
        days=1,
        clock=ProposalClock.ROW_CREATED,
        trigger="the attempt",
        rationale="synthetic",
        compared_to_today=TodayComparison.SHORTER,
    )
    undecided = replace(RETENTION["loginattempt"], ratified=False, proposal=proposal)
    monkeypatch.setattr(retention, "RETENTION", {**RETENTION, "loginattempt": undecided})
    assert main([]) == 0
    unratified = capsys.readouterr().out.split("Unratified", 1)[1]
    line = next(line for line in unratified.splitlines() if "loginattempt" in line)
    assert "proposed: 1 day after the attempt" in line


def test_report_exits_nonzero_on_a_registry_gap(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A gap in the registry turns the report into a failure, not a footnote."""
    monkeypatch.setattr("scripts.retention_report.retention_gaps", lambda _m: ("table 'x'",))
    assert main([]) != 0
    assert "table 'x'" in capsys.readouterr().err


def test_report_exits_nonzero_on_a_missing_proposal(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """An unratified rule with no proposal is a failure the owner cannot review."""
    monkeypatch.setattr(
        "scripts.retention_report.proposal_findings",
        lambda: ("gumroadsale is unratified but carries no proposal",),
    )
    assert main([]) != 0
    assert "carries no proposal" in capsys.readouterr().err
