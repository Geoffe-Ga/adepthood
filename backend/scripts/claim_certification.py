"""Validate per-claim certification records and gate which ledger claims may be published.

Issue #3076 (B24) holds every public privacy/product claim C01-C24 to one rule:
a claim may be *published* only while an independent, signed, unexpired
certification record backs it. Three files meet here:

* ``docs/legal/claim-ledger.json`` -- each claim's exact sentence, its digest,
  its audit status, the B-item gates it depends on, and ``withheld`` or
  ``published``;
* ``backend/src/privacy/claim_coverage.json`` -- what the forbidden-effect
  tests prove (#3158). A certificate may not contradict it: a claim whose
  coverage is ``partial`` or ``uncovered`` certifies only with a limitation
  that says so;
* ``docs/qa/claim-certifications.json`` -- one closed record per claim: who
  implemented, who independently reviewed, which commit was tested and which
  build served it, which tests and journeys back it, which gates passed, who
  signed the exact sentence, and until when.

This module is only a validator. It never runs a test, opens a socket, spawns
a process, or reads a credential: test ids arrive as the saved output of
``pytest --collect-only -q`` and serving releases as fields an operator copied
from ``GET /admin/serving-receipt`` and ``/build-receipt.json``. Anything it
cannot verify is *not* a pass, the discipline of ``scripts/issue_evidence.py``.

The schema is closed, like ``scripts/managed_vault_pilot_evidence.py``: no
field can hold a user id, URL, email or journal text, and output is limited to
a claim id and a closed :class:`Reason` vocabulary.

Usage::

    cd backend
    python -m pytest --collect-only -q > /tmp/collected.txt
    python -m pytest --collect-only -q -m "xfail or skip or skipif" > /tmp/non-running.txt
    python -m scripts.claim_certification ../docs/qa/claim-certifications.json \
        --collected /tmp/collected.txt --non-running /tmp/non-running.txt
    python -m scripts.claim_certification ../docs/qa/claim-certifications.json --gate

Both collections are required to verify pytest evidence: without the second,
xfail and skip status was never checked, so pytest references are
unverifiable rather than present.

Exit codes (records):
    0 -- the file holds at least one record, and every record is certified.
    1 -- every record is well formed, but at least one is withheld, incomplete,
         drifted or expired.
    2 -- at least one record (or an input file) is malformed or unsafe, or the
         file holds no records.

Exit codes (``--gate``):
    0 -- the ledger and certifications are total and well formed, and every
         ``published`` claim has a current certificate.
    1 -- at least one gate problem was found (each is printed).
    2 -- an input file could not be read as JSON.
"""

from __future__ import annotations

import argparse
import enum
import hashlib
import json
import re
import sys
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Final, TypeGuard, cast

EXIT_CERTIFIED: Final = 0
EXIT_INCOMPLETE: Final = 1
EXIT_INVALID: Final = 2
SCHEMA_VERSION: Final = 1

#: A certificate is a dated decision, not a standing licence. Owner-tunable.
MAX_CERTIFICATE_AGE_DAYS: Final = 90
#: Evidence (live journeys, serving receipt) and the signoff must be gathered
#: within this many days before ``issued_on``: a certificate is not a licence to
#: reuse an old run. Owner-tunable.
MAX_EVIDENCE_AGE_DAYS: Final = 30
#: The ``-m`` expression whose collection lists tests that never assert.
NON_RUNNING_MARKERS: Final = "xfail or skip or skipif"

_FIRST_CLAIM: Final = 1
_LAST_CLAIM: Final = 24
#: Every claim of the ledger, exactly once, in order.
CLAIM_IDS: Final[tuple[str, ...]] = tuple(f"C{n:02d}" for n in range(_FIRST_CLAIM, _LAST_CLAIM + 1))

#: ``receipt_schema`` values of ``GET /admin/serving-receipt`` and ``/build-receipt.json``.
SUPPORTED_RECEIPT_SCHEMAS: Final = frozenset({1})
#: What a serving receipt reports when it cannot name its commit.
UNKNOWN_RELEASE: Final = "unknown"

#: The loop's own identities. Compared exactly (case-insensitively), never as
#: substrings, so ``abbott`` or ``talbot`` stay eligible. A heuristic: appointing
#: the reviewer is the owner's job (see docs/qa/claim-certification.md).
AGENT_LOGINS: Final = frozenset(
    {
        "agent",
        "anthropic",
        "bot",
        "claude",
        "claude-bot",
        "claude-code",
        "copilot",
        "dependabot",
        "github-actions",
        "noreply",
        "ralph",
        "ralph-loop",
        "renovate",
    }
)
BOT_SUFFIX: Final = "[bot]"

#: Draft vocabulary, ratified by the owner with the protocol doc.
LIMITATION_CODES: Final = frozenset(
    {
        "forbidden_effect_coverage_partial",
        "forbidden_effect_coverage_uncovered",
        "vendor_terms_unverified",
        "operator_can_read",
        "server_side_processing",
        "residual_backup_copies",
        "frontend_telemetry_not_driven",
        "web_build_only",
        "beta_scope_only",
    }
)
EXCLUSION_CODES: Final = frozenset(
    {
        "excludes_backups_within_retention",
        "excludes_native_apps",
        "excludes_self_hosted_vault",
        "excludes_vendor_side_retention",
        "intimate_tier_only",
    }
)
AUDIT_STATUSES: Final = frozenset(
    {"true", "partially_true", "false", "misleading", "not_verifiable", "not_implemented"}
)
#: Audit verdicts that make a limitation mandatory on any certificate.
PARTIAL_AUDIT_STATUSES: Final = frozenset({"partially_true", "misleading"})
#: The limitation a claim_coverage.json status obliges a certificate to state.
COVERAGE_LIMITATIONS: Final[Mapping[str, str]] = {
    "partial": "forbidden_effect_coverage_partial",
    "uncovered": "forbidden_effect_coverage_uncovered",
}

