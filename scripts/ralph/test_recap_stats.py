"""Tests for the Ralph recap: pure stats helpers and the backlog count.

Run from the repo root with:

    python -m pytest scripts/ralph -q

`stats.py` is pure and tested directly. `recap.py` is the I/O shell; only its
adepthood-specific backlog filtering is unit-tested here (network calls are
monkeypatched), since everything else is a thin wrapper over `stats`.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest

import recap
import stats as rs

UTC = dt.timezone.utc


def _at(day: int, hour: int = 12) -> dt.datetime:
    return dt.datetime(2026, 6, day, hour, tzinfo=UTC)


# ---------- parse_iso ----------


def test_parse_iso_handles_trailing_z() -> None:
    parsed = rs.parse_iso("2026-06-27T08:30:00Z")
    assert parsed == dt.datetime(2026, 6, 27, 8, 30, tzinfo=UTC)


# ---------- normalize_verdict ----------


def test_normalize_verdict_returns_none_without_verdict_line() -> None:
    assert rs.normalize_verdict("Looks great, merging!") is None


def test_normalize_verdict_detects_lgtm() -> None:
    assert rs.normalize_verdict("Nice work.\nVerdict: LGTM") == rs.LGTM


def test_normalize_verdict_changes_requested_beats_lgtm_mention() -> None:
    body = "This is not yet LGTM.\nVerdict: CHANGES_REQUESTED"
    assert rs.normalize_verdict(body) == rs.CHANGES_REQUESTED


def test_normalize_verdict_defaults_to_comments() -> None:
    assert rs.normalize_verdict("Some notes.\nVerdict: COMMENTS") == rs.COMMENTS


# ---------- iterations_before_lgtm ----------


def test_iterations_before_lgtm_counts_rounds() -> None:
    verdicts = [rs.CHANGES_REQUESTED, rs.COMMENTS, rs.LGTM]
    assert rs.iterations_before_lgtm(verdicts) == 2


def test_iterations_before_lgtm_zero_for_clean_merge() -> None:
    assert rs.iterations_before_lgtm([rs.LGTM]) == 0


def test_iterations_before_lgtm_none_when_never_lgtm() -> None:
    assert rs.iterations_before_lgtm([rs.CHANGES_REQUESTED, rs.COMMENTS]) is None


# ---------- merge_rate ----------


def test_merge_rate_empty() -> None:
    rate = rs.merge_rate([], now=_at(27))
    assert rate["total"] == 0.0
    assert rate["per_day"] == 0.0


def test_merge_rate_spans_first_merge_to_now() -> None:
    merged = [_at(20), _at(22), _at(24)]
    rate = rs.merge_rate(merged, now=_at(30))
    assert rate["total"] == 3.0
    assert rate["span_days"] == 10.0
    assert rate["per_day"] == 0.3


def test_merge_rate_last_7_days_window() -> None:
    merged = [_at(1), _at(25), _at(27)]
    rate = rs.merge_rate(merged, now=_at(28))
    assert rate["last_7_days"] == 2.0


# ---------- time_to_merge_stats ----------


def test_time_to_merge_stats() -> None:
    out = rs.time_to_merge_stats([1.0, 3.0, 5.0])
    assert out["median"] == 3.0
    assert out["fastest"] == 1.0
    assert out["slowest"] == 5.0
    assert out["mean"] == 3.0


# ---------- iteration_stats ----------


def test_iteration_stats_clean_merge_rate() -> None:
    out = rs.iteration_stats([0, 0, 2, 4])
    assert out["clean_merge_rate"] == 0.5
    assert out["max"] == 4.0
    assert out["sample"] == 4.0


def test_iteration_stats_empty() -> None:
    out = rs.iteration_stats([])
    assert out["sample"] == 0.0


# ---------- estimate_remaining ----------


def test_estimate_remaining_projects_eta() -> None:
    est = rs.estimate_remaining(10, 2.0, now=_at(1))
    assert est["known"] is True
    assert est["days_remaining"] == 5.0
    assert est["eta"] == _at(6)


def test_estimate_remaining_unknown_when_rate_zero() -> None:
    est = rs.estimate_remaining(10, 0.0, now=_at(1))
    assert est["known"] is False
    assert est["days_remaining"] is None


def test_estimate_remaining_clear_backlog() -> None:
    est = rs.estimate_remaining(0, 2.0, now=_at(1))
    assert est["open_items"] == 0
    assert est["days_remaining"] == 0.0


# ---------- churn_totals ----------


def test_churn_totals_sums_and_nets() -> None:
    out = rs.churn_totals([(10, 3, 2), (5, 5, 1)])
    assert out["additions"] == 15
    assert out["deletions"] == 8
    assert out["net"] == 7
    assert out["files"] == 3


# ---------- busiest_day ----------


def test_busiest_day_picks_max() -> None:
    merged = [_at(20), _at(20), _at(21)]
    result = rs.busiest_day(merged)
    assert result == ("2026-06-20", 2)


def test_busiest_day_none_when_empty() -> None:
    assert rs.busiest_day([]) is None


# ---------- count_open_backlog (adepthood adaptation) ----------


def _issue(number: int, *, labels: list[str], is_pr: bool = False) -> dict[str, Any]:
    issue: dict[str, Any] = {"number": number, "labels": [{"name": name} for name in labels]}
    if is_pr:
        issue["pull_request"] = {"url": f"https://example/{number}"}
    return issue


def _patch_issues(monkeypatch: pytest.MonkeyPatch, issues: list[dict[str, Any]]) -> None:
    monkeypatch.setattr(recap, "_gh_get_paged", lambda *a, **k: issues)


def test_count_open_backlog_excludes_prs_and_labelled_issues(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RALPH_EXCLUDE_LABELS", raising=False)
    issues = [
        _issue(1, labels=[]),  # counted
        _issue(2, labels=["enhancement"]),  # counted
        _issue(3, labels=["epic"]),  # excluded by label
        _issue(4, labels=["blocked", "enhancement"]),  # excluded by label
        _issue(5, labels=[], is_pr=True),  # excluded as a PR
    ]
    _patch_issues(monkeypatch, issues)
    assert recap.count_open_backlog("owner/repo", token="t") == 2


def test_count_open_backlog_respects_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RALPH_EXCLUDE_LABELS", "deferred")
    issues = [
        _issue(1, labels=["epic"]),  # no longer excluded (override drops "epic")
        _issue(2, labels=["deferred"]),  # excluded by override
        _issue(3, labels=[]),  # counted
    ]
    _patch_issues(monkeypatch, issues)
    assert recap.count_open_backlog("owner/repo", token="t") == 2
