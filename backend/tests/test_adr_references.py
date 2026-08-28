"""Guards that the decision record says only what it can point at.

Three failure modes, one document family.

*A cited ADR that does not exist.* A path of the form
``docs/adr/NNNN-slug.md`` written into a shipped document is a claim that a
file is there to read, and a reader who follows it gets nothing.

*The same claim made by number.* Naming a record by number and nothing else
used to be exempt here, on the reasoning that prose without a path promises no
file.  It promises something worse: an authority.  Five open issues spent
months resting a requirement on a numbered record nobody had written, and two
agents rediscovered that independently in one day.  The exemption that let it
happen is narrowed rather than removed -- naming an unwritten record *as
unwritten* stays legitimate, because it is how this repo records a dependency
it cannot cite -- so a number with no file must sit beside a disclaimer saying
so.  Another repository's records are out of scope: they are cited by number
here on purpose and were never going to be on our disk.

*An ADR that misdescribes the code.* The operator-side ontologization record
names the two enforcement points its whole privacy argument rests on.  If
either is renamed, the ADR silently becomes the most authoritative wrong
statement in the repository, so the symbols it names are pinned from the code
side as well.  The consent record is held the same way, and one turn tighter:
it exists to say which shipped shape a third feature should copy, so the tests
it names as pinning each shape are asserted to be real test functions.
"""

from __future__ import annotations

import re
from pathlib import Path

