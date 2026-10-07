"""Guards that the custody decision (ADR 0009) stays complete, sourced and honest.

ADR 0009 records the owner's 2026-10-07 decision for #3066: the operator must
not be able to read journal entries, so journal keys become user-held with no
operator escrow, inference moves to the device or the person's vault, and a
cloud model is reached only with the person's own key. The record has a
machine-readable twin, ``docs/adr/0009-architecture-scorecard.json``, and the
failure this module exists to stop is the one the epic names: "architecture
hidden in prose". So the twin is validated, not merely parsed:

* every option is scored on every mandatory dimension;
* a budget or staffing cell is ``unknown`` or carries an owner-provenanced
  source -- never a figure lifted from a pricing page;
* every ``repo:`` evidence source resolves to a file, and a named symbol in it;
* an ``accepted`` record names its decider, date, selection, rejected
  alternatives, the reviews still owed, and the questions the owner left open.

It also pins the custody baseline the implementation epic (B13, #3067) must
invert: today the server process holds every key, and the codec has no
per-person key parameter. That test fails by design when user-held keys land.
"""

from __future__ import annotations

import copy
import inspect
import json
import re
from datetime import date
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from services import journal_encryption as je
from services.encryption_inventory import (
    ROW_ID_COLUMN,
    EncryptedColumn,
    encrypted_columns,
    raw_table,
)
from services.journal_encryption import EncryptedString
from tests.support.encrypted_rows import insert_row

_REPO_ROOT = Path(__file__).resolve().parents[2]
_ADR_DIR = _REPO_ROOT / "docs" / "adr"
_ADR = _ADR_DIR / "0009-privacy-custody-and-inference-architecture.md"
_SCORECARD = _ADR_DIR / "0009-architecture-scorecard.json"
_EPIC_DRAFT = _ADR_DIR / "0009-b13-epic-draft.md"
_NGINX_CONF = _REPO_ROOT / "frontend" / "nginx.conf"

# The options the issue compares, the status quo at HEAD, and the composite the
# owner selected (B's user-held keys with D's device-side and vault-local
# inference). Scored as its own column because the selection is the
# composite, not either half.
_OPTIONS = ("status_quo", "A", "B", "C", "D", "E", "BD")
_SELECTED = "BD"

_MANDATORY_DIMENSIONS = (
    "boundary",
    "key_custody",
    "recovery",
    "metadata_leakage",
    "inference_location",
    "supported_platforms",
    "update_trust",
    "primary_copy_removal",
    "threat_actors",
    "budget_usd_per_active_account_month",
    "staffing",
    "reopen_triggers",
)
_MONEY_DIMENSIONS = frozenset({"budget_usd_per_active_account_month", "staffing"})
_UNKNOWN = {"status": "unknown", "owner_input_required": True}
_SOURCE_PREFIXES = ("repo:", "issue:#", "creek-vault:", "owner:")
_OWNER_SOURCE_PREFIX = "owner:"
# Every owner decision this record may cite, by date, and the decision
# bullets on that date it may cite by anchor. An ``owner:`` source that names
# anything else is laundered provenance. Each anchor must also appear in ADR
# 0009 beside the decision text it labels.
_OWNER_DECISIONS: dict[str, frozenset[str]] = {
    "2026-10-07": frozenset(
        {
            "B12-premise",
            "B12-cloud-byok",
            "B12-credits",
            "B12-web",
            # The owner's answers to ADR 0009's follow-up questions, same day.
            "followup-runtime",
            "followup-web-anchor",
            "followup-web-enrol",
            "followup-scope",
            "followup-migration",
            "followup-recovery",
            "followup-feature-loss",
            "followup-native",
            "followup-byok-web",
            "followup-primitives",
        }
    ),
}
# Anchors under which the owner has actually supplied a budget or staffing
# figure. None exist yet, so no money cell can be owner-sourced until the
# owner records one here.
_OWNER_BUDGET_ANCHORS: frozenset[str] = frozenset()
_OWNER_SOURCE = re.compile(r"^owner:(\d{4}-\d{2}-\d{2})#([A-Za-z0-9-]+)$")
_REPO_SOURCE_PREFIX = "repo:"
_STATUSES = frozenset({"proposed", "accepted"})
_REVIEW_CONSULTED = "consulted"
_REVIEW_OWED = "not_yet_consulted"
_PHASE_IDS = ("a", "b", "c", "d")
# The journal tables carry at least body, title and the AI notes on them; a
# scope that shrinks below this has stopped describing the journal.
_MIN_IN_SCOPE_JOURNAL_COLUMNS = 10

_ACCEPTED_STATUS = "- **Status:** Accepted"
_DECIDER_LINE = "- **Decider:** Geoff"
_DECIDED_ON_LINE = "- **Decided on:** 2026-10-07"
_NOT_OPERATOR_BLIND = "provider-managed custody is not operator-blind"
_AMENDMENT_HEADING = "## Amended by ADR 0009 (2026-10-07)"

