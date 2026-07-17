"""Tests for the Creek Vault MCP client seam (services.creek_vault_client)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import cast

import httpx
import pytest
from pydantic import ValidationError

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultIngestRequest,
    VaultIngestResult,
    VaultTierCeiling,
    VaultWheelAspect,
    VaultWheelBalance,
)
from services.creek_vault_client import (
    LocalFallbackCreekVaultClient,
    McpCreekVaultClient,
    build_creek_vault_client,
)

_CREATED_AT = datetime(2026, 7, 10, 12, 0, tzinfo=UTC)


def _handshake_payload(
    capabilities: Sequence[str],
    contract_version: str = CONTRACT_VERSION,
    ontology_version: str = "1.0.0",
    attestation: Mapping[str, object] | None = None,
) -> dict[str, object]:
    """Build a well-formed creek.handshake response payload."""
    return {
        "capabilities": list(capabilities),
        "contract_version": contract_version,
        "ontology_version": ontology_version,
        "attestation": attestation,
    }


class ScriptedTransport:
    """Fake transport whose per-method responses/exceptions are pre-scripted."""

    def __init__(
        self,
        responses: Mapping[str, Mapping[str, object]] | None = None,
        raises: Mapping[str, Exception] | None = None,
    ) -> None:
        """Store the scripted per-method responses and exceptions."""
        self._responses = dict(responses or {})
        self._raises = dict(raises or {})

    async def call(self, method: str, _params: Mapping[str, object]) -> Mapping[str, object]:
        """Raise or return the scripted result for ``method``."""
        if method in self._raises:
            raise self._raises[method]
        return self._responses.get(method, {})


class RaisingTransport:
    """Fake transport whose call() always raises a fixed exception."""

    def __init__(self, exc: Exception) -> None:
        """Store the exception this fake will raise on every call."""
        self._exc = exc

    async def call(self, _method: str, _params: Mapping[str, object]) -> Mapping[str, object]:
        """Raise the stored exception unconditionally."""
        raise self._exc


class GarbagePayloadTransport:
    """Fake transport that returns a fixed, possibly malformed payload for any call."""

    def __init__(self, payload: Mapping[str, object]) -> None:
        """Store the payload this fake will return verbatim."""
        self._payload = payload

    async def call(self, _method: str, _params: Mapping[str, object]) -> Mapping[str, object]:
        """Return the stored payload regardless of method or params."""
        return self._payload


class MutableHandshakeTransport:
    """Fake transport whose advertised capabilities can change between calls."""

    def __init__(self, capabilities: Sequence[str]) -> None:
        """Store the initially advertised capability list."""
        self.capabilities = list(capabilities)
        self.handshake_calls = 0

    async def call(self, method: str, _params: Mapping[str, object]) -> Mapping[str, object]:
        """Return the current capability list for creek.handshake."""
        if method == CreekCapability.HANDSHAKE.value:
            self.handshake_calls += 1
            return _handshake_payload(self.capabilities)
        return {}


class HandshakeThenNonMappingTransport:
    """Handshakes normally, then returns a non-mapping payload for any other call."""

    def __init__(self, capability: str, payload: object) -> None:
        """Store the capability to advertise and the non-mapping payload to return."""
        self._capability = capability
        self._payload = payload

    async def call(self, method: str, _params: Mapping[str, object]) -> Mapping[str, object]:
        """Return a valid handshake for the probe, else the stored non-mapping payload."""
        if method == CreekCapability.HANDSHAKE.value:
            return _handshake_payload([self._capability])
        return cast("Mapping[str, object]", self._payload)


def _ingest_request() -> VaultIngestRequest:
    """Build a minimal VaultIngestRequest for the ingest-path tests."""
    return VaultIngestRequest(
        body="hello vault", tier_ceiling=VaultTierCeiling.OPEN, created_at=_CREATED_AT
    )


@pytest.mark.asyncio
async def test_handshake_happy_path_populates_result() -> None:
    """A successful handshake returns a populated HandshakeResult."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload(
                [CreekCapability.INGEST.value, CreekCapability.WHEEL.value],
                attestation={"quote": "sentinel-attestation"},
            )
        }
    )
    client = McpCreekVaultClient(transport=transport)
    result = await client.handshake()
    assert result.available is True
    assert result.contract_version == CONTRACT_VERSION
    assert result.ontology_version == "1.0.0"
    assert result.capabilities == frozenset({CreekCapability.INGEST, CreekCapability.WHEEL})
    assert result.attestation == {"quote": "sentinel-attestation"}


