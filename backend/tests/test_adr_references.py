"""Guards that the decision record says only what it can point at.

Two failure modes, one document family.

*A cited ADR that does not exist.* A path of the form
``docs/adr/NNNN-slug.md`` written into a shipped document is a claim that a
file is there to read, and a reader who follows it gets nothing.  Prose that
names an ADR by number without a path makes no such claim -- naming an
unwritten ADR as unwritten is how this repo already records a dependency it
cannot cite (see the boundary ADR's treatment of an unshipped companion
document) -- so only paths are checked here.

*An ADR that misdescribes the code.* The operator-side ontologization record
names the two enforcement points its whole privacy argument rests on.  If
either is renamed, the ADR silently becomes the most authoritative wrong
statement in the repository, so the symbols it names are pinned from the code
side as well.
"""

from __future__ import annotations

import re
from pathlib import Path

from models.journal_entry import JournalClassification
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
