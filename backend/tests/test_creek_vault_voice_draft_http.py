"""HTTP contract tests for Creek's dedicated Voice Draft resource."""

from __future__ import annotations

from http import HTTPStatus

import httpx
import pytest

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapabilityUnsupportedError,
    CreekCeilingUnrepresentableError,
    CreekVaultUnavailableError,
    VaultIngestAction,
    VaultTierCeiling,
    VaultVoiceDraftRequest,
)
from services.creek_vault_client import CONTRACT_MINOR, HttpCreekVaultClient

_VAULT_URL = "https://vault.example.test"
_API_KEY = "voice-draft-test-key"  # pragma: allowlist secret
_EXTERNAL_ID = "adepthood-voicedraft-0123456789abcdef0123456789abcdef"
_CONTENT = "SENTINEL_VOICE_DRAFT_CONTENT"
_FRAGMENT_ID = "voice-draft-fragment-1"


def _handshake_payload(*, supports_voice_drafts: bool = True) -> dict[str, object]:
    minor = ".".join(CONTRACT_VERSION.split(".")[:2])
    return {
        "vault": {"available": True},
        "capabilities": ["voice-drafts"] if supports_voice_drafts else ["journal-upsert"],
        "contract_version": CONTRACT_VERSION,
        "contract_minor": minor,
        "supported_contract_minors": [minor],
        "ontology_version": "aptitude-wavelength/2026-05-23",
        "attestation": None,
    }


def _upsert_response(
    *,
    external_id: object = _EXTERNAL_ID,
    attribution: object = None,
) -> dict[str, object]:
    return {
        "status": "ok",
        "tier_ceiling": "personal",
        "external_id": external_id,
        "fragment_id": _FRAGMENT_ID,
        "action": "created",
        "tier": "personal",
        "attribution": (
            {"author": "ai", "author_slug": "ai-as-user", "voice_weight": 0.0}
            if attribution is None
            else attribution
        ),
    }


def _delete_response(*, external_id: object = _EXTERNAL_ID) -> dict[str, object]:
    return {
        "status": "ok",
        "tier_ceiling": "personal",
        "external_id": external_id,
        "action": "deleted",
    }


class _VoiceDraftRoute:
    """Record calls and serve a healthy handshake plus scripted draft responses."""

    def __init__(
        self,
        *,
        supports_voice_drafts: bool = True,
        upsert_response: object = None,
        delete_response: object = None,
        draft_error: Exception | None = None,
    ) -> None:
        self.supports_voice_drafts = supports_voice_drafts
        self.upsert_response = _upsert_response() if upsert_response is None else upsert_response
        self.delete_response = _delete_response() if delete_response is None else delete_response
        self.draft_error = draft_error
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path.endswith("/v1/capabilities"):
            return httpx.Response(
                HTTPStatus.OK,
                json=_handshake_payload(supports_voice_drafts=self.supports_voice_drafts),
            )
        if self.draft_error is not None:
            raise self.draft_error
        payload = self.delete_response if request.method == "DELETE" else self.upsert_response
        return httpx.Response(HTTPStatus.OK, json=payload)


def _request(
    tier: VaultTierCeiling = VaultTierCeiling.PERSONAL,
) -> VaultVoiceDraftRequest:
    return VaultVoiceDraftRequest(
        external_id=_EXTERNAL_ID,
        content=_CONTENT,
        tier=tier,
        tier_ceiling=tier,
    )


async def _client(route: _VoiceDraftRoute) -> HttpCreekVaultClient:
    transport = httpx.MockTransport(route)
    client = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=httpx.AsyncClient(transport=transport),
    )
    await client.handshake()
    return client


@pytest.mark.asyncio
async def test_http_voice_draft_upsert_uses_the_published_resource_shape() -> None:
    """PUT addresses the opaque id and sends only content plus the source tier."""
    route = _VoiceDraftRoute()
    client = await _client(route)

    result = await client.upsert_voice_draft(_request())

    assert result.stored is True
    assert result.vault_ref == _FRAGMENT_ID
    assert result.action is VaultIngestAction.CREATED
    sent = route.requests[-1]
    assert sent.method == "PUT"
    assert str(sent.url) == f"{_VAULT_URL}/v1/voice-drafts/{_EXTERNAL_ID}"
    assert sent.headers["Authorization"] == f"Bearer {_API_KEY}"
    assert sent.headers["X-Creek-Contract-Version"] == CONTRACT_MINOR
    assert sent.headers["X-Creek-Tier-Ceiling"] == "personal"
    assert sent.content == b'{"content":"SENTINEL_VOICE_DRAFT_CONTENT","tier":"personal"}'
    assert b"title" not in sent.content


