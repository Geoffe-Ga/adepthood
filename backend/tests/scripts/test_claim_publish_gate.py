"""The publish gate: no ledger claim is ``published`` without a current certificate (#3076).

Three files meet here, each owning one question:

* ``docs/legal/claim-ledger.json`` -- *what* is promised: each claim C01-C24,
  its exact sentence and digest, and whether it is ``withheld`` or
  ``published``;
* ``backend/src/privacy/claim_coverage.json`` -- *what tests prove* about it
  (B15, #3158), which a certificate may not contradict;
* ``docs/qa/claim-certifications.json`` -- *who independently signed off*, on
  which serving build, until when.

Today nothing is certified, so the gate passes only because nothing is
published -- not because anything is allow-listed. The violating fixtures below
prove it can fail, in process and through the shell, as the playbook requires.
"""

from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import Mapping
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Final, cast

import pytest

from privacy.claim_coverage import load_manifest
from scripts import claim_certification as cert
from tests.support.pytest_node_ids import node_state

_BACKEND_DIR: Final = Path(__file__).resolve().parents[2]
_LEDGER: Final = cert.LEDGER_PATH
_CERTS: Final = cert.CERTIFICATIONS_PATH
_TODAY: Final = date(2026, 10, 14)
_SHA: Final = "a" * 40
_DIGEST: Final = "sha256:" + "0" * 64


def _load(path: Path) -> dict[str, Any]:
    return cast("dict[str, Any]", json.loads(path.read_text(encoding="utf-8")))


def _coverage() -> Mapping[str, str]:
    return {row.claim: row.status.value for row in load_manifest()}


def _evidence() -> cert.Evidence:
    return cert.Evidence(
        node_state=node_state,
        jest_file_exists=lambda ref: (cert.REPO_ROOT / ref).is_file(),
        journeys=cert.journey_statuses(json.loads(cert.JOURNEYS_PATH.read_text(encoding="utf-8"))),
    )


def _boom() -> cert.Evidence:
    pytest.fail("the gate collected evidence although no published claim cites any")


def _problems(ledger: object, records: object, today: date = _TODAY) -> tuple[str, ...]:
    return cert.publish_gate_problems(
        ledger, records, coverage=_coverage(), today=today, evidence_factory=_evidence
    )


# ── The committed files ───────────────────────────────────────────────────────


def test_every_claim_id_has_a_certification_entry() -> None:
    ledger_ids = [claim["id"] for claim in _load(_LEDGER)["claims"]]
    record_ids = [record["claim_id"] for record in _load(_CERTS)["records"]]
    assert ledger_ids == list(cert.CLAIM_IDS)
    assert record_ids == list(cert.CLAIM_IDS)
    assert len(cert.CLAIM_IDS) == len(set(cert.CLAIM_IDS)) == 24


def test_ledger_sentences_hash_to_their_digests() -> None:
    """Whether a claim may be published is the gate's question, not this test's."""
    for claim in _load(_LEDGER)["claims"]:
        assert claim["sentence_sha256"] == cert.sentence_digest(claim["sentence"])
    assert cert.ledger_problems(_load(_LEDGER)) == ()


def test_seeded_records_are_structurally_valid_and_withheld() -> None:
    ledger = {claim["id"]: claim for claim in _load(_LEDGER)["claims"]}
    coverage = _coverage()
    for record in _load(_CERTS)["records"]:
        claim_id = record["claim_id"]
        verdict = cert.validate_record(
            record,
            ledger_entry=ledger[claim_id],
            coverage_status=coverage.get(claim_id),
            today=_TODAY,
            evidence=_evidence(),
        )
        assert verdict == (cert.EXIT_INCOMPLETE, (cert.Reason.WITHHELD,)), claim_id
        groups = [[gate["item"] for gate in group] for group in record["required_gates"]]
        assert groups == ledger[claim_id]["required_gates"]


def test_custody_claims_need_one_custody_branch_not_both() -> None:
    ledger = {claim["id"]: claim for claim in _load(_LEDGER)["claims"]}
    for claim_id in ("C03", "C23"):
        groups = ledger[claim_id]["required_gates"]
        assert ["B13", "B14"] in groups
        assert ["B13"] not in groups
        assert ["B14"] not in groups


def test_coverage_manifest_claims_are_ledger_claims() -> None:
    """B15's manifest keys on the same ids; it never mints a claim of its own."""
    assert set(_coverage()) <= set(cert.CLAIM_IDS)


def test_committed_ledger_publishes_nothing_uncertified() -> None:
    problems = cert.publish_gate_problems(
        _load(_LEDGER),
        _load(_CERTS),
        coverage=_coverage(),
        today=datetime.now(UTC).date(),
        evidence_factory=_boom,
    )
    assert problems == ()


# ── Violating fixtures (the gate can fail) ────────────────────────────────────


