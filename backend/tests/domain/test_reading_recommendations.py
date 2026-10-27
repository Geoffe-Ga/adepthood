"""Recommendations cite real current writing and select only available readings."""

from __future__ import annotations

import pytest

from domain.reading_recommendations import (
    ReadingCandidate,
    ReadingRequest,
    ReadingSource,
    parse_reading_recommendation,
)


def request() -> ReadingRequest:
    """Use synthetic source material rather than real journal content."""
    return ReadingRequest(
        catalog_version="course-1",
        readings=(ReadingCandidate(24, 6, "Embodied Understanding", "Notice resentment."),),
        sources=(
            ReadingSource(
                8, "A synthetic entry", "I noticed resentment in my shoulders.", "personal"
            ),
        ),
    )


def answer(**changes: object) -> dict[str, object]:
    """Return a grounded recommendation from the vault's published envelope."""
    return {
        "status": "ok",
        "recommendation": {
            "content_id": 24,
            "entry_id": 8,
            "quote": "resentment in my shoulders",
            "reason": "You describe resentment through a physical sensation.",
            "benefit": "A way to notice that sensation before deciding how to act.",
            **changes,
        },
    }


def test_accepts_only_a_real_source_quote_and_offered_reading() -> None:
    """The consumer independently validates the producer rather than trusting its prose."""
    result = parse_reading_recommendation(answer(), request())
    assert result is not None
    assert result.content_id == 24
    assert result.entry_id == 8
    assert result.quote in request().sources[0].content


@pytest.mark.parametrize(
    "reply",
    [
        answer(content_id=999),
        answer(entry_id=999),
        answer(quote="An invented memory"),
        answer(quote=""),
        answer(reason=""),
        answer(benefit=""),
        answer(url="https://an-unoffered-reading.example/"),
        {"status": "empty", "recommendation": None},
        {"status": "ok", "recommendation": None},
    ],
)
def test_drops_an_unverifiable_recommendation(reply: dict[str, object]) -> None:
    """There is no generic or fabricated recommendation fallback."""
    assert parse_reading_recommendation(reply, request()) is None


def test_wire_request_keeps_context_order_stable_and_excludes_private_metadata() -> None:
    """Only bounded reading text and eligible source excerpts reach the vault model."""
    body = request().wire_body()
    assert body["catalog_version"] == "course-1"
    assert body["readings"] == [
        {"content_id": 24, "title": "Embodied Understanding", "content": "Notice resentment."}
    ]
    assert body["sources"] == [
        {"entry_id": 8, "tier": "personal", "content": "I noticed resentment in my shoulders."}
    ]
