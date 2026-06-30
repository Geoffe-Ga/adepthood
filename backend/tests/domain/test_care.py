"""Tests for the non-clinical care resources in :mod:`domain.care`.

These guard the reviewable copy: it routes to human + professional support, is
warm and non-shaming, and carries no diagnosis or medication guidance
(NORTH-STAR §10).
"""

from __future__ import annotations

from domain.care import (
    CARE_MESSAGE,
    CARE_RESOURCES,
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
    lowered = CARE_MESSAGE.lower()
    # Explicitly reframes distress as not a failure; never shaming.
    assert "failure" in lowered
    assert "alone" in lowered


def test_contains_no_diagnosis_or_medication_guidance() -> None:
    blob = " ".join(f"{r.name} {r.contact} {r.what_it_is}" for r in (*CARE_RESOURCES,)).lower()
    blob += " " + CARE_MESSAGE.lower()
    for banned in ("diagnos", "medication", "prescri", "dosage", "pill", "antidepressant"):
        assert banned not in blob
