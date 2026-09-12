"""Voice Draft mirroring into a connected Creek Vault.

The generated essay remains authoritative in Postgres.  Its vault copy is an
optional, capability-gated replica: one immediate attempt, no queue, no retry,
and no exception allowed to cost the writer the essay they just generated.
"""

from __future__ import annotations

import pytest

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultIngestAction,
    VaultTierCeiling,
    VaultVoiceDraftDeleteResult,
    VaultVoiceDraftRequest,
    VaultVoiceDraftResult,
)
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_voice_drafts import (
    mirror_voice_draft,
    retract_voice_draft,
    voice_draft_external_id,
)

_ESSAY = "SENTINEL_VOICE_DRAFT_ESSAY"
_FRAGMENT_ID = "voice-draft-fragment-1"


class _RecordingVoiceDraftClient(LocalFallbackCreekVaultClient):
    """Minimal recording implementation of the Voice Draft client seam."""

    def __init__(
        self,
        *,
        available: bool = True,
        supported: bool = True,
        fail_upsert: bool = False,
        fail_delete: bool = False,
    ) -> None:
        super().__init__()
        self.available = available
        self.supported = supported
        self.fail_upsert = fail_upsert
        self.fail_delete = fail_delete
        self.handshake_calls = 0
        self.upserts: list[VaultVoiceDraftRequest] = []
        self.deletes: list[tuple[str, VaultTierCeiling]] = []

    async def handshake(self) -> HandshakeResult:
        self.handshake_calls += 1
        capabilities = frozenset({CreekCapability.VOICE_DRAFTS}) if self.supported else frozenset()
        return HandshakeResult(
            available=self.available,
            contract_version=CONTRACT_VERSION if self.available else None,
            ontology_version="aptitude-wavelength/2026-05-23" if self.available else None,
            capabilities=capabilities,
            attestation=None,
        )

    def supports(self, capability: CreekCapability, /) -> bool:
        return self.available and self.supported and capability is CreekCapability.VOICE_DRAFTS

    async def upsert_voice_draft(self, request: VaultVoiceDraftRequest, /) -> VaultVoiceDraftResult:
        self.upserts.append(request)
        if self.fail_upsert:
            raise CreekVaultUnavailableError("synthetic voice draft failure")
        return VaultVoiceDraftResult(
            stored=True,
            vault_ref=_FRAGMENT_ID,
            action=VaultIngestAction.CREATED,
        )

    async def delete_voice_draft(
        self, external_id: str, tier_ceiling: VaultTierCeiling, /
    ) -> VaultVoiceDraftDeleteResult:
        self.deletes.append((external_id, tier_ceiling))
        if self.fail_delete:
            raise CreekVaultUnavailableError("synthetic voice draft failure")
        return VaultVoiceDraftDeleteResult(deleted=True)


def test_voice_draft_external_id_is_stable_opaque_and_owner_scoped() -> None:
    """The URL key is deterministic but carries neither prose nor raw local ids."""
    first = voice_draft_external_id(owner_user_id=12, marginalia_id=34)
    assert first == voice_draft_external_id(owner_user_id=12, marginalia_id=34)
    assert first.startswith("adepthood-voicedraft-")
    assert len(first.removeprefix("adepthood-voicedraft-")) == 32
    assert first != voice_draft_external_id(owner_user_id=13, marginalia_id=34)
    assert first != voice_draft_external_id(owner_user_id=12, marginalia_id=35)
    assert "12" not in first
    assert "34" not in first


def test_voice_draft_request_repr_excludes_the_essay() -> None:
    """A traceback or debug log cannot expose draft prose through dataclass repr."""
    request = VaultVoiceDraftRequest(
        external_id="adepthood-voicedraft-opaque",
        content=_ESSAY,
        tier=VaultTierCeiling.PERSONAL,
        tier_ceiling=VaultTierCeiling.PERSONAL,
    )
    assert _ESSAY not in repr(request)


