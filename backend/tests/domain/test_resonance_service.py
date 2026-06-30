"""Guardrail-presence tests for :mod:`domain.resonance` prompt builders.

Issue #890 — medication-safety guardrail in every prompt that sends user writing
to a model.  These tests assert that :data:`~domain.care.MEDICATION_GUARDRAIL`
is embedded in the output of every resonance prompt builder, pinning the
single-source-of-truth constant rather than a copied literal.

The constant does not yet exist in :mod:`domain.care`; these tests therefore
FAIL on import (``ImportError: cannot import name 'MEDICATION_GUARDRAIL'``) until
the implementation-specialist adds it.  That is the correct RED state.
"""

from __future__ import annotations

from domain.care import MEDICATION_GUARDRAIL
from domain.resonance import _build_essay_prompt, build_prompt

# ---------------------------------------------------------------------------
# Fixtures shared across this module
# ---------------------------------------------------------------------------

_BODY = (
    "Today I walked by the river and felt the old fear rise again. "
    "But I noticed the willow bending without breaking, and something settled."
)

_ANCHOR_TEXT = "the willow bending without breaking"
_KIND = "symbol"
_NOTE = "The willow holds you."


# ---------------------------------------------------------------------------
# build_prompt — main resonance prompt
# ---------------------------------------------------------------------------


def test_build_prompt_contains_medication_guardrail() -> None:
    """MEDICATION_GUARDRAIL must be a substring of build_prompt(<body>).

    The guardrail is sourced from :data:`domain.care.MEDICATION_GUARDRAIL` so
    the constant is the single source of truth; a copied literal would not
    satisfy this test if the constant wording changes.
    """
    prompt = build_prompt(_BODY)
    assert MEDICATION_GUARDRAIL in prompt, (
        "build_prompt must embed MEDICATION_GUARDRAIL verbatim so it reaches "
        "the model on every resonance call"
    )


def test_build_prompt_with_prior_entries_contains_medication_guardrail() -> None:
    """Guardrail must survive the prior-entries branch of build_prompt."""
    prompt = build_prompt(_BODY, prior_entries=["An earlier entry about water."])
    assert MEDICATION_GUARDRAIL in prompt


# ---------------------------------------------------------------------------
# _build_essay_prompt — expansion prompt
# ---------------------------------------------------------------------------


def test_build_essay_prompt_contains_medication_guardrail() -> None:
    """MEDICATION_GUARDRAIL must be a substring of _build_essay_prompt(...).

    The essay builder sends the full entry body to the model; the guardrail
    must accompany that call too (NORTH-STAR §10).
    """
    prompt = _build_essay_prompt(_BODY, _ANCHOR_TEXT, _KIND, _NOTE)
    assert MEDICATION_GUARDRAIL in prompt, (
        "_build_essay_prompt must embed MEDICATION_GUARDRAIL verbatim"
    )


# ---------------------------------------------------------------------------
# Non-regression: existing parse / anchoring contract must not break
# ---------------------------------------------------------------------------
# The added guardrail text is instruction overhead injected into the system /
# prompt string; it must not interfere with the JSON parsing contract.
# The parse-and-anchor tests live in ``tests/test_resonance_service.py``
# (the top-level module that was the original home for resonance tests).
# We do not duplicate them here — see that file for coverage.
