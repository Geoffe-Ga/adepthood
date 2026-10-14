"""Tests for ``backend/scripts/claim_certification.py`` (issue #3076).

A certification record is an independent, signed, expiring release decision
for one claim of the claim ledger (``docs/legal/claim-ledger.json``). The
validator must refuse every shortcut the issue names -- a self-review, a
dangling or xfail test reference, a serving build that is not the tested
commit, an unmet dependency gate, a copy edited after signoff, an expired
certificate -- and must still certify a record that does everything right.
The positive control (:func:`test_fully_valid_record_certifies`) is what keeps
the rest of this file from passing against a validator that rejects
everything.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from collections.abc import Callable
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Final

import pytest

from scripts import claim_certification as cert
from scripts.claim_certification import Reason

_BACKEND_DIR: Final = Path(__file__).resolve().parents[2]
_MODULE_PATH: Final = _BACKEND_DIR / "scripts" / "claim_certification.py"

SHA_A: Final = "a" * 40
SHA_B: Final = "b" * 40
DIGEST: Final = "sha256:" + "0" * 64
SENTENCE: Final = "Intimate entries do not leave the primary private journal boundary."
NODE: Final = "backend/tests/security/test_x.py::test_y"
XFAIL_NODE: Final = "backend/tests/security/test_x.py::test_gap"
JEST: Final = "frontend/__tests__/x.test.ts"
COVERED_JOURNEY: Final = "journal.write"
UNCOVERED_JOURNEY: Final = "journal.gap"
TODAY: Final = date(2026, 10, 6)
ISSUED: Final = date(2026, 10, 1)
#: Evidence is gathered before the certificate is issued, and the signoff follows it.
EVIDENCE_DAY: Final = "2026-09-28"
SENTINEL: Final = "zzsentinelzz"

Record = dict[str, Any]


def _passed(item: str) -> dict[str, object]:
    return {"item": item, "status": "passed", "evidence_ref": {"kind": "github_pull", "number": 1}}


def _ledger_entry(**overrides: object) -> dict[str, object]:
    entry: dict[str, object] = {
        "id": "C07",
        "sentence": SENTENCE,
        "sentence_sha256": cert.sentence_digest(SENTENCE),
        "audit_status": "partially_true",
        "required_gates": [["B01"], ["B03"], ["B13", "B14"]],
        "status": "withheld",
    }
    entry.update(overrides)
    return entry


def _certified() -> Record:
    return {
        "claim_id": "C07",
        "status": "certified",
        "implementers": ["alice"],
        "reviewer": "rhea",
        "tested_commits": {"backend": SHA_A, "frontend": SHA_A},
        "serving_receipt": {
            "receipt_schema": 1,
            "backend_release": SHA_A,
            "frontend_release": SHA_A,
            "observed_on": EVIDENCE_DAY,
            "artifact_sha256": DIGEST,
        },
        "automated_evidence": [
            {"kind": "pytest", "ref": NODE},
            {"kind": "jest", "ref": JEST},
            {"kind": "journey", "ref": COVERED_JOURNEY},
        ],
        "live_journey_evidence": [{"observed_on": EVIDENCE_DAY, "artifact_sha256": DIGEST}],
        "required_gates": [
            [_passed("B01")],
            [_passed("B03")],
            [_passed("B13"), {"item": "B14", "status": "pending", "evidence_ref": None}],
        ],
        "issued_on": ISSUED.isoformat(),
        "expires_on": "2026-12-01",
        "release_decision": {
            "decider": "geoffe-ga",
            "decided_on": ISSUED.isoformat(),
            "sentence_sha256": cert.sentence_digest(SENTENCE),
        },
        "exclusions": [],
        "limitations": ["forbidden_effect_coverage_partial"],
    }


def _node_state(ref: str) -> str:
    return {NODE: "present", XFAIL_NODE: "xfail"}.get(ref, "missing")


def _evidence(
    node_state: Callable[[str], str] | None = _node_state,
) -> cert.Evidence:
    return cert.Evidence(
        node_state=node_state,
        jest_file_exists=lambda ref: ref == JEST,
        journeys={COVERED_JOURNEY: "covered", UNCOVERED_JOURNEY: "uncovered"},
    )


def _validate(
    record: object,
    *,
    entry: dict[str, object] | None = None,
    coverage: str | None = "partial",
    today: date = TODAY,
    evidence: cert.Evidence | None = None,
) -> tuple[int, tuple[Reason, ...]]:
    return cert.validate_record(
        record,
        ledger_entry=entry or _ledger_entry(),
        coverage_status=coverage,
        today=today,
        evidence=evidence or _evidence(),
    )


def _incomplete(*reasons: Reason) -> tuple[int, tuple[Reason, ...]]:
    return (cert.EXIT_INCOMPLETE, reasons)


def _invalid(*reasons: Reason) -> tuple[int, tuple[Reason, ...]]:
    return (cert.EXIT_INVALID, reasons)


# ── Positive controls ─────────────────────────────────────────────────────────


def test_fully_valid_record_certifies() -> None:
    assert _validate(_certified()) == (cert.EXIT_CERTIFIED, ())


def test_validity_exactly_at_limit_certifies() -> None:
    record = _certified()
    record["expires_on"] = (ISSUED + timedelta(days=cert.MAX_CERTIFICATE_AGE_DAYS)).isoformat()
    assert _validate(record) == (cert.EXIT_CERTIFIED, ())
    record["expires_on"] = (ISSUED + timedelta(days=cert.MAX_CERTIFICATE_AGE_DAYS + 1)).isoformat()
    assert _validate(record) == _invalid(Reason.VALIDITY_TOO_LONG)


def test_last_valid_day_certifies_and_the_next_expires() -> None:
    record = _certified()
    assert _validate(record, today=date(2026, 12, 1)) == (cert.EXIT_CERTIFIED, ())
    assert _validate(record, today=date(2026, 12, 2)) == _incomplete(Reason.EXPIRED)


# ── Independence (AC6) ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("reviewer", "reason"),
    [
        (None, Reason.REVIEWER_MISSING),
        ("alice", Reason.REVIEWER_IS_IMPLEMENTER),
        ("Alice", Reason.REVIEWER_IS_IMPLEMENTER),
        ("claude", Reason.REVIEWER_IS_AGENT),
        ("Claude", Reason.REVIEWER_IS_AGENT),
        ("bot", Reason.REVIEWER_IS_AGENT),
        ("agent", Reason.REVIEWER_IS_AGENT),
        ("github-actions", Reason.REVIEWER_IS_AGENT),
        ("renovate[bot]", Reason.REVIEWER_IS_AGENT),
        ("github-actions[bot]", Reason.REVIEWER_IS_AGENT),
    ],
)
def test_certified_record_without_independent_reviewer_is_incomplete(
    reviewer: str | None, reason: Reason
) -> None:
    record = _certified()
    record["reviewer"] = reviewer
    assert _validate(record) == _incomplete(reason)


@pytest.mark.parametrize("reviewer", ["abbott", "talbot", "ralphie", "reagent-x"])
def test_agent_denylist_is_exact_not_substring(reviewer: str) -> None:
    record = _certified()
    record["reviewer"] = reviewer
    assert _validate(record) == (cert.EXIT_CERTIFIED, ())


def test_an_email_identity_is_never_a_reviewer() -> None:
    """``noreply@anthropic.com`` is the loop's commit identity: not a login, so invalid."""
    record = _certified()
    record["reviewer"] = "noreply@anthropic.com"
    assert _validate(record) == _invalid(Reason.BAD_LOGIN)


