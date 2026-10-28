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
from tests.support.encrypted_rows import insert_row, stored_plaintext

_REPO_ROOT = Path(__file__).resolve().parents[2]
_ADR_DIR = _REPO_ROOT / "docs" / "adr"
_ADR = _ADR_DIR / "0009-privacy-custody-and-inference-architecture.md"
_SCORECARD = _ADR_DIR / "0009-architecture-scorecard.json"
_EPIC_DRAFT = _ADR_DIR / "0009-b13-epic-draft.md"
_NGINX_CONF = _REPO_ROOT / "frontend" / "nginx.conf"
_SRI_SCRIPT = _REPO_ROOT / "frontend" / "web-hardening" / "sri.js"
# The server level, which locations without their own headers inherit, and
# ``location = /index.html``, which sets its own and so must repeat it.
_CSP_HEADER_SITES = 2

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
    # The owner's 2026-10-20 amendment, recorded on Creek-Vault#1849: a
    # vendor-attested inference runtime is admitted under Creek-Vault ADR-0016
    # Decision 3, and D05 reopens for the inference leg alone.
    "2026-10-20": frozenset({"attested-inference-pool"}),
    # The owner's 2026-10-21 decisions, recorded on Creek-Vault#1896: the
    # vendor is Privatemode, Decision 3.3 condition (f) is waived on
    # vendor-asserted evidence, and (c) and (e) are waived with substitutes.
    "2026-10-21": frozenset({"attested-vendor-and-waivers"}),
    # The owner's 2026-10-27 release decision R5-1: the four independent
    # reviews stop being phase gates. They are still not done, so nothing may
    # claim they were.
    "2026-10-27": frozenset({"reviewer-gates-waived"}),
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

# The owner's 2026-10-20 amendment (Creek-Vault#1849), which Creek-Vault ADR-0016
# Decision 0 Q1 specifies and whose merge its Status clause waits on. The
# wording is pinned because the amendment is a privacy-posture change: a
# paraphrase that widened it would pass a looser assertion.
_AMENDMENT_ANCHOR = "owner:2026-10-20#attested-inference-pool"
_ATTESTED_EXCEPTION = (
    "a vendor-attested runtime verified under Creek-Vault ADR-0016 Decision 3 may be reached "
    "with the app's own credential, because the vendor cannot read what it carries"
)
_ATTESTED_CREDIT_PAYEE = (
    "managed no-retention runtime we run, or a vendor-attested runtime verified under "
    "Creek-Vault ADR-0016 Decision 3"
)
_ATTESTED_LABEL = "processed in an attested private enclave run by `<vendor>`, not stored"
# The conditions the owner waived, and nothing else. (c) and (e) are the pair
# Creek-Vault ADR-0016 Decision 3.3 says a vendor cannot meet, unmeetable under
# O5 by construction; (f) is meetable in principle and unverified in fact, so
# it is waived in a different sense, on vendor-asserted evidence -- see below.
# Every other condition is kept, not applicable, or added for a vendor, so a
# fourth entry here is a widening. Shrinking this dict un-waives a condition
# the owner waived on 2026-10-21, which is the direction that is wrong.
_D05_WAIVERS = {
    "c": "nonce freshness",
    "e": "a hostile-host lab",
    "f": "reproducible builds",
}
# The substitutes the owner named for the two structural waivers, in the
# owner's own words on Creek-Vault#1896. They are load-bearing: a waiver
# recorded without its substitute is a blank cheque, so each is pinned.
# The 2026-10-20 half waived only the structural pair; (f) joined on
# 2026-10-21, so the first amendment entry is held to the pair it recorded.
_STRUCTURAL_WAIVERS = {"c": "nonce freshness", "e": "a hostile-host lab"}
_D05_SUBSTITUTES = {
    "c": "the vendor's binding of the attested measurement to the live session key",
    "e": "T18's negative tests",
}
_VENDOR_ANCHOR = "owner:2026-10-21#attested-vendor-and-waivers"
# A waiver that outlives the vendor it was granted for is the quiet way to end
# up in another jurisdiction: the owner chose Bochum, and a successor swapping
# in a US vendor would keep the waivers and discard the reason for them.
_VENDOR_BINDING = (
    "apply to **Privatemode, operated by Edgeless Systems GmbH, and to no other vendor**"
)
# Which side opens the connection. If this is left implicit, a server-side call
# to the vendor reads as admitted, and the premise of item 1 depends on it not
# being.
_VAULT_DIALS = "**The vault dials the vendor, not our server.**"
# The wording this amendment exists to replace. It said condition (f) was an
# open blocker, which is the opposite of what the owner decided, and it was one
# review away from merging. The record refuses to accept it back.
_PRE_DECISION_WORDING = re.compile(
    r"open blocker|until it is verified|third waiver|has not verified \(f\) for either",
    re.IGNORECASE,
)
# The decided D05 paragraph, which the amendment appends to rather than
# rewrites. Pinned verbatim from the 2026-10-07 record.
_D05_AS_DECIDED = (
    "D05 is not pursued. C is rejected for now (see below). It reopens only if "
    "the owner sets an operator-blind target for the managed runtime's processing."
)
# Any `**(x) ...: waived**` heading, in any case and with or without the stop,
# so a fourth waiver cannot slip in by not matching the house format.
_WAIVER_HEADING = re.compile(r"\*\*\(([a-h])\)[^*]*?:\s*waived\.?\*\*", re.IGNORECASE)
# The vendor, its operator and its jurisdiction, which condition (h) requires
# to be chosen explicitly rather than inherited from a default.
_VENDOR_FACTS = (
    "Privatemode",
    "Edgeless Systems GmbH",
    "Bochum",
    "Germany",
)
# A waiver of independent verification is not a claim that verification
# happened, and the owner required every dependent artifact to say so.
_VENDOR_ASSERTED = "vendor-asserted"
_NOT_VERIFIED = "not a claim that verification happened"
# Decision 5 of Creek-Vault ADR-0016 is untouched by this amendment, and the
# route that would be easiest to forget is the router's own rescue target.
_INTIMATE_OFF_THE_POOL = (
    "INTIMATE content never reaches the pool, by any route, including the `default` rescue path"
)

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

    Phase (b)'s first slice made the web CSP enforced and added SRI, so the
    record says so in the present tense and nowhere still calls it report-only.
    If either is ever rolled back, the update-trust section is stale again:
    rewrite it here rather than deleting the assertion.
    """
    text = _adr_text()
    nginx = _NGINX_CONF.read_text(encoding="utf-8")

    assert "JOURNAL_ENCRYPTION_KEYS" in text
    assert je.KEYS_ENV_VAR == "JOURNAL_ENCRYPTION_KEYS"
    assert "EncryptedString" in text
    assert EncryptedString.__module__ == "services.journal_encryption"
    assert "Content-Security-Policy-Report-Only" not in nginx
    assert len(re.findall(r"add_header Content-Security-Policy\s+\"", nginx)) >= _CSP_HEADER_SITES
    assert "Content-Security-Policy-Report-Only" not in text
    assert "report-only today" not in text
    assert "sends an enforced `Content-Security-Policy`" in _flat(text)
    assert _SRI_SCRIPT.is_file()
    assert "frontend/web-hardening/sri.js" in text
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


def _server_codec_column(qualified: str) -> EncryptedColumn | None:
    """The inventory entry for ``table.column`` if it is under the server codec, else None."""
    return next((target for target in encrypted_columns() if target.qualified == qualified), None)


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
@pytest.mark.parametrize("qualified", sorted(_journal_scope()[0]))
async def test_server_env_keys_alone_recover_every_in_scope_journal_column(
    db_session: AsyncSession, qualified: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Baseline: with only ``JOURNAL_ENCRYPTION_KEYS``, the server reads the journal.

    A synthetic canary is written through the ORM. The raw stored bytes are
    then read and decrypted with nothing but the env key, after the key cache
    is dropped. That is the operator's power over stored journal prose today.
    Like the codec test above, this **fails by design** when B13 phase (c)
    lands: client-held ciphertext no longer opens under the env key alone.
    """
    # Parametrized over the scorecard's own names, not the inventory, so a
    # column that leaves the server codec fails here instead of vanishing
    # from the parametrization.
    target = _server_codec_column(qualified)
    assert target is not None, f"{qualified} is no longer under the server-key codec"
    canary = f"custody canary for {qualified}"
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
        assert je.decrypt(stored) == stored_plaintext(target, canary)
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
    # The relay path, named hop by hop: the header is validated, then the
    # vendor call resolves the key and dials the provider from the server.
    assert "`resolve_chat_api_key` (validates and returns the key)" in text
    assert "`_resolve_api_key`" in text
    assert "`_call_openai` / `_call_anthropic`" in text
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


