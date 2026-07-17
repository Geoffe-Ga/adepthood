"""Tests for the pure Creek Vault domain module (domain.creek_vault)."""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from datetime import UTC, datetime

import pytest

from domain import creek_vault
from domain.creek_vault import (
    CONSUMER_ID,
    CONTRACT_VERSION,
    TIER_CEILING_BY_CLASSIFICATION,
    CreekCapability,
    HandshakeResult,
    VaultIngestRequest,
    VaultTierCeiling,
    tier_ceiling_for,
)
from models.journal_entry import JournalClassification


class TestTierCeilingMapping:
    """The three verbatim classification -> tier-ceiling mappings from the contract table."""

    def test_public_maps_to_open(self) -> None:
        """PUBLIC keys OPEN in the raw mapping dict."""
        assert (
            TIER_CEILING_BY_CLASSIFICATION[JournalClassification.PUBLIC.value]
            is VaultTierCeiling.OPEN
        )

    def test_personal_maps_to_personal(self) -> None:
        """PERSONAL keys PERSONAL in the raw mapping dict."""
        assert (
            TIER_CEILING_BY_CLASSIFICATION[JournalClassification.PERSONAL.value]
            is VaultTierCeiling.PERSONAL
        )

    def test_intimate_maps_to_intimate(self) -> None:
        """INTIMATE keys INTIMATE in the raw mapping dict."""
        assert (
            TIER_CEILING_BY_CLASSIFICATION[JournalClassification.INTIMATE.value]
            is VaultTierCeiling.INTIMATE
        )

    def test_tier_ceiling_for_public(self) -> None:
        """tier_ceiling_for resolves PUBLIC to OPEN."""
        assert tier_ceiling_for(JournalClassification.PUBLIC.value) is VaultTierCeiling.OPEN

    def test_tier_ceiling_for_personal(self) -> None:
        """tier_ceiling_for resolves PERSONAL to PERSONAL."""
        assert tier_ceiling_for(JournalClassification.PERSONAL.value) is VaultTierCeiling.PERSONAL

    def test_tier_ceiling_for_intimate(self) -> None:
        """tier_ceiling_for resolves INTIMATE to INTIMATE."""
        assert tier_ceiling_for(JournalClassification.INTIMATE.value) is VaultTierCeiling.INTIMATE

    def test_unknown_classification_raises(self) -> None:
        """An unrecognized classification fails closed rather than defaulting to OPEN."""
        with pytest.raises((ValueError, creek_vault.CreekVaultError)):
            tier_ceiling_for("not-a-real-tier")

    def test_empty_classification_raises(self) -> None:
        """An empty-string classification also fails closed."""
        with pytest.raises((ValueError, creek_vault.CreekVaultError)):
            tier_ceiling_for("")


def test_tier_ceiling_keys_match_journal_classification_enum() -> None:
    """The mapping's key set must not drift from JournalClassification's values."""
    assert set(TIER_CEILING_BY_CLASSIFICATION) == {c.value for c in JournalClassification}


class TestCreekCapability:
    """Six wire-name capability members."""

    def test_has_six_members(self) -> None:
        """Exactly six capabilities are defined."""
        assert len(CreekCapability) == 6

    def test_handshake_value_is_wire_name(self) -> None:
        """HANDSHAKE's value is the creek.handshake wire name."""
        assert CreekCapability.HANDSHAKE.value == "creek.handshake"

    def test_ingest_value_is_wire_name(self) -> None:
        """INGEST's value is the creek.ingest wire name."""
        assert CreekCapability.INGEST.value == "creek.ingest"

    def test_save_value_is_wire_name(self) -> None:
        """SAVE's value is the creek.save wire name."""
        assert CreekCapability.SAVE.value == "creek.save"

    def test_classify_value_is_wire_name(self) -> None:
        """CLASSIFY's value is the creek.classify wire name."""
        assert CreekCapability.CLASSIFY.value == "creek.classify"

    def test_reflect_value_is_wire_name(self) -> None:
        """REFLECT's value is the creek.reflect wire name."""
        assert CreekCapability.REFLECT.value == "creek.reflect"

    def test_wheel_value_is_wire_name(self) -> None:
        """WHEEL's value is the creek.wheel wire name."""
        assert CreekCapability.WHEEL.value == "creek.wheel"


