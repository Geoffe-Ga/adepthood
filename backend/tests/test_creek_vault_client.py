"""Tests for the Creek Vault MCP client seam (services.creek_vault_client)."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime
from typing import cast

import httpx
import pytest
from mcp import ClientSession
from mcp.server.fastmcp import FastMCP
from mcp.shared.exceptions import McpError
from mcp.shared.memory import create_connected_server_and_client_session
from mcp.types import CallToolResult, ImageContent, TextContent
from pydantic import BaseModel, ValidationError

from domain.constants import TOTAL_STAGES
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
from domain.resonance import ANCHOR_TEXT_MAX, NOTE_MAX, VALID_KINDS
from services.creek_vault_client import (
    _MARGINALIA_KIND_BY_CREEK_KIND,
    _MAX_FRAGMENT_ID_LENGTH,
    _MAX_REFLECT_NOTES,
    LocalFallbackCreekVaultClient,
    McpCreekVaultClient,
    _extract_tool_payload,
    _handshake_params,
    _ingest_params,
    _McpStreamableHttpTransport,
    _parse_ingest_result,
    _parse_reflection,
    _reflect_params,
    build_creek_vault_client,
)

_VAULT_URL = "https://vault.example.test"

_CREATED_AT = datetime(2026, 7, 10, 12, 0, tzinfo=UTC)

# One well-formed creek note's quote and note text, reused so the hygiene matrix
# can pair exactly one malformed item against a known-good sibling.
_REFLECT_QUOTE = "the river kept moving"
_REFLECT_NOTE = "You keep reaching for motion when you write about rest."

# Creek's seven published note kinds, restated here on purpose: this literal is
# the pin against the vocabulary drifting out from under the mapping table.
_CREEK_NOTE_KINDS = frozenset(
    {"reframe", "fear", "longing", "value", "pattern", "tension", "gift"},
)


def _handshake_payload(
    capabilities: Sequence[str],
    contract_version: str = CONTRACT_VERSION,
    ontology_version: str = "1.0.0",
    attestation: Mapping[str, object] | None = None,
    *,
    available: bool = True,
) -> dict[str, object]:
    """Build a well-formed creek.handshake response payload."""
    return {
        "available": available,
        "capabilities": list(capabilities),
        "contract_version": contract_version,
        "ontology_version": ontology_version,
        "attestation": attestation,
    }


def _creek_note(kind: object, quote: object, note: object) -> dict[str, object]:
    """Build one creek.reflect note item, allowing deliberately malformed field types."""
    return {"kind": kind, "quote": quote, "note": note}


def _reflect_payload(notes: object) -> dict[str, object]:
    """Build a well-formed creek.reflect ok-status response carrying ``notes``."""
    return {
        "status": "ok",
        "tool": CreekCapability.REFLECT.value,
        "tier_ceiling": VaultTierCeiling.OPEN.value,
        "routed_tier": VaultTierCeiling.OPEN.value,
        "notes": notes,
        "essay_grounded": False,
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
        entry_id=7,
        body="hello vault",
        tier=VaultTierCeiling.OPEN,
        tier_ceiling=VaultTierCeiling.OPEN,
        created_at=_CREATED_AT,
    )


@pytest.mark.asyncio
async def test_handshake_happy_path_populates_result() -> None:
    """A successful handshake returns a populated HandshakeResult."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload(
                [CreekCapability.JOURNAL.value, CreekCapability.WHEEL.value],
                attestation={"quote": "sentinel-attestation"},
            )
        }
    )
    client = McpCreekVaultClient(transport=transport)
    result = await client.handshake()
    assert result.available is True
    assert result.contract_version == CONTRACT_VERSION
    assert result.ontology_version == "1.0.0"
    assert result.capabilities == frozenset({CreekCapability.JOURNAL, CreekCapability.WHEEL})
    assert result.attestation == {"quote": "sentinel-attestation"}


