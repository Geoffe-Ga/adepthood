"""Guard the written record of the APTITUDE ontology against a retracted claim.

APTITUDE is one set of ten developmental positions under several names: the
Stages, the Aspects of Wholeness, the Wavelength Modes and creek's ``F1..F10``
are the same ten, joined on colour. An earlier reading called their all having
ten members a coincidence of cardinality and denied the mapping was a semantic
identity. The owner ratified the opposite, and ``domain.frequencies`` now
carries the canonical table.

That wrong reading has already propagated twice -- from a comment in the vault
client into ``domain.frequencies``, and from there into a pull request that
reported the correct code as a latent bug -- which is why it is worth a test
rather than a one-time edit. Prose is where it spread, so prose is what this
reads.

Two rules, because a living document and an architecture decision record want
opposite things from a retracted claim:

*Living documents state the current truth.* A contract note or an ontology
spine that still says the mapping is a coincidence is teaching the error to the
next reader, so the claim may not appear in one at all.

*An ADR is a historical record.* It keeps what was ruled, including what was
later overturned -- deleting the claim would erase the fact that it was made.
So an ADR may carry the claim, but never unmarked: the passage making it has
to name the dated amendment or supersession that reversed it, which is the
convention those documents already use.
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_ADR_DIR = _REPO_ROOT / "docs" / "adr"

# Where the ontology is written down in prose. Directories rather than a
# whole-tree walk, so a checkout that happens to hold scratch worktrees or
# vendored course text under other paths cannot change the verdict.
_DOC_ROOTS = (_REPO_ROOT / "docs", _REPO_ROOT / "graph")
_NAMED_DOCS = (_REPO_ROOT / "NORTH-STAR.md",)

# The retracted claim in each of the spellings it was written in.
_RETRACTED = re.compile(
    r"coincidence of cardinality|numeric coincidence|not a semantic identity",
    re.IGNORECASE,
)

# How this repository's ADRs mark a ruling that a later one overturned, e.g.
# ``**SUPERSEDED 2026-08-21 — see the note at the end of this ADR.**``.
_REVERSAL_MARKER = re.compile(r"(?:amended|superseded)\s+\d{4}-\d{2}-\d{2}", re.IGNORECASE)

# The ADR that made the claim, and the claim as it was written there. Pinned
# verbatim so the correction stays an amendment: a reader has to be able to see
# that the claim was made before seeing that it was reversed.
_ADR_0004 = _ADR_DIR / "0004-creek-vault-http-application-boundary.md"
_ORIGINAL_CLAIM = "the F1-F10-to-ten-stage numeric coincidence is NOT a semantic identity"

# Below this the sweep is finding almost nothing and its silence means nothing.
# ``docs/`` alone holds several times this many files.
_MINIMUM_DOCS_SWEPT = 5


def _markdown_under(root: Path) -> list[Path]:
    """Every Markdown file under ``root``, or nothing if it does not exist."""
    return sorted(root.rglob("*.md")) if root.is_dir() else []


def _all_docs() -> list[Path]:
    """Every prose document that states or could state the ontology."""
    swept = [path for root in _DOC_ROOTS for path in _markdown_under(root)]
    return swept + [path for path in _NAMED_DOCS if path.is_file()]


def _blocks(text: str) -> list[str]:
    """Markdown split into the units a single claim is made in.

    A paragraph, because prose wraps and a claim rarely sits on one line --
    except a table row, which is one line and one self-contained record, so
    marking a neighbouring row must not vouch for it.
    """
    units: list[str] = []
    for paragraph in re.split(r"\n\s*\n", text):
        rows = paragraph.splitlines()
        units.extend(rows if paragraph.lstrip().startswith("|") else [paragraph])
    return [unit for unit in units if unit.strip()]


def _passages_making_the_claim(path: Path) -> list[str]:
    """Blocks of ``path`` that assert the mapping is a coincidence."""
    return [
        block for block in _blocks(path.read_text(encoding="utf-8")) if _RETRACTED.search(block)
    ]


def test_the_sweep_reads_the_documents_it_claims_to() -> None:
    """A guard that silently swept nothing would pass for the wrong reason."""
    assert len(_all_docs()) >= _MINIMUM_DOCS_SWEPT
    assert _ADR_0004 in _all_docs()


def test_the_adr_keeps_the_claim_it_made() -> None:
    """The correction is an amendment, so the original wording survives."""
    assert _ORIGINAL_CLAIM in _ADR_0004.read_text(encoding="utf-8")


def test_no_living_document_still_calls_the_mapping_a_coincidence() -> None:
    """Anything outside the ADRs teaches the current ontology, not the old one."""
    offenders = {
        path.relative_to(_REPO_ROOT).as_posix(): _passages_making_the_claim(path)
        for path in _all_docs()
        if _ADR_DIR not in path.parents
    }
    assert {path: found for path, found in offenders.items() if found} == {}


def test_every_adr_passage_making_the_claim_names_its_reversal() -> None:
    """An ADR may record the claim, but never without the amendment that reversed it."""
    unmarked = {
        path.relative_to(_REPO_ROOT).as_posix(): [
            block
            for block in _passages_making_the_claim(path)
            if not _REVERSAL_MARKER.search(block)
        ]
        for path in _markdown_under(_ADR_DIR)
    }
    assert {path: found for path, found in unmarked.items() if found} == {}