def test_missing_implementers_cannot_prove_independence() -> None:
    record = _certified()
    record["implementers"] = []
    assert _validate(record) == _incomplete(Reason.IMPLEMENTERS_MISSING)


def test_an_agent_signoff_is_not_a_release_decision() -> None:
    record = _certified()
    record["release_decision"]["decider"] = "claude"
    assert _validate(record) == _incomplete(Reason.SIGNOFF_BY_AGENT)


# ── Automated evidence (AC4, AC5) ─────────────────────────────────────────────


def test_dangling_pytest_node_id_is_invalid_not_passing() -> None:
    record = _certified()
    record["automated_evidence"][0]["ref"] = "backend/tests/security/test_x.py::test_gone"
    assert _validate(record) == _invalid(Reason.DANGLING_PYTEST_NODE)


def test_unresolvable_pytest_evidence_is_not_a_pass() -> None:
    assert _validate(_certified(), evidence=_evidence(None)) == _incomplete(
        Reason.UNVERIFIABLE_PYTEST_EVIDENCE
    )


def test_dangling_jest_file_is_invalid() -> None:
    record = _certified()
    record["automated_evidence"][1]["ref"] = "frontend/__tests__/gone.test.ts"
    assert _validate(record) == _invalid(Reason.DANGLING_JEST_FILE)


def test_unknown_journey_is_invalid() -> None:
    record = _certified()
    record["automated_evidence"][2]["ref"] = "journal.never-registered"
    assert _validate(record) == _invalid(Reason.UNKNOWN_JOURNEY)


def test_uncovered_journey_cannot_support_certification() -> None:
    record = _certified()
    record["automated_evidence"][2]["ref"] = UNCOVERED_JOURNEY
    assert _validate(record) == _incomplete(Reason.UNCOVERED_JOURNEY)