# The present-tense custody-claim tripwire. A HEURISTIC, not a proof: it
# catches the phrasings this record family has actually used to overclaim and
# the plain-English forms a reviewer would read as a promise, sentence by
# sentence. A determined writer can still phrase around it; review remains
# the real check. Only an anchored scope (the decided target or a named phase)
# excuses a sentence; bare future or conditional words do not.
#
# "user-held" counts when predicated of something ("keys are user-held"); the
# attributive "the user-held key" names the design rather than asserting it.
# Affirmative custody terms. A sentence using one is excused by an explicit
# target or condition marker, or by a negation directly in front of the term
# ("is not operator-blind"), never by a stray "no" elsewhere in the sentence.
_AFFIRMATIVE_CLAIM = re.compile(
    r"operator-blind|end-to-end|end to end|\bE2EE\b|\b(?:is|are|already)\s+user-held\b",
    re.IGNORECASE,
)
# Custody claims that carry their own negation or exclusivity ("cannot read",
# "never relayed", "the only way ... reaches"). A preceding "not" cannot
# excuse these, because that word is the claim; only an anchored scope can.
_NEGATIVE_FORM_CLAIM = re.compile(
    r"\bcan(?:not|'t) (?:read|decrypt|see)\b|\bnever carr(?:y|ies)\b|"
    r"\bnone of (?:their|your|the person's) data reaches\b|\bnever reach(?:es)?\b|"
    r"\bnever pass(?:es)? through\b|\bholds? no (?:key|escrow)\b|\bnever relayed\b|"
    r"\bnever sees?\b|\bhas no access\b|\bnobody\b.{0,40}?\bcan read\b|"
    r"\bonly\W+way\b.{0,60}?\breach(?:es)?\b|\bfunds? only non-cloud\b",
    re.IGNORECASE,
)
# Anchored scope: the sentence names the decided target or a named phase.
# Unanchored "will", "if", "once", "would", "could" and "unless" do not
# count, because they excuse a flat claim from anywhere in the sentence
# ("Adepthood is operator-blind, if you ask us").
_ANCHORED_SCOPE = re.compile(
    r"\b(?:under the decision|under the target|target|decided|until phase|"
    r"once phase|once B13|when B13|not yet|not implemented)\b",
    re.IGNORECASE,
)
# A negation that governs the affirmative term right after it, allowing up to
# three words between ("is not described as operator-blind").
_NEGATION_BEFORE = re.compile(r"\b(?:not|never|no|neither|nor)\b(?:\W+\w+){0,3}\W*$", re.IGNORECASE)
# A double-quoted span is a mention only when a mention verb or noun stands
# just before it (allowing a short list of quoted terms), as in: before any
# copy says "end-to-end" or "operator-blind". A bare quote is still a claim:
# We are "operator-blind".
_QUOTED = re.compile(r'"[^"]*"')
_MENTION_BEFORE = re.compile(
    r"\b(?:says?|said|saying|phrase|term|terms|word|words|claim|claims|call|called|"
    r"advertise|advertises|label|labelled)\b(?:\W+\w+){0,4}\W*$",
    re.IGNORECASE,
)


# A sentence ends at terminal punctuation, including inside bold markup, so a
# bold heading cannot borrow the scope of the sentence after it.
_SENTENCE_END = re.compile(r"(?<=[.;!?])\s+|(?<=[.;!?]\*\*)\s+")


def _sentences(text: str) -> list[str]:
    """Split prose, bullets and table cells into sentences, each flattened."""
    blocks = re.split(r"\n\s*\n|\n(?=\s*(?:[-*] |#))|\|", text)
    return [sentence for block in blocks for sentence in re.split(_SENTENCE_END, _flat(block))]


