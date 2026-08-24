"""Tests for ``backend/scripts/issue_evidence.py``.

The checker exists because this repo's backlog decays faster than it is groomed:
on 2026-08-22 five issues in one day — four of them P0/P1 — carried premises that
were already false at HEAD, and two were caught only because a human re-ran their
greps by hand. Every one of those issues quoted the command that proved its
finding, so the evidence was mechanically re-runnable and nothing ever re-ran it.

These tests pin the two properties that decide whether such a checker is worth
having at all.

**It must never manufacture an ``expired``.** A bot that posts "your premise has
expired" on live work is distrusted after the first false positive, and after
that it costs more than it saves. Two traps recorded on the issue drive the
cases below: an extraction issue whose proposed symbol has *not been written yet*
looks identical to a resolved one under a naive grep, and an issue's *title* may
paraphrase a symbol that the code spells differently. Both must land on
``unverifiable``, never ``expired``.

**It must never let silence look like a pass.** A claim the extractor could not
turn into a command is not a verified claim. An issue with nothing checkable
reports ``unverifiable``, and every unparseable claim is named in the report.

Everything here runs against ``tmp_path`` trees and literal issue bodies. The
module under test performs no subprocess calls and no network I/O by design —
issue bodies are untrusted text written by many hands, so the "grep" is executed
in-process over an explicitly-vetted pattern subset rather than handed to a
shell. ``test_module_never_shells_out`` pins that.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from scripts import issue_evidence as mod
from scripts.issue_evidence import (
    EXIT_CLEAN,
    EXIT_EXPIRED,
    EXIT_INPUT,
    EXPIRED,
    HOLDS,
    KIND_GREP,
    KIND_PATH_LINE,
    KIND_QUOTED_LINE,
    UNVERIFIABLE,
    check_issue,
    extract_claims,
    main,
    render_report,
)


def _issue(number: int, body: str, title: str = "an issue") -> dict[str, object]:
    return {"number": number, "title": title, "body": body}


def _repo(tmp_path: Path, files: dict[str, str]) -> Path:
    for rel, text in files.items():
        target = tmp_path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
    return tmp_path


# --------------------------------------------------------------------------
# grep claims — extraction
# --------------------------------------------------------------------------


def test_extracts_grep_invocation_pattern_and_path() -> None:
    body = 'Running `grep -rn "upload" frontend/src` returns nothing.'
    claims = [c for c in extract_claims(body, Path()) if c.kind == KIND_GREP]
    assert len(claims) == 1
    assert claims[0].pattern == "upload"
    assert claims[0].target == "frontend/src"


def test_grep_claim_records_asserted_zero_polarity() -> None:
    body = '`grep -rn "widget" backend/src` returns nothing.'
    claim = next(c for c in extract_claims(body, Path()) if c.kind == KIND_GREP)
    assert claim.expects_matches is False


def test_grep_claim_records_asserted_nonzero_polarity() -> None:
    body = '`grep -rn "widget" backend/src` returns three hits.'
    claim = next(c for c in extract_claims(body, Path()) if c.kind == KIND_GREP)
    assert claim.expects_matches is True


def test_grep_claim_polarity_survives_markdown_emphasis() -> None:
    body = '- `grep -rn "widget" backend/src` -> **zero hits**. No picker.'
    claim = next(c for c in extract_claims(body, Path()) if c.kind == KIND_GREP)
    assert claim.expects_matches is False


# --------------------------------------------------------------------------
# grep claims — the two traps
# --------------------------------------------------------------------------


def test_absent_symbol_that_was_always_absent_holds(tmp_path: Path) -> None:
    """Trap 1: a refactor's proposed name has not been written yet.

    "``grep X`` returns nothing **and that is the bug**" and "``grep X`` returns
    nothing **and that means fixed**" are opposite claims that look identical to
    a pattern matcher. Absence that the body itself asserts is the premise, not
    its expiry.
    """
    root = _repo(tmp_path, {"backend/src/seed_helpers.py": "existing_system_keys = ()\n"})
    body = '`grep -rn "reject_duplicate_keys" backend/src` returns nothing — that is the bug.'
    report = check_issue(_issue(1, body), root)
    assert report.verdict == HOLDS


def test_claims_are_never_derived_from_the_title(tmp_path: Path) -> None:
    """Trap 2: titles paraphrase, bodies quote.

    ``install_trace_id_filter`` in a title names a function the code spells
    ``install_trace_id_logging``. Nothing in the title may become a claim.
    """
    root = _repo(
        tmp_path,
        {"backend/src/observability.py": "def install_trace_id_logging() -> None: ...\n"},
    )
    report = check_issue(
        _issue(1, "No checkable evidence here.", title="`install_trace_id_filter` is gone"),
        root,
    )
    assert report.verdict == UNVERIFIABLE
    assert all("install_trace_id_filter" not in result.claim.source for result in report.results)


# --------------------------------------------------------------------------
# grep claims — checking
# --------------------------------------------------------------------------


def test_asserted_zero_now_matching_is_expired(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"frontend/src/a.ts": "import pickSeedDocuments from './x';\n"})
    body = '`grep -rn "pickSeedDocuments" frontend/src` -> **zero hits**.'
    report = check_issue(_issue(2250, body), root)
    assert report.verdict == EXPIRED
    assert "pickSeedDocuments" in report.expired[0].claim.pattern


def test_asserted_nonzero_now_empty_is_expired(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "pass\n"})
    body = '`grep -rn "legacy_call" backend/src` returns four hits.'
    report = check_issue(_issue(3, body), root)
    assert report.verdict == EXPIRED


def test_asserted_nonzero_still_matching_holds(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "legacy_call()\n"})
    body = '`grep -rn "legacy_call" backend/src` returns four hits.'
    assert check_issue(_issue(3, body), root).verdict == HOLDS


def test_grep_without_stated_polarity_is_unverifiable(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "pass\n"})
    body = 'Start from `grep -rn "legacy_call" backend/src` and read what it prints.'
    report = check_issue(_issue(3, body), root)
    assert report.verdict == UNVERIFIABLE
    assert "polarity" in report.unverifiable[0].note


def test_bre_alternation_is_supported(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"frontend/src/a.ts": "const p = '/upload';\n"})
    body = r'`grep -rn "journal/upload\|/upload" frontend/src` -> zero hits.'
    assert check_issue(_issue(2250, body), root).verdict == EXPIRED


def test_regex_metacharacters_are_unverifiable_not_guessed(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "pass\n"})
    body = '`grep -rn "def .*_handler" backend/src` returns nothing.'
    report = check_issue(_issue(3, body), root)
    assert report.verdict == UNVERIFIABLE
    assert "regex" in report.unverifiable[0].note


def test_inverting_flag_is_unverifiable(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "pass\n"})
    body = '`grep -rvn "widget" backend/src` returns nothing.'
    report = check_issue(_issue(3, body), root)
    assert report.verdict == UNVERIFIABLE
    assert "flag" in report.unverifiable[0].note


def test_case_insensitive_flag_is_honoured(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "WIDGET = 1\n"})
    body = '`grep -rin "widget" backend/src` returns nothing.'
    assert check_issue(_issue(3, body), root).verdict == EXPIRED


def test_shell_metacharacters_in_path_are_refused(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "pass\n"})
    body = '`grep -rn "x" backend/src; rm -rf /` returns nothing.'
    report = check_issue(_issue(3, body), root)
    for result in report.results:
        assert result.verdict != EXPIRED


def test_absolute_and_parent_paths_are_refused(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "pass\n"})
    for path in ("/etc", "../secrets"):
        body = f'`grep -rn "x" {path}` returns nothing.'
        report = check_issue(_issue(3, body), root)
        assert report.verdict == UNVERIFIABLE


def test_missing_search_path_is_unverifiable_not_expired(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "pass\n"})
    body = '`grep -rn "x" docs/vendored` returns nothing.'
    report = check_issue(_issue(3, body), root)
    assert report.verdict == UNVERIFIABLE


def test_grep_note_reports_the_actual_count_and_first_match(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"frontend/src/a.ts": "widget\nwidget\n"})
    body = '`grep -rn "widget" frontend/src` returns nothing.'
    note = check_issue(_issue(3, body), root).expired[0].note
    assert "2" in note
    assert "frontend/src/a.ts:1" in note


# --------------------------------------------------------------------------
# path:line claims
# --------------------------------------------------------------------------


def test_path_line_within_file_length_holds(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\nb\nc\n"})
    report = check_issue(_issue(4, "See `backend/src/a.py:3` for the shape."), root)
    assert report.verdict == HOLDS


def test_path_line_past_end_of_file_is_expired(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\nb\n"})
    report = check_issue(_issue(4, "See `backend/src/a.py:900` for the shape."), root)
    assert report.verdict == EXPIRED
    assert "900" in report.expired[0].note


def test_missing_file_in_an_existing_directory_is_expired(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    report = check_issue(_issue(4, "See `backend/src/gone.py:3`."), root)
    assert report.verdict == EXPIRED


def test_path_rooted_outside_the_repo_tree_is_unverifiable(tmp_path: Path) -> None:
    """A citation into another repo is not this repo's citation.

    ``docs/Ontology/creek_ontology_agent_prompt.md:334`` names creek-vault, not
    adepthood. ``docs/`` exists here, so a naive "does the file exist" check
    reports a deletion that never happened.
    """
    root = _repo(tmp_path, {"docs/adr/0004.md": "a\n"})
    report = check_issue(_issue(4, "See `docs/Ontology/creek_ontology_agent_prompt.md:334`."), root)
    assert report.verdict == UNVERIFIABLE


def test_bare_filename_without_a_directory_is_not_a_claim(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/observability.py": "a\n"})
    claims = extract_claims("The function lives at observability.py:152.", root)
    assert [c for c in claims if c.kind == KIND_PATH_LINE] == []


def test_line_range_uses_its_upper_bound(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\nb\nc\n"})
    assert check_issue(_issue(4, "`backend/src/a.py:2-3`"), root).verdict == HOLDS
    assert check_issue(_issue(4, "`backend/src/a.py:2-9`"), root).verdict == EXPIRED


# --------------------------------------------------------------------------
# quoted-line claims
# --------------------------------------------------------------------------


def test_quoted_line_still_present_holds(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": 'x = 1\nREFLECT = "creek.reflect"\n'})
    body = 'The enum: `backend/src/a.py:2` — `REFLECT = "creek.reflect"`'
    report = check_issue(_issue(5, body), root)
    assert report.verdict == HOLDS
    assert any(r.claim.kind == KIND_QUOTED_LINE for r in report.results)


def test_quoted_line_moved_elsewhere_is_unverifiable(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": 'REFLECT = "creek.reflect"\nx = 1\n'})
    body = 'The enum: `backend/src/a.py:2` — `REFLECT = "creek.reflect"`'
    result = next(
        r for r in check_issue(_issue(5, body), root).results if r.claim.kind == KIND_QUOTED_LINE
    )
    assert result.verdict == UNVERIFIABLE
    assert "moved" in result.note


def test_quoted_line_gone_from_the_file_is_expired(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "x = 1\ny = 2\n"})
    body = 'The enum: `backend/src/a.py:2` — `REFLECT = "creek.reflect"`'
    result = next(
        r for r in check_issue(_issue(5, body), root).results if r.claim.kind == KIND_QUOTED_LINE
    )
    assert result.verdict == EXPIRED


def test_bare_identifier_after_a_citation_is_not_a_quoted_line(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\nb\nc\n"})
    claims = extract_claims("`backend/src/a.py:2` — `_content_params` / `reflect`", root)
    assert [c for c in claims if c.kind == KIND_QUOTED_LINE] == []


# --------------------------------------------------------------------------
# verdict aggregation and loudness
# --------------------------------------------------------------------------


def test_one_expired_claim_decides_the_issue(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    body = "`backend/src/a.py:1` holds but `backend/src/a.py:400` does not."
    assert check_issue(_issue(6, body), root).verdict == EXPIRED


def test_issue_with_no_extractable_claims_is_unverifiable(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    report = check_issue(_issue(7, "Please make the onboarding feel warmer."), root)
    assert report.verdict == UNVERIFIABLE
    assert report.results == ()


def test_holding_issue_still_surfaces_its_unverifiable_claims(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\n", "docs/adr/0004.md": "a\n"})
    body = "`backend/src/a.py:1` and `docs/Ontology/other.md:5`."
    report = check_issue(_issue(8, body), root)
    assert report.verdict == HOLDS
    assert report.counts[UNVERIFIABLE] == 1
    rendered = render_report([report])
    assert "UNVERIFIABLE" in rendered
    assert "docs/Ontology/other.md" in rendered


def test_render_report_states_that_unverifiable_is_not_a_pass(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    report = check_issue(_issue(9, "Nothing checkable here at all."), root)
    rendered = render_report([report])
    assert "not a passing claim" in rendered.lower()


def test_render_report_is_empty_safe() -> None:
    assert "0 issue" in render_report([])


# --------------------------------------------------------------------------
# comment plumbing — once per transition, never per run
# --------------------------------------------------------------------------


def test_comment_marker_is_stable_for_the_same_findings(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"frontend/src/a.ts": "widget\n"})
    body = '`grep -rn "widget" frontend/src` returns nothing.'
    first = mod.comment_marker(check_issue(_issue(10, body), root))
    second = mod.comment_marker(check_issue(_issue(10, body), root))
    assert first == second
    assert first.startswith("<!-- issue-evidence:")


def test_comment_marker_changes_when_the_findings_change(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"frontend/src/a.ts": "widget\n", "backend/src/a.py": "a\n"})
    one = check_issue(_issue(10, '`grep -rn "widget" frontend/src` returns nothing.'), root)
    two = check_issue(_issue(10, "`backend/src/a.py:80`"), root)
    assert mod.comment_marker(one) != mod.comment_marker(two)


def test_comment_body_names_the_claim_and_what_is_there_now(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"frontend/src/a.ts": "widget\n"})
    report = check_issue(_issue(10, '`grep -rn "widget" frontend/src` returns nothing.'), root)
    text = mod.comment_body(report)
    assert "widget" in text
    assert "frontend/src/a.ts:1" in text
    assert mod.comment_marker(report) in text


def test_only_expired_issues_get_a_comment_payload(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    reports = [
        check_issue(_issue(11, "`backend/src/a.py:1`"), root),
        check_issue(_issue(12, "`backend/src/a.py:900`"), root),
    ]
    payload = mod.machine_payload(reports)
    assert [entry["number"] for entry in payload["comment"]] == [12]


# --------------------------------------------------------------------------
# the closed-but-not-done audit
# --------------------------------------------------------------------------


def test_closed_with_null_commit_and_holding_claims_is_flagged(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"NORTH-STAR.md": "a\nb\nthe Creek Vault MCP seam\n"})
    issue = _issue(2283, "See `NORTH-STAR.md:3`.")
    issue["state"] = "CLOSED"
    issue["closed_by_commit"] = None
    payload = mod.machine_payload([check_issue(issue, root)])
    assert payload["closed_not_done"] == [2283]


def test_closed_with_a_real_commit_is_not_flagged(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"NORTH-STAR.md": "a\nb\nc\n"})
    issue = _issue(2284, "See `NORTH-STAR.md:3`.")
    issue["state"] = "CLOSED"
    issue["closed_by_commit"] = "deadbeef"
    assert mod.machine_payload([check_issue(issue, root)])["closed_not_done"] == []


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _write_issues(tmp_path: Path, issues: list[dict[str, object]]) -> Path:
    path = tmp_path / "issues.json"
    path.write_text(json.dumps(issues), encoding="utf-8")
    return path


def test_main_returns_clean_when_nothing_expired(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    issues = _write_issues(tmp_path, [_issue(1, "`backend/src/a.py:1`")])
    assert main(["--issues-json", str(issues), "--root", str(root)]) == EXIT_CLEAN
    assert HOLDS in capsys.readouterr().out


def test_main_returns_expired_code_when_a_premise_expired(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    issues = _write_issues(tmp_path, [_issue(1, "`backend/src/a.py:900`")])
    assert main(["--issues-json", str(issues), "--root", str(root)]) == EXIT_EXPIRED


def test_main_reports_unreadable_input_as_an_input_error_not_a_verdict(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A transport failure must never look like an expired premise.

    ``gh`` failing on rate limits or an expired token yields no issues; reading
    that as "nothing expired" — or worse, as a verdict — is the bug #2219 fixed
    in ``pr-ready.sh``.
    """
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    missing = tmp_path / "absent.json"
    assert main(["--issues-json", str(missing), "--root", str(root)]) == EXIT_INPUT
    assert EXPIRED not in capsys.readouterr().err