_REQUIRED_SECTIONS = (
    "## Context",
    "## Decision",
    "## Threat actors",
    "## Options",
    "## Per-platform claim scoping",
    "## Client delivery and update trust",
    "## Primary-copy and derivative removal",
    "## Migration of existing server-readable data",
    "## BotMason credits",
    "## Recovery, reset and pairing (D03): decided parts and open owner questions",
    "## Confidential compute (D05)",
    "## Budget and staffing",
    "## Reviewers",
    "## Rejected alternatives",
    "## Implementation plan",
    "## Amended records",
    "## Reopen triggers",
    "## What this record does not unlock",
)

# The tests that hold the custody baseline, keyed by the module they live in so
# a move is caught rather than silently orphaning the citation.
_PINNING_TESTS = {
    "test_journal_text_at_rest.py": (
        "test_every_encrypted_column_stores_ciphertext",
        "test_the_pinned_inventory_is_exactly_what_the_schema_encrypts",
        "test_every_encrypted_table_has_a_row_factory",
    ),
    "test_custody_decision_record.py": (
        "test_custody_codec_has_no_per_principal_key",
        "test_server_env_keys_alone_recover_every_in_scope_journal_column",
    ),
}

# The records the owner's premise makes non-compliant, and one sentence from
# each that must survive the amendment: history is appended to, not rewritten.
_AMENDED_ADRS = {
    "0002-intimate-content-local-routing.md": (
        "## Decision 2 — Key custody: user-held keys plus confidential compute"
    ),
    "0007-demand-provisioned-confidential-vaults.md": (
        "## Decision 4 — Launch custody is explicit and provider-managed"
    ),
}

_KEY_PARAMETER = re.compile(r"key|principal|user|owner", re.IGNORECASE)
_OPTION_HEADING = re.compile(r"^### Option (\S+)$", re.MULTILINE)
_PHASE_HEADING = re.compile(r"^### Phase \(([a-z])\)", re.MULTILINE)


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------


def _adr_text() -> str:
    """The decision record, as shipped."""
    return _ADR.read_text(encoding="utf-8")