def test_xfail_node_cannot_support_certification() -> None:
    record = _certified()
    record["automated_evidence"][0]["ref"] = XFAIL_NODE
    assert _validate(record) == _incomplete(Reason.NON_RUNNING_EVIDENCE)


def test_certified_record_needs_automated_evidence() -> None:
    record = _certified()
    record["automated_evidence"] = []
    assert _validate(record) == _incomplete(Reason.AUTOMATED_EVIDENCE_MISSING)


@pytest.mark.parametrize(
    ("kind", "ref"),
    [
        ("pytest", "https://example.test/x.py::test_y"),
        ("pytest", "backend/tests/../x.py::test_y"),
        ("jest", "frontend/../etc/passwd.test.ts"),
        ("journey", "Some free text about a user"),
        ("screenshot", "journal.write"),
    ],
)
def test_unsafe_or_unknown_reference_is_invalid(kind: str, ref: str) -> None:
    record = _certified()
    record["automated_evidence"] = [{"kind": kind, "ref": ref}]
    assert _validate(record) == _invalid(Reason.UNSAFE_REFERENCE)


# ── Serving binding (AC7) ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("field", "value", "reason"),
    [
        ("backend_release", SHA_B, Reason.BACKEND_RELEASE_DRIFT),
        ("frontend_release", SHA_B, Reason.FRONTEND_RELEASE_DRIFT),
        ("frontend_release", "unknown", Reason.FRONTEND_RELEASE_DRIFT),
        ("receipt_schema", 2, Reason.RECEIPT_SCHEMA_UNSUPPORTED),
    ],
)
def test_serving_release_drift_blocks_certification(
    field: str, value: object, reason: Reason
) -> None:
    record = _certified()
    record["serving_receipt"][field] = value
    assert _validate(record) == _incomplete(reason)


def test_missing_receipt_blocks_certification() -> None:
    record = _certified()
    record["serving_receipt"] = None
    assert _validate(record) == _incomplete(Reason.RECEIPT_MISSING)


def test_declared_per_service_commit_pair_certifies() -> None:
    record = _certified()
    record["tested_commits"]["frontend"] = SHA_B
    record["serving_receipt"]["frontend_release"] = SHA_B
    assert _validate(record) == (cert.EXIT_CERTIFIED, ())


def test_tested_commit_must_be_a_full_sha() -> None:
    record = _certified()
    record["tested_commits"]["backend"] = "abc123"
    assert _validate(record) == _invalid(Reason.BAD_TESTED_COMMIT)
    record["tested_commits"]["backend"] = None
    assert _validate(record) == _incomplete(
        Reason.TESTED_COMMIT_MISSING, Reason.BACKEND_RELEASE_DRIFT
    )


# ── Expiry (AC8) ──────────────────────────────────────────────────────────────


def test_expired_certificate_is_incomplete() -> None:
    assert _validate(_certified(), today=date(2026, 12, 2)) == _incomplete(Reason.EXPIRED)


def test_issued_in_future_is_invalid() -> None:
    record = _certified()
    record["issued_on"] = "2026-10-07"
    assert _validate(record) == _invalid(Reason.ISSUED_IN_FUTURE)


def test_signoff_dated_in_future_is_invalid() -> None:
    record = _certified()
    record["release_decision"]["decided_on"] = "2026-10-07"
    assert _validate(record) == _invalid(Reason.OBSERVED_IN_FUTURE)


def test_window_ending_before_it_starts_is_invalid() -> None:
    record = _certified()
    record["expires_on"] = "2026-09-01"
    assert _validate(record) == _invalid(Reason.VALIDITY_TOO_LONG)


def test_certified_record_needs_a_validity_window() -> None:
    record = _certified()
    record["expires_on"] = None
    assert _validate(record) == _incomplete(Reason.VALIDITY_MISSING)


# ── Dependency gates (AC9) ────────────────────────────────────────────────────


def test_unmet_dependency_gate_blocks_certification() -> None:
    record = _certified()
    record["required_gates"][1][0]["status"] = "pending"
    assert _validate(record) == _incomplete(Reason.GATE_UNMET)


def test_passed_gate_without_evidence_is_unmet() -> None:
    record = _certified()
    record["required_gates"][0][0]["evidence_ref"] = None
    assert _validate(record) == _incomplete(Reason.GATE_EVIDENCE_MISSING, Reason.GATE_UNMET)


def test_gate_set_must_mirror_the_ledger() -> None:
    record = _certified()
    record["required_gates"] = record["required_gates"][:2]
    assert _validate(record) == _invalid(Reason.GATE_SET_MISMATCH)


