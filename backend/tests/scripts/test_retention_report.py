"""Meta-test for ``backend/scripts/retention_report.py`` (#3063).

The script prints the retention registry and the owner's ratification worklist.
It is an operator and reviewer aid, not a gate, but it must still run cleanly
and list the rules nobody has ratified -- ``gumroadsale`` above all, whose
lifetime is a legal question.
"""

from __future__ import annotations

import pytest

from scripts.retention_report import main


def test_report_exits_zero_and_lists_unratified(capsys: pytest.CaptureFixture[str]) -> None:
    """The report runs and names the payment record as unratified."""
    assert main([]) == 0
    out = capsys.readouterr().out
    assert "gumroadsale" in out
    unratified = out.split("Unratified", 1)[1]
    assert "gumroadsale" in unratified
    assert "fly_volume_snapshots" in out
    gumroad = next(line for line in unratified.splitlines() if "gumroadsale" in line)
    assert "proposed:" in gumroad


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