def test_main_rejects_a_json_document_that_is_not_a_list(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    path = tmp_path / "issues.json"
    path.write_text('{"message": "API rate limit exceeded"}', encoding="utf-8")
    assert main(["--issues-json", str(path), "--root", str(root)]) == EXIT_INPUT


def test_main_writes_machine_payload_when_asked(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    issues = _write_issues(tmp_path, [_issue(42, "`backend/src/a.py:900`")])
    out = tmp_path / "payload.json"
    main(["--issues-json", str(issues), "--root", str(root), "--json-out", str(out)])
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["comment"][0]["number"] == 42
    assert payload["comment"][0]["marker"].startswith("<!-- issue-evidence:")


def test_main_reads_stdin_when_asked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps([_issue(1, "`backend/src/a.py:1`")])))
    assert main(["--issues-json", "-", "--root", str(root)]) == EXIT_CLEAN
    assert "#1" in capsys.readouterr().out


# --------------------------------------------------------------------------
# safety properties
# --------------------------------------------------------------------------


def test_module_never_shells_out() -> None:
    """Issue bodies are untrusted input and this job holds a write token."""
    source = Path(mod.__file__).read_text(encoding="utf-8")
    for forbidden in ("subprocess", "os.system", "shell=True", "popen"):
        assert forbidden not in source.replace("no subprocess", "")