REPO_ROOT: Final = Path(__file__).resolve().parents[2]
LEDGER_PATH: Final = REPO_ROOT / "docs" / "legal" / "claim-ledger.json"
CERTIFICATIONS_PATH: Final = REPO_ROOT / "docs" / "qa" / "claim-certifications.json"
COVERAGE_PATH: Final = REPO_ROOT / "backend" / "src" / "privacy" / "claim_coverage.json"
JOURNEYS_PATH: Final = REPO_ROOT / "frontend" / "e2e" / "journeys.json"

WITHHELD: Final = "withheld"
CERTIFIED: Final = "certified"
PUBLISHED: Final = "published"
_PASSED: Final = "passed"
_COVERED: Final = "covered"
_PRESENT: Final = "present"
_XFAIL: Final = "xfail"
_GATE_STATUSES: Final = frozenset({"pending", "blocked", "failed", _PASSED})
_EVIDENCE_REF_KINDS: Final = frozenset({"github_pull", "github_issue"})
_COLLECT_SEPARATOR: Final = "::"
_BACKEND_PREFIX: Final = "backend/"
_BACKEND_TESTS: Final = "tests/"

_SHA_RE: Final = re.compile(r"^[0-9a-f]{40}$")
_DIGEST_RE: Final = re.compile(r"^sha256:[0-9a-f]{64}$")
_DATE_RE: Final = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
_LOGIN_RE: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$")
_GATE_RE: Final = re.compile(r"^B[0-9]{2}$")
_REF_PATTERNS: Final[Mapping[str, re.Pattern[str]]] = {
    "pytest": re.compile(
        r"^backend/tests/(?:[A-Za-z0-9_]+/)*test_[A-Za-z0-9_]+\.py"
        r"::(?:Test[A-Za-z0-9_]+::)?test_[A-Za-z0-9_]+(?:\[[A-Za-z0-9_.-]+\])?$"
    ),
    # No segment may start with a dot, so ``..`` can never climb out of frontend/.
    "jest": re.compile(
        r"^frontend/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.test\.tsx?$"
    ),
    "journey": re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$"),
}


class Reason(enum.StrEnum):
    """Why a record is not certified. The only free text the validator ever prints."""

    # Invalid (exit 2): the record is malformed, unsafe, or contradicts the tree.
    MALFORMED = "MALFORMED"
    UNKNOWN_KEY = "UNKNOWN_KEY"
    BAD_LOGIN = "BAD_LOGIN"
    BAD_TESTED_COMMIT = "BAD_TESTED_COMMIT"
    BAD_DATE = "BAD_DATE"
    BAD_DIGEST = "BAD_DIGEST"
    UNSAFE_REFERENCE = "UNSAFE_REFERENCE"
    UNKNOWN_LIMITATION_CODE = "UNKNOWN_LIMITATION_CODE"
    UNKNOWN_EXCLUSION_CODE = "UNKNOWN_EXCLUSION_CODE"
    CLAIM_MISMATCH = "CLAIM_MISMATCH"
    GATE_SET_MISMATCH = "GATE_SET_MISMATCH"
    DANGLING_PYTEST_NODE = "DANGLING_PYTEST_NODE"
    DANGLING_JEST_FILE = "DANGLING_JEST_FILE"
    UNKNOWN_JOURNEY = "UNKNOWN_JOURNEY"
    ISSUED_IN_FUTURE = "ISSUED_IN_FUTURE"
    OBSERVED_IN_FUTURE = "OBSERVED_IN_FUTURE"
    VALIDITY_TOO_LONG = "VALIDITY_TOO_LONG"
    LIMITATIONS_REQUIRED = "LIMITATIONS_REQUIRED"
    # Incomplete (exit 1): well formed, but not (or no longer) a certificate.
    WITHHELD = "WITHHELD"
    IMPLEMENTERS_MISSING = "IMPLEMENTERS_MISSING"
    REVIEWER_MISSING = "REVIEWER_MISSING"
    REVIEWER_IS_AGENT = "REVIEWER_IS_AGENT"
    REVIEWER_IS_IMPLEMENTER = "REVIEWER_IS_IMPLEMENTER"
    TESTED_COMMIT_MISSING = "TESTED_COMMIT_MISSING"
    RECEIPT_MISSING = "RECEIPT_MISSING"
    RECEIPT_SCHEMA_UNSUPPORTED = "RECEIPT_SCHEMA_UNSUPPORTED"
    BACKEND_RELEASE_DRIFT = "BACKEND_RELEASE_DRIFT"
    FRONTEND_RELEASE_DRIFT = "FRONTEND_RELEASE_DRIFT"
    AUTOMATED_EVIDENCE_MISSING = "AUTOMATED_EVIDENCE_MISSING"
    UNVERIFIABLE_PYTEST_EVIDENCE = "UNVERIFIABLE_PYTEST_EVIDENCE"
    NON_RUNNING_EVIDENCE = "NON_RUNNING_EVIDENCE"
    UNCOVERED_JOURNEY = "UNCOVERED_JOURNEY"
    LIVE_JOURNEY_MISSING = "LIVE_JOURNEY_MISSING"
    GATE_EVIDENCE_MISSING = "GATE_EVIDENCE_MISSING"
    GATE_UNMET = "GATE_UNMET"
    SIGNOFF_MISSING = "SIGNOFF_MISSING"
    SIGNOFF_BY_AGENT = "SIGNOFF_BY_AGENT"
    SIGNOFF_SENTENCE_DRIFT = "SIGNOFF_SENTENCE_DRIFT"
    VALIDITY_MISSING = "VALIDITY_MISSING"
    EXPIRED = "EXPIRED"
    EVIDENCE_OUTSIDE_WINDOW = "EVIDENCE_OUTSIDE_WINDOW"
    SIGNOFF_BEFORE_EVIDENCE = "SIGNOFF_BEFORE_EVIDENCE"


