"""A scriptable fake vault for the journal resonance route's read path.

Shared by the router-level vault read tests and the vault-boundary matrix
(#3061), so both script the same handshake, ingest and reflect behaviour rather
than drifting apart. Records every handshake and reflect call so a test can
assert the vault was, or was not, asked.
"""

from __future__ import annotations

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    HandshakeResult,
    VaultClassification,
    VaultIngestRequest,
    VaultIngestResult,
    VaultReflection,
    VaultReflectionStatus,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultWheelBalance,
)

DEFAULT_REFLECT_CAPABILITIES = frozenset(
    {CreekCapability.JOURNAL, CreekCapability.CLASSIFY, CreekCapability.REFLECT}
)


def empty_reflection() -> VaultReflection:
    """Build the reflection a vault with nothing to say answers with."""
    return VaultReflection(
        status=VaultReflectionStatus.EMPTY,
        notes=(),
        essay=None,
        essay_grounded=False,
        routed_tier=VaultTierCeiling.PERSONAL,
    )


class ReflectingVaultClient:
    """Fake CreekVaultClient: ingests/classifies for entry creation, scripts reflect."""

    def __init__(
        self,
        *,
        available: bool = True,
        capabilities: frozenset[CreekCapability] = DEFAULT_REFLECT_CAPABILITIES,
        reflect_result: VaultReflection | None = None,
        reflect_error: Exception | None = None,
    ) -> None:
        """Store the scripted handshake outcome and reflect behavior."""
        self.ingest_calls: list[VaultIngestRequest] = []
        self.handshake_calls = 0
        self.reflect_calls: list[tuple[str, VaultTierCeiling]] = []
        self._available = available
        self._capabilities = capabilities
        self._reflect_result = reflect_result if reflect_result is not None else empty_reflection()
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
        """Record the request and return an incrementing vault ref (write path)."""
        self.ingest_calls.append(request)
        return VaultIngestResult(stored=True, vault_ref=f"vault-ref-{len(self.ingest_calls)}")

    async def upload(self, request: VaultUploadRequest, /) -> VaultUploadResult:
        """Unused on this path; raises if a test calls it by mistake."""
        raise NotImplementedError(request)

    async def classify(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Return a fixed classification tag set (write path)."""
        return VaultClassification(tags=("courage",))

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Record the call, then raise the scripted error or return the scripted reflection."""
        self.reflect_calls.append((body, tier_ceiling))
        if self._reflect_error is not None:
            raise self._reflect_error
        return self._reflect_result

    async def wheel(self) -> VaultWheelBalance:
        """Return an empty wheel balance (unused by the reflect path)."""
        return VaultWheelBalance(aspects=())