@pytest.mark.asyncio
async def test_is_available_true_after_successful_handshake() -> None:
    """is_available() reflects a successful handshake."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.JOURNAL.value])
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
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.JOURNAL.value])
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    assert client.supports(CreekCapability.JOURNAL) is True
    assert client.supports(CreekCapability.WHEEL) is False


@pytest.mark.asyncio
async def test_unknown_advertised_capability_strings_are_ignored() -> None:
    """A capability string outside CreekCapability is dropped, not erroring."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload(
                [CreekCapability.JOURNAL.value, "creek.unknown-future-capability"]
            )
        }
    )
    client = McpCreekVaultClient(transport=transport)
    result = await client.handshake()
    assert result.capabilities == frozenset({CreekCapability.JOURNAL})


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
    """Valid versions and availability but a non-list capabilities field degrades to unavailable."""
    payload = {
        "available": True,
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
    payload = _handshake_payload([CreekCapability.JOURNAL.value], contract_version="1.0.0")
    client = McpCreekVaultClient(transport=GarbagePayloadTransport(payload))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()


@pytest.mark.asyncio
async def test_handshake_degrades_when_response_marks_unavailable() -> None:
    """A reachable vault that reports available=False degrades to unavailable."""
    payload = _handshake_payload([CreekCapability.JOURNAL.value], available=False)
    client = McpCreekVaultClient(transport=GarbagePayloadTransport(payload))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()


@pytest.mark.asyncio
async def test_handshake_ignores_non_string_capability_alongside_valid_ones() -> None:
    """A non-string capability entry is dropped while valid string entries still parse."""
    payload: dict[str, object] = {
        "available": True,
        "capabilities": [CreekCapability.JOURNAL.value, 42, CreekCapability.WHEEL.value],
        "contract_version": CONTRACT_VERSION,
        "ontology_version": "1.0.0",
        "attestation": None,
    }
    client = McpCreekVaultClient(transport=GarbagePayloadTransport(payload))
    result = await client.handshake()
    assert result.available is True
    assert result.capabilities == frozenset({CreekCapability.JOURNAL, CreekCapability.WHEEL})


@pytest.mark.asyncio
async def test_handshake_degrades_to_unavailable_on_malformed_attestation() -> None:
    """An attestation field that is neither a mapping nor null degrades to unavailable."""
    payload: dict[str, object] = {
        "available": True,
        "capabilities": [CreekCapability.JOURNAL.value],
        "contract_version": CONTRACT_VERSION,
        "ontology_version": "1.0.0",
        "attestation": "not-a-mapping",
    }
    client = McpCreekVaultClient(transport=GarbagePayloadTransport(payload))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()


def test_handshake_params_sends_only_privacy_tier_ceiling() -> None:
    """Handshake params carry only privacy_tier_ceiling, never consumer or contract_version."""
    params = _handshake_params()
    assert params == {"privacy_tier_ceiling": VaultTierCeiling.OPEN.value}


def test_ingest_params_maps_entry_onto_wire_fields() -> None:
    """Ingest params carry exactly the creek.journal wire fields, with no consumer key."""
    request = VaultIngestRequest(
        entry_id=99,
        body="page",
        tier=VaultTierCeiling.PERSONAL,
        tier_ceiling=VaultTierCeiling.PERSONAL,
        created_at=_CREATED_AT,
    )
    assert _ingest_params(request) == {
        "content": "page",
        "external_id": "99",
        "timestamp": _CREATED_AT.isoformat(),
        "tier": "personal",
        "privacy_tier_ceiling": "personal",
    }
    assert "consumer" not in _ingest_params(request)


def test_parse_ingest_result_error_status_is_not_stored() -> None:
    """A non-ok status parses to stored=False with no vault_ref."""
    result = _parse_ingest_result({"status": "error", "fragment_id": "x"})
    assert result == VaultIngestResult(stored=False, vault_ref=None)


def test_parse_ingest_result_missing_fragment_id_is_not_stored() -> None:
    """An ok status with no fragment_id parses to stored=False with no vault_ref."""
    result = _parse_ingest_result({"status": "ok"})
    assert result == VaultIngestResult(stored=False, vault_ref=None)


def test_parse_ingest_result_empty_fragment_id_is_not_stored() -> None:
    """An ok status with an empty fragment_id parses to stored=False with no vault_ref."""
    result = _parse_ingest_result({"status": "ok", "fragment_id": ""})
    assert result == VaultIngestResult(stored=False, vault_ref=None)


@pytest.mark.parametrize(
    "fragment_id",
    [
        pytest.param("f" * (_MAX_FRAGMENT_ID_LENGTH + 1), id="oversized"),
        pytest.param("frag\r\n\x00-1", id="unprintable"),
    ],
)
def test_parse_ingest_result_unstorable_fragment_id_is_not_stored(fragment_id: str) -> None:
    """An ok status whose ref is too long or unprintable is not-stored, on this transport too.

    ``vault_ref`` is persisted verbatim on the entry, so the same bound has to
    hold whichever transport answered -- an MCP vault gets no wider a channel
    into that column than an HTTP one.
    """
    result = _parse_ingest_result({"status": "ok", "fragment_id": fragment_id})
    assert result == VaultIngestResult(stored=False, vault_ref=None)


def test_parse_ingest_result_ok_with_fragment_id_is_stored() -> None:
    """An ok status with a non-empty fragment_id parses to stored=True carrying the ref."""
    result = _parse_ingest_result({"status": "ok", "fragment_id": "frag-1", "action": "created"})
    assert result == VaultIngestResult(stored=True, vault_ref="frag-1")


@pytest.mark.asyncio
async def test_supported_capability_call_succeeds() -> None:
    """ingest() succeeds via creek.journal on a transport that advertised JOURNAL."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.JOURNAL.value]),
            CreekCapability.JOURNAL.value: {
                "status": "ok",
                "fragment_id": "vault-ref-1",
                "action": "created",
            },
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
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.JOURNAL.value])
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
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.JOURNAL.value])
        },
        raises={CreekCapability.JOURNAL.value: OSError("connection reset")},
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
async def test_reflect_renders_creek_notes_as_the_marginalia_contract() -> None:
    """reflect() turns creek's own note shape into the strict marginalia JSON contract."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.REFLECT.value]),
            CreekCapability.REFLECT.value: _reflect_payload(
                [
                    _creek_note("pattern", _REFLECT_QUOTE, _REFLECT_NOTE),
                    _creek_note("fear", "I stalled again", "The stall gets named plainly here."),
                ]
            ),
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    result = await client.reflect("body text", VaultTierCeiling.OPEN)
    assert json.loads(result) == {
        "notes": [
            {"kind": "connection", "quote": _REFLECT_QUOTE, "note": _REFLECT_NOTE},
            {
                "kind": "theme",
                "quote": "I stalled again",
                "note": "The stall gets named plainly here.",
            },
        ]
    }


@pytest.mark.asyncio
async def test_reflect_legacy_reflection_shaped_payload_yields_no_reflection() -> None:
    """A payload carrying only the old reflection key has no ok status, so the caller falls back."""
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.REFLECT.value]),
            CreekCapability.REFLECT.value: {"reflection": "a warm note"},
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    result = await client.reflect("body text", VaultTierCeiling.OPEN)
    assert result == ""