#: Exit 2: the record is malformed, unsafe, or contradicts the tree. Declared
#: explicitly, so a member's position in :class:`Reason` never decides its tier.
INVALID_REASONS: Final[frozenset[Reason]] = frozenset(
    {
        Reason.MALFORMED,
        Reason.UNKNOWN_KEY,
        Reason.BAD_LOGIN,
        Reason.BAD_TESTED_COMMIT,
        Reason.BAD_DATE,
        Reason.BAD_DIGEST,
        Reason.UNSAFE_REFERENCE,
        Reason.UNKNOWN_LIMITATION_CODE,
        Reason.UNKNOWN_EXCLUSION_CODE,
        Reason.CLAIM_MISMATCH,
        Reason.GATE_SET_MISMATCH,
        Reason.DANGLING_PYTEST_NODE,
        Reason.DANGLING_JEST_FILE,
        Reason.UNKNOWN_JOURNEY,
        Reason.ISSUED_IN_FUTURE,
        Reason.OBSERVED_IN_FUTURE,
        Reason.VALIDITY_TOO_LONG,
        Reason.LIMITATIONS_REQUIRED,
    }
)
#: Exit 1: well formed, but not (or no longer) a certificate. Every
#: :class:`Reason` is in exactly one of the two tiers (tested for totality).
INCOMPLETE_REASONS: Final[frozenset[Reason]] = frozenset(
    {
        Reason.WITHHELD,
        Reason.IMPLEMENTERS_MISSING,
        Reason.REVIEWER_MISSING,
        Reason.REVIEWER_IS_AGENT,
        Reason.REVIEWER_IS_IMPLEMENTER,
        Reason.TESTED_COMMIT_MISSING,
        Reason.RECEIPT_MISSING,
        Reason.RECEIPT_SCHEMA_UNSUPPORTED,
        Reason.BACKEND_RELEASE_DRIFT,
        Reason.FRONTEND_RELEASE_DRIFT,
        Reason.AUTOMATED_EVIDENCE_MISSING,
        Reason.UNVERIFIABLE_PYTEST_EVIDENCE,
        Reason.NON_RUNNING_EVIDENCE,
        Reason.UNCOVERED_JOURNEY,
        Reason.LIVE_JOURNEY_MISSING,
        Reason.GATE_EVIDENCE_MISSING,
        Reason.GATE_UNMET,
        Reason.SIGNOFF_MISSING,
        Reason.SIGNOFF_BY_AGENT,
        Reason.SIGNOFF_SENTENCE_DRIFT,
        Reason.VALIDITY_MISSING,
        Reason.EXPIRED,
        Reason.EVIDENCE_OUTSIDE_WINDOW,
        Reason.SIGNOFF_BEFORE_EVIDENCE,
    }
)

Verdict = tuple[int, tuple[Reason, ...]]
Checker = Callable[[object], list[Reason]]
_VERDICT_NAMES: Final[Mapping[int, str]] = {
    EXIT_CERTIFIED: "CERTIFIED",
    EXIT_INCOMPLETE: "INCOMPLETE",
    EXIT_INVALID: "INVALID",
}


@dataclass(frozen=True, slots=True)
class Evidence:
    """How references resolve against the tree.

    ``node_state`` maps a repo-relative pytest node id to ``present``,
    ``xfail`` or ``missing`` (the values of ``privacy.claim_coverage.NodeState``);
    ``None`` means no collection was supplied, so pytest evidence is
    unverifiable -- never passing.
    """

    node_state: Callable[[str], str] | None
    jest_file_exists: Callable[[str], bool]
    journeys: Mapping[str, str]


_NO_TIME: Final = timedelta(0)
_MAX_VALIDITY: Final = timedelta(days=MAX_CERTIFICATE_AGE_DAYS)

_MAX_EVIDENCE_AGE: Final = timedelta(days=MAX_EVIDENCE_AGE_DAYS)

_NO_EVIDENCE: Final = Evidence(node_state=None, jest_file_exists=lambda _ref: False, journeys={})


@dataclass(frozen=True, slots=True)
class LedgerClaim:
    """One parsed claim of the ledger."""

    id: str
    sentence: str
    sentence_sha256: str
    audit_status: str
    required_gates: tuple[tuple[str, ...], ...]
    status: str


def sentence_digest(text: str) -> str:
    """``sha256:`` of the exact UTF-8 sentence. No normalisation: a curly quote is drift."""
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def withheld_record(claim_id: str, gate_groups: Iterable[Iterable[str]]) -> dict[str, Any]:
    """The seed record for a claim nobody has certified: every gate pending."""
    return {
        "claim_id": claim_id,
        "status": WITHHELD,
        "implementers": [],
        "reviewer": None,
        "tested_commits": {"backend": None, "frontend": None},
        "serving_receipt": None,
        "automated_evidence": [],
        "live_journey_evidence": [],
        "required_gates": [
            [{"item": item, "status": "pending", "evidence_ref": None} for item in group]
            for group in gate_groups
        ],
        "issued_on": None,
        "expires_on": None,
        "release_decision": None,
        "exclusions": [],
        "limitations": [],
    }


# ── Shape (closed schema) ─────────────────────────────────────────────────────


def _is_mapping(value: object) -> TypeGuard[Mapping[str, object]]:
    return isinstance(value, Mapping)


def _matches(value: object, pattern: re.Pattern[str]) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _parse_date(value: object) -> date | None:
    if not _matches(value, _DATE_RE):
        return None
    try:
        return date.fromisoformat(cast("str", value))
    except ValueError:
        return None


def _closed(value: object, fields: frozenset[str]) -> list[Reason]:
    if not _is_mapping(value):
        return [Reason.MALFORMED]
    keys = set(value)
    if keys - fields:
        return [Reason.UNKNOWN_KEY]
    return [Reason.MALFORMED] if fields - keys else []