@pytest.mark.asyncio
async def test_is_available_true_after_successful_handshake() -> None:
    """is_available() reflects a successful handshake."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.INGEST.value])
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    assert client.is_available() is True


@pytest.mark.asyncio
async def test_supports_reflects_advertised_capabilities() -> None:
    """supports() is True only for the capabilities the handshake advertised."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.INGEST.value])
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    assert client.supports(CreekCapability.INGEST) is True
    assert client.supports(CreekCapability.WHEEL) is False


@pytest.mark.asyncio
async def test_unknown_advertised_capability_strings_are_ignored() -> None:
    """A capability string outside CreekCapability is dropped, not erroring."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload(
                [CreekCapability.INGEST.value, "creek.unknown-future-capability"]
            )
        }
    )
    client = McpCreekVaultClient(transport=transport)
    result = await client.handshake()
    assert result.capabilities == frozenset({CreekCapability.INGEST})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "exc",
    [
        OSError("connection refused"),
        TimeoutError("timed out"),
        httpx.ConnectError("unreachable"),
    ],
)
async def test_handshake_degrades_to_unavailable_on_transport_error(exc: Exception) -> None:
    """A raising transport never propagates -- handshake() degrades to unavailable."""
    client = McpCreekVaultClient(transport=RaisingTransport(exc))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()


@pytest.mark.asyncio
async def test_handshake_degrades_to_unavailable_on_missing_keys() -> None:
    """A payload missing the expected keys degrades to unavailable, not a raise."""
    client = McpCreekVaultClient(transport=GarbagePayloadTransport({"unexpected": "shape"}))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()


@pytest.mark.asyncio
async def test_handshake_degrades_to_unavailable_on_wrong_typed_fields() -> None:
    """A payload with wrong-typed fields degrades to unavailable, not a raise."""
    payload = {
        "capabilities": "not-a-list",
        "contract_version": 123,
        "ontology_version": None,
        "attestation": None,
    }
    client = McpCreekVaultClient(transport=GarbagePayloadTransport(payload))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()


@pytest.mark.asyncio
async def test_handshake_degrades_to_unavailable_on_non_list_capabilities() -> None:
    """Valid versions but a non-list capabilities field degrades to unavailable."""
    payload = {
        "capabilities": "not-a-list",
        "contract_version": CONTRACT_VERSION,
        "ontology_version": "1.0.0",
        "attestation": None,
    }
    client = McpCreekVaultClient(transport=GarbagePayloadTransport(payload))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()


@pytest.mark.asyncio
async def test_handshake_degrades_to_unavailable_on_contract_major_mismatch() -> None:
    """A contract-major-version mismatch degrades to unavailable, not a raise."""
    payload = _handshake_payload([CreekCapability.INGEST.value], contract_version="1.0.0")
    client = McpCreekVaultClient(transport=GarbagePayloadTransport(payload))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()


@pytest.mark.asyncio
async def test_handshake_ignores_non_string_capability_alongside_valid_ones() -> None:
    """A non-string capability entry is dropped while valid string entries still parse."""
    payload: dict[str, object] = {
        "capabilities": [CreekCapability.INGEST.value, 42, CreekCapability.WHEEL.value],
        "contract_version": CONTRACT_VERSION,
        "ontology_version": "1.0.0",
        "attestation": None,
    }
    client = McpCreekVaultClient(transport=GarbagePayloadTransport(payload))
    result = await client.handshake()
    assert result.available is True
    assert result.capabilities == frozenset({CreekCapability.INGEST, CreekCapability.WHEEL})


@pytest.mark.asyncio
async def test_handshake_degrades_to_unavailable_on_malformed_attestation() -> None:
    """An attestation field that is neither a mapping nor null degrades to unavailable."""
    payload: dict[str, object] = {
        "capabilities": [CreekCapability.INGEST.value],
        "contract_version": CONTRACT_VERSION,
        "ontology_version": "1.0.0",
        "attestation": "not-a-mapping",
    }
    client = McpCreekVaultClient(transport=GarbagePayloadTransport(payload))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()


@pytest.mark.asyncio
async def test_supported_capability_call_succeeds() -> None:
    """ingest() succeeds through a transport that advertised INGEST at handshake."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.INGEST.value]),
            CreekCapability.INGEST.value: {"stored": True, "vault_ref": "vault-ref-1"},
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    result = await client.ingest(_ingest_request())
    assert result == VaultIngestResult(stored=True, vault_ref="vault-ref-1")


@pytest.mark.asyncio
async def test_unsupported_capability_raises_unsupported_error() -> None:
    """wheel() raises when the handshake did not advertise WHEEL."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.INGEST.value])
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.wheel()


@pytest.mark.asyncio
async def test_supported_call_normalizes_transport_error() -> None:
    """A supported call whose transport then raises normalizes to CreekVaultUnavailableError."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.INGEST.value])
        },
        raises={CreekCapability.INGEST.value: OSError("connection reset")},
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    with pytest.raises(CreekVaultUnavailableError):
        await client.ingest(_ingest_request())


