"""Guardrail-presence tests for :mod:`domain.detection` prompt builder.

Issue #890 — medication-safety guardrail in every prompt that sends user writing
to a model.  This module asserts that :data:`~domain.care.MEDICATION_GUARDRAIL`
is embedded in the output of :func:`~domain.detection.build_detection_prompt`.

The constant does not yet exist in :mod:`domain.care`; these tests therefore
FAIL on import (``ImportError: cannot import name 'MEDICATION_GUARDRAIL'``) until
the implementation-specialist adds it.  That is the correct RED state.
"""

from __future__ import annotations

from domain.care import MEDICATION_GUARDRAIL
from domain.detection import DetectionCandidate, build_detection_prompt

# ---------------------------------------------------------------------------
# Fixtures shared across this module
# ---------------------------------------------------------------------------

_BODY = (
    "This morning I meditated for twenty minutes by the window. "
    "Later I went for a run along the river. "
    "I planned to journal tonight but never got to it."
)

_CANDIDATES = (
    DetectionCandidate(index=0, target_type="habit", target_id=10, name="Meditation"),
    DetectionCandidate(index=1, target_type="practice", target_id=20, name="Run"),
    DetectionCandidate(index=2, target_type="habit", target_id=30, name="Journal"),
)


# ---------------------------------------------------------------------------
# build_detection_prompt — completion-detection prompt
# ---------------------------------------------------------------------------


def test_build_detection_prompt_contains_medication_guardrail() -> None:
    """MEDICATION_GUARDRAIL must be a substring of build_detection_prompt(<body>, <candidates>).

    The detection prompt embeds the journal entry body verbatim and sends it to
    the model; the guardrail must accompany that call (NORTH-STAR §10).
    The assertion pins the imported constant — not a copied literal — so the
    single source of truth in :mod:`domain.care` drives all builders.
    """
    prompt = build_detection_prompt(_BODY, _CANDIDATES)
    assert MEDICATION_GUARDRAIL in prompt, (
        "build_detection_prompt must embed MEDICATION_GUARDRAIL verbatim so it "
        "reaches the model on every completion-detection call"
    )


def test_build_detection_prompt_guardrail_present_with_single_candidate() -> None:
    """Guardrail appears even when there is only one candidate (edge case)."""
    single = (DetectionCandidate(index=0, target_type="habit", target_id=10, name="Meditation"),)
    prompt = build_detection_prompt(_BODY, single)
    assert MEDICATION_GUARDRAIL in prompt


# ---------------------------------------------------------------------------
# Non-regression: JSON / anchoring contract must not break
# ---------------------------------------------------------------------------
# The guardrail is appended as instruction text; it must not corrupt the
# structured JSON contract the model returns.  The parse/anchor tests in
# ``tests/test_detection_service.py`` exercise that contract; we defer to
# them rather than duplicating here.