def _card() -> dict[str, object]:
    """The scorecard, as shipped, narrowed to a JSON object."""
    loaded: object = json.loads(_SCORECARD.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def _as_dict(value: object) -> dict[str, object]:
    """``value`` if it is a JSON object, else an empty one (reported upstream)."""
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[object]:
    """``value`` if it is a JSON array, else an empty one (reported upstream)."""
    return value if isinstance(value, list) else []


def _is_text(value: object) -> bool:
    """Whether ``value`` is a non-blank string."""
    return isinstance(value, str) and bool(value.strip())


def _is_iso_date(value: object) -> bool:
    """Whether ``value`` is a ``YYYY-MM-DD`` string that names a real day."""
    if not isinstance(value, str):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


# --------------------------------------------------------------------------
# The validator. Every message names a JSON path, never a value.
# --------------------------------------------------------------------------


def _cell_violation(path: str, cell: object) -> str | None:
    """A scored cell is ``{value, source}`` or the unknown marker."""
    if cell == _UNKNOWN:
        return None
    fields = _as_dict(cell)
    if not _is_text(fields.get("value")) or not isinstance(fields.get("source"), str):
        return f"{path} must be {{value, source}} or the unknown marker"
    return None


def _option_violations(card: dict[str, object]) -> list[str]:
    """Every option is present and scored on every mandatory dimension."""
    options = _as_dict(card.get("options"))
    violations = [f"options.{name} is missing" for name in _OPTIONS if name not in options]
    for name, scored in options.items():
        cells = _as_dict(scored)
        for dimension in _MANDATORY_DIMENSIONS:
            path = f"options.{name}.{dimension}"
            if dimension not in cells:
                violations.append(f"{path} is missing")
                continue
            found = _cell_violation(path, cells[dimension])
            if found is not None:
                violations.append(found)
    return violations


def _owner_anchor(source: object) -> str | None:
    """The decision anchor of a well-formed, known ``owner:<date>#<anchor>`` source."""
    match = _OWNER_SOURCE.match(source) if isinstance(source, str) else None
    if match is None:
        return None
    date_part, anchor = match.groups()
    return anchor if anchor in _OWNER_DECISIONS.get(date_part, frozenset()) else None


def _money_violations(
    card: dict[str, object], budget_anchors: frozenset[str] = _OWNER_BUDGET_ANCHORS
) -> list[str]:
    """Money and staffing are unknown, or cite an owner budget decision; never ours."""
    violations: list[str] = []
    for name, scored in _as_dict(card.get("options")).items():
        cells = _as_dict(scored)
        for dimension in sorted(_MONEY_DIMENSIONS & cells.keys()):
            cell = cells[dimension]
            anchor = _owner_anchor(_as_dict(cell).get("source"))
            if cell != _UNKNOWN and anchor not in budget_anchors:
                violations.append(
                    f"options.{name}.{dimension} is neither unknown nor an owner budget decision"
                )
    return violations


def _symbol_defined(source: str, name: str) -> bool:
    """Whether ``name`` is a def, class or module-level assignment in ``source``."""
    escaped = re.escape(name)
    definition = rf"^(?:async def|def|class) {escaped}\b"
    assignment = rf"^{escaped}\s*[:=]"
    return bool(re.search(definition, source, re.MULTILINE)) or bool(
        re.search(assignment, source, re.MULTILINE)
    )


def _repo_source_violation(path: str, source: str, root: Path) -> str | None:
    """A ``repo:<file>[::<symbol>]`` source names a file and symbol that exist."""
    target, _, symbol = source.removeprefix(_REPO_SOURCE_PREFIX).partition("::")
    file = root / target
    if not file.is_file():
        return f"{path} cites a repo file that does not exist"
    if symbol and not _symbol_defined(file.read_text(encoding="utf-8"), symbol):
        return f"{path} cites a symbol its file does not define"
    return None


def _source_violation(path: str, source: object, root: Path) -> str | None:
    """One evidence source has a known prefix and, for ``repo:``, resolves."""
    if not isinstance(source, str) or not source.startswith(_SOURCE_PREFIXES):
        return f"{path} has an evidence source with no recognised prefix"
    if source.startswith(_REPO_SOURCE_PREFIX):
        return _repo_source_violation(path, source, root)
    if source.startswith(_OWNER_SOURCE_PREFIX) and _owner_anchor(source) is None:
        return f"{path} cites an owner decision that is not on record"
    return None


def _source_violations(card: dict[str, object], root: Path) -> list[str]:
    """Every scored cell's evidence is checkable, and every ``repo:`` one is real."""
    violations: list[str] = []
    for name, scored in _as_dict(card.get("options")).items():
        for dimension, cell in _as_dict(scored).items():
            if cell == _UNKNOWN:
                continue
            found = _source_violation(
                f"options.{name}.{dimension}.source", _as_dict(cell).get("source"), root
            )
            if found is not None:
                violations.append(found)
    return violations


def _selection_violations(card: dict[str, object]) -> list[str]:
    """Status, claim scope, status quo and the rejected list are coherent."""
    violations: list[str] = []
    if card.get("status") not in _STATUSES:
        violations.append("status must be proposed or accepted")
    if card.get("unlocks_public_claims") is not False:
        violations.append("unlocks_public_claims must be false (B24 gates every claim)")
    if "status_quo" not in _as_dict(card.get("options")):
        violations.append("options.status_quo must describe HEAD")
    rejected_names: set[object] = set()
    for index, entry in enumerate(_as_list(card.get("rejected"))):
        fields = _as_dict(entry)
        rejected_names.add(fields.get("option"))
        if fields.get("option") not in _OPTIONS or not _is_text(fields.get("reason")):
            violations.append(f"rejected[{index}] needs a known option and a reason")
    if card.get("selected_option") in rejected_names:
        violations.append("selected_option also appears in rejected")
    return violations


def _review_violation(index: int, entry: object) -> str | None:
    """A review is either done (who, when) or owed (before which phase)."""
    fields = _as_dict(entry)
    if not _is_text(fields.get("role")):
        return f"reviewers[{index}].role is missing"
    status = fields.get("status")
    if status == _REVIEW_CONSULTED and _is_text(fields.get("name")):
        return (
            None if _is_iso_date(fields.get("consulted_on")) else f"reviewers[{index}].consulted_on"
        )
    if status == _REVIEW_OWED and _is_text(fields.get("required_before")):
        return None
    return f"reviewers[{index}] is neither consulted (name, date) nor owed (required_before)"


def _signoff_violations(card: dict[str, object]) -> list[str]:
    """An accepted record is signed, selects, rejects, and owns what it left open."""
    if card.get("status") != "accepted":
        return []
    violations: list[str] = []
    if not _is_text(card.get("decider")):
        violations.append("decider is required once accepted")
    if not _is_iso_date(card.get("decided_on")):
        violations.append("decided_on must be an ISO date once accepted")
    if card.get("selected_option") not in _OPTIONS:
        violations.append("selected_option must name a scored option once accepted")
    if not _as_list(card.get("rejected")):
        violations.append("rejected must list the alternatives once accepted")
    reviewers = _as_list(card.get("reviewers"))
    if not reviewers:
        violations.append("reviewers must list every review, done or owed")
    violations += [
        found
        for index, entry in enumerate(reviewers)
        if (found := _review_violation(index, entry)) is not None
    ]
    if not _as_list(card.get("open_owner_questions")):
        violations.append("open_owner_questions must list what the owner left undecided")
    return violations


def _scorecard_violations(card: dict[str, object], root: Path) -> list[str]:
    """Every way the scorecard fails to be a complete, sourced decision record."""
    return (
        _option_violations(card)
        + _money_violations(card)
        + _source_violations(card, root)
        + _selection_violations(card)
        + _signoff_violations(card)
    )


def _flat(text: str) -> str:
    """``text`` with every whitespace run collapsed, so hard wrapping cannot hide a phrase."""
    return " ".join(text.split())


def _option_slice(text: str, option: str) -> str:
    """The prose under ``### Option <option>`` up to the next ``###`` heading, flattened."""
    start = text.index(f"### Option {option}\n")
    end = text.find("\n### ", start + 1)
    return _flat(text[start : end if end != -1 else len(text)])


# --------------------------------------------------------------------------
# The record as shipped
# --------------------------------------------------------------------------


def test_custody_adr_records_the_owners_accepted_decision() -> None:
    """Geoff decided on 2026-10-07; the record and its twin both say so."""
    text = _adr_text()
    card = _card()

    assert _ACCEPTED_STATUS in text
    assert _DECIDER_LINE in text
    assert _DECIDED_ON_LINE in text
    assert card["status"] == "accepted"
    assert card["decider"] == "Geoff"
    assert card["decided_on"] == "2026-10-07"
    assert card["selected_option"] == _SELECTED


def test_custody_adr_carries_every_required_section() -> None:
    """A missing section is an undecided dimension hidden by omission."""
    text = _adr_text()

    assert [section for section in _REQUIRED_SECTIONS if section not in text] == []


def test_custody_scorecard_is_valid_as_shipped() -> None:
    """The shipped twin passes its own validator."""
    assert _scorecard_violations(_card(), _REPO_ROOT) == []


def test_custody_scorecard_and_record_agree() -> None:
    """Every scored option has prose and every option in prose is scored."""
    text = _adr_text()
    card = _card()

    assert set(_OPTION_HEADING.findall(text)) == set(_as_dict(card["options"]))
    assert (card["status"] == "accepted") == (_ACCEPTED_STATUS in text)
    assert (card["selected_option"] == _SELECTED) == (f"**Selected: Option {_SELECTED}**" in text)


@pytest.mark.parametrize("dimension", _MANDATORY_DIMENSIONS)
def test_custody_scorecard_scores_every_option_on_every_mandatory_dimension(
    dimension: str,
) -> None:
    """Dropping one dimension from one option is reported by its JSON path."""
    card = copy.deepcopy(_card())
    _as_dict(_as_dict(card["options"])["B"]).pop(dimension)

    violations = _scorecard_violations(card, _REPO_ROOT)

    assert violations == [f"options.B.{dimension} is missing"]


def test_custody_scorecard_reports_a_missing_option() -> None:
    """Dropping a whole option is reported by name."""
    card = copy.deepcopy(_card())
    _as_dict(card["options"]).pop("E")

    assert "options.E is missing" in _scorecard_violations(card, _REPO_ROOT)


def test_custody_scorecard_never_invents_budget_or_staffing() -> None:
    """Money is unknown or the owner's; a pricing page is not a budget."""
    card = _card()
    for scored in _as_dict(card["options"]).values():
        for dimension in _MONEY_DIMENSIONS:
            assert _as_dict(scored)[dimension] == _UNKNOWN

    mutants = (
        {"value": "6.70", "source": "issue:#3066"},
        {"value": "6.70"},
        {"value": "6.70", "source": "draft-analysis"},
    )
    for mutant in mutants:
        laundered = copy.deepcopy(card)
        _as_dict(_as_dict(laundered["options"])["E"])["staffing"] = mutant
        assert any("options.E.staffing" in found for found in _money_violations(laundered))

    # An owner decision that is not a budget decision cannot launder a figure.
    misattributed = copy.deepcopy(card)
    owner_figure = {"value": "6.70", "source": "owner:2026-10-07#B12-premise"}
    _as_dict(_as_dict(misattributed["options"])["E"])["staffing"] = owner_figure
    assert any("options.E.staffing" in found for found in _money_violations(misattributed))

    # Control: once the owner records a budget anchor, a figure under it passes.
    assert _money_violations(misattributed, frozenset({"B12-premise"})) == []


def test_custody_scorecard_evidence_must_resolve() -> None:
    """A cited file or symbol that is not there is a violation."""
    root = _REPO_ROOT

    assert _source_violation("p", "repo:backend/tests/does_not_exist.py", root) is not None
    assert (
        _source_violation("p", "repo:backend/tests/test_journal_text_at_rest.py::test_nope", root)
        is not None
    )
    assert (
        _source_violation(
            "p", "repo:backend/tests/test_column_classification.py::_PLAINTEXT_COLUMNS", root
        )
        is None
    )
    assert _source_violation("p", "bogus:x", root) is not None
    assert _source_violation("p", "owner:2026-10-07#B12-premise", root) is None
    assert _source_violation("p", "owner:2026-10-07", root) is not None
    assert _source_violation("p", "owner:2026-10-07#B12-made-up", root) is not None
    assert _source_violation("p", "owner:2099-01-01#B12-premise", root) is not None
    assert _source_violation("p", "owner:draft-analysis", root) is not None


def test_every_owner_anchor_is_recorded_beside_its_decision() -> None:
    """Each citable owner anchor appears in ADR 0009, and the card's decision source is one."""
    text = _adr_text()

    for decided_on, anchors in _OWNER_DECISIONS.items():
        for anchor in anchors:
            assert f"owner:{decided_on}#{anchor}" in text
    assert _owner_anchor(_card()["decision_source"]) is not None


def test_custody_scorecard_cannot_be_accepted_without_signoff() -> None:
    """An accepted card with no decider, reviews or selection fails loudly."""
    card = copy.deepcopy(_card())
    card.update(
        decider="",
        decided_on="not-a-date",
        reviewers=[],
        selected_option=None,
        rejected=[],
        open_owner_questions=[],
    )

    joined = "\n".join(_scorecard_violations(card, _REPO_ROOT))

    for field in ("decider", "decided_on", "reviewers", "selected_option", "rejected"):
        assert field in joined
    assert "open_owner_questions" in joined


def test_custody_scorecard_rejects_incoherent_selection() -> None:
    """Selecting a rejected option, unlocking claims or losing the status quo all fail."""
    base = _card()

    self_rejected = copy.deepcopy(base)
    self_rejected["selected_option"] = "C"
    assert "selected_option also appears in rejected" in _selection_violations(self_rejected)

    claims = copy.deepcopy(base)
    claims["unlocks_public_claims"] = True
    assert any("unlocks_public_claims" in found for found in _selection_violations(claims))

    no_status_quo = copy.deepcopy(base)
    _as_dict(no_status_quo["options"]).pop("status_quo")
    assert "options.status_quo must describe HEAD" in _selection_violations(no_status_quo)


def test_custody_scorecard_review_entries_are_done_or_owed() -> None:
    """A review is either consulted with a name and date, or owed before a phase."""
    assert _review_violation(0, {"role": "appsec", "status": _REVIEW_OWED}) is not None
    assert (
        _review_violation(0, {"role": "appsec", "status": _REVIEW_CONSULTED, "name": "x"})
        is not None
    )
    assert _review_violation(0, {"status": _REVIEW_OWED, "required_before": "b"}) is not None
    consulted = {
        "role": "appsec",
        "status": _REVIEW_CONSULTED,
        "name": "x",
        "consulted_on": "2026-10-20",
    }
    assert _review_violation(0, consulted) is None
    assert (
        _review_violation(0, {"role": "r", "status": _REVIEW_OWED, "required_before": "b"}) is None
    )


# Questions the owner answered on 2026-10-07; none may linger as "open".
_ANSWERED_QUESTIONS = frozenset(
    {"RUNTIME", "WEB-ANCHOR", "SCOPE", "MIGRATION", "FEATURE-LOSS", "NATIVE", "BYOK-WEB"}
)


def test_recovery_is_the_owners_and_the_rest_of_d03_stays_open() -> None:
    """The owner chose the recovery factors; pairing and the rest of D03 stay open."""
    card = _card()
    selected = _as_dict(_as_dict(card["options"])[_SELECTED])
    questions = {_as_dict(entry).get("id") for entry in _as_list(card["open_owner_questions"])}

    assert _owner_anchor(_as_dict(selected["recovery"]).get("source")) == "followup-recovery"
    assert "D03" in questions
    assert questions.isdisjoint(_ANSWERED_QUESTIONS)


def test_owner_answers_are_recorded_as_decisions() -> None:
    """Each answered question is a numbered decision, and the runtime limit is honest."""
    text = _adr_text()
    decision = _flat(text[text.index("## Decision\n") : text.index("## Threat actors")])

    assert "not operator-blind while it runs" in decision
    assert "labelled clearly each time" in decision
    assert "nobody can enrol in user-held keys until the CSP and SRI work ships" in decision
    assert "proposed, not final" in decision
    scope = _as_dict(_card()["journal_scope_proposal"])
    assert scope.get("status") == "decided: owner:2026-10-07#followup-scope"


def test_phase_plan_puts_web_protection_first_and_labels_runtime_use() -> None:
    """Nobody can enrol before CSP and SRI ship, so phase (b) starts there."""
    text = _flat(_adr_text())
    phase_a = text[text.index("### Phase (a)") : text.index("### Phase (b)")]
    phase_b = text[text.index("### Phase (b)") : text.index("### Phase (c)")]

    assert "labelled on each use" in phase_a
    assert "First slice: enforce the CSP and add SRI" in phase_b
    assert phase_b.index("First slice") < phase_b.index("Generate keys on the device")


def test_custody_adr_names_enforcement_that_exists() -> None:
    """The symbols and config the record argues from are still real.

    If the CSP is ever enforced, the update-trust section is stale: rewrite it
    here rather than deleting the assertion.
    """
    text = _adr_text()
    nginx = _NGINX_CONF.read_text(encoding="utf-8")

    assert "JOURNAL_ENCRYPTION_KEYS" in text
    assert je.KEYS_ENV_VAR == "JOURNAL_ENCRYPTION_KEYS"
    assert "EncryptedString" in text
    assert EncryptedString.__module__ == "services.journal_encryption"
    assert "Content-Security-Policy-Report-Only" in text
    assert "add_header Content-Security-Policy-Report-Only" in nginx
    assert re.search(r"add_header Content-Security-Policy\s+\"", nginx) is None
    assert "Creek-Vault ADR 0014" in text


def test_custody_adr_cites_pinning_tests_that_exist() -> None:
    """Each test the record leans on is named in it and defined where it says."""
    text = _adr_text()
    tests_dir = Path(__file__).resolve().parent
    for module, names in _PINNING_TESTS.items():
        source = (tests_dir / module).read_text(encoding="utf-8")
        for name in names:
            assert name in text
            assert re.search(rf"^(?:async )?def {name}\(", source, re.MULTILINE)


def _journal_scope() -> tuple[frozenset[str], frozenset[str]]:
    """The scorecard's SCOPE proposal: (in-scope journal columns, proposed out of scope)."""
    scope = _as_dict(_card()["journal_scope_proposal"])
    in_scope = frozenset(str(name) for name in _as_list(scope.get("in_scope")))
    out_of_scope = frozenset(str(name) for name in _as_list(scope.get("proposed_out_of_scope")))
    return in_scope, out_of_scope


def _in_scope_targets() -> list[EncryptedColumn]:
    """The in-scope journal columns, as the encryption inventory names them."""
    in_scope, _ = _journal_scope()
    return [target for target in encrypted_columns() if target.qualified in in_scope]


def test_journal_scope_proposal_classifies_every_encrypted_column() -> None:
    """Every EncryptedString column is proposed in or out of the premise; none is unclassified."""
    in_scope, out_of_scope = _journal_scope()
    schema = {target.qualified for target in encrypted_columns()}

    assert in_scope.isdisjoint(out_of_scope)
    assert in_scope | out_of_scope == schema
    assert len(in_scope) >= _MIN_IN_SCOPE_JOURNAL_COLUMNS


def test_custody_codec_has_no_per_principal_key() -> None:
    """Baseline: every in-scope journal column is still under the server-key codec.

    This is the structural custody baseline ADR 0009 must invert, checked on
    the schema rather than on prose. It holds while every in-scope journal
    column is typed ``EncryptedString``, the codec takes no per-person key, and
    ``EncryptedString`` adds no constructor of its own (so no owner can be
    bound to a column). Its companion,
    ``test_server_env_keys_alone_recover_every_in_scope_journal_column``,
    proves on a real database that the env keys alone recover each column.

    It is **expected to fail by design** when B13 (#3067) phase (c) moves a
    journal column to client-held ciphertext, or gives the codec a per-person
    key. When it fails for that reason, replace it with the inverted assertion
    and update ADR 0009's Context and Reopen triggers in the same change. Do
    not delete it to make the suite pass.
    """
    in_scope, _ = _journal_scope()
    under_server_codec = {target.qualified for target in encrypted_columns()}

    assert sorted(in_scope - under_server_codec) == []
    assert list(inspect.signature(je.encrypt).parameters) == ["plaintext"]
    assert list(inspect.signature(je.decrypt).parameters) == ["value"]
    assert "__init__" not in vars(EncryptedString)
    assert je.KEYS_ENV_VAR == "JOURNAL_ENCRYPTION_KEYS"


@pytest.mark.asyncio
@pytest.mark.parametrize("target", _in_scope_targets(), ids=lambda target: target.qualified)
async def test_server_env_keys_alone_recover_every_in_scope_journal_column(
    db_session: AsyncSession, target: EncryptedColumn, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Baseline: with only ``JOURNAL_ENCRYPTION_KEYS``, the server reads the journal.

    A synthetic canary is written through the ORM. The raw stored bytes are
    then read and decrypted with nothing but the env key, after the key cache
    is dropped. That is the operator's power over stored journal prose today.
    Like the codec test above, this **fails by design** when B13 phase (c)
    lands: client-held ciphertext no longer opens under the env key alone.
    """
    canary = f"custody canary for {target.qualified}"
    monkeypatch.setenv(je.KEYS_ENV_VAR, Fernet.generate_key().decode())
    je.reset_cache()
    try:
        row_id = await insert_row(db_session, target.table, lambda _column: canary)
        await db_session.commit()
        raw = raw_table(target)
        stored = (
            await db_session.execute(
                select(raw.c[target.column]).where(raw.c[ROW_ID_COLUMN] == row_id)
            )
        ).scalar_one()
        je.reset_cache()

        assert isinstance(stored, str)
        assert canary not in stored
        assert je.decrypt(stored) == canary
    finally:
        je.reset_cache()


@pytest.mark.parametrize("option", ["status_quo", "A", "E"])
def test_custody_adr_states_provider_managed_is_not_operator_blind(option: str) -> None:
    """Wherever the status quo or an operator-trusted option is described, it says so."""
    text = _adr_text()

    assert _NOT_OPERATOR_BLIND in _option_slice(text, option)
    assert "#3076" in text
    assert _card()["unlocks_public_claims"] is False


@pytest.mark.parametrize(("filename", "kept"), sorted(_AMENDED_ADRS.items()))
def test_non_compliant_adrs_carry_the_amendment_without_rewriting_history(
    filename: str, kept: str
) -> None:
    """ADR 0002 and 0007 are amended by an appended section; the original stands."""
    text = (_ADR_DIR / filename).read_text(encoding="utf-8")
    amendment = text[text.index(_AMENDMENT_HEADING) :]

    assert kept in text
    assert text.index(kept) < text.index(_AMENDMENT_HEADING)
    assert "0009-privacy-custody-and-inference-architecture.md" in amendment


def test_adr_0007_amendment_keeps_the_status_quo_phrase() -> None:
    """The amended managed-vault record still describes ordinary Fly truthfully."""
    text = (_ADR_DIR / "0007-demand-provisioned-confidential-vaults.md").read_text(encoding="utf-8")

    assert _NOT_OPERATOR_BLIND in _flat(text[text.index(_AMENDMENT_HEADING) :])


def test_implementation_plan_has_four_independently_shippable_phases() -> None:
    """Phases (a)-(d) are in the record, in order, and mirrored in the twin."""
    text = _adr_text()
    plan = text[text.index("## Implementation plan") :]
    phases = [_as_dict(entry).get("id") for entry in _as_list(_card()["phases"])]

    assert _PHASE_HEADING.findall(plan) == list(_PHASE_IDS)
    assert phases == list(_PHASE_IDS)
    assert plan.count("Shippable on its own:") >= len(_PHASE_IDS)


def test_b13_epic_draft_exists_and_points_at_the_record() -> None:
    """The drafted epic body for #3067 is on disk for the owner to post."""
    draft = _EPIC_DRAFT.read_text(encoding="utf-8")

    assert "0009-privacy-custody-and-inference-architecture.md" in draft
    assert "test_custody_codec_has_no_per_principal_key" in draft


def test_custody_adr_records_the_server_proxied_byok_gap() -> None:
    """Under the premise, BYOK goes device-to-vendor; today it is relayed, so say so.

    While the client still sends the person's key to our server in the
    ``X-LLM-API-Key`` header, the record must name that relay as a known gap
    and phase (a) must require the client-direct path. When phase (a) retires
    the header, this fails: rewrite the gap note as closed, here and in ADR
    0009, in the same change.
    """
    text = _flat(_adr_text())
    client = (_REPO_ROOT / "frontend" / "src" / "api" / "index.ts").read_text(encoding="utf-8")
    phase_a = _flat(text[text.index("### Phase (a)") : text.index("### Phase (b)")])

    assert "'X-LLM-API-Key'" in client
    assert "Known gap until phase (a) lands" in text
    assert "BYOK calls go from the person's device straight to the vendor" in text
    assert "Move BYOK inference client-side" in phase_a
    assert "no `X-LLM-API-Key` header" in phase_a


def test_claim_scoping_has_no_stored_versus_future_split_for_active_attackers() -> None:
    """A captured user-held key opens all stored history, not only future content.

    So no platform may sell stored history as safe from the operator or the
    update channel while future content carries the caveat.
    """
    text = _adr_text()
    section = text[text.index("## Per-platform claim scoping") : text.index("## Client delivery")]
    flat = _flat(section)

    assert "| Future content |" not in section
    assert "stop at stored history" not in flat
    assert "stored history and future content alike" in flat
    assert "Protected **only while the signed build is honest**" in flat


def test_every_open_owner_question_is_listed_in_the_record() -> None:
    """The twin's open questions and the record's list agree, so none is hidden."""
    text = _adr_text()
    section = text[text.index("## Open owner questions") : text.index("## What this record")]
    listed = set(re.findall(r"^- \*\*([A-Z0-9-]+):\*\*", section, re.MULTILINE))
    questions = {_as_dict(entry).get("id") for entry in _as_list(_card()["open_owner_questions"])}

    assert listed == questions


def test_decision_three_does_not_invent_byok_consent_granularity() -> None:
    """The owner decided BYOK-only cloud; consent granularity is a proposal, not a decision."""
    text = _adr_text()
    decision = _flat(text[text.index("## Decision\n") : text.index("## Threat actors")])

    assert "per-feature opt-in" not in decision
    assert "BYOK-CONSENT" in decision


# A custody word that, said flatly in the present tense, is a claim nothing
# yet supports. Each may appear only in a sentence that negates it or scopes
# it to a target, a condition or a future.
_CUSTODY_CLAIM = re.compile(
    r"operator-blind|end-to-end|\bE2EE\b|already user-held|cannot read it", re.IGNORECASE
)
_SCOPING_MARKER = re.compile(
    r"\b(?:not|no|never|neither|nor|until|unless|once|will|would|if|whether|"
    r"target|decided|must|only while|stop|stops)\b",
    re.IGNORECASE,
)


def _unscoped_custody_claims(text: str) -> list[str]:
    """Sentences that state a custody property flatly, with no negation or scope."""
    blocks = re.split(r"\n\s*\n|\n(?=\s*(?:[-*] |#))|\|", text)
    sentences = [
        sentence for block in blocks for sentence in re.split(r"(?<=[.;!?])\s+", _flat(block))
    ]
    return [
        sentence
        for sentence in sentences
        if _CUSTODY_CLAIM.search(sentence) and not _SCOPING_MARKER.search(sentence)
    ]


def _amendment_sections() -> dict[str, str]:
    """The appended ADR 0009 amendment of each amended local record."""
    sections: dict[str, str] = {}
    for filename in _AMENDED_ADRS:
        text = (_ADR_DIR / filename).read_text(encoding="utf-8")
        sections[filename] = text[text.index(_AMENDMENT_HEADING) :]
    return sections


def _scorecard_prose(card: dict[str, object]) -> str:
    """Every scored value in the twin, joined, so the scan covers JSON too."""
    return "\n".join(
        str(_as_dict(cell).get("value", ""))
        for scored in _as_dict(card.get("options")).values()
        for cell in _as_dict(scored).values()
    )


def test_no_affirmative_present_tense_custody_claim() -> None:
    """ADR 0009, its twin and the amendments never state a custody property flatly."""
    documents = {"0009": _adr_text(), "scorecard": _scorecard_prose(_card())}
    documents.update(_amendment_sections())

    found = {name: _unscoped_custody_claims(text) for name, text in documents.items()}

    assert {name: hits for name, hits in found.items() if hits} == {}


def test_the_custody_claim_scan_bites() -> None:
    """A flat claim is caught; a negated or scoped one is not."""
    assert _unscoped_custody_claims("Adepthood is operator-blind.") != []
    assert _unscoped_custody_claims("Journal content is already user-held.") != []
    assert _unscoped_custody_claims("Ordinary Fly is not operator-blind.") == []
    assert _unscoped_custody_claims("It is operator-blind once phase (c) lands.") == []


def test_adr_0007_amendment_adds_no_condition_for_lifting_intimate_skip_only() -> None:
    """ADR 0002 Decision 1 is unchanged, so the 0007 amendment may not reopen INTIMATE.

    Whether device-side inference may ever touch INTIMATE is an open owner
    question in ADR 0009, not a decided path.
    """
    text = (_ADR_DIR / "0007-demand-provisioned-confidential-vaults.md").read_text(encoding="utf-8")
    amendment = _flat(text[text.index(_AMENDMENT_HEADING) :])
    questions = {_as_dict(entry).get("id") for entry in _as_list(_card()["open_owner_questions"])}

    assert "skip-only for inference until" not in amendment
    assert "adds no condition for lifting it" in amendment
    assert "INTIMATE-DEVICE" in questions


def test_removal_inventory_names_the_real_derived_plaintext() -> None:
    """The derived-plaintext inventory is the registry's members, not a paraphrase.

    ``DERIVED_FROM_PROSE`` holds no "detected facts"; completion detection
    output (``completionsuggestion.completed_units`` and ``completed_on``) is a
    separate, non-textual derived store and must be listed on its own.
    """
    text = _flat(_adr_text())
    removal = text[text.index("## Primary-copy and derivative removal") :]
    removal = removal[: removal.index("## Migration of existing")]
    registry = (_REPO_ROOT / "backend" / "tests" / "test_column_classification.py").read_text(
        encoding="utf-8"
    )
    group = registry[registry.index('"DERIVED_FROM_PROSE": frozenset(') :]
    members = re.findall(r'"([a-z_]+\.[a-z_]+)"', group[: group.index(")")])

    assert members
    assert "detected facts" not in text
    assert [member for member in members if f"`{member}`" not in removal] == []
    assert "`completionsuggestion.completed_units`" in removal
    assert "`completionsuggestion.completed_on`" in removal


def test_selected_primary_copy_removal_matches_the_scope_split() -> None:
    """BD's removal cell names the in-scope count, not all 18 columns.

    Feedback and the stored vault credential are proposed out of scope, so a
    cell promising to remove "all 18" contradicts the scope it sits beside.
    """
    cell = str(_as_dict(_as_dict(_as_dict(_card()["options"])[_SELECTED])["primary_copy_removal"]))
    in_scope, _ = _journal_scope()

    assert "All 18" not in cell
    assert f"{len(in_scope)} in-scope" in cell


def test_b13_epic_draft_lists_exactly_the_open_owner_questions() -> None:
    """The drafted epic carries the same open questions as the twin, no stale ones."""
    draft = _EPIC_DRAFT.read_text(encoding="utf-8")
    section = draft[draft.index("## Open owner questions") : draft.index("## Dependencies")]
    listed = set(re.findall(r"^- \*\*([A-Z0-9-]+):\*\*", section, re.MULTILINE))
    questions = {_as_dict(entry).get("id") for entry in _as_list(_card()["open_owner_questions"])}

    assert listed == questions


def test_decisions_three_and_four_scope_the_cloud_rule_and_name_the_app_key_gap() -> None:
    """Today the app's own key pays when no BYOK key is sent, so the rule is a target.

    ``_resolve_api_key`` falls back to the server ``LLM_API_KEY`` when no
    BYOK key is supplied. While it does, the record must state the cloud rule
    as the decided target and name the fallback as a known gap that phase (a)
    closes with #3096.
    """
    text = _flat(_adr_text())
    decision = text[text.index("## Decision ") : text.index("## Threat actors")]
    botmason = (_REPO_ROOT / "backend" / "src" / "services" / "botmason.py").read_text(
        encoding="utf-8"
    )

    assert "return _get_llm_api_key()" in botmason
    assert "The app's own cloud key never carries" not in decision
    assert "Without such a key, **none of their data reaches a cloud model**" not in decision
    assert "Known gap until phase (a) lands, with #3096: the app-key fallback" in decision