@pytest.mark.asyncio
async def test_classify_success_drops_non_string_tags() -> None:
    """classify() returns only the string tags, dropping non-string entries."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.CLASSIFY.value]),
            CreekCapability.CLASSIFY.value: {"tags": ["courage", "shadow", 123]},
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    result = await client.classify("body text", VaultTierCeiling.OPEN)
    assert result == VaultClassification(tags=("courage", "shadow"))


@pytest.mark.asyncio
async def test_classify_missing_tags_returns_empty_classification() -> None:
    """classify() returns an empty tag tuple when the response tags are absent or wrong-typed."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.CLASSIFY.value]),
            CreekCapability.CLASSIFY.value: {"tags": "not-a-list"},
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    result = await client.classify("body text", VaultTierCeiling.OPEN)
    assert result == VaultClassification(tags=())


@pytest.mark.asyncio
async def test_reflect_success_returns_reflection_text() -> None:
    """reflect() returns the reflection string from a successful vault response."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.REFLECT.value]),
            CreekCapability.REFLECT.value: {"reflection": "a warm note"},
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    result = await client.reflect("body text", VaultTierCeiling.OPEN)
    assert result == "a warm note"


@pytest.mark.asyncio
async def test_reflect_missing_reflection_returns_empty_string() -> None:
    """reflect() returns the empty string when the response reflection is absent or wrong-typed."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.REFLECT.value]),
            CreekCapability.REFLECT.value: {"reflection": 123},
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    result = await client.reflect("body text", VaultTierCeiling.OPEN)
    assert result == ""


@pytest.mark.asyncio
async def test_wheel_success_projects_onto_vault_wheel_balance() -> None:
    """wheel() projects a vault-computed wheel payload onto VaultWheelBalance."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.WHEEL.value]),
            CreekCapability.WHEEL.value: {
                "aspects": [
                    {"stage_number": 1, "aspect": "courage", "fullness": 0.5},
                    {"stage_number": 2, "aspect": "shadow", "fullness": 0.75},
                ]
            },
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    result = await client.wheel()
    assert result == VaultWheelBalance(
        aspects=(
            VaultWheelAspect(stage_number=1, aspect="courage", fullness=0.5),
            VaultWheelAspect(stage_number=2, aspect="shadow", fullness=0.75),
        )
    )


@pytest.mark.asyncio
async def test_wheel_malformed_fields_raise_validation_error() -> None:
    """wheel() does not normalize a bad-fields payload; the parse error surfaces."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.WHEEL.value]),
            CreekCapability.WHEEL.value: {"aspects": [{"stage_number": "not-an-int"}]},
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    with pytest.raises(ValidationError):
        await client.wheel()


@pytest.mark.asyncio
async def test_reprobe_picks_up_newly_advertised_capability() -> None:
    """A second handshake() against a transport advertising a new capability flips supports()."""
    transport = MutableHandshakeTransport(capabilities=[CreekCapability.INGEST.value])
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    assert client.supports(CreekCapability.WHEEL) is False
    transport.capabilities = [CreekCapability.INGEST.value, CreekCapability.WHEEL.value]
    await client.handshake()
    assert client.supports(CreekCapability.WHEEL) is True
    assert transport.handshake_calls == 2


def test_fresh_client_reports_unavailable_before_handshake() -> None:
    """A client that has never handshaken reports unavailable and unsupported."""
    client = McpCreekVaultClient(transport=RaisingTransport(OSError("never called")))
    assert client.is_available() is False
    assert client.supports(CreekCapability.INGEST) is False
    assert client.supports(CreekCapability.WHEEL) is False


@pytest.mark.asyncio
async def test_local_fallback_handshake_is_unavailable() -> None:
    """LocalFallbackCreekVaultClient.handshake() reports unavailable with no transport."""
    client = LocalFallbackCreekVaultClient()
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()


def test_local_fallback_is_available_false() -> None:
    """LocalFallbackCreekVaultClient.is_available() is False."""
    assert LocalFallbackCreekVaultClient().is_available() is False


def test_local_fallback_supports_nothing() -> None:
    """LocalFallbackCreekVaultClient.supports() is False for every capability."""
    client = LocalFallbackCreekVaultClient()
    assert all(client.supports(capability) is False for capability in CreekCapability)


@pytest.mark.asyncio
async def test_local_fallback_ingest_reports_not_stored_without_raising() -> None:
    """ingest() on the local fallback reports stored=False and never raises."""
    client = LocalFallbackCreekVaultClient()
    result = await client.ingest(_ingest_request())
    assert result == VaultIngestResult(stored=False, vault_ref=None)


