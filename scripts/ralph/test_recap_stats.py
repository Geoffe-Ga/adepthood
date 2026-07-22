"""Tests for the Ralph recap: pure stats helpers and the backlog count.

Run from the repo root with:

    python -m pytest scripts/ralph -q

`stats.py` is pure and tested directly. `recap.py` is the I/O shell; only its
adepthood-specific backlog filtering is unit-tested here (network calls are
monkeypatched), since everything else is a thin wrapper over `stats`.
"""

from __future__ import annotations

import datetime as dt
import pathlib
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
    assert rate == {"last_24h": 0.0, "per_hour": 0.0, "last_7_days": 0.0, "per_day": 0.0}


def test_merge_rate_last_24h_per_hour() -> None:
    # Two merges within 24h of `now` (27th 06:00 and 12:00); one is older.
    merged = [_at(26, 5), _at(27, 6), _at(27, 12)]
    rate = rs.merge_rate(merged, now=_at(27, 12))
    assert rate["last_24h"] == 2.0
    assert rate["per_hour"] == 2.0 / 24.0


def test_merge_rate_last_7_days_per_day() -> None:
    # Two merges within 7 days of the 28th; the 1st is outside the window.
    merged = [_at(1), _at(25), _at(27)]
    rate = rs.merge_rate(merged, now=_at(28))
    assert rate["last_7_days"] == 2.0
    assert rate["per_day"] == 2.0 / 7.0


def test_merge_rate_drops_stale_all_time_keys() -> None:
    rate = rs.merge_rate([_at(27)], now=_at(27))
    assert "total" not in rate
    assert "span_days" not in rate


# ---------- time_to_merge_stats ----------


def test_time_to_merge_stats() -> None:
    out = rs.time_to_merge_stats([1.0, 3.0, 5.0])
    assert out["median"] == 3.0
    assert out["fastest"] == 1.0
    assert out["slowest"] == 5.0
    assert out["mean"] == 3.0


# ---------- merge_intervals_hours ----------


def test_merge_intervals_hours_returns_consecutive_gaps() -> None:
    # 09:00, 12:00, 15:00 -> two 3-hour gaps.
    assert rs.merge_intervals_hours([_at(27, 9), _at(27, 12), _at(27, 15)]) == [3.0, 3.0]


def test_merge_intervals_hours_sorts_before_diffing() -> None:
    # Newest-first input (as the recap holds it) still yields positive gaps.
    assert rs.merge_intervals_hours([_at(27, 15), _at(27, 9), _at(27, 12)]) == [3.0, 3.0]


def test_merge_intervals_hours_empty_below_two_merges() -> None:
    assert rs.merge_intervals_hours([]) == []
    assert rs.merge_intervals_hours([_at(27, 9)]) == []


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


# ---------- net_lines_from_code_frequency ----------


def test_net_lines_from_code_frequency_sums_signed_weeks() -> None:
    # GitHub reports deletions as negatives: (100-30) + (50-10) = 110.
    weeks = [[1_700_000_000, 100, -30], [1_700_600_000, 50, -10]]
    assert rs.net_lines_from_code_frequency(weeks) == 110


def test_net_lines_from_code_frequency_empty_is_zero() -> None:
    assert rs.net_lines_from_code_frequency([]) == 0


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


# ---------- count_merged_total ----------