@pytest.mark.asyncio
async def test_http_voice_draft_delete_sends_no_content() -> None:
    """DELETE retracts the addressed draft with only the admission headers."""
    route = _VoiceDraftRoute()
    client = await _client(route)

    result = await client.delete_voice_draft(_EXTERNAL_ID, VaultTierCeiling.PERSONAL)

    assert result.deleted is True
    sent = route.requests[-1]
    assert sent.method == "DELETE"
    assert str(sent.url) == f"{_VAULT_URL}/v1/voice-drafts/{_EXTERNAL_ID}"
    assert sent.headers["X-Creek-Tier-Ceiling"] == "personal"
    assert sent.content == b""


@pytest.mark.asyncio
async def test_http_voice_draft_capability_gate_prevents_content_egress() -> None:
    """A reachable vault that omitted voice-drafts sees only the handshake."""
    route = _VoiceDraftRoute(supports_voice_drafts=False)
    client = await _client(route)

    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.upsert_voice_draft(_request())

    assert len(route.requests) == 1
    assert _CONTENT.encode() not in route.requests[0].content


@pytest.mark.asyncio
async def test_http_voice_draft_intimate_tier_is_refused_before_egress() -> None:
    """Even a direct adapter caller cannot put an intimate essay on the wire."""
    route = _VoiceDraftRoute()
    client = await _client(route)

    with pytest.raises(CreekCeilingUnrepresentableError):
        await client.upsert_voice_draft(_request(VaultTierCeiling.INTIMATE))

    assert len(route.requests) == 1
    assert _CONTENT.encode() not in route.requests[0].content


@pytest.mark.parametrize(
    "payload",
    [
        _upsert_response(external_id="somebody-elses-draft"),
        _upsert_response(
            attribution={"author": "owner", "author_slug": "owner", "voice_weight": 1}
        ),
        {**_upsert_response(), "tier_ceiling": "intimate"},
        {**_upsert_response(), "tier": "open"},
    ],
    ids=["wrong_external_id", "owner_voice", "wider_ceiling", "wrong_source_tier"],
)
@pytest.mark.asyncio
async def test_http_voice_draft_rejects_an_untrustworthy_success(payload: object) -> None:
    """A 2xx must prove identity, tier, attribution, and zero owner voice weight."""
    client = await _client(_VoiceDraftRoute(upsert_response=payload))

    result = await client.upsert_voice_draft(_request())

    assert result.stored is False
    assert result.vault_ref is None
    assert result.action is None


@pytest.mark.asyncio
async def test_http_voice_draft_delete_rejects_the_wrong_identity_echo() -> None:
    """A delete confirmation for another resource is not our retraction."""
    client = await _client(
        _VoiceDraftRoute(delete_response=_delete_response(external_id="another-draft"))
    )

    result = await client.delete_voice_draft(_EXTERNAL_ID, VaultTierCeiling.PERSONAL)

    assert result.deleted is False


@pytest.mark.asyncio
async def test_http_voice_draft_transport_failure_is_content_free() -> None:
    """Transport errors normalize without echoing the generated essay."""
    route = _VoiceDraftRoute(draft_error=httpx.ConnectError("offline"))
    client = await _client(route)

    with pytest.raises(CreekVaultUnavailableError) as exc_info:
        await client.upsert_voice_draft(_request())

    assert _CONTENT not in str(exc_info.value)
    assert _API_KEY not in str(exc_info.value)
    assert exc_info.value.__cause__ is None


@pytest.mark.asyncio
async def test_http_voice_draft_external_id_is_one_inert_path_segment() -> None:
    """A direct caller cannot redirect draft content with slashes or dot segments."""
    hostile_id = "../draft/elsewhere"
    route = _VoiceDraftRoute(upsert_response=_upsert_response(external_id=hostile_id))
    client = await _client(route)
    request = VaultVoiceDraftRequest(
        external_id=hostile_id,
        content=_CONTENT,
        tier=VaultTierCeiling.PERSONAL,
        tier_ceiling=VaultTierCeiling.PERSONAL,
    )

    result = await client.upsert_voice_draft(request)

    assert result.stored is True
    sent = route.requests[-1]
    assert sent.url.raw_path.endswith(b"/%2E%2E%2Fdraft%2Felsewhere")