def _object(checks: Mapping[str, Checker]) -> Checker:
    fields = frozenset(checks)

    def check(value: object) -> list[Reason]:
        problems = _closed(value, fields)
        if problems:
            return problems
        mapping = cast("Mapping[str, object]", value)
        return [reason for name, field in checks.items() for reason in field(mapping[name])]

    return check


def _list_of(item: Checker, *, non_empty: bool = False) -> Checker:
    def check(value: object) -> list[Reason]:
        if not isinstance(value, list) or (non_empty and not value):
            return [Reason.MALFORMED]
        return [reason for element in value for reason in item(element)]

    return check


def _optional(inner: Checker) -> Checker:
    return lambda value: [] if value is None else inner(value)


def _pattern(pattern: re.Pattern[str], reason: Reason) -> Checker:
    return lambda value: [] if _matches(value, pattern) else [reason]


def _one_of(allowed: Iterable[str], reason: Reason = Reason.MALFORMED) -> Checker:
    vocabulary = frozenset(allowed)
    return lambda value: [] if isinstance(value, str) and value in vocabulary else [reason]


def _date_field(value: object) -> list[Reason]:
    return [] if _parse_date(value) is not None else [Reason.BAD_DATE]


def _receipt_schema(value: object) -> list[Reason]:
    return [] if isinstance(value, int) and not isinstance(value, bool) else [Reason.MALFORMED]


def _release(value: object) -> list[Reason]:
    return [] if value == UNKNOWN_RELEASE or _matches(value, _SHA_RE) else [Reason.MALFORMED]


def _gate_number(value: object) -> list[Reason]:
    valid = isinstance(value, int) and not isinstance(value, bool) and value > 0
    return [] if valid else [Reason.MALFORMED]


def _reference(value: object) -> list[Reason]:
    problems = _closed(value, frozenset({"kind", "ref"}))
    if problems:
        return problems
    mapping = cast("Mapping[str, object]", value)
    pattern = _REF_PATTERNS.get(str(mapping["kind"]))
    return (
        []
        if pattern is not None and _matches(mapping["ref"], pattern)
        else [Reason.UNSAFE_REFERENCE]
    )


_login = _pattern(_LOGIN_RE, Reason.BAD_LOGIN)
_digest = _pattern(_DIGEST_RE, Reason.BAD_DIGEST)

_RECORD_SHAPE: Final = _object(
    {
        "claim_id": _one_of(CLAIM_IDS),
        "status": _one_of((WITHHELD, CERTIFIED)),
        "implementers": _list_of(_login),
        "reviewer": _optional(_login),
        "tested_commits": _object(
            {
                "backend": _optional(_pattern(_SHA_RE, Reason.BAD_TESTED_COMMIT)),
                "frontend": _optional(_pattern(_SHA_RE, Reason.BAD_TESTED_COMMIT)),
            }
        ),
        "serving_receipt": _optional(
            _object(
                {
                    "receipt_schema": _receipt_schema,
                    "backend_release": _release,
                    "frontend_release": _release,
                    "observed_on": _date_field,
                    "artifact_sha256": _digest,
                }
            )
        ),
        "automated_evidence": _list_of(_reference),
        "live_journey_evidence": _list_of(
            _object({"observed_on": _date_field, "artifact_sha256": _digest})
        ),
        "required_gates": _list_of(
            _list_of(
                _object(
                    {
                        "item": _pattern(_GATE_RE, Reason.MALFORMED),
                        "status": _one_of(_GATE_STATUSES),
                        "evidence_ref": _optional(
                            _object({"kind": _one_of(_EVIDENCE_REF_KINDS), "number": _gate_number})
                        ),
                    }
                ),
                non_empty=True,
            )
        ),
        "issued_on": _optional(_date_field),
        "expires_on": _optional(_date_field),
        "release_decision": _optional(
            _object({"decider": _login, "decided_on": _date_field, "sentence_sha256": _digest})
        ),
        "exclusions": _list_of(_one_of(EXCLUSION_CODES, Reason.UNKNOWN_EXCLUSION_CODE)),
        "limitations": _list_of(_one_of(LIMITATION_CODES, Reason.UNKNOWN_LIMITATION_CODE)),
    }
)


# ── Meaning ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class _Context:
    record: Mapping[str, Any]
    claim: LedgerClaim
    coverage_status: str | None
    today: date
    evidence: Evidence

    @property
    def certified(self) -> bool:
        return bool(self.record["status"] == CERTIFIED)


def _is_agent(login: str) -> bool:
    lowered = login.lower()
    return lowered.endswith(BOT_SUFFIX) or lowered in AGENT_LOGINS


def _claim_matches(ctx: _Context) -> list[Reason]:
    return [] if ctx.record["claim_id"] == ctx.claim.id else [Reason.CLAIM_MISMATCH]


def _group_items(group: Sequence[str]) -> frozenset[str] | None:
    """An any-of group's items as a set, or ``None`` when an item repeats."""
    items = frozenset(group)
    return items if len(items) == len(group) else None


def _gate_set(ctx: _Context) -> list[Reason]:
    """Groups pair with the ledger's by position; items within a group in any order.

    A repeated item is a mismatch outright, so the set comparison cannot hide it.
    """
    record = [
        _group_items([gate["item"] for gate in group]) for group in ctx.record["required_gates"]
    ]
    ledger = [frozenset(group) for group in ctx.claim.required_gates]
    return [] if None not in record and record == ledger else [Reason.GATE_SET_MISMATCH]


def _issued_in_past(ctx: _Context) -> list[Reason]:
    issued = _parse_date(ctx.record["issued_on"])
    return [Reason.ISSUED_IN_FUTURE] if issued is not None and issued > ctx.today else []