def test_reflect_params_sends_only_content_and_privacy_tier_ceiling() -> None:
    """Reflect params carry exactly the creek.reflect wire fields, with no consumer key."""
    params = _reflect_params("some body", VaultTierCeiling.PERSONAL)
    assert params == {"content": "some body", "privacy_tier_ceiling": "personal"}
    assert {"consumer", "body", "tier_ceiling"}.isdisjoint(params)


@pytest.mark.parametrize(
    ("creek_kind", "marginalia_kind"),
    [
        pytest.param("pattern", "connection", id="pattern"),
        pytest.param("reframe", "theme", id="reframe"),
        pytest.param("fear", "theme", id="fear"),
        pytest.param("longing", "theme", id="longing"),
        pytest.param("value", "theme", id="value"),
        pytest.param("tension", "theme", id="tension"),
        pytest.param("gift", "theme", id="gift"),
    ],
)
def test_parse_reflection_maps_each_creek_kind(creek_kind: str, marginalia_kind: str) -> None:
    """Each of creek's seven note kinds renders as its ratified marginalia kind."""
    payload = _reflect_payload([_creek_note(creek_kind, _REFLECT_QUOTE, _REFLECT_NOTE)])
    assert json.loads(_parse_reflection(payload)) == {
        "notes": [{"kind": marginalia_kind, "quote": _REFLECT_QUOTE, "note": _REFLECT_NOTE}]
    }


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(
            {
                "status": "empty",
                "tool": CreekCapability.REFLECT.value,
                "tier_ceiling": VaultTierCeiling.OPEN.value,
                "routed_tier": VaultTierCeiling.OPEN.value,
                "notes": [],
                "essay_grounded": False,
            },
            id="empty",
        ),
        pytest.param(
            {
                "status": "escalate",
                "tool": CreekCapability.REFLECT.value,
                "tier_ceiling": VaultTierCeiling.PERSONAL.value,
                "reason": "care signal detected in the submitted content",
                "care_signal": {"severity": "high", "category": "self_harm"},
            },
            id="escalate",
        ),
        pytest.param(
            {
                "status": "refused",
                "tool": CreekCapability.REFLECT.value,
                "tier_ceiling": VaultTierCeiling.OPEN.value,
                "reason": "requested content exceeds the configured tier ceiling",
            },
            id="refused",
        ),
        pytest.param(
            {"notes": [_creek_note("gift", _REFLECT_QUOTE, _REFLECT_NOTE)]},
            id="status_missing",
        ),
        pytest.param(
            {"status": "partial", "notes": [_creek_note("gift", _REFLECT_QUOTE, _REFLECT_NOTE)]},
            id="status_unknown_future",
        ),
        pytest.param(
            {"status": 123, "notes": [_creek_note("gift", _REFLECT_QUOTE, _REFLECT_NOTE)]},
            id="status_wrong_typed",
        ),
    ],
)
def test_parse_reflection_non_ok_status_yields_no_reflection(payload: Mapping[str, object]) -> None:
    """Any status other than the literal ok yields no reflection, even carrying usable notes."""
    assert _parse_reflection(payload) == ""