from models.journal_entry import JournalClassification
from services.corpus_consent import CONSENT_GRANTED_BY_DEFAULT
from services.frequency_classification import (
    IntimateContentRefusedError,
    classify_frequencies,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_ADR_DIR = _REPO_ROOT / "docs" / "adr"
_ONTOLOGIZATION_ADR = _ADR_DIR / "0005-operator-side-ontologization.md"

# A path citation: a claim that this exact file is on disk to be read.
_ADR_PATH_CITATION = re.compile(r"docs/adr/(\d{4})-[a-z0-9-]+\.md")
# A relative sibling link, the form one ADR uses to reach another.
_ADR_SIBLING_LINK = re.compile(r"\]\((\d{4})-[a-z0-9-]+\.md\)")

# Where a path citation can plausibly be written.  Wide enough that the scan
# cannot pass by looking nowhere, narrow enough to stay fast.
_SCANNED_TREES = ("docs", "backend/src", "backend/tests", "graph", "scripts")
_SCANNED_ROOT_DOCS = ("NORTH-STAR.md", "CLAUDE.md", "AGENTS.md", "README.md")

# The scan is worthless if it finds nothing, and a refactor that quietly stops
# matching would present as a pass.  Four ADRs cross-reference each other and
# the drift guards cite them by path, so the real count is comfortably above
# this floor; it exists to fail loudly if the scan ever collapses to zero.
_MINIMUM_CITATIONS_FOUND = 5

_REQUIRED_ADR_SECTIONS = (
    "## Context",
    "## Decision 1",
    "## Decision 2",
    "## Decision 3",
    "## Decision 4",
    "## Decision 5",
    "## Open question",
    "## Consequences",
)

# The distinction this ADR exists to draw: per-user scoping is a partition of
# the table, not a claim about who can read it.
_ISOLATION_CLAIM = "isolation, not operator-blindness"

# An agent may not ratify a privacy posture, so the record ships unratified and
# a human flips it.
_PROPOSED_STATUS = "- **Status:** Proposed"

_CONSENT_ADR = _ADR_DIR / "0006-consent-as-an-auditable-event.md"

# A prose citation: names a record by number and borrows its authority without
# claiming a path.  The separator is a run of whitespace or a hyphen, because
# these documents are hard-wrapped and a citation that happens to straddle a
# line break is the same claim as one that does not.
_ADR_NUMBER_CITATION = re.compile(r"\bADR[\s-]+(\d{4})\b")

# One of these has to sit beside a number with no file for the citation to read
# as "this is not written yet" rather than as an authority a reader could go
# and consult.
_UNWRITTEN_MARKERS = (
    "does not exist",
    "never existed",
    "is unwritten",
    "was never written",
    "has never been written",
)

# How far from the citation a disclaimer may sit.  Wide enough to survive the
# line wrapping these documents are written at, narrow enough that a disclaimer
# three paragraphs away cannot launder an unrelated citation.
_DISCLAIMER_WINDOW = 240

# Records belonging to another repository, cited by number because that is the
# only handle we have on them.  They are not ours to ship, and their absence
# from `docs/adr/` is not a defect.
_FOREIGN_ADR_REPOS = ("creek-vault",)
_FOREIGN_QUALIFIER_WINDOW = 32

# Same reasoning as the citation floor above: a scan that quietly stopped
# visiting files would present as a clean sweep.
_MINIMUM_FILES_SCANNED = 50

_REQUIRED_CONSENT_ADR_SECTIONS = (
    "## Context",
    "## Decision 1",
    "## Decision 2",
    "## Decision 3",
    "## What this settles in ADR 0005, and what it leaves open",
    "## Consequences",
)

# The record's whole job is to say which shipped shape a third feature copies,
# so it cites each shape by the test that holds it.  Keyed by the module the
# test lives in, because a bare test name rots silently once the test moves.
_CONSENT_ADR_PINNING_TESTS = {
    "services/test_corpus_consent.py": (
        "test_changing_your_mind_appends_rather_than_overwrites",
        "test_repeating_a_decision_does_not_repeat_the_event",
    ),
    "test_account_deletion_api.py": ("test_deletion_logs_counts_and_never_content",),
    "services/test_corpus_backfill.py": (
        "test_a_resumed_sweep_is_logged_under_the_yes_that_was_already_standing",
        "test_a_sweep_that_found_nothing_pending_logs_nothing",
    ),
}

# The two questions ADR 0005 left open that this record may not close, in the
# words ADR 0005 uses for them.
_STILL_OPEN_IN_CONSENT_ADR = ("Retention", "Whose provider account sees the content")

# The constant the conservative default lives in, pinned from the code side so
# the record cannot outlive the thing it describes.
_DEFAULT_CONSTANT_NAME = "CONSENT_GRANTED_BY_DEFAULT"

# ADR 0005 named the phantom in two places -- once in the decision that needed
# the shape, once in its own list of open questions -- and both now carry a
# dated note forward to the record that holds it.  Counted rather than merely
# found, because amending one and forgetting the other leaves half a reader
# still chasing a number.
_CONSENT_ADR_AMENDMENT = "**AMENDED 2026-08-22:**"
_EXPECTED_AMENDMENT_NOTES = 2


def _scanned_files() -> list[Path]:
    """Every file a path citation could be written into."""
    files = [
        path
        for tree in _SCANNED_TREES
        for suffix in ("*.md", "*.py")
        for path in (_REPO_ROOT / tree).rglob(suffix)
    ]
    files.extend(_REPO_ROOT / name for name in _SCANNED_ROOT_DOCS)
    return [path for path in files if path.is_file()]


def _adr_files_by_number() -> dict[str, Path]:
    """Every shipped ADR, keyed by its four-digit number."""
    return {path.name[:4]: path for path in _ADR_DIR.glob("[0-9][0-9][0-9][0-9]-*.md")}


def _names_another_repos_record(text: str, start: int) -> bool:
    """Whether the citation at ``start`` is qualified by another repository."""
    prefix = text[max(0, start - _FOREIGN_QUALIFIER_WINDOW) : start].lower()
    return any(repo in prefix for repo in _FOREIGN_ADR_REPOS)


def _is_marked_unwritten(text: str, start: int, end: int) -> bool:
    """Whether a disclaimer sits close enough to the citation to govern it."""
    window = text[max(0, start - _DISCLAIMER_WINDOW) : end + _DISCLAIMER_WINDOW].lower()
    return any(marker in window for marker in _UNWRITTEN_MARKERS)


def _phantom_citations(text: str, shipped: dict[str, Path]) -> list[str]:
    """Every numbered citation in ``text`` that names an authority nobody wrote."""
    return [
        match.group(0)
        for match in _ADR_NUMBER_CITATION.finditer(text)
        if match.group(1) not in shipped
        and not _names_another_repos_record(text, match.start())
        and not _is_marked_unwritten(text, match.start(), match.end())
    ]


def test_every_cited_adr_path_resolves_to_a_shipped_file() -> None:
    """No document may point at an ADR file that is not there to read."""
    shipped = _adr_files_by_number()
    dangling: list[str] = []
    found = 0
    for path in _scanned_files():
        text = path.read_text(encoding="utf-8")
        cited = _ADR_PATH_CITATION.findall(text)
        if path.parent == _ADR_DIR:
            cited += _ADR_SIBLING_LINK.findall(text)
        found += len(cited)
        dangling += [
            f"{path.relative_to(_REPO_ROOT)} cites ADR {number}, which does not exist"
            for number in cited
            if number not in shipped
        ]
    assert not dangling, "\n".join(dangling)
    assert found >= _MINIMUM_CITATIONS_FOUND, f"only {found} citations scanned -- scan is broken"


def test_no_document_cites_a_record_number_nobody_wrote() -> None:
    """A number with no file must be named as unwritten or not named at all.

    The failure this catches is not a broken link -- there is no link -- but a
    requirement that looks ratified and is not, which is expensive precisely
    because it survives review: everyone assumes somebody else read the record.
    """
    shipped = _adr_files_by_number()
    phantom: list[str] = []
    scanned = 0
    for path in _scanned_files():
        scanned += 1
        phantom += [
            f"{path.relative_to(_REPO_ROOT)} cites {citation}, which nobody wrote"
            for citation in _phantom_citations(path.read_text(encoding="utf-8"), shipped)
        ]
    assert not phantom, "\n".join(phantom)
    assert scanned >= _MINIMUM_FILES_SCANNED, f"only {scanned} files scanned -- scan is broken"


def test_consent_adr_carries_every_required_section() -> None:
    """The record five issues were already citing exists, with its argument in it."""
    text = _CONSENT_ADR.read_text(encoding="utf-8")
    missing = [section for section in _REQUIRED_CONSENT_ADR_SECTIONS if section not in text]
    assert not missing, f"missing sections: {missing}"


def test_consent_adr_is_shipped_unratified() -> None:
    """Recording what shipped is an agent's job; ratifying it is not."""
    assert _PROPOSED_STATUS in _CONSENT_ADR.read_text(encoding="utf-8")


def test_consent_adr_names_tests_that_exist_for_both_shapes() -> None:
    """Each shape the record distinguishes is cited by a test that is really there.

    Both halves are asserted: the record has to name the test, and the named
    test has to be a function in the module the record points at.  Either one
    alone lets the citation rot into the authoritative wrong statement the
    other guards in this module exist to prevent.
    """
    text = _CONSENT_ADR.read_text(encoding="utf-8")
    unnamed: list[str] = []
    for module, names in _CONSENT_ADR_PINNING_TESTS.items():
        source = (Path(__file__).parent / module).read_text(encoding="utf-8")
        unnamed += [name for name in names if name not in text or f"def {name}(" not in source]
    assert not unnamed, f"pinning tests not both cited and defined: {unnamed}"


def test_consent_adr_leaves_the_questions_it_may_not_answer_open() -> None:
    """Retention and whose provider key classifies stay where ADR 0005 left them."""
    text = _CONSENT_ADR.read_text(encoding="utf-8")
    dropped = [question for question in _STILL_OPEN_IN_CONSENT_ADR if question not in text]
    assert not dropped, f"open questions the record stops carrying: {dropped}"


def test_consent_adr_names_the_default_that_exists() -> None:
    """The conservative default the record describes still resolves in the code."""
    assert _DEFAULT_CONSTANT_NAME in _CONSENT_ADR.read_text(encoding="utf-8")
    assert CONSENT_GRANTED_BY_DEFAULT is False


def test_ontologization_adr_points_forward_to_the_consent_record() -> None:
    """The two places ADR 0005 named the phantom now name the record instead."""
    text = _ONTOLOGIZATION_ADR.read_text(encoding="utf-8")
    assert text.count(_CONSENT_ADR_AMENDMENT) == _EXPECTED_AMENDMENT_NOTES


def test_ontologization_adr_is_shipped_unratified() -> None:
    """The record exists, and leaves ratification to a human."""
    text = _ONTOLOGIZATION_ADR.read_text(encoding="utf-8")
    assert _PROPOSED_STATUS in text


def test_ontologization_adr_carries_every_required_section() -> None:
    """Header, five numbered decisions, the open question, the consequences."""
    text = _ONTOLOGIZATION_ADR.read_text(encoding="utf-8")
    missing = [section for section in _REQUIRED_ADR_SECTIONS if section not in text]
    assert not missing, f"missing sections: {missing}"


def test_ontologization_adr_states_isolation_is_not_operator_blindness() -> None:
    """The one distinction the record exists to draw is stated in those words."""
    text = _ONTOLOGIZATION_ADR.read_text(encoding="utf-8")
    assert _ISOLATION_CLAIM in text


def test_ontologization_adr_names_enforcement_that_exists() -> None:
    """Both symbols the ADR rests its refusal on still resolve in the code."""
    text = _ONTOLOGIZATION_ADR.read_text(encoding="utf-8")
    assert "IntimateContentRefusedError" in text
    assert IntimateContentRefusedError.__name__ == "IntimateContentRefusedError"
    assert "services/creek_vault_write.py" in text
    assert JournalClassification.INTIMATE.value == "intimate"
    assert classify_frequencies.__module__ == "services.frequency_classification"