def _validity_window(ctx: _Context) -> list[Reason]:
    """A window runs forward, and for at most :data:`MAX_CERTIFICATE_AGE_DAYS`."""
    issued = _parse_date(ctx.record["issued_on"])
    expires = _parse_date(ctx.record["expires_on"])
    if issued is None or expires is None:
        return []
    span = expires - issued
    return [] if _NO_TIME <= span <= _MAX_VALIDITY else [Reason.VALIDITY_TOO_LONG]


def _observation_dates(record: Mapping[str, Any]) -> list[object]:
    dates: list[object] = [item["observed_on"] for item in record["live_journey_evidence"]]
    if record["serving_receipt"] is not None:
        dates.append(record["serving_receipt"]["observed_on"])
    if record["release_decision"] is not None:
        dates.append(record["release_decision"]["decided_on"])
    return dates


def _observed_in_past(ctx: _Context) -> list[Reason]:
    future = [d for d in map(_parse_date, _observation_dates(ctx.record)) if d and d > ctx.today]
    return [Reason.OBSERVED_IN_FUTURE] if future else []


def _evidence_dates(record: Mapping[str, Any]) -> list[date]:
    """When the live journeys ran and the serving receipt was sampled."""
    dates: list[object] = [item["observed_on"] for item in record["live_journey_evidence"]]
    if record["serving_receipt"] is not None:
        dates.append(record["serving_receipt"]["observed_on"])
    return list(filter(None, map(_parse_date, dates)))


def _decided_on(record: Mapping[str, Any]) -> date | None:
    decision = record["release_decision"]
    return None if decision is None else _parse_date(decision["decided_on"])


def _evidence_window(ctx: _Context) -> list[Reason]:
    """Evidence and signoff fall within :data:`MAX_EVIDENCE_AGE_DAYS` before issue."""
    issued = _parse_date(ctx.record["issued_on"])
    if issued is None:
        return []
    dates = [*_evidence_dates(ctx.record), *filter(None, [_decided_on(ctx.record)])]
    inside = all(issued - _MAX_EVIDENCE_AGE <= day <= issued for day in dates)
    return [] if inside else [Reason.EVIDENCE_OUTSIDE_WINDOW]


def _signoff_follows_evidence(ctx: _Context) -> list[Reason]:
    """The decider signs what was observed, so the signoff is dated after it."""
    decided = _decided_on(ctx.record)
    evidence = _evidence_dates(ctx.record)
    if decided is None or not evidence:
        return []
    return [] if decided >= max(evidence) else [Reason.SIGNOFF_BEFORE_EVIDENCE]


def _audit_limitations(ctx: _Context) -> list[Reason]:
    """AC13: a claim the audit found partial or misleading is certified with limits."""
    if not ctx.certified or ctx.claim.audit_status not in PARTIAL_AUDIT_STATUSES:
        return []
    return [] if ctx.record["limitations"] else [Reason.LIMITATIONS_REQUIRED]


def _coverage_limitations(ctx: _Context) -> list[Reason]:
    """AC13: partial/uncovered forbidden-effect coverage (claim_coverage.json) is stated."""
    required = COVERAGE_LIMITATIONS.get(ctx.coverage_status or "")
    if not ctx.certified or required is None:
        return []
    return [] if required in ctx.record["limitations"] else [Reason.LIMITATIONS_REQUIRED]


def _implementers_named(ctx: _Context) -> list[Reason]:
    """Independence is unprovable when nobody is named as an implementer."""
    return [] if ctx.record["implementers"] else [Reason.IMPLEMENTERS_MISSING]


def _reviewer(ctx: _Context) -> list[Reason]:
    """AC6: a named reviewer who implemented nothing and is not the loop."""
    reviewer = ctx.record["reviewer"]
    if reviewer is None:
        return [Reason.REVIEWER_MISSING]
    if _is_agent(reviewer):
        return [Reason.REVIEWER_IS_AGENT]
    implementers = {login.lower() for login in ctx.record["implementers"]}
    return [Reason.REVIEWER_IS_IMPLEMENTER] if reviewer.lower() in implementers else []


def _tested_commits(ctx: _Context) -> list[Reason]:
    commits = ctx.record["tested_commits"]
    missing = commits["backend"] is None or commits["frontend"] is None
    return [Reason.TESTED_COMMIT_MISSING] if missing else []


def _serving_binding(ctx: _Context) -> list[Reason]:
    """AC7: both serving releases equal the commits that were tested."""
    receipt = ctx.record["serving_receipt"]
    if receipt is None:
        return [Reason.RECEIPT_MISSING]
    commits = ctx.record["tested_commits"]
    outcomes = (
        (Reason.RECEIPT_SCHEMA_UNSUPPORTED, receipt["receipt_schema"] in SUPPORTED_RECEIPT_SCHEMAS),
        (Reason.BACKEND_RELEASE_DRIFT, _bound(receipt["backend_release"], commits["backend"])),
        (Reason.FRONTEND_RELEASE_DRIFT, _bound(receipt["frontend_release"], commits["frontend"])),
    )
    return [reason for reason, holds in outcomes if not holds]


def _bound(release: str, tested: str | None) -> bool:
    """A served release binds only to a tested commit, and only when equal to it."""
    return tested is not None and release == tested


def _pytest_reference(ref: str, evidence: Evidence) -> list[Reason]:
    if evidence.node_state is None:
        return [Reason.UNVERIFIABLE_PYTEST_EVIDENCE]
    state = evidence.node_state(ref)
    if state == _XFAIL:
        return [Reason.NON_RUNNING_EVIDENCE]
    return [] if state == _PRESENT else [Reason.DANGLING_PYTEST_NODE]


def _jest_reference(ref: str, evidence: Evidence) -> list[Reason]:
    return [] if evidence.jest_file_exists(ref) else [Reason.DANGLING_JEST_FILE]


