"""The grounded offer uses only the versioned, keyless managed-vault operation."""

from __future__ import annotations

import json

import httpx
import pytest

from domain.reading_recommendations import ReadingCandidate, ReadingRequest, ReadingSource
from services.creek_vault_client import HttpCreekVaultClient


def context() -> ReadingRequest:
    return ReadingRequest(
        "course-1",
        (ReadingCandidate(24, 6, "Embodied understanding", "Notice resentment."),),
        (ReadingSource(8, None, "I noticed resentment in my shoulders.", "personal"),),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("ready", [True, False, None])
async def test_reading_recommendation_requires_keyless_model_and_uses_own_minor(
    ready: bool | None,
) -> None:
    sent: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        if request.url.path == "/v1/capabilities":
            return httpx.Response(
                200,
                json={
                    "contract_version": "0.25.0",
                    "ontology_version": "1.0.0",
                    "supported_contract_minors": ["0.22", "0.25"],
                    "capabilities": ["capabilities", "reading-recommendations"],
                    "vault": {"available": True},
                    "keyless_inference": ready,
                },
            )
        assert request.url.path == "/v1/reading-recommendations"
        assert request.headers["X-Creek-Contract-Version"] == "0.25"
        assert request.headers["X-Creek-Tier-Ceiling"] == "personal"
        assert not any("provider" in key.lower() for key in request.headers)
        assert json.loads(request.content) == context().wire_body()
        return httpx.Response(
            200,
            json={
                "status": "ok",
                "recommendation": {
                    "content_id": 24,
                    "entry_id": 8,
                    "quote": "resentment in my shoulders",
                    "reason": "You describe a bodily sensation.",
                    "benefit": "A practice for noticing it.",
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as transport:
        client = HttpCreekVaultClient(
            "https://vault.example.test", "synthetic-token", http_client=transport
        )
        handshake = await client.handshake()
        assert handshake.available
        result = await client.recommend_reading(context())
    assert (result is not None) is (ready is True)
    assert len(sent) == (2 if ready is True else 1)
