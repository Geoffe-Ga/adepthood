"""The completeness gate grades the body the server actually serves (issue #3070).

``scripts/content_completeness.py`` runs in the ``content-drift`` CI job, which
installs no app dependencies, so it cannot import ``src/``. It therefore keeps
its own copy of the frontmatter stripper and of the stage count. This module,
which runs in the full suite where ``src/`` is importable, pins both copies to
the server's: if the copies drift, the thin-chapter check would grade a
different body from the one readers receive.
"""

from __future__ import annotations

import pytest

from domain.constants import TOTAL_STAGES
from scripts.content_completeness import CONTENT_DIR, STAGE_COUNT, load_corpus, strip_frontmatter
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


def test_stage_count_matches_total_stages() -> None:
    """The gate's stage range is the program's, not a second literal."""
    assert STAGE_COUNT == TOTAL_STAGES