def _journey_reference(ref: str, evidence: Evidence) -> list[Reason]:
    status = evidence.journeys.get(ref)
    if status is None:
        return [Reason.UNKNOWN_JOURNEY]
    return [] if status == _COVERED else [Reason.UNCOVERED_JOURNEY]


_RESOLVERS: Final[Mapping[str, Callable[[str, Evidence], list[Reason]]]] = {
    "pytest": _pytest_reference,
    "jest": _jest_reference,
    "journey": _journey_reference,
}


def _automated_evidence(ctx: _Context) -> list[Reason]:
    """AC4/AC5: every reference resolves; xfail and uncovered support nothing."""
    references = ctx.record["automated_evidence"]
    reasons = [] if references else [Reason.AUTOMATED_EVIDENCE_MISSING]
    for reference in references:
        reasons.extend(_RESOLVERS[reference["kind"]](reference["ref"], ctx.evidence))
    return reasons


def _live_journeys(ctx: _Context) -> list[Reason]:
    return [] if ctx.record["live_journey_evidence"] else [Reason.LIVE_JOURNEY_MISSING]


def _gate_met(gate: Mapping[str, Any]) -> bool:
    return gate["status"] == _PASSED and gate["evidence_ref"] is not None


def _gate_unevidenced(gate: Mapping[str, Any]) -> bool:
    return gate["status"] == _PASSED and gate["evidence_ref"] is None


def _group_reasons(group: Sequence[Mapping[str, Any]]) -> list[Reason]:
    """An any-of group is met by one passed gate that carries evidence."""
    unevidenced = [Reason.GATE_EVIDENCE_MISSING] * sum(map(_gate_unevidenced, group))
    return unevidenced + ([] if any(map(_gate_met, group)) else [Reason.GATE_UNMET])


def _gates(ctx: _Context) -> list[Reason]:
    """AC9: each any-of group has one passed gate carrying evidence."""
    return [reason for group in ctx.record["required_gates"] for reason in _group_reasons(group)]


def _signoff(ctx: _Context) -> list[Reason]:
    """AC10: a human decider signed this exact sentence."""
    decision = ctx.record["release_decision"]
    if decision is None:
        return [Reason.SIGNOFF_MISSING]
    reasons = [Reason.SIGNOFF_BY_AGENT] if _is_agent(decision["decider"]) else []
    if decision["sentence_sha256"] != sentence_digest(ctx.claim.sentence):
        reasons.append(Reason.SIGNOFF_SENTENCE_DRIFT)
    return reasons


def _expiry(ctx: _Context) -> list[Reason]:
    """AC8: a certificate lapses the day after ``expires_on``."""
    expires = _parse_date(ctx.record["expires_on"])
    if _parse_date(ctx.record["issued_on"]) is None or expires is None:
        return [Reason.VALIDITY_MISSING]
    return [Reason.EXPIRED] if ctx.today > expires else []


_CHECKS: Final[tuple[Callable[[_Context], list[Reason]], ...]] = (
    _claim_matches,
    _gate_set,
    _issued_in_past,
    _validity_window,
    _observed_in_past,
    _audit_limitations,
    _coverage_limitations,
    _implementers_named,
    _reviewer,
    _tested_commits,
    _serving_binding,
    _automated_evidence,
    _live_journeys,
    _gates,
    _signoff,
    _evidence_window,
    _signoff_follows_evidence,
    _expiry,
)


def _unique(reasons: Iterable[Reason]) -> tuple[Reason, ...]:
    return tuple(dict.fromkeys(reasons))


def _run_checks(ctx: _Context) -> list[Reason]:
    reasons: list[Reason] = []
    for check in _CHECKS:
        reasons.extend(check(ctx))
    return reasons


def _verdict(ctx: _Context, reasons: list[Reason]) -> Verdict:
    invalid = _unique(filter(INVALID_REASONS.__contains__, reasons))
    if invalid:
        return EXIT_INVALID, invalid
    if not ctx.certified:
        return EXIT_INCOMPLETE, (Reason.WITHHELD,)
    return (EXIT_INCOMPLETE, _unique(reasons)) if reasons else (EXIT_CERTIFIED, ())


def validate_record(
    record: object,
    *,
    ledger_entry: object,
    coverage_status: str | None,
    today: date,
    evidence: Evidence,
) -> Verdict:
    """Judge one certification record against its ledger claim.

    Args:
        record: The record as parsed from JSON.
        ledger_entry: The ledger claim it certifies.
        coverage_status: That claim's ``claim_coverage.json`` status, if any.
        today: The date the certificate must be current on.
        evidence: How test, Jest and journey references resolve.

    Returns:
        The exit code and the closed reasons behind it.
    """
    claim = parse_ledger_claim(ledger_entry)
    if claim is None:
        return EXIT_INVALID, (Reason.MALFORMED,)
    shape = _RECORD_SHAPE(record)
    if shape:
        return EXIT_INVALID, _unique(shape)
    ctx = _Context(cast("Mapping[str, Any]", record), claim, coverage_status, today, evidence)
    return _verdict(ctx, _run_checks(ctx))


# ── The ledger and the publish gate ───────────────────────────────────────────


_LEDGER_CLAIM_SHAPE: Final = _object(
    {
        "id": _one_of(CLAIM_IDS),
        "sentence": lambda value: [] if isinstance(value, str) and value else [Reason.MALFORMED],
        "sentence_sha256": _digest,
        "audit_status": _one_of(AUDIT_STATUSES),
        "required_gates": _list_of(
            _list_of(_pattern(_GATE_RE, Reason.MALFORMED), non_empty=True), non_empty=True
        ),
        "status": _one_of((WITHHELD, PUBLISHED)),
    }
)