def _without_mentions(sentence: str) -> str:
    """``sentence`` with each quoted span that is a mention replaced by ``Q``."""
    out = ""
    cursor = 0
    for match in _QUOTED.finditer(sentence):
        prefix = out + sentence[cursor : match.start()]
        mention = _MENTION_BEFORE.search(prefix) is not None
        out = prefix + ("Q" if mention else match.group(0))
        cursor = match.end()
    return out + sentence[cursor:]


def _affirmative_is_negated(sentence: str) -> bool:
    """Whether every affirmative custody term is directly preceded by a negation."""
    return all(
        _NEGATION_BEFORE.search(sentence[: match.start()])
        for match in _AFFIRMATIVE_CLAIM.finditer(sentence)
    )


def _is_unscoped_claim(sentence: str) -> bool:
    """Whether ``sentence`` states custody with no anchored scope or governing negation."""
    if _ANCHORED_SCOPE.search(sentence):
        return False
    if _NEGATIVE_FORM_CLAIM.search(sentence):
        return True
    return bool(_AFFIRMATIVE_CLAIM.search(sentence)) and not _affirmative_is_negated(sentence)


def _unscoped_custody_claims(text: str) -> list[str]:
    """Sentences that state a custody property flatly (heuristic; see above)."""
    return [
        sentence for sentence in _sentences(text) if _is_unscoped_claim(_without_mentions(sentence))
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
    """ADR 0009, its twin, the amendments and the B13 draft never state custody flatly."""
    documents = {
        "0009": _adr_text(),
        "scorecard": _scorecard_prose(_card()),
        "b13-draft": _EPIC_DRAFT.read_text(encoding="utf-8"),
    }
    documents.update(_amendment_sections())

    found = {name: _unscoped_custody_claims(text) for name, text in documents.items()}

    assert {name: hits for name, hits in found.items() if hits} == {}


# The surfaces a reader actually sees a custody claim on (#3264): the public
# policy and terms, and the copy compiled into the app. App copy is read as the
# string literals of non-test TypeScript; comments are matched so they are
# skipped, since a comment is never shown to anyone.
_LEGAL_DOCUMENTS = ("privacy-policy.md", "terms-of-service.md")
_TS_SOURCE_SUFFIXES = (".ts", ".tsx")
_TS_LITERAL = re.compile(
    r"//[^\n]*|/\*.*?\*/"
    r"|'(?P<single>(?:\\.|[^'\\\n])*)'"
    r'|"(?P<double>(?:\\.|[^"\\\n])*)"'
    r"|`(?P<template>(?:\\.|[^`\\])*)`",
    re.DOTALL,
)


def _ts_string_literals(source: str) -> str:
    """Each string literal in ``source``, one block per literal, newline escapes decoded."""
    bodies = (
        next(body for body in match.group("single", "double", "template") if body is not None)
        for match in _TS_LITERAL.finditer(source)
        if match.lastgroup is not None
    )
    return "\n\n".join(body.replace("\\n", "\n") for body in bodies)


def _is_app_source(path: Path) -> bool:
    """Whether ``path`` is shipped TypeScript rather than a test."""
    return (
        path.suffix in _TS_SOURCE_SUFFIXES
        and "__tests__" not in path.parts
        and ".test." not in path.name
    )


def _surface_documents(root: Path) -> dict[str, str]:
    """The policy, the terms and each app source file's literals, named by repo path."""
    documents = {
        f"docs/legal/{name}": (root / "docs" / "legal" / name).read_text(encoding="utf-8")
        for name in _LEGAL_DOCUMENTS
    }
    for path in sorted((root / "frontend" / "src").rglob("*")):
        if _is_app_source(path):
            source = path.read_text(encoding="utf-8")
            documents[path.relative_to(root).as_posix()] = _ts_string_literals(source)
    return documents


def test_no_unscoped_custody_claim_in_the_policy_terms_or_app_copy() -> None:
    """The privacy policy, the terms and the app's copy never state custody flatly."""
    documents = _surface_documents(_REPO_ROOT)

    found = {name: _unscoped_custody_claims(text) for name, text in documents.items()}

    assert any(name.startswith("frontend/src/") for name in documents)
    assert {name: hits for name, hits in found.items() if hits} == {}


_PLANTED_POLICY = (
    "## Your journal\n\nYour entries are encrypted at rest.\n"
    "Adepthood is operator-blind, so\nwe cannot help you recover them.\n"
)
_PLANTED_TS = (
    "// Adepthood is operator-blind -- a comment, never shown.\n"
    "export const COPY =\n"
    "  'Your journal stays yours.\\n' +\n"
    '  "Adepthood is operator-blind.";\n'
)


def test_the_surface_scan_reads_each_new_source(tmp_path: Path) -> None:
    """A planted claim in the policy, the terms or an app literal is reported by file."""
    legal = tmp_path / "docs" / "legal"
    legal.mkdir(parents=True)
    (legal / "privacy-policy.md").write_text(_PLANTED_POLICY, encoding="utf-8")
    (legal / "terms-of-service.md").write_text(
        "Journal keys are user-held today.\n", encoding="utf-8"
    )
    tests_dir = tmp_path / "frontend" / "src" / "features" / "__tests__"
    tests_dir.mkdir(parents=True)
    (tests_dir.parent / "copy.ts").write_text(_PLANTED_TS, encoding="utf-8")
    (tests_dir / "copy.test.ts").write_text("'Adepthood is operator-blind.';\n", encoding="utf-8")
    (tests_dir.parent / "Screen.test.tsx").write_text(
        "'Adepthood is operator-blind.';\n", encoding="utf-8"
    )

    found = {
        name: _unscoped_custody_claims(text) for name, text in _surface_documents(tmp_path).items()
    }

    assert {name: hits for name, hits in found.items() if hits} == {
        "docs/legal/privacy-policy.md": [
            "Adepthood is operator-blind, so we cannot help you recover them."
        ],
        "docs/legal/terms-of-service.md": ["Journal keys are user-held today."],
        "frontend/src/features/copy.ts": ["Adepthood is operator-blind."],
    }


# Planted violations: each is a flat claim the scan must catch. The first
# three are the reviewers' own bypass examples.
_PLANTED_CLAIMS = (
    "Adepthood is end-to-end encrypted, with no operator escrow.",
    "Managed vault journal content is end-to-end encrypted, not provider-readable.",
    "The operator cannot read stored journal entries.",
    "The app's own cloud key never carries a person's journal content.",
    "Without such a key, none of their data reaches a cloud model.",
    "Adepthood's server holds no key that can read a journal entry.",
    "Your writing never reaches a cloud model.",
    "We can't see your journal.",
    "The journal is encrypted end to end.",
    "Adepthood is operator-blind.",
    "Journal content is already user-held.",
    # Round-3 bypasses: bare user-held, unanchored will/if, quoting a claim,
    # and the relay, exclusivity and credits phrasings.
    "Journal keys are user-held today.",
    "Adepthood is operator-blind, so we will never see it.",
    "Adepthood is operator-blind, if you ask us.",
    'We are "operator-blind".',
    "BYOK plaintext is never relayed by our server.",
    "It is the only way any of a person's content reaches a cloud model.",
    "Credits fund only non-cloud inference.",
)
# Scoped or negated statements the scan must let through.
_SCOPED_STATEMENTS = (
    "Ordinary Fly is not operator-blind.",
    "Provider-managed custody is not operator-blind.",
    "Under the decision, the app's own cloud key will never carry journal content.",
    "Once phase (c) lands, the operator cannot decrypt stored content.",
    "It is decided to become user-held.",
    "Keys are not user-held yet.",
    "Neither is operator-blind during processing.",
    'No copy may say "operator-blind" before B24 certifies it.',
)


@pytest.mark.parametrize("sentence", _PLANTED_CLAIMS)
def test_the_custody_claim_scan_catches_a_planted_claim(sentence: str) -> None:
    """Each planted flat claim is reported."""
    assert _unscoped_custody_claims(sentence) == [sentence]


@pytest.mark.parametrize("sentence", _SCOPED_STATEMENTS)
def test_the_custody_claim_scan_lets_scoped_statements_through(sentence: str) -> None:
    """A statement scoped to a target or condition, or directly negated, passes."""
    assert _unscoped_custody_claims(sentence) == []


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


def _removal_section() -> str:
    """The flattened ``## Primary-copy and derivative removal`` section."""
    text = _flat(_adr_text())
    removal = text[text.index("## Primary-copy and derivative removal") :]
    return removal[: removal.index("## Migration of existing")]


def _removal_item(removal: str, start: str, end: str) -> str:
    """The slice of the removal section from ``start`` up to ``end``."""
    item = removal[removal.index(start) :]
    return item[: item.index(end)]


def _named_columns(text: str) -> set[str]:
    """Every backticked ``table.column`` (or ``table.*``) in ``text``, file names aside."""
    names = re.findall(r"`([a-z_]+\.(?:[a-z_]+|\*))`", text)
    return {name for name in names if not name.endswith(".py")}


def _derived_from_prose_registry() -> set[str]:
    """The ``DERIVED_FROM_PROSE`` members of ``_PLAINTEXT_COLUMNS``, read from source."""
    registry = (_REPO_ROOT / "backend" / "tests" / "test_column_classification.py").read_text(
        encoding="utf-8"
    )
    group = registry[registry.index('"DERIVED_FROM_PROSE": frozenset(') :]
    return set(re.findall(r'"([a-z_]+\.[a-z_]+)"', group[: group.index(")")]))


def _covered(column: str, names: set[str]) -> bool:
    """True when ``column`` is named exactly or by its table's ``table.*`` wildcard."""
    return column in names or f"{column.partition('.')[0]}.*" in names


def test_removal_inventory_names_the_real_derived_plaintext() -> None:
    """The derived-plaintext inventory is exactly the registry's members, not a paraphrase.

    Two-way: every ``DERIVED_FROM_PROSE`` member is listed in item 2, and item 2
    lists nothing that has left the registry (as the embedding and vault tags
    did when #3263 encrypted them). ``DERIVED_FROM_PROSE`` holds no "detected
    facts"; completion detection output (``completionsuggestion.completed_units``
    and ``completed_on``) is a separate, non-textual derived store and must be
    listed on its own.
    """
    removal = _removal_section()
    item_two = _removal_item(
        removal, "2. **`DERIVED_FROM_PROSE` plaintext**", "3. **Completion detection output.**"
    )
    members = _derived_from_prose_registry()
    named = _named_columns(item_two)

    assert members
    assert "detected facts" not in _flat(_adr_text())
    assert sorted(members - named) == []
    assert sorted(named - members) == []
    assert "`completionsuggestion.completed_units`" in removal
    assert "`completionsuggestion.completed_on`" in removal


def test_removal_inventory_counts_the_real_encrypted_columns() -> None:
    """Item 1's "N ``EncryptedString`` columns" is the size of B02's inventory."""
    counts = re.findall(r"The (\d+) `EncryptedString` columns", _removal_section())

    assert counts == [str(len(encrypted_columns()))]


def test_removal_scope_bullets_match_the_scorecard_scope_split() -> None:
    """Item 1's in-scope and out-of-scope bullets name the scorecard's split, both ways."""
    removal = _removal_section()
    in_bullet = _named_columns(
        _removal_item(removal, "**Journal content, in scope:**", "**Out of scope:**")
    )
    out_bullet = _named_columns(
        _removal_item(removal, "**Out of scope:**", "2. **`DERIVED_FROM_PROSE` plaintext**")
    )
    in_scope, out_of_scope = _journal_scope()

    assert sorted(column for column in in_scope if not _covered(column, in_bullet)) == []
    assert sorted(column for column in out_of_scope if not _covered(column, out_bullet)) == []
    assert sorted(column for column in out_of_scope if _covered(column, in_bullet)) == []
    assert sorted(column for column in in_scope if _covered(column, out_bullet)) == []


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


def test_decisions_three_and_four_scope_the_cloud_rule_and_record_the_closed_app_key_gap() -> None:
    """The cloud rule stays a target; the app-key fallback is recorded as closed, and is.

    Phase (a)'s first slice (#3067) removed the server ``LLM_API_KEY`` fallback
    from ``_resolve_api_key``. The record must say the gap is closed only while
    the code agrees: no server-key read in the provider layer, and a keyless
    resolution that refuses. Reintroducing the fallback fails here until the
    note is put back. The BYOK relay gap stays open until slice a2 and is
    pinned by :func:`test_custody_adr_records_the_server_proxied_byok_gap`.
    """
    text = _flat(_adr_text())
    decision = text[text.index("## Decision ") : text.index("## Threat actors")]
    botmason = (_REPO_ROOT / "backend" / "src" / "services" / "botmason.py").read_text(
        encoding="utf-8"
    )
    resolver = botmason[botmason.index("def _resolve_api_key(") :]
    resolver = resolver[: resolver.index("\ndef ")]

    assert "_get_llm_api_key" not in botmason
    assert 'os.getenv("LLM_API_KEY"' not in botmason
    assert "raise NoGenerationSourceError(KEY_REQUIRED_DETAIL)" in resolver
    assert "The app's own cloud key never carries" not in decision
    assert "Without such a key, **none of their data reaches a cloud model**" not in decision
    assert "Known gap until phase (a) lands, with #3096: the app-key fallback" not in decision
    assert "Closed by phase (a)'s first slice (#3067), with #3096: the app-key fallback." in (
        decision
    )
    assert "backend/tests/security/test_byok_only_cloud.py" in decision


def test_header_lists_only_what_is_still_open() -> None:
    """The recovery factors are Decision item 11, so the header may not call them open."""
    text = _flat(_adr_text())
    header = text[: text.index("## Context")]

    assert "D03 recovery semantics are still open" not in header
    assert "the recovery factors are Decision item 11" in header


def test_b13_epic_draft_carries_the_per_platform_caveat() -> None:
    """The draft states the premise as a target with the caveat, and no stored/future split."""
    draft = _flat(_EPIC_DRAFT.read_text(encoding="utf-8"))

    assert "The operator cannot read stored journal entries." not in draft
    assert "rests on trusting the code we serve until signed builds ship" in draft
    assert "only while the signed build is honest" in draft
    assert "future-capture" not in draft


def test_adr_0002_amendment_scopes_the_cloud_rule_and_records_the_closed_app_key_gap() -> None:
    """The 0002 amendment states BYOK-only and credits-non-cloud as targets; the gap is closed."""
    text = (_ADR_DIR / "0002-intimate-content-local-routing.md").read_text(encoding="utf-8")
    amendment = _flat(text[text.index(_AMENDMENT_HEADING) :])

    assert "It is the **only** way any of a person's content reaches" not in amendment
    assert "BotMason credits fund only non-cloud inference." not in amendment
    assert "is decided to be the **only** way any of a person's content will reach" in amendment
    assert "Under the decision, BotMason credits will fund only non-cloud inference" in amendment
    assert "known gap: the app-key fallback" not in amendment
    assert "The former known gap, the app-key fallback, is closed" in amendment
    assert "ADR 0009 Decision item 4" in amendment
    assert "#3096" in amendment


def test_selected_boundary_is_a_target_and_names_the_relay_gap() -> None:
    """BD's boundary cell scopes both sentences and admits today's relay and runtime."""
    cell = _as_dict(_as_dict(_as_dict(_card()["options"])[_SELECTED])["boundary"])
    value = str(cell.get("value"))
    prose = _flat(_option_slice(_adr_text(), _SELECTED))

    assert "never relayed by our server" not in value
    assert "Under the target, plaintext will exist only" in value
    assert "managed no-retention runtime" in value
    assert "until phase (a), BYOK is relayed through our server" in value
    assert value in prose


def test_reviewers_and_budget_record_the_owners_2026_10_14_decision() -> None:
    """No outside reviewer is hired, and that leaves the independent gate unmet (#3260).

    The owner chose adversarial AI reviews plus their own review, and no paid
    runtime or paid reviews for now. Neither is independent review, so every
    owed review stays owed: none may be marked consulted on the strength of it.
    """
    text = _flat(_adr_text())
    reviewers = text[text.index("## Reviewers") : text.index("## Rejected alternatives")]
    budget = text[text.index("## Budget and staffing") : text.index("## Reviewers")]

    assert "rely on adversarial AI reviews plus the owner's own review" in reviewers
    assert "No outside reviewer, firm or audit is being hired" in reviewers
    assert "This does not meet this record's independent-review gate" in reviewers
    assert "stays uncertified under B24" in reviewers
    assert "no paid runtime and no paid reviews" in budget
    statuses = {_as_dict(entry).get("status") for entry in _as_list(_card()["reviewers"])}
    assert statuses == {_REVIEW_OWED}


# --------------------------------------------------------------------------
# The owner's 2026-10-20 amendment: a vendor-attested inference runtime
# --------------------------------------------------------------------------


def _amendment() -> dict[str, object]:
    """The twin's 2026-10-20 amendment entry, or an empty object if it is gone."""
    entries = [
        _as_dict(entry)
        for entry in _as_list(_card().get("amendments"))
        if _as_dict(entry).get("date") == "2026-10-20"
    ]
    return entries[0] if entries else {}


def test_decision_items_three_and_four_admit_the_vendor_attested_runtime() -> None:
    """Item 3 keeps its cloud definition and gains the exception; item 4 gains the payee.

    This is the amendment Creek-Vault ADR-0016 Decision 0 Q1 specifies, and its
    Status clause makes that record's Accepted conditional on this merging.
    Deleting either phrase re-blocks Creek-Vault ADR-0016, so rewrite the record
    here rather than loosening the assertion.
    """
    text = _flat(_adr_text())
    decision = text[text.index("## Decision ") : text.index("## Threat actors")]

    assert _AMENDMENT_ANCHOR in decision
    assert _ATTESTED_EXCEPTION in decision
    assert "The definition of a cloud model above is unchanged" in decision
    assert _ATTESTED_CREDIT_PAYEE in decision
    # The exception is narrow: an ordinary cloud vendor still needs BYOK.
    assert "every other ordinary cloud model still need the person's own key" in decision
    # And it is not sold as a guarantee: (f) is the condition it rests on,
    # it is waived rather than met, and the record says which.
    assert "Decision 3.3 condition (f)" in decision
    assert "unverified for either candidate vendor" in decision
    assert _VENDOR_ANCHOR in decision
    assert _VENDOR_ASSERTED in decision
    assert _NOT_VERIFIED in decision


def test_the_attested_runtime_carries_its_own_honest_limit_and_label() -> None:
    """The per-use label and the operator-blind caveat cover the new runtime too."""
    text = _flat(_adr_text())
    decision = text[text.index("## Decision ") : text.index("## Threat actors")]
    phase_a = text[text.index("### Phase (a)") : text.index("### Phase (b)")]

    # The runtime we run keeps its original limit, unweakened.
    assert "not operator-blind while it runs" in decision
    assert "labelled clearly each time" in decision
    # The attested runtime is held to the target rather than exempted from it.
    assert "held to the operator-blind target rather than exempted from it" in decision
    assert "neither met nor certified today" in decision
    assert _ATTESTED_LABEL in decision
    assert _ATTESTED_LABEL in phase_a


def test_d05_is_reopened_for_the_inference_leg_with_exactly_three_named_waivers() -> None:
    """D05 reopens for inference only, and names each condition the owner waived.

    Creek-Vault ADR-0016 Decision 3.3 identifies (c) nonce freshness and (e) a
    hostile-host lab as the pair O5 cannot meet, and the owner waived both on
    2026-10-21 with the substitutes named below; (f) reproducible builds is
    waived in a different sense, on vendor-asserted evidence. A fourth
    waiver, or one recorded without its substitute, is a widening of a
    privacy posture: fail here rather than let it pass as prose.
    """
    text = _adr_text()
    section = _flat(text[text.index("## Confidential compute (D05)") : text.index("## Budget and")])

    assert "Reopened for the inference leg only, 2026-10-20" in section
    assert _AMENDMENT_ANCHOR in section
    assert "for that leg and for nothing else" in section
    # The decided paragraph survives verbatim, with the storage leg untouched
    # by the appended amendment, and so do custody and recovery.
    assert _D05_AS_DECIDED in section
    assert "is the decision as taken on 2026-10-07 and is kept as written" in section
    assert "D05 stays unpursued, C stays rejected" in section
    assert "they stay under Decision items 1, 2 and 11" in section
    # Exactly the three conditions the owner waived, each marked as waived.
    for condition, name in _D05_WAIVERS.items():
        assert f"**({condition}) {name}: WAIVED.**" in section
    assert set(_WAIVER_HEADING.findall(section)) == set(_D05_WAIVERS)
    assert len(_WAIVER_HEADING.findall(section)) == len(_D05_WAIVERS)
    assert _VENDOR_ANCHOR in section
    # Each structural waiver is recorded beside the substitute that is the
    # reason it is defensible at all.
    for condition, substitute in _D05_SUBSTITUTES.items():
        assert substitute in section, condition
    assert "Three conditions are waived and no others" in section
    # A vendor with no per-key caps is refused, not waived.
    assert "fails selection rather than earning a fourth waiver" in section


def test_managed_runtime_rows_separate_the_runtime_we_run_from_the_attested_one() -> None:
    """The threat-actor and per-platform rows say which runtime each caveat describes."""
    text = _adr_text()
    actors = _flat(text[text.index("## Threat actors") : text.index("## Options")])
    platforms = _flat(
        text[
            text.index("## Per-platform claim scoping") : text.index(
                "## Client delivery and update trust"
            )
        ]
    )

    assert "sees inputs to a managed runtime we run while they run" in actors
    assert "excluded from the enclave by hardware under the vendor's attestation chain" in actors
    assert "sees the vendor's request metadata" in actors
    # The vendor is an actor in its own right once the pool is admitted.
    assert "| Inference vendor (vendor-attested runtime only) |" in text
    assert "keeps request metadata under condition (g)" in actors
    assert "is held to the operator-blind target for the inference leg instead" in platforms
    assert "the target is not met until B24 certifies it" in platforms


def test_the_twin_records_the_amendment_and_changes_nothing_it_may_not() -> None:
    """The scorecard carries the amendment, its waivers, and the untouched selection."""
    card = _card()
    amendment = _amendment()

    assert amendment.get("source") == _AMENDMENT_ANCHOR
    assert amendment.get("d05_reopened_for") == "inference leg only"
    waived = {
        str(_as_dict(entry).get("condition")): str(_as_dict(entry).get("name"))
        for entry in _as_list(amendment.get("d05_waivers"))
    }
    assert waived == _STRUCTURAL_WAIVERS
    assert {_as_dict(entry).get("status") for entry in _as_list(amendment.get("d05_waivers"))} == {
        "waived"
    }
    # The amendment moves the inference leg and nothing else.
    assert card["selected_option"] == _SELECTED
    assert card["status"] == "accepted"
    assert card["decided_on"] == "2026-10-07"
    assert card["unlocks_public_claims"] is False
    assert _as_dict(card["journal_scope_proposal"]).get("status") == (
        "decided: owner:2026-10-07#followup-scope"
    )
    # And the twin's own cells name the new runtime, so prose and JSON agree.
    selected = _as_dict(_as_dict(card["options"])[_SELECTED])
    inference = str(_as_dict(selected["inference_location"]).get("value"))
    assert "vendor-attested runtime verified under Creek-Vault ADR-0016 Decision 3" in inference
    assert inference in _flat(_option_slice(_adr_text(), _SELECTED))


def test_the_vendor_is_named_with_its_jurisdiction_and_deployment_shape() -> None:
    """Condition (h) is a choice, so the record names who runs the enclave and where.

    "A vendor" is not a jurisdiction. The owner chose Privatemode over
    Tinfoil for the EU domicile, and that choice also fixes the deployment
    shape: a loopback sidecar per vault image, with the attestation verified
    inside the vendor's client code rather than ours. Both belong in the
    record, because both are what the exclusion of the operator rests on.
    """
    text = _flat(_adr_text())
    section = text[text.index("## Confidential compute (D05)") : text.index("## Budget and")]
    decision = text[text.index("## Decision ") : text.index("## Threat actors")]

    for fact in _VENDOR_FACTS:
        assert fact in section, fact
        assert fact in decision, fact
    assert "loopback sidecar" in text
    assert "inside the vendor's client code" in text
    assert _VENDOR_ANCHOR in section


def test_condition_f_is_waived_on_vendor_asserted_evidence_and_says_so() -> None:
    """(f) is waived, not met, and every dependent sentence reads "vendor-asserted"."""
    text = _flat(_adr_text())
    section = text[text.index("## Confidential compute (D05)") : text.index("## Budget and")]

    assert "**(f) reproducible builds: WAIVED.**" in section
    assert _VENDOR_ASSERTED in section
    assert _NOT_VERIFIED in section
    # The threat-actor row the exclusion appears in says it there too, so a
    # reader who reads only the table is not left with a verified claim.
    actors = _flat(text[text.index("## Threat actors") : text.index("## Options")])
    assert _VENDOR_ASSERTED in actors


def test_intimate_never_reaches_the_pool_by_any_route() -> None:
    """Decision 5 of the Creek record is restated here, rescue path included.

    The `default` stage is the router's rescue target, and it is the route an
    amendment is most likely to leave implicit. Pinned in both places a
    reader could stop at: the decision items and the D05 section.
    """
    text = _flat(_adr_text())
    decision = text[text.index("## Decision ") : text.index("## Threat actors")]
    d05 = text[text.index("## Confidential compute (D05)") : text.index("## Budget and")]

    assert _INTIMATE_OFF_THE_POOL in decision
    assert _INTIMATE_OFF_THE_POOL in d05


def test_grounding_embeddings_ride_the_pool_only_inside_the_measurement_set() -> None:
    """Q2's option (i) is admitted on its own condition, with (iii) as the fallback.

    An embedding is computed from the same prose as a reflection, so letting
    the pool compute it widens what leaves the vault unless the embedding
    model is inside the attested measurement set. The record admits it on
    exactly that condition and names the ungrounded fallback.
    """
    decision = _flat(_adr_text())
    decision = decision[decision.index("## Decision ") : decision.index("## Threat actors")]

    assert "inside the attested measurement set" in decision
    assert "option (iii)" in decision
    assert "stays ungrounded" in decision


def _vendor_amendment() -> dict[str, object]:
    """The twin's 2026-10-21 amendment entry, or an empty object if it is gone."""
    entries = [
        _as_dict(entry)
        for entry in _as_list(_card().get("amendments"))
        if _as_dict(entry).get("date") == "2026-10-21"
    ]
    return entries[0] if entries else {}


def test_the_twin_records_the_vendor_the_waivers_and_their_substitutes() -> None:
    """The machine-readable half carries every 2026-10-21 decision, and no more."""
    amendment = _vendor_amendment()

    assert amendment.get("source") == _VENDOR_ANCHOR
    vendor = _as_dict(amendment.get("vendor"))
    assert vendor.get("name") == "Privatemode"
    assert vendor.get("operator") == "Edgeless Systems GmbH"
    assert vendor.get("jurisdiction") == "Bochum, Germany"
    waived = {
        str(_as_dict(entry).get("condition")): _as_dict(entry)
        for entry in _as_list(amendment.get("d05_waivers"))
    }
    assert {key: str(entry.get("name")) for key, entry in waived.items()} == _D05_WAIVERS
    assert {str(entry.get("status")) for entry in waived.values()} == {"waived"}
    # The substitutes travel with the waivers in the twin as well as the prose.
    for condition, substitute in _D05_SUBSTITUTES.items():
        assert substitute in str(waived[condition].get("substitute")), condition
    # (f) is waived on evidence, not on impossibility, and says whose evidence.
    assert waived["f"].get("evidence") == _VENDOR_ASSERTED
    # And the amendment still moves nothing it may not.
    unchanged = " ".join(str(entry) for entry in _as_list(amendment.get("unchanged")))
    assert _INTIMATE_OFF_THE_POOL in unchanged
    assert _card()["unlocks_public_claims"] is False


def test_the_metered_vendor_line_is_surfaced_against_the_no_paid_runtime_answer() -> None:
    """The amendment admits a paid runtime, so the record says so where money lives.

    The owner's 2026-10-14 answer was "no paid runtime, for now", and
    Creek-Vault ADR-0016 Decision 3.6 concedes O5 is metered per token. Both
    stay in the record, with no figure invented for either: the tension is
    the owner's to hold, and hiding it would make the budget section read as
    though the amendment changed nothing.
    """
    text = _flat(_adr_text())
    budget = text[text.index("## Budget and staffing") : text.index("## Reviewers")]

    assert "no paid runtime and no paid reviews" in budget
    assert "metered, per-token" in budget
    assert _VENDOR_ANCHOR in budget
    # And no figure sneaks in with it: the money cells are still unknown.
    assert _money_violations(_card()) == []


def _actor_row(label: str) -> str:
    """The Threat-actors row whose first cell starts with ``label``, flattened."""
    rows = [row for row in _adr_text().splitlines() if row.startswith(f"| {label}")]
    assert len(rows) == 1, f"expected one {label!r} row, found {len(rows)}"
    return _flat(rows[0])


def test_the_exception_and_the_waivers_are_bound_to_the_chosen_vendor() -> None:
    """Another vendor, or another jurisdiction, is a new owner decision.

    This is the widening that would cost the most and show the least: the
    waivers are reusable text, and the reason for them is a jurisdiction. A
    successor who moved to a US-domiciled vendor under this record would keep
    (c), (e) and (f) and throw away the EU domicile the owner chose them for.
    So the binding is stated, and the reopen trigger refuses a substitution.
    """
    text = _flat(_adr_text())
    decision = text[text.index("## Decision ") : text.index("## Threat actors")]
    triggers = text[text.index("## Reopen triggers") : text.index("## Open owner questions")]

    assert _VENDOR_BINDING in decision
    assert "is **a new owner decision** and inherits none of these waivers" in decision
    assert "Tinfoil, Inc., under United States jurisdiction" in decision
    # And the trigger says a replacement is a decision, not an operation.
    assert "not to a second vendor either" in triggers
    assert "a fresh owner decision under condition (h)" in triggers
    # The (f) waiver itself travels no further than the vendor it names.
    d05 = text[text.index("## Confidential compute (D05)") : text.index("## Budget and")]
    assert "granted for Privatemode and travels to no other vendor" in d05


def test_the_exception_says_which_side_dials_the_vendor() -> None:
    """The vault opens the connection; a server-side call is not admitted.

    Left implicit, the exception reads as permitting adepthood's server to
    call the vendor directly, which would put journal plaintext back in the
    process Decision item 1 exists to keep it out of.
    """
    decision = _flat(_adr_text())
    decision = decision[decision.index("## Decision ") : decision.index("## Threat actors")]

    assert _VAULT_DIALS in decision
    assert "This exception admits no call from adepthood's server to the vendor" in decision


def test_the_record_will_not_take_the_pre_decision_wording_back() -> None:
    """The near-miss wording cannot return anywhere in the record or its twin.

    The draft this amendment corrected recorded condition (f) as an unmet
    blocker: "until it is verified", "earning a third waiver". Those phrases
    are the opposite of the 2026-10-21 decision, and the `(f) ... WAIVED`
    heading surviving elsewhere would not stop them from reading as policy.
    """
    offenders = {
        "0009": _PRE_DECISION_WORDING.findall(_adr_text()),
        "scorecard": _PRE_DECISION_WORDING.findall(json.dumps(_card())),
        "b13-draft": _PRE_DECISION_WORDING.findall(_EPIC_DRAFT.read_text(encoding="utf-8")),
    }

    assert {name: hits for name, hits in offenders.items() if hits} == {}


def test_every_claim_resting_on_condition_f_says_vendor_asserted() -> None:
    """Each placement is checked on its own, so deleting one stays caught.

    A count over the whole document lets any single row lose the qualifier
    while the document still "says vendor-asserted somewhere". These are the
    four claims that rest on (f): the item 3 exception, item 4's honest limit,
    and the operator, hosting-provider and vendor rows of the threat table.
    """
    text = _flat(_adr_text())
    decision = text[text.index("## Decision ") : text.index("## Threat actors")]
    exception = decision[decision.index("**Decided exception, 2026-10-20") :]
    honest_limit = decision[decision.index("**Honest limit for the vendor-attested runtime") :]

    assert _VENDOR_ASSERTED in exception[: exception.index("**The vendor, decided 2026-10-21")]
    assert _VENDOR_ASSERTED in honest_limit[: honest_limit.index("**Grounding embeddings")]
    for label in ("Privileged operator", "Hosting provider", "Inference vendor"):
        assert _VENDOR_ASSERTED in _actor_row(label), label


def test_the_per_activation_cap_is_recorded_as_unconfirmed_for_this_vendor() -> None:
    """The brake is cited from a record that documented it for the other vendor.

    Creek-Vault ADR-0016 Decision 3 item 4 describes per-key caps on one
    vendor's admin API and makes a vendor without them fail the item. Stating
    the cap as settled for Privatemode would assert something nobody checked,
    so it is recorded as to-be-confirmed with a return to the owner.
    """
    decision = _flat(_adr_text())
    decision = decision[decision.index("## Decision ") : decision.index("## Threat actors")]

    assert "to be confirmed by the Creek build issue" in decision
    assert "the choice returns to the owner rather than proceeding without the brake" in decision


def test_the_twin_records_the_two_kinds_of_waiver_and_the_spend_boundary() -> None:
    """(c) and (e) are unmeetable; (f) is unverified. The twin keeps them apart."""
    waived = {
        str(_as_dict(entry).get("condition")): _as_dict(entry)
        for entry in _as_list(_vendor_amendment().get("d05_waivers"))
    }

    assert {key: entry.get("unmeetable_under_o5") for key, entry in waived.items()} == {
        "c": True,
        "e": True,
        "f": False,
    }
    unchanged = " ".join(str(entry) for entry in _as_list(_vendor_amendment().get("unchanged")))
    assert "No spend is authorized by this record" in unchanged


# --------------------------------------------------------------------------
# The owner's 2026-10-27 amendment: reviewer gates waived (release decision R5-1)
# --------------------------------------------------------------------------

_GATES_WAIVED_ANCHOR = "owner:2026-10-27#reviewer-gates-waived"
_GATES_WAIVED_HEADING = "## Amendment 2026-10-27: reviewer gates waived by owner"


def _gates_waived_amendment() -> dict[str, object]:
    """The twin's 2026-10-27 amendment entry, or an empty object if it is gone."""
    entries = [
        _as_dict(entry)
        for entry in _as_list(_card().get("amendments"))
        if _as_dict(entry).get("date") == "2026-10-27"
    ]
    return entries[0] if entries else {}


def test_the_reviewer_gate_waiver_keeps_every_claim_boundary() -> None:
    """Waiving the gates lets phases proceed; it certifies nothing (R5-1).

    The owner dropped the four independent reviews as phase gates. The reviews
    were not done, so the 2026-10-14 text stays, every review stays owed, and
    the amendment restates the boundaries a reader could otherwise think it
    lifted: no independent-review claim, the operator-blind claim uncertified
    under B24, and no "end-to-end" or "operator-blind" claim at all.
    """
    text = _flat(_adr_text())
    reviewers = text[text.index("## Reviewers") : text.index("## Rejected alternatives")]
    amendment = text[text.index(_GATES_WAIVED_HEADING) : text.index("## Rejected alternatives")]

    # Appended, not rewritten: the 2026-10-14 gate text survives above it.
    assert reviewers.index("This does not meet this record's independent-review gate") < (
        reviewers.index(_GATES_WAIVED_HEADING)
    )
    assert _GATES_WAIVED_ANCHOR in amendment
    assert "Phases (b)-(d) may proceed on adversarial AI review plus owner review" in amendment
    assert "independent, external or outside party has checked" in amendment
    assert "stays uncertified under B24" in amendment
    assert 'no copy may claim "end-to-end" or "operator-blind"' in amendment
    assert "real paying users" in amendment
    statuses = {_as_dict(entry).get("status") for entry in _as_list(_card()["reviewers"])}
    assert statuses == {_REVIEW_OWED}
    twin = _gates_waived_amendment()
    assert twin.get("source") == _GATES_WAIVED_ANCHOR
    assert _card()["unlocks_public_claims"] is False
