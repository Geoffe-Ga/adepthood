"""The completeness gate grades the body the server actually serves (issue #3070).

``scripts/content_completeness.py`` runs in the ``content-drift`` CI job, which
installs no app dependencies, so it cannot import ``src/``. It therefore keeps
its own copy of the frontmatter stripper and of the stage count. This module,
which runs in the full suite where ``src/`` is importable, pins both copies to
the server's: if the copies drift, the thin-chapter check would grade a
different body from the one readers receive.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from domain.constants import TOTAL_STAGES
from scripts.content_completeness import (
    CONTENT_DIR,
    STAGE_COUNT,
    body_word_count,
    load_corpus,
    strip_frontmatter,
)
from services.content_repository import _strip_frontmatter

_BOM = "\ufeff"


def test_strip_frontmatter_matches_served_body() -> None:
    """Every served file strips to exactly the body the content repository serves."""
    corpus = load_corpus(CONTENT_DIR)
    assert corpus.documents
    for document in corpus.documents:
        text = (CONTENT_DIR / document.path).read_text(encoding="utf-8")
        assert strip_frontmatter(text) == _strip_frontmatter(text), document.path


@pytest.mark.parametrize(
    "text",
    [
        f"{_BOM}---\ntitle: x\n---\nbody\n",
        "---\ntitle: never closed\nbody\n",
        "prose\n---\nthematic break\n",
        "",
        "---  \na: b\n---\t\nbody",
    ],
    ids=["bom", "unclosed", "late-fence", "empty", "trailing-space-fences"],
)
def test_strip_frontmatter_matches_server_on_edge_cases(text: str) -> None:
    """BOM, unclosed fence, a later thematic break and empty input all agree."""
    assert strip_frontmatter(text) == _strip_frontmatter(text)


def test_gate_grades_exactly_the_served_body(tmp_path: Path) -> None:
    """The gate grades the server's body along its own call path, stripping once.

    Through ``load_corpus`` -> ``Document.body``, the graded body equals the
    server's body for every served file and for a body that opens with a ``---``
    thematic break, and the word count is taken from that body as-is.
    """
    corpus = load_corpus(CONTENT_DIR)
    for document in corpus.documents:
        served = _strip_frontmatter((CONTENT_DIR / document.path).read_text(encoding="utf-8"))
        assert document.body == served, document.path
        assert body_word_count(document.body) == _prose_words(served), document.path

    text = "---\ntitle: x\n---\n---\nalpha beta gamma\n---\nend\n"
    (tmp_path / "markdown").mkdir()
    (tmp_path / "markdown" / "c.md").write_text(text, encoding="utf-8")
    chapter = {
        "id": "c",
        "stage": 1,
        "chapter": 1,
        "slug": "c",
        "title": "C",
        "path": "markdown/c.md",
    }
    manifest = {"chapters": [chapter], "stage_intros": [], "site_resources": []}
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (document,) = load_corpus(tmp_path).documents
    assert document.body == _strip_frontmatter(text)
    assert body_word_count(document.body) == _prose_words(_strip_frontmatter(text))


def _prose_words(served: str) -> int:
    """Words on non-heading lines, computed independently of the gate."""
    return sum(
        len(line.split()) for line in served.splitlines() if not re.match(r"^\s{0,3}#{1,6}\s", line)
    )


def test_stage_count_matches_total_stages() -> None:
    """The gate's stage range is the program's, not a second literal."""
    assert STAGE_COUNT == TOTAL_STAGES