def parse_ledger_claim(value: object) -> LedgerClaim | None:
    """One ledger claim, or ``None`` when it is not shaped like one."""
    if _LEDGER_CLAIM_SHAPE(value):
        return None
    raw = cast("Mapping[str, Any]", value)
    return LedgerClaim(
        id=raw["id"],
        sentence=raw["sentence"],
        sentence_sha256=raw["sentence_sha256"],
        audit_status=raw["audit_status"],
        required_gates=tuple(tuple(group) for group in raw["required_gates"]),
        status=raw["status"],
    )


def _items(document: object, key: str) -> list[object] | None:
    """The list under ``key`` of a ``{schema_version: 1, key: [...]}`` document."""
    if _closed(document, frozenset({"schema_version", key})):
        return None
    mapping = cast("Mapping[str, object]", document)
    items = mapping[key]
    if mapping["schema_version"] != SCHEMA_VERSION or not isinstance(items, list):
        return None
    return cast("list[object]", items)


def _missing(ids: Sequence[object], where: str) -> list[str]:
    return [f"{claim_id} missing from {where}" for claim_id in CLAIM_IDS if claim_id not in ids]


def _repeated(ids: Sequence[object], where: str) -> list[str]:
    counted = [claim_id for claim_id in CLAIM_IDS if ids.count(claim_id) > 1]
    return [f"{claim_id} appears more than once in {where}" for claim_id in counted]


def _unknown(ids: Sequence[object], where: str) -> list[str]:
    return [f"an unknown claim id in {where}" for claim_id in ids if claim_id not in CLAIM_IDS]


def _totality(ids: Sequence[object], where: str) -> list[str]:
    """Every claim C01-C24 exactly once, and nothing else. Never echoes a value."""
    return [*_missing(ids, where), *_repeated(ids, where), *_unknown(ids, where)]


def _digest_problems(claims: Iterable[LedgerClaim]) -> list[str]:
    drifted = [
        claim for claim in claims if sentence_digest(claim.sentence) != claim.sentence_sha256
    ]
    return [f"{claim.id} sentence does not match its sha256" for claim in drifted]


def _ledger_claims(ledger: object) -> tuple[list[LedgerClaim], list[str]]:
    items = _items(ledger, "claims")
    if items is None:
        return [], ["the ledger is malformed"]
    claims = list(filter(None, map(parse_ledger_claim, items)))
    if len(claims) != len(items):
        return claims, ["a ledger claim is malformed"]
    ids: list[object] = [claim.id for claim in claims]
    return claims, _totality(ids, "the ledger") + _digest_problems(claims)


def ledger_problems(ledger: object) -> tuple[str, ...]:
    """Everything wrong with the ledger on its own: shape, totality, digests."""
    return tuple(_ledger_claims(ledger)[1])


def _record_id(record: object) -> object:
    return record.get("claim_id") if _is_mapping(record) else None


def _cites_evidence(records: Iterable[object]) -> bool:
    return any(_is_mapping(r) and r.get("automated_evidence") for r in records)


def _record_problem(claim: LedgerClaim, verdict: Verdict) -> str | None:
    code, reasons = verdict
    joined = ",".join(reasons)
    if code == EXIT_INVALID:
        return f"{claim.id} record is invalid: {joined}"
    if claim.status == PUBLISHED and code != EXIT_CERTIFIED:
        return f"{claim.id} published without a current certificate: {joined}"
    return None


def publish_gate_problems(
    ledger: object,
    certifications: object,
    *,
    coverage: Mapping[str, str],
    today: date,
    evidence_factory: Callable[[], Evidence],
) -> tuple[str, ...]:
    """Why the ledger may not ship as it stands, or nothing.

    Totality in both files, a well-formed record for every claim, and a
    current certificate behind every ``published`` claim. There is no
    allow-list: today the gate passes only because nothing is published.
    ``evidence_factory`` runs only when some record cites automated evidence.
    """
    claims, problems = _ledger_claims(ledger)
    records = _items(certifications, "records")
    if records is None:
        return (*problems, "the certifications file is malformed")
    problems.extend(_totality(list(map(_record_id, records)), "the certifications"))
    evidence = evidence_factory() if _cites_evidence(records) else _NO_EVIDENCE
    judge = _Judge(_by_id(claims), coverage, today, evidence)
    problems.extend(filter(None, map(judge.problem, records)))
    return tuple(problems)


def _by_id(claims: Iterable[LedgerClaim]) -> dict[str, LedgerClaim]:
    return {claim.id: claim for claim in claims}


@dataclass(frozen=True, slots=True)
class _Judge:
    """Validates records against the ledger claims they name."""

    claims: Mapping[str, LedgerClaim]
    coverage: Mapping[str, str]
    today: date
    evidence: Evidence

    def claim_for(self, record: object) -> LedgerClaim | None:
        """The ledger claim a record names, if the ledger has it."""
        claim_id = _record_id(record)
        return self.claims.get(claim_id) if isinstance(claim_id, str) else None

    def verdict(self, record: object, claim: LedgerClaim) -> Verdict:
        """The record's verdict against ``claim``."""
        return validate_record(
            record,
            ledger_entry=_ledger_entry(claim),
            coverage_status=self.coverage.get(claim.id),
            today=self.today,
            evidence=self.evidence,
        )

    def problem(self, record: object) -> str | None:
        """The gate problem this record raises, if any (a missing claim is totality's)."""
        claim = self.claim_for(record)
        return None if claim is None else _record_problem(claim, self.verdict(record, claim))


def _ledger_entry(claim: LedgerClaim) -> dict[str, object]:
    return {
        "id": claim.id,
        "sentence": claim.sentence,
        "sentence_sha256": claim.sentence_sha256,
        "audit_status": claim.audit_status,
        "required_gates": [list(group) for group in claim.required_gates],
        "status": claim.status,
    }


# ── Inputs ────────────────────────────────────────────────────────────────────


def journey_statuses(document: object) -> dict[str, str]:
    """``{journey id: status}`` from ``frontend/e2e/journeys.json``."""
    if not isinstance(document, list):
        return {}
    return dict(filter(None, map(_journey_pair, cast("list[object]", document))))