@pytest.mark.asyncio
async def test_personal_voice_draft_is_mirrored_once_after_a_capability_handshake() -> None:
    """A supported personal draft makes one idempotent upsert with its source tier."""
    client = _RecordingVoiceDraftClient()

    await mirror_voice_draft(
        client,
        owner_user_id=12,
        marginalia_id=34,
        essay=_ESSAY,
        classification="personal",
    )

    assert client.handshake_calls == 1
    assert len(client.upserts) == 1
    request = client.upserts[0]
    assert request.external_id == voice_draft_external_id(12, 34)
    assert request.content == _ESSAY
    assert request.tier is VaultTierCeiling.PERSONAL
    assert request.tier_ceiling is VaultTierCeiling.PERSONAL


@pytest.mark.asyncio
async def test_intimate_voice_draft_never_touches_the_client() -> None:
    """The intimate floor runs before handshake, so no essay can reach the wire."""
    client = _RecordingVoiceDraftClient()

    await mirror_voice_draft(
        client,
        owner_user_id=12,
        marginalia_id=34,
        essay=_ESSAY,
        classification="intimate",
    )

    assert client.handshake_calls == 0
    assert client.upserts == []


@pytest.mark.parametrize(
    ("available", "supported"),
    [(False, True), (True, False)],
    ids=["unavailable", "unsupported"],
)
@pytest.mark.asyncio
async def test_unavailable_or_unsupported_vault_silently_skips_the_draft(
    available: bool, supported: bool
) -> None:
    """Capability negotiation can close the mirror without affecting the essay."""
    client = _RecordingVoiceDraftClient(available=available, supported=supported)

    await mirror_voice_draft(
        client,
        owner_user_id=12,
        marginalia_id=34,
        essay=_ESSAY,
        classification="public",
    )

    assert client.handshake_calls == 1
    assert client.upserts == []


@pytest.mark.asyncio
async def test_failed_voice_draft_upsert_is_swallowed_and_never_retried() -> None:
    """One failed network attempt is the whole attempt: no exception, queue, or retry."""
    client = _RecordingVoiceDraftClient(fail_upsert=True)

    await mirror_voice_draft(
        client,
        owner_user_id=12,
        marginalia_id=34,
        essay=_ESSAY,
        classification="public",
    )

    assert client.handshake_calls == 1
    assert len(client.upserts) == 1


@pytest.mark.asyncio
async def test_retraction_deletes_by_opaque_id_at_the_widest_remote_ceiling() -> None:
    """Intimate reclassification deletes the prior copy without sending its prose."""
    client = _RecordingVoiceDraftClient()

    confirmed = await retract_voice_draft(client, owner_user_id=12, marginalia_id=34)

    assert confirmed is True
    assert client.handshake_calls == 1
    assert client.upserts == []
    assert client.deletes == [(voice_draft_external_id(12, 34), VaultTierCeiling.PERSONAL)]


@pytest.mark.parametrize(
    ("available", "supported", "expected_confirmation"),
    [(False, True, False), (True, False, False)],
    ids=["unavailable", "unsupported"],
)
@pytest.mark.asyncio
async def test_retraction_is_also_capability_gated(
    available: bool,
    supported: bool,
    expected_confirmation: bool,
) -> None:
    """A connected vault that cannot serve DELETE never confirms absence."""
    client = _RecordingVoiceDraftClient(available=available, supported=supported)

    confirmed = await retract_voice_draft(client, owner_user_id=12, marginalia_id=34)

    assert confirmed is expected_confirmation
    assert client.handshake_calls == 1
    assert client.deletes == []


@pytest.mark.asyncio
async def test_failed_voice_draft_retraction_is_swallowed_and_never_retried() -> None:
    """A retraction failure is one content-free attempt, with no local backlog."""
    client = _RecordingVoiceDraftClient(fail_delete=True)

    confirmed = await retract_voice_draft(client, owner_user_id=12, marginalia_id=34)

    assert confirmed is False
    assert client.handshake_calls == 1
    assert len(client.deletes) == 1


@pytest.mark.asyncio
async def test_local_fallback_confirms_there_is_no_remote_draft() -> None:
    """No configured destination cannot hold a replica that deletion must chase."""
    confirmed = await retract_voice_draft(
        LocalFallbackCreekVaultClient(),
        owner_user_id=12,
        marginalia_id=34,
    )

    assert confirmed is True