@pytest.mark.parametrize(
    "notes",
    [
        pytest.param([], id="empty_list"),
        pytest.param("not-a-list", id="string"),
        pytest.param({}, id="mapping"),
        pytest.param(
            ["not-a-mapping", _creek_note("prophecy", _REFLECT_QUOTE, _REFLECT_NOTE), 7],
            id="every_item_malformed",
        ),
    ],
)
def test_parse_reflection_ok_without_usable_notes_yields_no_reflection(notes: object) -> None:
    """An ok status with nothing usable yields no reflection rather than an empty notes list."""
    assert _parse_reflection(_reflect_payload(notes)) == ""


def test_parse_reflection_ok_without_a_notes_key_yields_no_reflection() -> None:
    """An ok payload with no notes key at all yields no reflection, never a bare notes list."""
    payload = {"status": "ok", "tool": CreekCapability.REFLECT.value}
    assert _parse_reflection(payload) == ""


@pytest.mark.parametrize(
    "bad_note",
    [
        pytest.param("not-a-mapping", id="non_mapping_item"),
        pytest.param(_creek_note("prophecy", _REFLECT_QUOTE, _REFLECT_NOTE), id="unknown_kind"),
        pytest.param(_creek_note(7, _REFLECT_QUOTE, _REFLECT_NOTE), id="non_string_kind"),
        pytest.param({"kind": "gift", "note": _REFLECT_NOTE}, id="missing_quote"),
        pytest.param({"kind": "gift", "quote": _REFLECT_QUOTE}, id="missing_note"),
        pytest.param(_creek_note("gift", 7, _REFLECT_NOTE), id="non_string_quote"),
        pytest.param(_creek_note("gift", _REFLECT_QUOTE, 7), id="non_string_note"),
        pytest.param(_creek_note("gift", "", _REFLECT_NOTE), id="empty_quote"),
        pytest.param(_creek_note("gift", " \n\t ", _REFLECT_NOTE), id="whitespace_quote"),
        pytest.param(_creek_note("gift", _REFLECT_QUOTE, ""), id="empty_note"),
        pytest.param(_creek_note("gift", _REFLECT_QUOTE, " \n\t "), id="whitespace_note"),
        pytest.param(
            _creek_note("gift", "q" * (ANCHOR_TEXT_MAX + 1), _REFLECT_NOTE), id="oversized_quote"
        ),
        pytest.param(
            _creek_note("gift", _REFLECT_QUOTE, "n" * (NOTE_MAX + 1)), id="oversized_note"
        ),
    ],
)
def test_parse_reflection_drops_a_malformed_note_keeping_its_sibling(bad_note: object) -> None:
    """A malformed note is dropped item by item, never taking its well-formed sibling with it."""
    payload = _reflect_payload([bad_note, _creek_note("gift", _REFLECT_QUOTE, _REFLECT_NOTE)])
    assert json.loads(_parse_reflection(payload)) == {
        "notes": [{"kind": "theme", "quote": _REFLECT_QUOTE, "note": _REFLECT_NOTE}]
    }


