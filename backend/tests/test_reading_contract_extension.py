"""Verify the optional 0.25 operation against pinned producer-owned documents.

The base bundle remains 0.22 so older vaults retain every existing operation.
Discovery is unversioned; only the advertised optional operation declares 0.25.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import httpx
import jsonschema
import pytest

from domain.creek_vault import CONTRACT_VERSION, CreekCapability
from domain.reading_recommendations import ReadingCandidate, ReadingRequest, ReadingSource
from services.creek_vault_client import _CAPABILITY_BY_WIRE_NAME, HttpCreekVaultClient

_ROOT = Path(__file__).parent / "fixtures" / "creek_readings_v025"


def test_extension_pin_matches_producer_manifest_and_capability_table() -> None:
    """Every copied byte is pinned and every new translated name is published."""
    vendor = json.loads((_ROOT / "vendor.json").read_bytes())
    manifest = json.loads((_ROOT / "manifest.json").read_bytes())
    assert vendor["commit"] == "d45fd9174429b4cf118bb6f1c4a6a898fd085ce0"
    assert vendor["contract_version"] == manifest["contract_version"] == "0.25.0"
    assert CONTRACT_VERSION == "0.22.0"
    upstream = {entry["path"]: entry["sha256"] for entry in manifest["files"]}
    assert set(vendor["files"]) == {
        path.relative_to(_ROOT).as_posix()
        for path in _ROOT.rglob("*.json")
        if path.name != "vendor.json"
    }
    for name, digest in vendor["files"].items():
        assert hashlib.sha256((_ROOT / name).read_bytes()).hexdigest() == digest
        if name != "manifest.json":
            assert upstream[name] == digest
    capabilities = json.loads((_ROOT / "examples/capabilities/success.json").read_bytes())
    assert set(_CAPABILITY_BY_WIRE_NAME) == set(capabilities["capabilities"])


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["success", "empty"])
async def test_published_extension_drives_the_real_consumer(state: str) -> None:
    """Native producer discovery and responses cross the real HTTP adapter."""
    request = ReadingRequest(
        "contract-conformance",
        (ReadingCandidate(24, 1, "Synthetic reading", "A synthetic course exercise."),),
        (ReadingSource(8, None, "Synthetic journal passage.", "personal"),),
    )
    sent: list[httpx.Request] = []

    def handle(wire: httpx.Request) -> httpx.Response:
        sent.append(wire)
        if wire.url.path == "/v1/capabilities":
            assert "X-Creek-Contract-Version" not in wire.headers
            name = "examples/capabilities/success.json"
        else:
            assert wire.url.path == "/v1/reading-recommendations"
            assert wire.headers["X-Creek-Contract-Version"] == "0.25"
            schema = json.loads(
                (_ROOT / "schemas/ReadingRecommendationRequest.schema.json").read_bytes()
            )
            jsonschema.validate(json.loads(wire.content), schema)
            name = f"examples/reading-recommendations/{state}.json"
        return httpx.Response(200, json=json.loads((_ROOT / name).read_bytes()))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        client = HttpCreekVaultClient(
            "https://vault.example.test", "synthetic-key", http_client=http
        )
        handshake = await client.handshake()
        assert handshake.available
        assert handshake.keyless_inference is True
        assert client.supports(CreekCapability.READING_RECOMMENDATIONS)
        result = await client.recommend_reading(request)
    assert len(sent) == 2
    if state == "success":
        assert result is not None
        assert result.quote == request.sources[0].content
        assert result.content_id == 24
        assert result.entry_id == 8
    else:
        assert result is None
