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

from services import journal_encryption as je
from services.journal_encryption import EncryptedString

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
_REPO_SOURCE_PREFIX = "repo:"
_STATUSES = frozenset({"proposed", "accepted"})
_REVIEW_CONSULTED = "consulted"
_REVIEW_OWED = "not_yet_consulted"
_PHASE_IDS = ("a", "b", "c", "d")

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
    "## Recovery, reset and pairing (D03): open owner questions",
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
    "test_custody_decision_record.py": ("test_custody_codec_has_no_per_principal_key",),
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


def _money_violations(card: dict[str, object]) -> list[str]:
    """Money and staffing are unknown or owner-sourced, never estimated by us."""
    violations: list[str] = []
    for name, scored in _as_dict(card.get("options")).items():
        cells = _as_dict(scored)
        for dimension in sorted(_MONEY_DIMENSIONS & cells.keys()):
            cell = cells[dimension]
            source = _as_dict(cell).get("source")
            owner_sourced = isinstance(source, str) and source.startswith(_OWNER_SOURCE_PREFIX)
            if cell != _UNKNOWN and not owner_sourced:
                violations.append(f"options.{name}.{dimension} is neither unknown nor owner:")
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

    signed = copy.deepcopy(card)
    owner_figure = {"value": "6.70", "source": "owner:2026-10-07"}
    _as_dict(_as_dict(signed["options"])["E"])["staffing"] = owner_figure
    assert _money_violations(signed) == []


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
    assert _source_violation("p", "owner:2026-10-07", root) is None


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


def test_recovery_for_the_selection_stays_an_open_owner_question() -> None:
    """D03 is the owner's; the record must not invent recovery semantics."""
    card = _card()
    selected = _as_dict(_as_dict(card["options"])[_SELECTED])
    questions = [_as_dict(entry).get("id") for entry in _as_list(card["open_owner_questions"])]

    assert selected["recovery"] == _UNKNOWN
    assert "D03" in questions


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


def test_custody_codec_has_no_per_principal_key() -> None:
    """Baseline: one server-held key registry encrypts every person's prose.

    This is the measurable custody baseline ADR 0009 must invert. It is
    **expected to fail by design** when B13 (#3067) lands user-held keys: a
    codec that takes a per-person key, or an ``EncryptedString`` bound to an
    owner, is the change this test is waiting for. When it fails for that
    reason, replace it with the inverted assertion and update ADR 0009's
    "Reopen triggers" and "Context" sections in the same change -- do not
    delete it to make the suite pass.
    """
    encrypt_parameters = list(inspect.signature(je.encrypt).parameters)
    decrypt_parameters = list(inspect.signature(je.decrypt).parameters)
    column_parameters = list(inspect.signature(EncryptedString.__init__).parameters)

    assert encrypt_parameters == ["plaintext"]
    assert decrypt_parameters == ["value"]
    assert [name for name in column_parameters if _KEY_PARAMETER.search(name)] == []
    assert je.KEYS_ENV_VAR == "JOURNAL_ENCRYPTION_KEYS"


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