def test_parse_reflection_keeps_notes_at_the_exact_length_boundaries() -> None:
    """A quote of exactly ANCHOR_TEXT_MAX and a note of exactly NOTE_MAX both survive."""
    quote = "q" * ANCHOR_TEXT_MAX
    note = "n" * NOTE_MAX
    payload = _reflect_payload([_creek_note("value", quote, note)])
    assert json.loads(_parse_reflection(payload)) == {
        "notes": [{"kind": "theme", "quote": quote, "note": note}]
    }


def test_parse_reflection_passes_the_quote_through_verbatim() -> None:
    """A quote keeps its exact surrounding whitespace, since adepthood anchors it verbatim."""
    quote = f"  {_REFLECT_QUOTE}  "
    payload = _reflect_payload([_creek_note("pattern", quote, _REFLECT_NOTE)])
    assert json.loads(_parse_reflection(payload)) == {
        "notes": [{"kind": "connection", "quote": quote, "note": _REFLECT_NOTE}]
    }


def test_parse_reflection_caps_the_note_count_keeping_the_leading_prefix() -> None:
    """Only the first _MAX_REFLECT_NOTES notes are rendered, in the order the vault sent them."""
    over_cap = [
        _creek_note("gift", _REFLECT_QUOTE, f"note number {index}")
        for index in range(_MAX_REFLECT_NOTES + 3)
    ]
    rendered = json.loads(_parse_reflection(_reflect_payload(over_cap)))
    assert [note["note"] for note in rendered["notes"]] == [
        f"note number {index}" for index in range(_MAX_REFLECT_NOTES)
    ]


def test_parse_reflection_ignores_additive_response_fields() -> None:
    """Essay and relation fields creek may add do not change the rendered marginalia."""
    notes = [_creek_note("longing", _REFLECT_QUOTE, _REFLECT_NOTE)]
    bare: Mapping[str, object] = {"status": "ok", "notes": notes}
    enriched: Mapping[str, object] = {
        **_reflect_payload(notes),
        "essay": "a grounded essay the strict marginalia contract has no room for",
        "essay_grounded": True,
        "related_praxis": ["morning-sit"],
        "related_eddies": [{"id": "eddy-1"}],
    }
    assert json.loads(_parse_reflection(enriched)) == json.loads(_parse_reflection(bare))
    assert json.loads(_parse_reflection(enriched)) == {
        "notes": [{"kind": "theme", "quote": _REFLECT_QUOTE, "note": _REFLECT_NOTE}]
    }


def test_marginalia_kind_map_targets_only_anchorable_kinds() -> None:
    """Every mapped kind is one domain.resonance will actually anchor."""
    assert set(_MARGINALIA_KIND_BY_CREEK_KIND.values()) <= VALID_KINDS


def test_marginalia_kind_map_covers_creeks_published_kinds() -> None:
    """The mapping's keys are exactly creek's seven published note kinds."""
    assert set(_MARGINALIA_KIND_BY_CREEK_KIND) == _CREEK_NOTE_KINDS


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
async def test_wheel_over_cap_aspect_count_raises_validation_error() -> None:
    """wheel() rejects an aspect list larger than the schema ceiling."""
    over_cap = [
        {"stage_number": n, "aspect": f"Aspect-{n}", "fullness": 0.5}
        for n in range(1, TOTAL_STAGES + 2)
    ]
    transport = ScriptedTransport(
        responses={
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.WHEEL.value]),
            CreekCapability.WHEEL.value: {"aspects": over_cap},
        }
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    with pytest.raises(ValidationError):
        await client.wheel()


@pytest.mark.asyncio
async def test_reprobe_picks_up_newly_advertised_capability() -> None:
    """A second handshake() against a transport advertising a new capability flips supports()."""
    transport = MutableHandshakeTransport(capabilities=[CreekCapability.JOURNAL.value])
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    assert client.supports(CreekCapability.WHEEL) is False
    transport.capabilities = [CreekCapability.JOURNAL.value, CreekCapability.WHEEL.value]
    await client.handshake()
    assert client.supports(CreekCapability.WHEEL) is True
    assert transport.handshake_calls == 2


