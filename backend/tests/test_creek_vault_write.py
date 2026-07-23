"""Tests for the Creek Vault write path (services.creek_vault_write).

This is the TDD RED suite: services.creek_vault_write does not exist yet, so
every test here fails on import until the implementation specialist writes
the module against the signatures documented in the module docstring these
tests assume.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultIngestRequest,
    VaultIngestResult,
    VaultTierCeiling,
    VaultWheelBalance,
)
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_write import (
    VaultWriteOutcome,
    VaultWriteStatus,
    get_creek_vault_client,
    store_and_classify,
)

_CREATED_AT = datetime(2026, 7, 10, 12, 0, tzinfo=UTC)
_BODY = "A quiet entry about the week's practice."


class RecordingVaultClient:
    """Fake CreekVaultClient that records every call and returns scripted results."""

    def __init__(
        self,
        *,
        available: bool = True,
        capabilities: frozenset[CreekCapability] = frozenset({CreekCapability.JOURNAL}),
        ingest: VaultIngestResult | Exception | None = None,
        classify: VaultClassification | Exception | None = None,
    ) -> None:
        """Store the scripted handshake/ingest/classify behavior for this fake.

        ``ingest`` and ``classify`` each take either the scripted success result
        or an ``Exception`` to raise when that method is called.
        """
        self.calls: list[tuple[str, object]] = []
        self._available = available
        self._capabilities = capabilities
        self._ingest = ingest or VaultIngestResult(stored=True, vault_ref="ref-default")
        self._classify = classify or VaultClassification(tags=())

    async def handshake(self) -> HandshakeResult:
        """Record the call and return the scripted availability/capabilities."""
        self.calls.append(("handshake", None))
        return HandshakeResult(
            available=self._available,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=self._capabilities,
            attestation=None,
        )

    def is_available(self) -> bool:
        """Return the scripted availability without recording a call."""
        return self._available

    def supports(self, capability: CreekCapability, /) -> bool:
        """Return whether ``capability`` is in the scripted capability set."""
        return capability in self._capabilities

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Record the ingest request, then raise or return the scripted result."""
        self.calls.append(("ingest", request))
        if isinstance(self._ingest, Exception):
            raise self._ingest
        return self._ingest

    async def classify(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Record the classify call, then raise or return the scripted result."""
        self.calls.append(("classify", (body, tier_ceiling)))
        if isinstance(self._classify, Exception):
            raise self._classify
        return self._classify

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> str:
        """Record the reflect call and return an empty string (unused here)."""
        self.calls.append(("reflect", (body, tier_ceiling)))
        return ""

    async def wheel(self) -> VaultWheelBalance:
        """Record the wheel call and return an empty balance (unused here)."""
        self.calls.append(("wheel", None))
        return VaultWheelBalance(aspects=())


def _call_names(client: RecordingVaultClient) -> list[str]:
    """Return the ordered list of method names the fake recorded."""
    return [name for name, _args in client.calls]


def _ingest_request(client: RecordingVaultClient) -> VaultIngestRequest:
    """Return the single VaultIngestRequest the fake recorded on ingest."""
    args = next(a for name, a in client.calls if name == "ingest")
    assert isinstance(args, VaultIngestRequest)
    return args


@pytest.mark.asyncio
async def test_intimate_entry_skips_and_never_touches_client() -> None:
    """An intimate entry never calls the vault -- not even handshake()."""
    client = RecordingVaultClient()
    outcome = await store_and_classify(
        client, body=_BODY, classification="intimate", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.SKIPPED_INTIMATE, vault_ref=None, tags=()
    )
    assert client.calls == []


@pytest.mark.asyncio
async def test_unavailable_vault_returns_unavailable_status() -> None:
    """A handshake reporting unavailable degrades to UNAVAILABLE, never calling ingest."""
    client = RecordingVaultClient(available=False, capabilities=frozenset())
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.UNAVAILABLE, vault_ref=None, tags=()
    )
    assert _call_names(client) == ["handshake"]


@pytest.mark.asyncio
async def test_available_but_ingest_unsupported_returns_unavailable_status() -> None:
    """An available vault that does not advertise JOURNAL also degrades to UNAVAILABLE."""
    client = RecordingVaultClient(available=True, capabilities=frozenset({CreekCapability.REFLECT}))
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome.status == VaultWriteStatus.UNAVAILABLE
    assert outcome.vault_ref is None
    assert outcome.tags == ()
    assert _call_names(client) == ["handshake"]


@pytest.mark.asyncio
async def test_public_classification_maps_to_open_tier_ceiling() -> None:
    """A public entry's ingest request carries the OPEN tier ceiling."""
    client = RecordingVaultClient(ingest=VaultIngestResult(stored=True, vault_ref="ref-open"))
    await store_and_classify(
        client, body=_BODY, classification="public", created_at=_CREATED_AT, entry_id=101
    )
    ingest_call = _ingest_request(client)
    assert ingest_call.tier_ceiling == VaultTierCeiling.OPEN


@pytest.mark.asyncio
async def test_personal_classification_maps_to_personal_tier_ceiling() -> None:
    """A personal entry's ingest request carries the PERSONAL tier ceiling."""
    client = RecordingVaultClient(ingest=VaultIngestResult(stored=True, vault_ref="ref-personal"))
    await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    ingest_call = _ingest_request(client)
    assert ingest_call.tier_ceiling == VaultTierCeiling.PERSONAL


@pytest.mark.asyncio
async def test_ingest_request_carries_body_created_at_and_entry_id() -> None:
    """The mapped VaultIngestRequest carries the caller's body, timestamp, id, and tier."""
    client = RecordingVaultClient()
    await store_and_classify(
        client,
        body=_BODY,
        classification="personal",
        created_at=_CREATED_AT,
        entry_id=101,
    )
    ingest_call = _ingest_request(client)
    assert ingest_call.body == _BODY
    assert ingest_call.created_at == _CREATED_AT
    assert ingest_call.entry_id == 101
    assert ingest_call.tier == VaultTierCeiling.PERSONAL


@pytest.mark.asyncio
async def test_ingest_success_without_classify_support_returns_ingested_empty_tags() -> None:
    """A vault supporting only INGEST returns INGESTED with the vault_ref and empty tags."""
    client = RecordingVaultClient(
        capabilities=frozenset({CreekCapability.JOURNAL}),
        ingest=VaultIngestResult(stored=True, vault_ref="ref-x"),
    )
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.INGESTED, vault_ref="ref-x", tags=()
    )
    assert _call_names(client) == ["handshake", "ingest"]


