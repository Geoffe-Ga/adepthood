"""Unit tests for the Creek Vault reflection seam.

RED: ``services.creek_vault_reflect`` does not exist yet, so every test here
fails at collection with a ``ModuleNotFoundError`` until ``VaultResonanceLLM``
and ``select_reflection_llm`` are implemented.
"""

from __future__ import annotations

from collections.abc import Mapping

import pytest

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
    VaultWheelBalance,
)
from domain.resonance import ResonanceLLM, generate_marginalia
from services.creek_vault_client import McpCreekVaultClient
from services.creek_vault_reflect import VaultResonanceLLM, select_reflection_llm

_BODY = "the body under reflection"

# A body plus two verbatim substrings of it, so the vault's quotes anchor for
# real rather than being paraphrases the resonance pass would drop.
_LOOP_STALL_QUOTE = "I stalled again"
_LOOP_RIVER_QUOTE = "the river kept moving"
_LOOP_BODY = f"{_LOOP_STALL_QUOTE} this week, and yet {_LOOP_RIVER_QUOTE} without me."


class RecordingVaultClient:
    """A scriptable, call-recording fake CreekVaultClient (reflect path only)."""

    def __init__(
        self,
        *,
        available: bool = True,
        capabilities: frozenset[CreekCapability] = frozenset({CreekCapability.REFLECT}),
        reflect_result: str = "a vault reflection",
        reflect_error: Exception | None = None,
    ) -> None:
        """Store the scripted handshake outcome and reflect behavior."""
        self.handshake_calls = 0
        self.reflect_calls: list[tuple[str, VaultTierCeiling]] = []
        self._available = available
        self._capabilities = capabilities
        self._reflect_result = reflect_result
        self._reflect_error = reflect_error

    async def handshake(self) -> HandshakeResult:
        """Record the call and return the scripted availability/capabilities."""
        self.handshake_calls += 1
        return HandshakeResult(
            available=self._available,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=self._capabilities,
            attestation=None,
        )

    def is_available(self) -> bool:
        """Return the scripted availability."""
        return self._available

    def supports(self, capability: CreekCapability, /) -> bool:
        """Return whether ``capability`` is in the scripted capability set."""
        return capability in self._capabilities

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Unused on the reflect path; raises if a test calls it by mistake."""
        raise NotImplementedError(request)

    async def classify(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Unused on the reflect path; raises if a test calls it by mistake."""
        raise NotImplementedError((body, tier_ceiling))

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> str:
        """Record the call, then raise the scripted error or return the scripted text."""
        self.reflect_calls.append((body, tier_ceiling))
        if self._reflect_error is not None:
            raise self._reflect_error
        return self._reflect_result

    async def wheel(self) -> VaultWheelBalance:
        """Unused on the reflect path; raises if a test calls it by mistake."""
        raise NotImplementedError


class RecordingFallbackLLM:
    """A stub ``ResonanceLLM`` that records every prompt it is given."""

    def __init__(self, result: str = "fallback reflection") -> None:
        """Store the sentinel completion text and start an empty prompt log."""
        self.prompts: list[str] = []
        self._result = result

    async def complete(self, prompt: str) -> str:
        """Record ``prompt`` and return the sentinel completion."""
        self.prompts.append(prompt)
        return self._result


class ScriptedReflectTransport:
    """A minimal vault transport: a REFLECT-capable handshake, then one scripted reflect payload."""

    def __init__(self, reflect_payload: Mapping[str, object]) -> None:
        """Store the creek.reflect response this fake answers every reflect call with."""
        self._reflect_payload = reflect_payload

    async def call(self, method: str, _params: Mapping[str, object]) -> Mapping[str, object]:
        """Answer creek.handshake as a REFLECT-capable vault, anything else with the payload."""
        if method == CreekCapability.HANDSHAKE.value:
            return {
                "available": True,
                "capabilities": [CreekCapability.REFLECT.value],
                "contract_version": CONTRACT_VERSION,
                "ontology_version": "1.0.0",
                "attestation": None,
            }
        return self._reflect_payload


@pytest.mark.asyncio
async def test_vault_reflection_reaches_marginalia_instead_of_the_cloud_fallback() -> None:
    """A creek-shaped vault reflection anchors as marginalia without deferring to the cloud."""
    payload: Mapping[str, object] = {
        "status": "ok",
        "tool": CreekCapability.REFLECT.value,
        "tier_ceiling": VaultTierCeiling.PERSONAL.value,
        "routed_tier": VaultTierCeiling.PERSONAL.value,
        "essay_grounded": False,
        "notes": [
            {
                "kind": "pattern",
                "quote": _LOOP_RIVER_QUOTE,
                "note": "Motion keeps answering the weeks you call stalled.",
            },
            {
                "kind": "fear",
                "quote": _LOOP_STALL_QUOTE,
                "note": "You name the stall plainly before anything else.",
            },
        ],
    }
    client = McpCreekVaultClient(transport=ScriptedReflectTransport(payload))
    await client.handshake()
    fallback = RecordingFallbackLLM()
    llm = VaultResonanceLLM(
        client, body=_LOOP_BODY, tier_ceiling=VaultTierCeiling.PERSONAL, fallback=fallback
    )

    anchored = await generate_marginalia(_LOOP_BODY, llm=llm)

    assert [(note.kind, note.anchor_text) for note in anchored] == [
        ("connection", _LOOP_RIVER_QUOTE),
        ("theme", _LOOP_STALL_QUOTE),
    ]
    assert fallback.prompts == []