def _publish(ledger: dict[str, Any], claim_id: str) -> dict[str, Any]:
    for claim in ledger["claims"]:
        if claim["id"] == claim_id:
            claim["status"] = "published"
    return ledger


def test_published_claim_requires_current_certificate() -> None:
    problems = _problems(_publish(_load(_LEDGER), "C07"), _load(_CERTS))
    assert problems == ("C07 published without a current certificate: WITHHELD",)


def _certified_c19(ledger: Mapping[str, Any]) -> dict[str, Any]:
    """A record for C19 that certifies on the real ledger with no pytest evidence."""
    claim = next(c for c in ledger["claims"] if c["id"] == "C19")
    return {
        "claim_id": "C19",
        "status": "certified",
        "implementers": ["alice"],
        "reviewer": "rhea",
        "tested_commits": {"backend": _SHA, "frontend": _SHA},
        "serving_receipt": {
            "receipt_schema": 1,
            "backend_release": _SHA,
            "frontend_release": _SHA,
            "observed_on": "2026-10-02",
            "artifact_sha256": _DIGEST,
        },
        "automated_evidence": [{"kind": "journey", "ref": "auth.signup-login-authenticated-read"}],
        "live_journey_evidence": [{"observed_on": "2026-10-02", "artifact_sha256": _DIGEST}],
        "required_gates": [
            [
                {
                    "item": item,
                    "status": "passed",
                    "evidence_ref": {"kind": "github_pull", "number": 1},
                }
            ]
            for [item] in claim["required_gates"]
        ],
        "issued_on": "2026-10-01",
        "expires_on": "2026-12-01",
        "release_decision": {
            "decider": "geoffe-ga",
            "decided_on": "2026-10-01",
            "sentence_sha256": claim["sentence_sha256"],
        },
        "exclusions": [],
        "limitations": ["forbidden_effect_coverage_uncovered"],
    }


def _with_record(records: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    records["records"] = [
        record if r["claim_id"] == record["claim_id"] else r for r in records["records"]
    ]
    return records


def test_a_current_certificate_licenses_publication_and_expiry_withdraws_it() -> None:
    """The positive control: a gate that rejects everything would fail here."""
    ledger = _publish(_load(_LEDGER), "C19")
    journeys = cert.journey_statuses(json.loads(cert.JOURNEYS_PATH.read_text(encoding="utf-8")))
    assert journeys["auth.signup-login-authenticated-read"] == "covered"
    records = _with_record(_load(_CERTS), _certified_c19(ledger))
    assert _problems(ledger, records) == ()
    assert _problems(ledger, records, today=date(2026, 12, 2)) == (
        "C19 published without a current certificate: EXPIRED",
    )


def test_totality_holds_for_both_files() -> None:
    ledger = _load(_LEDGER)
    ledger["claims"] = ledger["claims"][1:]
    assert "C01 missing from the ledger" in _problems(ledger, _load(_CERTS))
    records = _load(_CERTS)
    records["records"].append(records["records"][0])
    assert "C01 appears more than once in the certifications" in _problems(_load(_LEDGER), records)


def test_a_malformed_record_fails_the_gate_even_unpublished() -> None:
    records = _load(_CERTS)
    records["records"][0]["note"] = "zzsentinelzz"
    problems = _problems(_load(_LEDGER), records)
    assert problems == ("C01 record is invalid: UNKNOWN_KEY",)


def test_a_ledger_sentence_edited_without_its_digest_fails_the_gate() -> None:
    ledger = _load(_LEDGER)
    ledger["claims"][6]["sentence"] += " (edited)"
    assert "C07 sentence does not match its sha256" in _problems(ledger, _load(_CERTS))


# ── Through the shell (playbook meta-test) ────────────────────────────────────


def _gate(certs: Path, ledger: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "scripts.claim_certification",
            str(certs),
            "--ledger",
            str(ledger),
            "--gate",
            "--today",
            _TODAY.isoformat(),
        ],
        cwd=_BACKEND_DIR,
        capture_output=True,
        text=True,
        check=False,
    )


def test_gate_cli_exits_nonzero_on_violating_fixture(tmp_path: Path) -> None:
    violating = tmp_path / "ledger.json"
    violating.write_text(json.dumps(_publish(_load(_LEDGER), "C07")), encoding="utf-8")
    result = _gate(_CERTS, violating)
    assert result.returncode == cert.EXIT_INCOMPLETE, result.stderr
    assert "C07 published without a current certificate" in result.stdout

    garbage = tmp_path / "garbage.json"
    garbage.write_text("{not json", encoding="utf-8")
    assert _gate(garbage, _LEDGER).returncode == cert.EXIT_INVALID

    clean = _gate(_CERTS, _LEDGER)
    assert clean.returncode == cert.EXIT_CERTIFIED, clean.stdout + clean.stderr