@pytest.mark.asyncio
async def test_journal_write_never_classifies_even_with_classify_advertised() -> None:
    """The journal write path never calls classify, even when CLASSIFY is advertised."""
    client = RecordingVaultClient(
        capabilities=frozenset({CreekCapability.JOURNAL, CreekCapability.CLASSIFY}),
        ingest=VaultIngestResult(stored=True, vault_ref="ref-y"),
        classify=VaultClassification(tags=("courage", "shadow")),
    )
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.INGESTED, vault_ref="ref-y", tags=()
    )
    assert _call_names(client) == ["handshake", "ingest"]


@pytest.mark.asyncio
async def test_ingest_raising_creek_vault_error_returns_degraded_without_raising() -> None:
    """A CreekVaultError from ingest() degrades to DEGRADED rather than propagating."""
    client = RecordingVaultClient(
        capabilities=frozenset({CreekCapability.JOURNAL}),
        ingest=CreekVaultUnavailableError("creek vault call failed: creek.journal"),
    )
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(status=VaultWriteStatus.DEGRADED, vault_ref=None, tags=())


@pytest.mark.asyncio
async def test_ingest_reporting_not_stored_from_available_vault_returns_degraded() -> None:
    """stored=False from an available, supporting vault is a degraded write, not an ingest."""
    client = RecordingVaultClient(
        capabilities=frozenset({CreekCapability.JOURNAL}),
        ingest=VaultIngestResult(stored=False, vault_ref=None),
    )
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(status=VaultWriteStatus.DEGRADED, vault_ref=None, tags=())


@pytest.mark.asyncio
async def test_classify_error_after_successful_ingest_still_returns_ingested() -> None:
    """A classify scripted to raise is never even called; the write stays INGESTED."""
    client = RecordingVaultClient(
        capabilities=frozenset({CreekCapability.JOURNAL, CreekCapability.CLASSIFY}),
        ingest=VaultIngestResult(stored=True, vault_ref="ref-z"),
        classify=CreekVaultUnavailableError("creek vault call failed: creek.classify"),
    )
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.INGESTED, vault_ref="ref-z", tags=()
    )
    assert _call_names(client) == ["handshake", "ingest"]


@pytest.mark.asyncio
async def test_unknown_classification_raises_value_error_without_touching_client() -> None:
    """An unrecognized classification fails closed via tier_ceiling_for, before any vault call."""
    client = RecordingVaultClient()
    with pytest.raises(ValueError, match="bogus"):
        await store_and_classify(
            client, body=_BODY, classification="bogus", created_at=_CREATED_AT, entry_id=101
        )
    assert client.calls == []


@pytest.mark.asyncio
async def test_local_fallback_client_returns_unavailable_for_non_intimate_entry() -> None:
    """The real no-vault LocalFallbackCreekVaultClient degrades a non-intimate write."""
    client = LocalFallbackCreekVaultClient()
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.UNAVAILABLE, vault_ref=None, tags=()
    )


def test_get_creek_vault_client_returns_local_fallback_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no CREEK_VAULT_URL configured, the FastAPI provider yields the local fallback."""
    monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    client = get_creek_vault_client()
    assert isinstance(client, LocalFallbackCreekVaultClient)