def test_count_merged_total_reads_search_total_count(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(recap, "_request_json", lambda *a, **k: {"total_count": 723, "items": []})
    assert recap.count_merged_total("owner/repo", token="t") == 723


# ---------- fetch_recent_merged_prs ----------


def _hit(number: int, *, merged: str, created: str) -> dict[str, Any]:
    return {"number": number, "created_at": created, "pull_request": {"merged_at": merged}}


def test_fetch_recent_merged_prs_sorts_newest_merge_first(monkeypatch: pytest.MonkeyPatch) -> None:
    hits = [
        _hit(1, merged="2026-06-25T00:00:00Z", created="2026-06-24T00:00:00Z"),
        _hit(2, merged="2026-06-27T00:00:00Z", created="2026-06-26T00:00:00Z"),
        _hit(3, merged="2026-06-26T00:00:00Z", created="2026-06-25T00:00:00Z"),
    ]
    monkeypatch.setattr(recap, "_gh_search_issues", lambda *a, **k: hits)
    out = recap.fetch_recent_merged_prs("owner/repo", token="t", since=_at(20).date(), max_prs=200)
    assert [pr["number"] for pr in out] == [2, 3, 1]


# ---------- _open_to_merge_hours ----------


def test_open_to_merge_hours_measures_open_to_merge_window() -> None:
    pr = _hit(1, merged="2026-06-27T12:00:00Z", created="2026-06-27T10:00:00Z")
    assert recap._open_to_merge_hours(pr) == 2.0


def test_open_to_merge_hours_clamps_negative_to_zero() -> None:
    # Clock skew (merge stamped before open) must not produce a negative window.
    pr = _hit(1, merged="2026-06-27T10:00:00Z", created="2026-06-27T12:00:00Z")
    assert recap._open_to_merge_hours(pr) == 0.0


# ---------- _pr_churn ----------


def test_pr_churn_reads_detail_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(recap, "fetch_pr_detail", lambda *a, **k: {"additions": 12, "deletions": 4, "changed_files": 3})
    assert recap._pr_churn("owner/repo", 1, token="t") == (12, 4, 3)


def test_pr_churn_degrades_to_zero_on_http_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import urllib.error

    def _boom(*_a: Any, **_k: Any) -> dict[str, Any]:
        raise urllib.error.URLError("network down")

    monkeypatch.setattr(recap, "fetch_pr_detail", _boom)
    assert recap._pr_churn("owner/repo", 1, token="t") == (0, 0, 0)


# ---------- fetch_repo_net_lines ----------


def test_fetch_repo_net_lines_sums_code_frequency(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(recap, "_request_json", lambda *a, **k: [[1, 100, -40], [2, 20, -5]])
    assert recap.fetch_repo_net_lines("owner/repo", token="t") == 75


def test_fetch_repo_net_lines_none_when_stats_still_warming(monkeypatch: pytest.MonkeyPatch) -> None:
    # A 202 from GitHub yields an empty body (None); retries exhaust to None.
    # Inject a no-op sleep so the backoff doesn't actually wait.
    monkeypatch.setattr(recap, "_request_json", lambda *a, **k: None)
    assert (
        recap.fetch_repo_net_lines("owner/repo", token="t", attempts=2, sleep=lambda _s: None)
        is None
    )


def test_fetch_repo_net_lines_warms_to_data_after_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    # Cold 202 (None) twice, then the warmed stats land — backoff between tries.
    responses: list[object] = [None, None, [[0, 100, -40]]]
    calls = {"n": 0}

    def _req(*_a: Any, **_k: Any) -> object:
        out = responses[calls["n"]]
        calls["n"] += 1
        return out

    monkeypatch.setattr(recap, "_request_json", _req)
    slept: list[float] = []
    result = recap.fetch_repo_net_lines("owner/repo", token="t", attempts=4, sleep=slept.append)
    assert result == 60  # 100 + (-40)
    assert calls["n"] == 3
    assert slept == [2.0, 4.0]  # exponential backoff before the 2nd and 3rd attempts


def test_fetch_repo_net_lines_empty_list_is_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    # A valid 200 [] (no history) is 0 net, not the "—" placeholder.
    monkeypatch.setattr(recap, "_request_json", lambda *a, **k: [])
    assert recap.fetch_repo_net_lines("owner/repo", token="t", sleep=lambda _s: None) == 0


def test_loc_line_renders_zero_net_not_dash() -> None:
    line = recap._loc_line({"additions": 0, "deletions": 0}, {"additions": 0, "deletions": 0}, 0)
    assert "0 net" in line
    assert "—" not in line


def test_fetch_repo_net_lines_none_on_http_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import urllib.error

    def _boom(*_a: Any, **_k: Any) -> object:
        raise urllib.error.HTTPError("u", 500, "err", {}, None)  # type: ignore[arg-type]

    monkeypatch.setattr(recap, "_request_json", _boom)
    assert recap.fetch_repo_net_lines("owner/repo", token="t") is None


# ---------- this-PR display lines ----------


def test_this_pr_iter_line_variants() -> None:
    assert recap._this_pr_iter_line(None) == "merged without an LGTM verdict"
    assert recap._this_pr_iter_line(0) == "**0** rounds · clean first try"
    assert recap._this_pr_iter_line(1) == "**1** round to LGTM"
    assert recap._this_pr_iter_line(3) == "**3** rounds to LGTM"


def test_this_pr_tick_line_handles_first_merge() -> None:
    assert recap._this_pr_tick_line(None) == "first tracked merge"
    assert recap._this_pr_tick_line(0.5) == "**30m** since the previous merge"


def test_this_pr_review_line_formats_window() -> None:
    assert recap._this_pr_review_line(2.0) == "**2.0h** open → merge"


def test_loc_line_renders_three_windows() -> None:
    loc_24h = {"additions": 1200, "deletions": 300, "net": 900, "files": 5}
    loc_7d = {"additions": 8400, "deletions": 1600, "net": 6800, "files": 40}
    line = recap._loc_line(loc_24h, loc_7d, 124_500)
    assert line == "+1,200 / -300 (24h) · +8,400 / -1,600 (7d) · 124,500 net (full repo)"


def test_loc_line_placeholder_when_repo_net_unavailable() -> None:
    totals = {"additions": 0, "deletions": 0, "net": 0, "files": 0}
    line = recap._loc_line(totals, totals, None)
    assert line.endswith("— (full repo)")


# ---------- _heuristic_headline ----------


def test_heuristic_headline_strips_conventional_prefix() -> None:
    assert recap._heuristic_headline("feat(backend): add the energy ledger") == "add the energy ledger"


def test_heuristic_headline_clips_to_ten_words() -> None:
    headline = recap._heuristic_headline("one two three four five six seven eight nine ten eleven")
    assert headline == "one two three four five six seven eight nine ten"


def test_heuristic_headline_blank_title_falls_back() -> None:
    assert recap._heuristic_headline("   ") == "Latest change merged into the tick loop"


# ---------- generate_headline ----------


class _Block:
    def __init__(self, text: str, kind: str = "text") -> None:
        self.text = text
        self.type = kind


class _Response:
    def __init__(self, blocks: list[_Block]) -> None:
        self.content = blocks


class _FakeAnthropic:
    """Minimal stand-in for the anthropic SDK that records create() kwargs."""

    last_kwargs: dict[str, Any] = {}

    class _Client:
        def __init__(self) -> None:
            self.messages = _FakeAnthropic._Messages()

    class _Messages:
        def create(self, **kwargs: Any) -> _Response:
            _FakeAnthropic.last_kwargs = kwargs
            return _Response([_Block("Energy ledger now powers daily streaks")])

    def Anthropic(self) -> "_FakeAnthropic._Client":  # noqa: N802 - mirrors the SDK's class name
        return _FakeAnthropic._Client()


def test_generate_headline_uses_sdk_and_passes_low_effort(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeAnthropic()
    _FakeAnthropic.last_kwargs = {}
    monkeypatch.setattr(recap, "_anthropic_mod", fake)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")  # pragma: allowlist secret

    headline = recap.generate_headline("feat: add energy ledger", "Body text")

    assert headline == "Energy ledger now powers daily streaks"
    assert _FakeAnthropic.last_kwargs["model"] == recap.HEADLINE_MODEL
    assert _FakeAnthropic.last_kwargs["output_config"] == {"effort": "low"}


def test_generate_headline_falls_back_when_no_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(recap, "_anthropic_mod", _FakeAnthropic())
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    assert recap.generate_headline("feat: add energy ledger", "Body") == "add energy ledger"


def test_generate_headline_falls_back_when_sdk_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(recap, "_anthropic_mod", None)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")  # pragma: allowlist secret

    assert recap.generate_headline("feat: add energy ledger", "Body") == "add energy ledger"


def test_generate_headline_falls_back_on_sdk_error(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Boom:
        def Anthropic(self) -> object:  # noqa: N802 - mirrors the SDK's class name
            raise RuntimeError("api down")

    monkeypatch.setattr(recap, "_anthropic_mod", _Boom())
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")  # pragma: allowlist secret

    assert recap.generate_headline("feat: add energy ledger", "Body") == "add energy ledger"


# ---------- parse_benchmark_trend ----------


def test_parse_benchmark_trend_parses_lines_in_input_order() -> None:
    # Newest-first input stays newest-first: the parser never sorts.
    lines = [
        '{"date": "2026-07-09", "reduction_avg": 21, "nodes": 16144, "edges": 36585}\n',
        '{"date": "2026-07-08", "reduction_avg": 16.4, "nodes": 15000, "edges": 35000}\n',
    ]
    out = rs.parse_benchmark_trend(lines)
    assert out == [
        {"date": "2026-07-09", "reduction_avg": 21.0, "nodes": 16144, "edges": 36585},
        {"date": "2026-07-08", "reduction_avg": 16.4, "nodes": 15000, "edges": 35000},
    ]
    assert isinstance(out[0]["reduction_avg"], float)
    assert isinstance(out[0]["nodes"], int)
    assert isinstance(out[0]["edges"], int)
    assert isinstance(out[0]["date"], str)


def test_parse_benchmark_trend_skips_blank_and_malformed_lines() -> None:
    lines = [
        "",
        "\n",
        "not json",
        '{"date": "2026-07-08"}',
        '["not", "an", "object"]',
        '{"date": "2026-07-09", "reduction_avg": 16.8, "nodes": 15080, "edges": 35598}',
    ]
    assert rs.parse_benchmark_trend(lines) == [
        {"date": "2026-07-09", "reduction_avg": 16.8, "nodes": 15080, "edges": 35598},
    ]


def test_parse_benchmark_trend_empty_input() -> None:
    assert rs.parse_benchmark_trend([]) == []


# ---------- benchmark_trend_summary ----------


def _trend_record(date: str, reduction: float, *, nodes: int = 16000, edges: int = 36000) -> dict[str, Any]:
    return {"date": date, "reduction_avg": reduction, "nodes": nodes, "edges": edges}


def test_benchmark_trend_summary_none_for_empty() -> None:
    assert rs.benchmark_trend_summary([]) is None


def test_benchmark_trend_summary_delta_up_from_week_old_prior() -> None:
    records = [
        _trend_record("2026-07-01", 16.4),
        _trend_record("2026-07-10", 16.8, nodes=15080, edges=35598),
    ]
    assert rs.benchmark_trend_summary(records) == {
        "date": "2026-07-10",
        "reduction_avg": 16.8,
        "nodes": 15080,
        "edges": 35598,
        "reduction_delta": 0.4,
    }


def test_benchmark_trend_summary_delta_down_is_negative() -> None:
    records = [_trend_record("2026-07-01", 17.1), _trend_record("2026-07-10", 16.8)]
    summary = rs.benchmark_trend_summary(records)
    assert summary is not None
    assert summary["reduction_delta"] == -0.3


def test_benchmark_trend_summary_delta_none_without_week_old_prior() -> None:
    # 2026-07-08 is only 2 days before the latest; no record is >= 7 days old.
    records = [_trend_record("2026-07-08", 16.6), _trend_record("2026-07-10", 16.8)]
    summary = rs.benchmark_trend_summary(records)
    assert summary is not None
    assert summary["reduction_delta"] is None


def test_benchmark_trend_summary_prior_exactly_week_days_old_counts() -> None:
    records = [_trend_record("2026-07-03", 16.0), _trend_record("2026-07-10", 16.5)]
    summary = rs.benchmark_trend_summary(records)
    assert summary is not None
    assert summary["reduction_delta"] == 0.5


def test_benchmark_trend_summary_picks_most_recent_qualifying_prior() -> None:
    records = [
        _trend_record("2026-06-25", 15.0),
        _trend_record("2026-07-02", 16.0),
        _trend_record("2026-07-10", 16.5),
    ]
    summary = rs.benchmark_trend_summary(records)
    assert summary is not None
    assert summary["reduction_delta"] == 0.5


# ---------- days_since ----------


def test_days_since_date_only_is_utc_midnight() -> None:
    now = dt.datetime(2026, 7, 10, 12, 0, tzinfo=UTC)
    assert rs.days_since("2026-07-07", now=now) == 3


def test_days_since_z_suffixed_full_iso() -> None:
    now = dt.datetime(2026, 7, 10, 12, 0, tzinfo=UTC)
    assert rs.days_since("2026-07-07T12:00:00Z", now=now) == 3


def test_days_since_partial_day_floors_to_zero() -> None:
    now = dt.datetime(2026, 7, 10, 12, 0, tzinfo=UTC)
    assert rs.days_since("2026-07-09T18:00:00Z", now=now) == 0


# ---------- _graph_recap_line ----------

_GRAPH_NOW = dt.datetime(2026, 7, 10, 12, 0, tzinfo=UTC)


def _graph_summary(delta: float | None) -> dict[str, Any]:
    return {
        "date": "2026-07-10",
        "reduction_avg": 16.8,
        "nodes": 15080,
        "edges": 35598,
        "reduction_delta": delta,
    }


def test_graph_recap_line_full_with_semantic_meta_and_positive_delta() -> None:
    meta = {"kind": "code+semantic", "built_at": "2026-07-07T12:00:00Z"}
    line = recap._graph_recap_line(_graph_summary(0.4), meta, now=_GRAPH_NOW)
    assert line == (
        "Knowledge graph: 15,080 nodes / 35,598 edges · "
        "avg query reduction 16.8× (↑0.4 vs last week) · "
        "semantic layer 3 days fresh"
    )
    # Pin the deliberate glyphs: MULTIPLICATION SIGN U+00D7 and UPWARDS ARROW U+2191, not ASCII.
    assert "16.8×" in line
    assert "16.8x" not in line
    assert "↑" in line


def test_graph_recap_line_negative_delta_uses_down_arrow() -> None:
    line = recap._graph_recap_line(_graph_summary(-0.3), None, now=_GRAPH_NOW)
    assert "(↓0.3 vs last week)" in line
    assert "↑" not in line


def test_graph_recap_line_omits_delta_clause_when_none() -> None:
    line = recap._graph_recap_line(_graph_summary(None), None, now=_GRAPH_NOW)
    assert "vs last week" not in line
    assert "16.8×" in line


def test_graph_recap_line_omits_semantic_clause_without_meta() -> None:
    line = recap._graph_recap_line(_graph_summary(0.4), None, now=_GRAPH_NOW)
    assert "semantic layer" not in line


def test_graph_recap_line_omits_semantic_clause_for_code_only_meta() -> None:
    meta = {"kind": "code-only", "built_at": "2026-07-07T12:00:00Z"}
    line = recap._graph_recap_line(_graph_summary(0.4), meta, now=_GRAPH_NOW)
    assert "semantic layer" not in line


def test_graph_recap_line_omits_semantic_clause_without_built_at() -> None:
    meta = {"kind": "code+semantic"}
    line = recap._graph_recap_line(_graph_summary(0.4), meta, now=_GRAPH_NOW)
    assert "semantic layer" not in line


# ---------- load_benchmark_trend ----------


def test_load_benchmark_trend_missing_file_returns_empty(tmp_path: pathlib.Path) -> None:
    assert recap.load_benchmark_trend(tmp_path / "missing.jsonl") == []


def test_load_benchmark_trend_reads_jsonl(tmp_path: pathlib.Path) -> None:
    path = tmp_path / "trend.jsonl"
    path.write_text(
        '{"date": "2026-07-09", "reduction_avg": 20.9, "nodes": 16144, "edges": 36585}\n\ngarbage\n',
        encoding="utf-8",
    )
    assert recap.load_benchmark_trend(path) == [
        {"date": "2026-07-09", "reduction_avg": 20.9, "nodes": 16144, "edges": 36585},
    ]


# ---------- fetch_semantic_meta ----------


def test_fetch_semantic_meta_returns_release_asset_json(monkeypatch: pytest.MonkeyPatch) -> None:
    # semantic-meta.json is the semantic layer's own provenance asset, published
    # only by the weekly semantic pass so the nightly code build never clobbers it.
    meta = {"kind": "code+semantic", "built_at": "2026-07-07T12:00:00Z"}
    release = {
        "tag_name": "knowledge-graph",
        "assets": [
            {
                "name": "semantic-meta.json",
                "id": 99,
                "url": f"{recap.GITHUB_API}/repos/owner/repo/releases/assets/99",
                "browser_download_url": "https://example.com/download/semantic-meta.json",
            },
        ],
    }

    def _fake(url: str, **_k: Any) -> object:
        # Any asset-shaped URL yields the meta body; the release lookup itself
        # yields the release listing.
        if "semantic-meta.json" in url or "/assets/" in url:
            return meta
        return release

    monkeypatch.setattr(recap, "_request_json", _fake)
    assert recap.fetch_semantic_meta("owner/repo", token="t") == meta


def test_fetch_semantic_meta_none_on_http_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import urllib.error

    def _boom(*_a: Any, **_k: Any) -> object:
        raise urllib.error.HTTPError("u", 404, "missing", {}, None)  # type: ignore[arg-type]

    monkeypatch.setattr(recap, "_request_json", _boom)
    assert recap.fetch_semantic_meta("owner/repo", token="t") is None


def test_fetch_semantic_meta_none_on_url_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import urllib.error

    def _boom(*_a: Any, **_k: Any) -> object:
        raise urllib.error.URLError("network down")

    monkeypatch.setattr(recap, "_request_json", _boom)
    assert recap.fetch_semantic_meta("owner/repo", token="t") is None