def _journey_pair(entry: object) -> tuple[str, str] | None:
    if not _is_mapping(entry):
        return None
    journey, status = entry.get("id"), entry.get("status")
    return (journey, status) if isinstance(journey, str) and isinstance(status, str) else None


def coverage_statuses(document: object) -> dict[str, str] | None:
    """``{claim id: status}`` from ``claim_coverage.json``; ``None`` if unreadable."""
    if not _is_mapping(document):
        return None
    statuses = {claim: _row_status(row) for claim, row in document.items()}
    return None if None in statuses.values() else cast("dict[str, str]", statuses)


def _row_status(row: object) -> str | None:
    status = row.get("status") if _is_mapping(row) else None
    return status if isinstance(status, str) else None


def _repo_relative(node_id: str) -> str:
    """Collection from backend/ prints ``tests/...``; records cite ``backend/tests/...``."""
    return _BACKEND_PREFIX + node_id if node_id.startswith(_BACKEND_TESTS) else node_id


def collected_node_ids(text: str) -> frozenset[str]:
    """Node ids from saved ``pytest --collect-only -q`` output."""
    return frozenset(
        _repo_relative(line.strip()) for line in text.splitlines() if _COLLECT_SEPARATOR in line
    )


def node_state_from(collected: str, non_running: str) -> Callable[[str], str]:
    """Resolve node ids against saved collection output rather than by running anything."""
    present = collected_node_ids(collected)
    xfails = collected_node_ids(non_running)

    def state(node_id: str) -> str:
        if node_id in xfails:
            return _XFAIL
        return _PRESENT if node_id in present else "missing"

    return state


def parser() -> argparse.ArgumentParser:
    """The command line, documented in the module docstring."""
    cli = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0] if __doc__ else None)
    cli.add_argument("certifications", type=Path)
    cli.add_argument("--ledger", type=Path, default=LEDGER_PATH)
    cli.add_argument("--coverage", type=Path, default=COVERAGE_PATH)
    cli.add_argument("--journeys", type=Path, default=JOURNEYS_PATH)
    cli.add_argument("--repo-root", type=Path, default=REPO_ROOT)
    cli.add_argument("--collected", type=Path, help="saved `pytest --collect-only -q` output")
    cli.add_argument(
        "--non-running",
        type=Path,
        help=f'saved `pytest --collect-only -q -m "{NON_RUNNING_MARKERS}"` output; '
        "required with --collected",
    )
    cli.add_argument("--today", type=date.fromisoformat, default=None)
    cli.add_argument("--gate", action="store_true", help="run the publish gate")
    return cli


class _UnreadableError(Exception):
    """An input file could not be read."""


def _read_json(path: Path) -> object:
    try:
        return cast("object", json.loads(path.read_text(encoding="utf-8")))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _UnreadableError from exc


def _read_text(path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise _UnreadableError from exc


@dataclass(frozen=True, slots=True)
class _Inputs:
    ledger: object
    certifications: object
    coverage: Mapping[str, str]
    evidence: Evidence


def _resolver(collected: str | None, non_running: str | None) -> Callable[[str], str] | None:
    """Both collections, or nothing: without the second, skips were never checked."""
    if collected is None or non_running is None:
        return None
    return node_state_from(collected, non_running)


def _inputs(args: argparse.Namespace) -> _Inputs:
    coverage = coverage_statuses(_read_json(args.coverage))
    if coverage is None:
        raise _UnreadableError
    collected = _read_text(args.collected)
    non_running = _read_text(args.non_running)
    root: Path = args.repo_root
    evidence = Evidence(
        node_state=_resolver(collected, non_running),
        jest_file_exists=lambda ref: (root / ref).is_file(),
        journeys=journey_statuses(_read_json(args.journeys)),
    )
    return _Inputs(_read_json(args.ledger), _read_json(args.certifications), coverage, evidence)


def _say(line: str) -> None:
    """Print one value-free report line."""
    sys.stdout.write(line + "\n")


def _run_gate(inputs: _Inputs, today: date) -> int:
    problems = publish_gate_problems(
        inputs.ledger,
        inputs.certifications,
        coverage=inputs.coverage,
        today=today,
        evidence_factory=lambda: inputs.evidence,
    )
    for problem in problems:
        _say(problem)
    return EXIT_INCOMPLETE if problems else EXIT_CERTIFIED


def _run_records(inputs: _Inputs, today: date) -> int:
    records = _items(inputs.certifications, "records")
    if records is None:
        _say("the certifications file is malformed")
        return EXIT_INVALID
    if not records:
        _say("the certifications file has no records")
        return EXIT_INVALID
    judge = _Judge(
        _by_id(_ledger_claims(inputs.ledger)[0]), inputs.coverage, today, inputs.evidence
    )
    return max(_report(judge, index, record) for index, record in enumerate(records))


def _report(judge: _Judge, index: int, record: object) -> int:
    """Print one record's value-free verdict line and return its exit code."""
    claim = judge.claim_for(record)
    if claim is None:
        _say(f"record[{index}] INVALID {Reason.MALFORMED}")
        return EXIT_INVALID
    code, reasons = judge.verdict(record, claim)
    _say(f"{claim.id} {_VERDICT_NAMES[code]} {','.join(reasons)}".rstrip())
    return code


def main(argv: Sequence[str] | None = None) -> int:
    """Validate certification records, or with ``--gate`` run the publish gate."""
    args = parser().parse_args(argv)
    today: date = args.today or datetime.now(UTC).date()
    try:
        inputs = _inputs(args)
    except _UnreadableError:
        sys.stderr.write("an input file could not be read as JSON\n")
        return EXIT_INVALID
    return _run_gate(inputs, today) if args.gate else _run_records(inputs, today)


if __name__ == "__main__":
    sys.exit(main())