def test_fresh_client_reports_unavailable_before_handshake() -> None:
    """A client that has never handshaken reports unavailable and unsupported."""
    client = McpCreekVaultClient(transport=RaisingTransport(OSError("never called")))
    assert client.is_available() is False
    assert client.supports(CreekCapability.JOURNAL) is False
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
        CreekCapability.JOURNAL.value, ["not", "a", "mapping"]
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
            CreekCapability.HANDSHAKE.value: _handshake_payload([CreekCapability.JOURNAL.value])
        },
        raises={
            CreekCapability.JOURNAL.value: OSError(
                f"upstream rejected body: {body_sentinel} key={key_sentinel}"
            )
        },
    )
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    request = VaultIngestRequest(
        entry_id=7,
        body=body_sentinel,
        tier=VaultTierCeiling.OPEN,
        tier_ceiling=VaultTierCeiling.OPEN,
        created_at=_CREATED_AT,
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


# --- Real MCP streamable-HTTP transport driven against an in-memory vault ---
# These tests exercise _McpStreamableHttpTransport end to end by injecting an
# in-memory FastMCP server through its connect seam, so the real MCP lifecycle
# (initialize -> tools/call -> result) runs with no network.


class _IngestOut(BaseModel):
    """Typed ingest result used to exercise the structuredContent branch."""

    status: str
    fragment_id: str
    action: str


def _mem_connect(server: FastMCP) -> Callable[[], AbstractAsyncContextManager[ClientSession]]:
    """Return a connect factory yielding an in-memory session bound to ``server``."""

    def _factory() -> AbstractAsyncContextManager[ClientSession]:
        return create_connected_server_and_client_session(server)

    return _factory


class _RaisingConnect:
    """A connect context manager whose entry raises, simulating an unreachable vault."""

    def __init__(self, exc: BaseException) -> None:
        """Store the exception raised on context entry."""
        self._exc = exc

    async def __aenter__(self) -> ClientSession:
        """Raise the stored exception instead of yielding a session."""
        raise self._exc

    async def __aexit__(self, *_exc_info: object) -> bool:
        """Return False; never invoked because entry raises."""
        return False


def _serve_handshake(server: FastMCP, capabilities: Sequence[str]) -> None:
    """Register a creek.handshake tool advertising ``capabilities`` on ``server``."""
    advertised = list(capabilities)

    @server.tool(name=CreekCapability.HANDSHAKE.value)
    def _handshake(privacy_tier_ceiling: str = VaultTierCeiling.OPEN.value) -> dict[str, object]:
        """Answer a handshake with a well-formed advertised-capability payload."""
        del privacy_tier_ceiling
        return _handshake_payload(advertised)


@pytest.mark.asyncio
async def test_real_transport_handshake_populates_result() -> None:
    """The real MCP transport completes a handshake against an in-memory server."""
    server = FastMCP("fake-creek-vault")
    _serve_handshake(server, [CreekCapability.JOURNAL.value])
    transport = _McpStreamableHttpTransport(_VAULT_URL, "api-key", connect=_mem_connect(server))
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    assert client.is_available() is True
    assert client.supports(CreekCapability.JOURNAL) is True


@pytest.mark.asyncio
async def test_real_transport_handshake_sends_privacy_tier_ceiling() -> None:
    """The real transport passes only privacy_tier_ceiling to the handshake tool."""
    received: dict[str, object] = {}
    server = FastMCP("fake-creek-vault")

    @server.tool(name=CreekCapability.HANDSHAKE.value)
    def _handshake(privacy_tier_ceiling: str = "sentinel") -> dict[str, object]:
        """Record the tier ceiling the client sent, then answer normally."""
        received["privacy_tier_ceiling"] = privacy_tier_ceiling
        return _handshake_payload([CreekCapability.JOURNAL.value])

    transport = _McpStreamableHttpTransport(_VAULT_URL, "api-key", connect=_mem_connect(server))
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    assert received == {"privacy_tier_ceiling": VaultTierCeiling.OPEN.value}
    assert client.is_available() is True


@pytest.mark.asyncio
async def test_real_transport_degrades_on_connection_exception_group() -> None:
    """A connection failure surfacing as an ExceptionGroup degrades to unavailable."""
    failure = ExceptionGroup("connect failed", [httpx.ConnectError("unreachable")])
    transport = _McpStreamableHttpTransport(
        _VAULT_URL, "api-key", connect=lambda: _RaisingConnect(failure)
    )
    client = McpCreekVaultClient(transport=transport)
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()


@pytest.mark.asyncio
async def test_real_transport_reads_structured_content() -> None:
    """A tool with a typed result is read from structuredContent."""
    server = FastMCP("fake-creek-vault")
    _serve_handshake(server, [CreekCapability.JOURNAL.value])

    @server.tool(name=CreekCapability.JOURNAL.value)
    def _ingest(
        content: str, external_id: str, timestamp: str, tier: str, privacy_tier_ceiling: str
    ) -> _IngestOut:
        """Return a typed ingest result so structuredContent is populated."""
        del content, external_id, timestamp, tier, privacy_tier_ceiling
        return _IngestOut(status="ok", fragment_id="vault-ref-structured", action="created")

    transport = _McpStreamableHttpTransport(_VAULT_URL, "api-key", connect=_mem_connect(server))
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    result = await client.ingest(_ingest_request())
    assert result == VaultIngestResult(stored=True, vault_ref="vault-ref-structured")


def test_extract_tool_payload_reads_content_text() -> None:
    """A result with no structuredContent is JSON-decoded from its content text."""
    result = CallToolResult(
        content=[TextContent(type="text", text='{"stored": true, "vault_ref": "vault-ref-text"}')]
    )
    assert _extract_tool_payload(result) == {"stored": True, "vault_ref": "vault-ref-text"}


def test_extract_tool_payload_empty_content_yields_empty_mapping() -> None:
    """A result with no content blocks yields the empty mapping, never an IndexError."""
    result = CallToolResult(content=[])
    assert _extract_tool_payload(result) == {}


def test_extract_tool_payload_non_mapping_text_yields_empty_mapping() -> None:
    """Content text that decodes to a non-mapping JSON value yields the empty mapping."""
    result = CallToolResult(content=[TextContent(type="text", text="[1, 2, 3]")])
    assert _extract_tool_payload(result) == {}


def test_extract_tool_payload_skips_non_text_block_before_text() -> None:
    """A leading non-text content block is skipped so a later text block still parses."""
    image = ImageContent(type="image", data="Zm9v", mimeType="image/png")
    result = CallToolResult(content=[image, TextContent(type="text", text='{"stored": true}')])
    assert _extract_tool_payload(result) == {"stored": True}


def test_extract_tool_payload_error_result_raises_without_reading_content() -> None:
    """An isError result raises rather than surfacing its (possibly sensitive) content text."""
    leak = "SENTINEL_ERROR_CONTENT_DO_NOT_LEAK"
    result = CallToolResult(content=[TextContent(type="text", text=leak)], isError=True)
    with pytest.raises(McpError) as exc_info:
        _extract_tool_payload(result)
    assert leak not in str(exc_info.value)


@pytest.mark.asyncio
async def test_real_transport_tool_error_degrades_without_leaking_body() -> None:
    """A tool that raises degrades to CreekVaultUnavailableError without leaking the body."""
    body_sentinel = "SENTINEL_BODY_REAL_TRANSPORT_DO_NOT_LEAK"
    server = FastMCP("fake-creek-vault")
    _serve_handshake(server, [CreekCapability.JOURNAL.value])

    @server.tool(name=CreekCapability.JOURNAL.value)
    def _ingest(
        content: str, external_id: str, timestamp: str, tier: str, privacy_tier_ceiling: str
    ) -> dict[str, object]:
        """Raise with the body in the message to prove the client never surfaces it."""
        del external_id, timestamp, tier, privacy_tier_ceiling
        raise RuntimeError(f"vault exploded on {content}")

    transport = _McpStreamableHttpTransport(_VAULT_URL, "api-key", connect=_mem_connect(server))
    client = McpCreekVaultClient(transport=transport)
    await client.handshake()
    request = VaultIngestRequest(
        entry_id=7,
        body=body_sentinel,
        tier=VaultTierCeiling.OPEN,
        tier_ceiling=VaultTierCeiling.OPEN,
        created_at=_CREATED_AT,
    )
    with pytest.raises(CreekVaultUnavailableError) as exc_info:
        await client.ingest(request)
    assert body_sentinel not in str(exc_info.value)


def test_real_transport_rejects_plaintext_remote_url() -> None:
    """The real transport refuses a plaintext remote URL before binding the key."""
    with pytest.raises(ValueError, match="https"):
        _McpStreamableHttpTransport("http://vault.example.test", "api-key")
