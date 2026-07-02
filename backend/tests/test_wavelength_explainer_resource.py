"""Copy-contract guard for the vendored Wavelength explainer resource.

Pins the raw Markdown at ``content/markdown/resources/wavelength-explainer.md``
against content drift: the five core concepts, all six wave phases, and the
absence of shaming or ranking language must survive future edits.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Final

_RESOURCE_PATH: Final[Path] = (
    Path(__file__).resolve().parents[1]
    / "content"
    / "markdown"
    / "resources"
    / "wavelength-explainer.md"
)

_REQUIRED_KEYWORDS: Final[tuple[str, ...]] = (
    "torus",
    "spiral",
    "compression",
    "octave",
    "chord",
)

_REQUIRED_PHASES: Final[tuple[str, ...]] = (
    "Rising",
    "Peaking",
    "Withdrawal",
    "Diminishing",
    "Bottoming Out",
    "Restoration",
)

_SHAMING_LANGUAGE: Final[str] = (
    r"\b(better than|worse than|higher\s+self\s+than|superior|inferior|"
    r"failing|failure|you should|not enough|behind|fall short)\b"
)


def test_resource_file_exists() -> None:
    """The vendored explainer markdown ships at the expected path."""
    assert _RESOURCE_PATH.is_file()


def test_resource_contains_all_core_concept_keywords() -> None:
    """Every core concept keyword appears in the vendored body, case-insensitive."""
    text = _RESOURCE_PATH.read_text(encoding="utf-8").lower()

    for keyword in _REQUIRED_KEYWORDS:
        assert keyword in text


def test_resource_contains_all_six_wave_phases() -> None:
    """All six named phases of the wave cycle appear in the vendored body."""
    text = _RESOURCE_PATH.read_text(encoding="utf-8")

    for phase in _REQUIRED_PHASES:
        assert phase in text


def test_resource_never_contains_shaming_or_ranking_language() -> None:
    """The vendored body never matches the anti-shaming/ranking regex."""
    text = _RESOURCE_PATH.read_text(encoding="utf-8")

    assert re.search(_SHAMING_LANGUAGE, text, re.IGNORECASE) is None