@pytest.mark.asyncio
async def test_local_fallback_classify_raises_unsupported() -> None:
    """classify() on the local fallback raises CreekCapabilityUnsupportedError."""
    client = LocalFallbackCreekVaultClient()
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.classify("body text", VaultTierCeiling.OPEN)


@pytest.mark.asyncio
async def test_local_fallback_reflect_raises_unsupported() -> None:
    """reflect() on the local fallback raises CreekCapabilityUnsupportedError."""
    client = LocalFallbackCreekVaultClient()
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.reflect("body text", VaultTierCeiling.OPEN)


@pytest.mark.asyncio
async def test_local_fallback_wheel_raises_unsupported() -> None:
    """wheel() on the local fallback raises CreekCapabilityUnsupportedError."""
    client = LocalFallbackCreekVaultClient()
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.wheel()


def test_factory_returns_local_fallback_when_env_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """CREEK_VAULT_URL unset -> LocalFallbackCreekVaultClient."""
    monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    client = build_creek_vault_client()
    assert isinstance(client, LocalFallbackCreekVaultClient)


def test_factory_returns_local_fallback_when_env_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    """CREEK_VAULT_URL set to the empty string -> LocalFallbackCreekVaultClient."""
    monkeypatch.setenv("CREEK_VAULT_URL", "")
    client = build_creek_vault_client()
    assert isinstance(client, LocalFallbackCreekVaultClient)


def test_factory_returns_mcp_client_when_env_set(monkeypatch: pytest.MonkeyPatch) -> None:
    """CREEK_VAULT_URL set -> McpCreekVaultClient using the injected transport."""
    monkeypatch.setenv("CREEK_VAULT_URL", "https://vault.example.test")
    client = build_creek_vault_client(transport=ScriptedTransport())
    assert isinstance(client, McpCreekVaultClient)


def test_factory_rejects_plaintext_remote_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """A plaintext http:// URL to a remote host fails closed rather than leaking the key."""
    monkeypatch.setenv("CREEK_VAULT_URL", "http://vault.example.test")
    monkeypatch.delenv("CREEK_VAULT_API_KEY", raising=False)
    with pytest.raises(ValueError, match="https"):
        build_creek_vault_client()


def test_factory_accepts_https_remote_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """An https URL to a remote host builds a real transport without raising."""
    monkeypatch.setenv("CREEK_VAULT_URL", "https://vault.example.test")
    monkeypatch.delenv("CREEK_VAULT_API_KEY", raising=False)
    assert isinstance(build_creek_vault_client(), McpCreekVaultClient)


def test_factory_accepts_plaintext_loopback_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """Plaintext http:// to a loopback host is tolerated for local development."""
    monkeypatch.setenv("CREEK_VAULT_URL", "http://localhost:8000")
    monkeypatch.delenv("CREEK_VAULT_API_KEY", raising=False)
    assert isinstance(build_creek_vault_client(), McpCreekVaultClient)


@pytest.mark.asyncio
async def test_supported_call_normalizes_non_mapping_payload() -> None:
    """A supported call whose response is not a mapping degrades to CreekVaultUnavailableError."""
    transport = HandshakeThenNonMappingTransport(
        CreekCapability.INGEST.value, ["not", "a", "mapping"]
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    with pytest.raises(CreekVaultUnavailableError):
        await client.ingest(_ingest_request())


@pytest.mark.asyncio
async def test_unavailable_error_never_leaks_body_or_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CreekVaultUnavailableError's message never contains the entry body or the API key."""
    body_sentinel = "SENTINEL_BODY_TEXT_DO_NOT_LEAK"
    key_sentinel = "SENTINEL_API_KEY_DO_NOT_LEAK"
    monkeypatch.setenv("CREEK_VAULT_API_KEY", key_sentinel)
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.INGEST.value])
        },
        raises={
            CreekCapability.INGEST.value: OSError(
                f"upstream rejected body: {body_sentinel} key={key_sentinel}"
            )
        },
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    request = VaultIngestRequest(
        body=body_sentinel, tier_ceiling=VaultTierCeiling.OPEN, created_at=_CREATED_AT
    )
    with pytest.raises(CreekVaultUnavailableError) as exc_info:
        await client.ingest(request)
    message = str(exc_info.value)
    assert body_sentinel not in message
    assert key_sentinel not in message
    # ``from None`` must sever the chain so no traceback printer surfaces the
    # original exception (whose text carries both sentinels) as a cause/context.
    assert exc_info.value.__cause__ is None
    assert exc_info.value.__suppress_context__ is True
