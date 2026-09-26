"""Tests for the non-clinical care resources in :mod:`domain.care`.

These guard the reviewable copy: it routes to human + professional support, is
warm and non-shaming, and carries no diagnosis or medication guidance
(NORTH-STAR §10).

The :data:`~domain.care.MEDICATION_GUARDRAIL` tests (issue #890) assert the
single-source-of-truth constant exists and carries the load-bearing concepts
mandated by NORTH-STAR §10: never advise reducing/stopping/changing medication,
and defer that decision to the user and their prescriber.
"""

from __future__ import annotations

from domain.care import (
    CARE_MESSAGE,
    CARE_RESOURCES,
    CARE_TITLE,
    MEDICATION_GUARDRAIL,
    CarePayload,
    CareResource,
    build_care_payload,
)


def test_payload_carries_the_message_and_all_resources() -> None:
    payload = build_care_payload()
    assert isinstance(payload, CarePayload)
    assert payload.message == CARE_MESSAGE
    assert payload.resources == CARE_RESOURCES
    assert all(isinstance(resource, CareResource) for resource in payload.resources)


# The issue's reviewed copy (#2862): a five-word heading and a two-sentence body.
_EXPECTED_TITLE = "You're not alone in this"
_EXPECTED_MESSAGE = (
    "What you're feeling is real, and reaching out to a person is a sign of strength. "
    "The people below are there for exactly this, any time."
)
_MAX_MESSAGE_SENTENCES = 2


def test_payload_carries_a_short_title() -> None:
    payload = build_care_payload()
    assert CARE_TITLE == _EXPECTED_TITLE
    assert payload.title == CARE_TITLE


def test_message_is_at_most_two_sentences() -> None:
    assert CARE_MESSAGE == _EXPECTED_MESSAGE
    assert CARE_MESSAGE.count(".") <= _MAX_MESSAGE_SENTENCES


def test_resources_lead_with_the_crisis_lines_in_canonical_order() -> None:
    kinds = [resource.kind for resource in CARE_RESOURCES]
    assert kinds == ["hotline", "text_line", "human", "professional"]
    assert "988" in CARE_RESOURCES[0].contact
    assert "741741" in CARE_RESOURCES[1].contact


def test_routes_to_human_and_professional_support() -> None:
    kinds = {resource.kind for resource in CARE_RESOURCES}
    # Immediate human lines, a trusted person, and a professional.
    assert {"hotline", "text_line", "human", "professional"} <= kinds


def test_includes_the_expected_crisis_pointers() -> None:
    blob = " ".join(f"{r.name} {r.contact} {r.what_it_is}" for r in CARE_RESOURCES)
    assert "988" in blob
    assert "741741" in blob
    assert "trust" in blob.lower()


def test_message_is_warm_and_non_shaming() -> None:
    lowered = f"{CARE_TITLE} {CARE_MESSAGE}".lower()
    # Names that the writer is not alone and that reaching out is strength.
    assert "alone" in lowered
    assert "strength" in lowered
    # Never shaming: no framing of distress as weakness or failing.
    for shaming in ("weak", "fail", "should have"):
        assert shaming not in lowered


def test_contains_no_diagnosis_or_medication_guidance() -> None:
    blob = " ".join(f"{r.name} {r.contact} {r.what_it_is}" for r in (*CARE_RESOURCES,)).lower()
    blob += " " + CARE_TITLE.lower() + " " + CARE_MESSAGE.lower()
    for banned in ("diagnos", "medication", "prescri", "dosage", "pill", "antidepressant"):
        assert banned not in blob


# ---------------------------------------------------------------------------
# MEDICATION_GUARDRAIL — issue #890
# ---------------------------------------------------------------------------


def test_medication_guardrail_is_a_non_empty_string() -> None:
    """MEDICATION_GUARDRAIL must be a non-empty str (the constant exists and is usable)."""
    assert isinstance(MEDICATION_GUARDRAIL, str)
    assert len(MEDICATION_GUARDRAIL.strip()) > 0


def test_medication_guardrail_references_medication() -> None:
    """The guardrail must mention the word 'medication' so it is unambiguous in scope."""
    assert "medication" in MEDICATION_GUARDRAIL.lower()


def test_medication_guardrail_names_prescriber() -> None:
    """The guardrail must defer medication decisions to a prescriber (NORTH-STAR §10).

    NORTH-STAR §10: 'that decision belongs to a person and their prescriber'.
    The constant must reference 'prescriber' so the boundary is explicit and
    machine-auditable across all prompt builders that embed it.
    """
    assert "prescriber" in MEDICATION_GUARDRAIL.lower()


def test_medication_guardrail_contains_never_advise_notion() -> None:
    """The guardrail must carry a prohibition on advising medication changes.

    Acceptable phrasings include 'never advise', 'do not advise', 'never
    recommend', or equivalent.  We assert on the negative-instruction root
    'never' or 'do not' combined with the domain concept 'reduc' (reduce/
    reducing), 'stop', or 'chang' (change/changing).  At least one of the
    three target verbs must appear in the guardrail so the implementer is
    forced to address the core prohibition, not just gesture at it.
    """
    lowered = MEDICATION_GUARDRAIL.lower()
    # The constant must carry a negation word paired with the prohibited action.
    has_negation = "never" in lowered or "do not" in lowered or "not advise" in lowered
    has_prohibited_verb = any(v in lowered for v in ("reduc", "stop", "chang"))
    assert has_negation, "guardrail must contain a negation instruction (never / do not)"
    assert has_prohibited_verb, (
        "guardrail must reference the prohibited action (reduce/stop/change medication)"
    )