class TestHandshakeResultUnavailable:
    """HandshakeResult.unavailable() is the empty/False result for an absent vault."""

    def test_available_is_false(self) -> None:
        """Available is False on the unavailable result."""
        assert HandshakeResult.unavailable().available is False

    def test_contract_version_is_none(self) -> None:
        """contract_version is None on the unavailable result."""
        assert HandshakeResult.unavailable().contract_version is None

    def test_ontology_version_is_none(self) -> None:
        """ontology_version is None on the unavailable result."""
        assert HandshakeResult.unavailable().ontology_version is None

    def test_capabilities_are_empty(self) -> None:
        """Capabilities is an empty frozenset on the unavailable result."""
        assert HandshakeResult.unavailable().capabilities == frozenset()

    def test_attestation_is_none(self) -> None:
        """Attestation is None on the unavailable result."""
        assert HandshakeResult.unavailable().attestation is None


class TestHandshakeResultPopulated:
    """A populated HandshakeResult round-trips its fields and is immutable."""

    def test_fields_round_trip(self) -> None:
        """Every constructor argument is readable back unchanged."""
        result = HandshakeResult(
            available=True,
            contract_version="0.1.0-draft",
            ontology_version="1.0.0",
            capabilities=frozenset({CreekCapability.HANDSHAKE, CreekCapability.INGEST}),
            attestation={"quote": "sentinel-attestation"},
        )
        assert result.available is True
        assert result.contract_version == "0.1.0-draft"
        assert result.ontology_version == "1.0.0"
        assert result.capabilities == frozenset({CreekCapability.HANDSHAKE, CreekCapability.INGEST})
        assert result.attestation == {"quote": "sentinel-attestation"}

    def test_is_frozen(self) -> None:
        """Mutating a field after construction raises FrozenInstanceError."""
        result = HandshakeResult.unavailable()
        with pytest.raises(FrozenInstanceError):
            result.available = True  # type: ignore[misc]


class TestErrorHierarchy:
    """CreekVaultError is the shared base for both concrete failure types."""

    def test_creek_vault_error_is_runtime_error(self) -> None:
        """CreekVaultError subclasses RuntimeError."""
        assert issubclass(creek_vault.CreekVaultError, RuntimeError)

    def test_unavailable_error_is_creek_vault_error(self) -> None:
        """CreekVaultUnavailableError subclasses CreekVaultError."""
        assert issubclass(creek_vault.CreekVaultUnavailableError, creek_vault.CreekVaultError)

    def test_capability_unsupported_error_is_creek_vault_error(self) -> None:
        """CreekCapabilityUnsupportedError subclasses CreekVaultError."""
        assert issubclass(creek_vault.CreekCapabilityUnsupportedError, creek_vault.CreekVaultError)


def test_vault_ingest_request_defaults_aspect_tags_to_empty_tuple() -> None:
    """aspect_tags defaults to an empty tuple when not supplied."""
    request = VaultIngestRequest(
        body="a private page",
        tier_ceiling=VaultTierCeiling.PERSONAL,
        created_at=datetime(2026, 7, 10, tzinfo=UTC),
    )
    assert request.aspect_tags == ()


def test_contract_version_constant() -> None:
    """CONTRACT_VERSION matches the draft version negotiated in the contract doc."""
    assert CONTRACT_VERSION == "0.1.0-draft"


def test_consumer_id_constant() -> None:
    """CONSUMER_ID matches the identifier adepthood presents at handshake."""
    assert CONSUMER_ID == "CREEK_MCP_CONSUMER"