def test_reordered_any_of_group_still_certifies() -> None:
    """#3287: order inside an any-of group carries no meaning."""
    record = _certified()
    record["required_gates"][2].reverse()
    assert [gate["item"] for gate in record["required_gates"][2]] == ["B14", "B13"]
    assert _validate(record) == (cert.EXIT_CERTIFIED, ())


def _pending(item: str) -> dict[str, object]:
    return {"item": item, "status": "pending", "evidence_ref": None}


@pytest.mark.parametrize(
    "custody_group",
    [
        pytest.param([_passed("B13")], id="missing-item"),
        pytest.param([_passed("B13"), _pending("B14"), _pending("B15")], id="extra-item"),
        pytest.param([_passed("B13"), _pending("B14"), _pending("B14")], id="duplicate-item"),
        pytest.param([_passed("B13"), _passed("B13"), _pending("B14")], id="duplicate-met-item"),
    ],
)
def test_any_of_group_must_hold_exactly_the_ledger_items(
    custody_group: list[dict[str, object]],
) -> None:
    """#3287: a set comparison must not hide a missing, extra or repeated item."""
    record = _certified()
    record["required_gates"][2] = custody_group
    assert _validate(record) == _invalid(Reason.GATE_SET_MISMATCH)


def test_gate_groups_follow_the_ledger_order() -> None:
    """#3287: groups pair with the ledger's groups by position (the documented contract)."""
    record = _certified()
    first, second, custody = record["required_gates"]
    record["required_gates"] = [second, first, custody]
    assert _validate(record) == _invalid(Reason.GATE_SET_MISMATCH)


def test_any_of_custody_group_needs_only_selected_branch() -> None:
    record = _certified()
    assert _validate(record) == (cert.EXIT_CERTIFIED, ())
    record["required_gates"][2][0]["status"] = "pending"
    assert _validate(record) == _incomplete(Reason.GATE_UNMET)


# ── Signoff (AC10) ────────────────────────────────────────────────────────────


def test_signoff_sentence_hash_must_match_ledger() -> None:
    edited = SENTENCE + " (edited)"
    entry = _ledger_entry(sentence=edited, sentence_sha256=cert.sentence_digest(edited))
    assert _validate(_certified(), entry=entry) == _incomplete(Reason.SIGNOFF_SENTENCE_DRIFT)
    record = _certified()
    record["release_decision"] = None
    assert _validate(record) == _incomplete(Reason.SIGNOFF_MISSING)


def test_sentence_digest_does_not_normalise_quotes() -> None:
    assert cert.sentence_digest("a\u2019b") != cert.sentence_digest("a'b")
    assert cert.sentence_digest("x").startswith("sha256:")


# ── Closed schema (AC1) ───────────────────────────────────────────────────────


@pytest.mark.parametrize("key", ["note", "user_id", "url"])
@pytest.mark.parametrize(
    "where",
    ["root", "serving_receipt", "release_decision", "gate", "evidence", "live"],
)
def test_unknown_key_rejected(key: str, where: str) -> None:
    record = _certified()
    target = {
        "root": record,
        "serving_receipt": record["serving_receipt"],
        "release_decision": record["release_decision"],
        "gate": record["required_gates"][0][0],
        "evidence": record["automated_evidence"][0],
        "live": record["live_journey_evidence"][0],
    }[where]
    target[key] = SENTINEL
    code, reasons = _validate(record)
    assert code == cert.EXIT_INVALID
    assert Reason.UNKNOWN_KEY in reasons
    assert SENTINEL not in " ".join(reasons)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("status", "published"),
        ("implementers", "alice"),
        ("issued_on", "October 1st"),
        ("live_journey_evidence", [{"observed_on": "2026-10-02", "artifact_sha256": "abc"}]),
        ("claim_id", "C99"),
    ],
)
def test_malformed_fields_are_invalid(field: str, value: object) -> None:
    record = _certified()
    record[field] = value
    assert _validate(record)[0] == cert.EXIT_INVALID


def test_a_record_that_is_not_an_object_is_invalid() -> None:
    assert _validate(["C07"]) == _invalid(Reason.MALFORMED)


def test_record_for_another_claim_is_invalid() -> None:
    record = _certified()
    record["claim_id"] = "C08"
    assert _validate(record) == _invalid(Reason.CLAIM_MISMATCH)


# ── Limitations and exclusions (AC13) ─────────────────────────────────────────


@pytest.mark.parametrize("audit_status", ["partially_true", "misleading"])
def test_partial_claim_requires_limitations(audit_status: str) -> None:
    record = _certified()
    record["limitations"] = []
    entry = _ledger_entry(audit_status=audit_status)
    assert _validate(record, entry=entry, coverage=None) == _invalid(Reason.LIMITATIONS_REQUIRED)
    record["limitations"] = ["Works on https://x"]
    assert _validate(record) == _invalid(Reason.UNKNOWN_LIMITATION_CODE)