def test_a_citation_repeated_in_the_body_is_checked_once(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    claims = extract_claims("`backend/src/a.py:1` ... and again `backend/src/a.py:1`.", root)
    assert len([c for c in claims if c.kind == KIND_PATH_LINE]) == 1


def test_grep_against_a_single_file_is_supported(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "widget = 1\n"})
    body = '`grep -n "widget" backend/src/a.py` returns nothing.'
    assert check_issue(_issue(15, body), root).verdict == EXPIRED


def test_oversized_files_are_skipped_by_the_search(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _repo(tmp_path, {"frontend/src/big.ts": "widget\n"})
    monkeypatch.setattr(mod, "MAX_SEARCHED_BYTES", 1)
    body = '`grep -rn "widget" frontend/src` returns nothing.'
    assert check_issue(_issue(16, body), root).verdict == HOLDS


def test_path_traversal_in_a_citation_is_unverifiable(tmp_path: Path) -> None:
    """A citation that escapes the repo is refused, never resolved."""
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    report = check_issue(_issue(17, "See `backend/../../etc/passwd.py:1`."), root)
    assert report.verdict == UNVERIFIABLE


def test_quoted_line_on_a_deleted_file_is_unverifiable(tmp_path: Path) -> None:
    """The deletion is the path:line claim's finding, not the quote's."""
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    body = 'It read `backend/src/gone.py:2` - `REFLECT = "creek.reflect"`'
    result = next(
        r for r in check_issue(_issue(18, body), root).results if r.claim.kind == KIND_QUOTED_LINE
    )
    assert result.verdict == UNVERIFIABLE


def test_quoted_line_past_end_of_file_defers_to_the_path_claim(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"backend/src/a.py": "a\n"})
    body = 'It read `backend/src/a.py:9` - `REFLECT = "creek.reflect"`'
    result = next(
        r for r in check_issue(_issue(19, body), root).results if r.claim.kind == KIND_QUOTED_LINE
    )
    assert result.verdict == UNVERIFIABLE
    assert "path:line" in result.note


def test_search_skips_vendored_and_generated_trees(tmp_path: Path) -> None:
    root = _repo(
        tmp_path,
        {"frontend/src/a.ts": "clean\n", "frontend/src/node_modules/dep/x.ts": "widget\n"},
    )
    body = '`grep -rn "widget" frontend/src` returns nothing.'
    assert check_issue(_issue(13, body), root).verdict == HOLDS


def test_undecodable_files_do_not_crash_the_search(tmp_path: Path) -> None:
    root = _repo(tmp_path, {"frontend/src/a.ts": "clean\n"})
    (root / "frontend/src/blob.bin").write_bytes(b"\xff\xfe\x00widget")
    body = '`grep -rn "nothinghere" frontend/src` returns nothing.'
    assert check_issue(_issue(14, body), root).verdict == HOLDS