@pytest.mark.asyncio
async def test_complete_delegates_to_vault_reflect_ignoring_prompt() -> None:
    """complete() calls client.reflect(body, tier_ceiling) and ignores the prompt."""
    client = RecordingVaultClient(reflect_result="what the vault sees")
    fallback = RecordingFallbackLLM()
    adapter = VaultResonanceLLM(
        client, body=_BODY, tier_ceiling=VaultTierCeiling.PERSONAL, fallback=fallback
    )

    result = await adapter.complete("this prompt is never sent to the vault")

    assert result == "what the vault sees"
    assert client.reflect_calls == [(_BODY, VaultTierCeiling.PERSONAL)]
    assert fallback.prompts == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error",
    [
        CreekVaultUnavailableError("creek vault call failed: creek.reflect"),
        CreekCapabilityUnsupportedError("capability not advertised: creek.reflect"),
    ],
    ids=["unavailable", "capability_unsupported"],
)
async def test_complete_falls_back_on_vault_error(error: Exception) -> None:
    """A CreekVaultError from reflect() falls back, passing the prompt through verbatim."""
    client = RecordingVaultClient(reflect_error=error)
    fallback = RecordingFallbackLLM("fallback text")
    adapter = VaultResonanceLLM(
        client, body=_BODY, tier_ceiling=VaultTierCeiling.OPEN, fallback=fallback
    )

    result = await adapter.complete("the exact prompt")

    assert result == "fallback text"
    assert fallback.prompts == ["the exact prompt"]


@pytest.mark.asyncio
@pytest.mark.parametrize("reflection", ["", "   \n\t  "], ids=["empty", "whitespace_only"])
async def test_complete_falls_back_on_empty_or_whitespace_reflection(reflection: str) -> None:
    """A blank vault reflection is treated as no answer and falls back."""
    client = RecordingVaultClient(reflect_result=reflection)
    fallback = RecordingFallbackLLM("fallback text")
    adapter = VaultResonanceLLM(
        client, body=_BODY, tier_ceiling=VaultTierCeiling.INTIMATE, fallback=fallback
    )

    result = await adapter.complete("the exact prompt")

    assert result == "fallback text"
    assert fallback.prompts == ["the exact prompt"]


@pytest.mark.asyncio
async def test_select_reflection_llm_short_circuits_on_care_flag() -> None:
    """A care-flagged entry returns the fallback with zero calls to the vault."""
    client = RecordingVaultClient()
    fallback = RecordingFallbackLLM()

    result = await select_reflection_llm(
        client, body=_BODY, classification="personal", care_flagged=True, fallback=fallback
    )

    assert result is fallback
    assert client.handshake_calls == 0
    assert client.reflect_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("available", "capabilities"),
    [
        (False, frozenset({CreekCapability.REFLECT})),
        (True, frozenset()),
    ],
    ids=["handshake_unavailable", "reflect_unsupported"],
)
async def test_select_reflection_llm_falls_back_when_not_reflect_ready(
    available: bool, capabilities: frozenset[CreekCapability]
) -> None:
    """An unavailable vault, or one that never advertises REFLECT, falls back."""
    client = RecordingVaultClient(available=available, capabilities=capabilities)
    fallback = RecordingFallbackLLM()

    result = await select_reflection_llm(
        client, body=_BODY, classification="personal", care_flagged=False, fallback=fallback
    )

    assert result is fallback
    assert client.handshake_calls == 1
    assert client.reflect_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("classification", "expected_ceiling"),
    [
        ("personal", VaultTierCeiling.PERSONAL),
        ("public", VaultTierCeiling.OPEN),
    ],
)
async def test_select_reflection_llm_returns_vault_adapter_with_resolved_tier(
    classification: str, expected_ceiling: VaultTierCeiling
) -> None:
    """An available, REFLECT-capable vault yields a VaultResonanceLLM at the right tier."""
    client = RecordingVaultClient(reflect_result="tiered reflection")
    fallback = RecordingFallbackLLM()

    result: ResonanceLLM = await select_reflection_llm(
        client, body=_BODY, classification=classification, care_flagged=False, fallback=fallback
    )

    assert isinstance(result, VaultResonanceLLM)
    completion = await result.complete("any prompt")
    assert completion == "tiered reflection"
    assert client.reflect_calls == [(_BODY, expected_ceiling)]


@pytest.mark.asyncio
async def test_select_reflection_llm_falls_back_on_unknown_classification() -> None:
    """An unrecognized classification fails closed to the fallback, no vault calls."""
    client = RecordingVaultClient()
    fallback = RecordingFallbackLLM()

    result = await select_reflection_llm(
        client, body=_BODY, classification="not_a_real_tier", care_flagged=False, fallback=fallback
    )

    assert result is fallback
    assert client.handshake_calls == 0
    assert client.reflect_calls == []