@pytest.mark.parametrize(
    ("coverage", "code"),
    [
        ("partial", "forbidden_effect_coverage_partial"),
        ("uncovered", "forbidden_effect_coverage_uncovered"),
    ],
)
def test_incomplete_forbidden_effect_coverage_must_be_stated(coverage: str, code: str) -> None:
    """A claim claim_coverage.json marks partial/uncovered cannot certify silently."""
    record = _certified()
    record["limitations"] = ["vendor_terms_unverified"]
    entry = _ledger_entry(audit_status="false")
    assert _validate(record, entry=entry, coverage=coverage) == _invalid(
        Reason.LIMITATIONS_REQUIRED
    )
    record["limitations"] = [code]
    assert _validate(record, entry=entry, coverage=coverage) == (cert.EXIT_CERTIFIED, ())


@pytest.mark.parametrize("audit_status", ["true", "false", "not_verifiable", "not_implemented"])
def test_covered_claim_with_a_non_partial_audit_needs_no_limitation(audit_status: str) -> None:
    record = _certified()
    record["limitations"] = []
    entry = _ledger_entry(audit_status=audit_status)
    assert _validate(record, entry=entry, coverage="covered") == (cert.EXIT_CERTIFIED, ())


def test_unknown_exclusion_code_is_invalid() -> None:
    record = _certified()
    record["exclusions"] = ["everything except what I said"]
    assert _validate(record) == _invalid(Reason.UNKNOWN_EXCLUSION_CODE)


# ── Live journeys and withheld records ────────────────────────────────────────


def test_missing_live_journey_evidence_blocks_certification() -> None:
    record = _certified()
    record["live_journey_evidence"] = []
    assert _validate(record) == _incomplete(Reason.LIVE_JOURNEY_MISSING)


def test_evidence_observed_in_future_is_invalid() -> None:
    record = _certified()
    record["live_journey_evidence"][0]["observed_on"] = "2026-10-07"
    assert _validate(record) == _invalid(Reason.OBSERVED_IN_FUTURE)


def test_withheld_record_is_valid_but_incomplete() -> None:
    assert _validate(cert.withheld_record("C07", [["B01"], ["B03"], ["B13", "B14"]])) == (
        _incomplete(Reason.WITHHELD)
    )


def test_withheld_record_is_still_shape_checked() -> None:
    record = cert.withheld_record("C07", [["B01"], ["B03"], ["B13", "B14"]])
    record["note"] = SENTINEL
    assert _validate(record) == _invalid(Reason.UNKNOWN_KEY)


# ── CLI (AC2) ─────────────────────────────────────────────────────────────────


def _write(path: Path, payload: object) -> Path:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _cli_world(tmp_path: Path, record: Record) -> list[str]:
    """Files for one C07 record; every other claim withheld so totality holds."""
    claims = [
        _ledger_entry(id=claim_id, required_gates=[["B01"], ["B03"], ["B13", "B14"]])
        for claim_id in cert.CLAIM_IDS
    ]
    records = [
        record
        if claim_id == "C07"
        else cert.withheld_record(claim_id, [["B01"], ["B03"], ["B13", "B14"]])
        for claim_id in cert.CLAIM_IDS
    ]
    tests_dir = tmp_path / "frontend" / "__tests__"
    tests_dir.mkdir(parents=True)
    (tests_dir / "x.test.ts").write_text("", encoding="utf-8")
    collected = tmp_path / "collected.txt"
    collected.write_text("tests/security/test_x.py::test_y\n\n3 tests collected\n", "utf-8")
    non_running = tmp_path / "non-running.txt"
    non_running.write_text("no tests collected (3 deselected)\n", "utf-8")
    return [
        str(_write(tmp_path / "certs.json", {"schema_version": 1, "records": records})),
        "--ledger",
        str(_write(tmp_path / "ledger.json", {"schema_version": 1, "claims": claims})),
        "--coverage",
        str(_write(tmp_path / "coverage.json", {"C07": {"status": "partial"}})),
        "--journeys",
        str(_write(tmp_path / "journeys.json", [{"id": COVERED_JOURNEY, "status": "covered"}])),
        "--repo-root",
        str(tmp_path),
        "--collected",
        str(collected),
        "--non-running",
        str(non_running),
        "--today",
        TODAY.isoformat(),
    ]


def _only_c07(argv: list[str]) -> list[str]:
    """Validate a file holding just C07 (no --gate, so totality is not asked)."""
    certs = Path(argv[0])
    payload = json.loads(certs.read_text("utf-8"))
    payload["records"] = [r for r in payload["records"] if r["claim_id"] == "C07"]
    certs.write_text(json.dumps(payload), "utf-8")
    return argv


def test_cli_exit_codes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    record = _certified()
    record["reviewer"] = "zzsentinelzz"
    argv = _only_c07(_cli_world(tmp_path / "ok", record))
    assert cert.main(argv) == cert.EXIT_CERTIFIED
    out = capsys.readouterr().out
    assert "C07 CERTIFIED" in out
    assert SENTINEL not in out
    assert NODE not in out

    withheld = _only_c07(_cli_world(tmp_path / "held", cert.withheld_record("C07", [])))
    assert cert.main(withheld) == cert.EXIT_INVALID  # gate set does not mirror the ledger

    held = _only_c07(
        _cli_world(
            tmp_path / "held2", cert.withheld_record("C07", [["B01"], ["B03"], ["B13", "B14"]])
        )
    )
    assert cert.main(held) == cert.EXIT_INCOMPLETE
    assert "C07 INCOMPLETE WITHHELD" in capsys.readouterr().out

    garbage = tmp_path / "garbage.json"
    garbage.write_text("{not json", encoding="utf-8")
    assert cert.main([str(garbage), *argv[1:]]) == cert.EXIT_INVALID


def test_cli_today_past_expiry_names_the_claim(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    argv = _only_c07(_cli_world(tmp_path, _certified()))
    argv[-1] = "2026-12-02"
    assert cert.main(argv) == cert.EXIT_INCOMPLETE
    assert "C07 INCOMPLETE EXPIRED" in capsys.readouterr().out


def test_cli_without_collected_ids_cannot_verify_pytest_evidence(tmp_path: Path) -> None:
    argv = _only_c07(_cli_world(tmp_path, _certified()))
    index = argv.index("--collected")
    del argv[index : index + 2]
    assert cert.main(argv) == cert.EXIT_INCOMPLETE


def test_cli_non_running_ids_mark_xfail(tmp_path: Path) -> None:
    argv = _only_c07(_cli_world(tmp_path, _certified()))
    non_running = tmp_path / "xfail.txt"
    non_running.write_text("tests/security/test_x.py::test_y\n", encoding="utf-8")
    assert cert.main([*argv, "--non-running", str(non_running)]) == cert.EXIT_INCOMPLETE


def test_cli_reaches_the_shell(tmp_path: Path) -> None:
    """``python -m`` from backend/, as an operator runs it; the code is not swallowed."""
    argv = _only_c07(_cli_world(tmp_path, _certified()))
    argv[-1] = "2026-12-02"
    result = subprocess.run(
        [sys.executable, "-m", "scripts.claim_certification", *argv],
        cwd=_BACKEND_DIR,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == cert.EXIT_INCOMPLETE, result.stderr
    assert "C07 INCOMPLETE EXPIRED" in result.stdout


def test_module_spawns_no_subprocess_and_opens_no_socket() -> None:
    tree = ast.parse(_MODULE_PATH.read_text(encoding="utf-8"))
    imported = {
        alias.name.split(".")[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.Import | ast.ImportFrom)
        for alias in (
            node.names if isinstance(node, ast.Import) else [ast.alias(node.module or "")]
        )
    }
    assert imported.isdisjoint({"subprocess", "socket", "urllib", "http", "requests", "httpx"})


def test_an_impossible_calendar_date_is_invalid() -> None:
    record = _certified()
    record["issued_on"] = "2026-02-30"
    assert _validate(record) == _invalid(Reason.BAD_DATE)


def test_a_malformed_ledger_entry_makes_the_record_invalid() -> None:
    entry = _ledger_entry(required_gates=[])
    assert _validate(_certified(), entry=entry) == _invalid(Reason.MALFORMED)


@pytest.mark.parametrize(
    ("ledger", "problem"),
    [
        ({"schema_version": 2, "claims": []}, "the ledger is malformed"),
        ({"schema_version": 1, "claims": [{"id": "C01"}]}, "a ledger claim is malformed"),
    ],
)
def test_malformed_ledger_documents_are_gate_problems(ledger: object, problem: str) -> None:
    assert problem in cert.ledger_problems(ledger)


def test_a_malformed_certifications_file_is_a_gate_problem() -> None:
    problems = cert.publish_gate_problems(
        {"schema_version": 1, "claims": []},
        {"records": []},
        coverage={},
        today=TODAY,
        evidence_factory=_evidence,
    )
    assert problems[-1] == "the certifications file is malformed"


def test_input_readers_refuse_malformed_documents() -> None:
    assert cert.journey_statuses({"id": "x"}) == {}
    assert cert.journey_statuses([{"id": "a", "status": "covered"}, "junk", {"id": 1}]) == {
        "a": "covered"
    }
    assert cert.coverage_statuses([]) is None
    assert cert.coverage_statuses({"C07": {"tests": []}}) is None
    assert cert.coverage_statuses({"C07": {"status": "partial"}}) == {"C07": "partial"}


def test_cli_reports_unknown_records_and_malformed_files(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    argv = _cli_world(tmp_path, _certified())
    certs = Path(argv[0])
    certs.write_text(json.dumps({"schema_version": 1, "records": [{"claim_id": "C99"}]}), "utf-8")
    assert cert.main(argv) == cert.EXIT_INVALID
    assert "record[0] INVALID MALFORMED" in capsys.readouterr().out
    certs.write_text(json.dumps({"records": []}), "utf-8")
    assert cert.main(argv) == cert.EXIT_INVALID
    coverage = Path(argv[argv.index("--coverage") + 1])
    coverage.write_text("[]", "utf-8")
    assert cert.main(argv) == cert.EXIT_INVALID
    assert cert.main([*argv, "--collected", str(tmp_path / "absent.txt")]) == cert.EXIT_INVALID


def test_cli_gate_in_process(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    argv = _cli_world(tmp_path, _certified())
    assert cert.main([*argv, "--gate"]) == cert.EXIT_CERTIFIED
    ledger = Path(argv[argv.index("--ledger") + 1])
    document = json.loads(ledger.read_text("utf-8"))
    document["claims"][0]["status"] = "published"
    ledger.write_text(json.dumps(document), "utf-8")
    assert cert.main([*argv, "--gate"]) == cert.EXIT_INCOMPLETE
    assert "C01 published without a current certificate: WITHHELD" in capsys.readouterr().out


# ── Review round (#3076 phase C) ──────────────────────────────────────────────


def test_cli_empty_records_is_not_certified(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Zero records is not "every record is certified"."""
    argv = _cli_world(tmp_path, _certified())
    Path(argv[0]).write_text(json.dumps({"schema_version": 1, "records": []}), "utf-8")
    assert cert.main(argv) == cert.EXIT_INVALID
    assert "the certifications file has no records" in capsys.readouterr().out


def test_cli_collected_without_non_running_is_unverifiable(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Without the non-running collection, xfail and skip status was never checked."""
    argv = _only_c07(_cli_world(tmp_path, _certified()))
    index = argv.index("--non-running")
    del argv[index : index + 2]
    assert cert.main(argv) == cert.EXIT_INCOMPLETE
    assert "C07 INCOMPLETE UNVERIFIABLE_PYTEST_EVIDENCE" in capsys.readouterr().out


def test_documented_non_running_collection_includes_skips() -> None:
    marker = cert.NON_RUNNING_MARKERS
    assert marker == "xfail or skip or skipif"
    assert f'-m "{marker}"' in (cert.__doc__ or "")
    doc = (cert.REPO_ROOT / "docs" / "qa" / "claim-certification.md").read_text("utf-8")
    assert f'-m "{marker}"' in doc
    assert "-m xfail >" not in doc
    assert marker in " ".join(cert.parser().format_help().split())


def _with_dates(record: Record, *, observed: str, decided: str) -> Record:
    record["serving_receipt"]["observed_on"] = observed
    record["live_journey_evidence"][0]["observed_on"] = observed
    record["release_decision"]["decided_on"] = decided
    return record


def test_backdated_evidence_does_not_certify() -> None:
    record = _with_dates(_certified(), observed="2019-01-01", decided="2019-01-01")
    assert _validate(record) == _incomplete(Reason.EVIDENCE_OUTSIDE_WINDOW)


def test_evidence_window_boundary() -> None:
    oldest = ISSUED - timedelta(days=cert.MAX_EVIDENCE_AGE_DAYS)
    record = _with_dates(_certified(), observed=oldest.isoformat(), decided=ISSUED.isoformat())
    assert _validate(record) == (cert.EXIT_CERTIFIED, ())
    too_old = (oldest - timedelta(days=1)).isoformat()
    record = _with_dates(_certified(), observed=too_old, decided=ISSUED.isoformat())
    assert _validate(record) == _incomplete(Reason.EVIDENCE_OUTSIDE_WINDOW)


@pytest.mark.parametrize("field", ["receipt", "live", "decision"])
def test_evidence_dated_after_issue_does_not_certify(field: str) -> None:
    record = _certified()
    target = {
        "receipt": record["serving_receipt"],
        "live": record["live_journey_evidence"][0],
        "decision": record["release_decision"],
    }[field]
    target["decided_on" if field == "decision" else "observed_on"] = "2026-10-02"
    code, reasons = _validate(record)
    assert code == cert.EXIT_INCOMPLETE
    assert reasons[0] == Reason.EVIDENCE_OUTSIDE_WINDOW


def test_signoff_before_the_evidence_does_not_certify() -> None:
    record = _with_dates(_certified(), observed=EVIDENCE_DAY, decided="2026-09-27")
    assert _validate(record) == _incomplete(Reason.SIGNOFF_BEFORE_EVIDENCE)


def test_all_dates_today_certifies() -> None:
    record = _with_dates(_certified(), observed=TODAY.isoformat(), decided=TODAY.isoformat())
    record["issued_on"] = TODAY.isoformat()
    record["expires_on"] = (TODAY + timedelta(days=30)).isoformat()
    assert _validate(record) == (cert.EXIT_CERTIFIED, ())


def test_serving_receipt_observed_in_future_is_invalid() -> None:
    record = _certified()
    record["serving_receipt"]["observed_on"] = (TODAY + timedelta(days=1)).isoformat()
    assert _validate(record) == _invalid(Reason.OBSERVED_IN_FUTURE)


@pytest.mark.parametrize("claim_id", [["C07"], {"id": "C07"}])
def test_unhashable_claim_id_is_malformed(claim_id: object) -> None:
    record = _certified()
    record["claim_id"] = claim_id
    assert _validate(record) == _invalid(Reason.MALFORMED)


def test_cli_unhashable_claim_id_is_invalid_without_traceback(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    argv = _cli_world(tmp_path, _certified())
    certs = Path(argv[0])
    payload = json.loads(certs.read_text("utf-8"))
    payload["records"][0]["claim_id"] = [SENTINEL]
    certs.write_text(json.dumps(payload), "utf-8")
    assert cert.main(argv) == cert.EXIT_INVALID
    out = capsys.readouterr().out
    assert "record[0] INVALID MALFORMED" in out
    assert cert.main([*argv, "--gate"]) == cert.EXIT_INCOMPLETE
    out += capsys.readouterr().out
    assert "an unknown claim id in the certifications" in out
    assert SENTINEL not in out


# ── Reason tiers (#3288) ──────────────────────────────────────────────────────


def _tier_violations(
    members: frozenset[Reason], invalid: frozenset[Reason], incomplete: frozenset[Reason]
) -> dict[Reason, int]:
    """Each member mapped to how many tiers hold it, when that is not exactly one."""
    counts = {member: (member in invalid) + (member in incomplete) for member in members}
    return {member: count for member, count in counts.items() if count != 1}


def test_every_reason_is_in_exactly_one_tier() -> None:
    """A new :class:`Reason` with no tier, or with both, fails CI."""
    assert cert.INVALID_REASONS
    assert cert.INCOMPLETE_REASONS
    assert _tier_violations(frozenset(Reason), cert.INVALID_REASONS, cert.INCOMPLETE_REASONS) == {}


@pytest.mark.parametrize(
    ("invalid", "incomplete", "expected"),
    [
        pytest.param(
            frozenset({Reason.MALFORMED}),
            frozenset({Reason.WITHHELD}),
            {Reason.EXPIRED: 0},
            id="in-neither",
        ),
        pytest.param(
            frozenset({Reason.MALFORMED, Reason.EXPIRED}),
            frozenset({Reason.WITHHELD, Reason.EXPIRED}),
            {Reason.EXPIRED: 2},
            id="in-both",
        ),
    ],
)
def test_tier_totality_check_catches_a_misfiled_reason(
    invalid: frozenset[Reason], incomplete: frozenset[Reason], expected: dict[Reason, int]
) -> None:
    """Non-vacuity: the totality check rejects a member in neither tier or in both."""
    members = frozenset({Reason.MALFORMED, Reason.WITHHELD, Reason.EXPIRED})
    assert _tier_violations(members, invalid, incomplete) == expected


def _tier_literal(name: str) -> ast.expr:
    tree = ast.parse(_MODULE_PATH.read_text(encoding="utf-8"))
    values = [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.AnnAssign)
        and isinstance(node.target, ast.Name)
        and node.target.id == name
        and node.value is not None
    ]
    assert len(values) == 1, name
    return values[0]


@pytest.mark.parametrize("name", ["INVALID_REASONS", "INCOMPLETE_REASONS"])
def test_reason_tiers_are_explicit_literals(name: str) -> None:
    """A tier is a literal set of named members, never a slice of declaration order."""
    value = _tier_literal(name)
    assert isinstance(value, ast.Call)
    assert isinstance(value.func, ast.Name)
    assert value.func.id == "frozenset"
    assert len(value.args) == 1
    literal = value.args[0]
    assert isinstance(literal, ast.Set)
    named = [
        element.attr
        for element in literal.elts
        if isinstance(element, ast.Attribute)
        and isinstance(element.value, ast.Name)
        and element.value.id == "Reason"
    ]
    assert len(named) == len(literal.elts)
    assert {Reason[attr] for attr in named} == getattr(cert, name)
