"""Tests for the pure Creek Vault domain module (domain.creek_vault)."""

from __future__ import annotations

import json
from dataclasses import FrozenInstanceError
from datetime import UTC, datetime

import pytest

from domain import creek_vault
from domain.creek_vault import (
    CONSUMER_ID,
    CONTRACT_VERSION,
    TIER_CEILING_BY_CLASSIFICATION,
    CreekCapability,
    CreekVaultCareEscalationError,
    CreekVaultPayloadError,
    HandshakeResult,
    VaultErrorCode,
    VaultIngestAction,
    VaultIngestRequest,
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
    tier_ceiling_for,
)
from models.journal_entry import JournalClassification
from scripts.creek_contract_drift import BUNDLE_ROOT

# Creek's error vocabulary, closed at contract 0.2 and published as an enum in
# the vendored envelope schema. Read at runtime rather than restated, so a code
# adepthood invents is caught against the bundle instead of against a copy.
_ERROR_ENVELOPE_SCHEMA = "schemas/ErrorEnvelope.schema.json"
_PUBLISHED_ERROR_CODE_COUNT = 9

# Creek's reflection response, whose ``status`` enum publishes the two outcomes a
# 200 may carry. An escalation is a different published document at the same
# status, so it is deliberately not a member of this enum.
_REFLECTION_RESPONSE_SCHEMA = "schemas/ReflectionResponse.schema.json"

# The published fields the domain value object carries across the seam. Both the
# vault's own answer and the routing it applied: five, and never a sixth built
# from Creek's own prose.
_REFLECTION_FIELDS = ("status", "notes", "essay", "essay_grounded", "routed_tier")


def _published_error_codes() -> frozenset[str]:
    """Return the wire error codes Creek publishes, read from the vendored schema."""
    schema = json.loads((BUNDLE_ROOT / _ERROR_ENVELOPE_SCHEMA).read_bytes())
    assert isinstance(schema, dict)
    published = schema["$defs"]["ErrorCode"]["enum"]
    assert isinstance(published, list)
    return frozenset(str(code) for code in published)


def _published_reflection_statuses() -> frozenset[str]:
    """Return the statuses Creek's reflection response publishes, read from the schema."""
    schema = json.loads((BUNDLE_ROOT / _REFLECTION_RESPONSE_SCHEMA).read_bytes())
    assert isinstance(schema, dict)
    published = schema["properties"]["status"]["enum"]
    assert isinstance(published, list)
    return frozenset(str(status) for status in published)


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

    def test_journal_value_is_wire_name(self) -> None:
        """JOURNAL's value is the creek.journal wire name."""
        assert CreekCapability.JOURNAL.value == "creek.journal"

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


class TestRatifiedWireVocabularies:
    """The two vault-supplied vocabularies, pinned to the exact strings on the wire.

    Both are parsed straight off a vault response and both are closed sets: a
    value that drifts stops matching what Creek sends, which silently degrades
    every write rather than failing loudly, so the members are pinned in order.
    """

    def test_error_codes_are_the_published_strings_adepthood_parses(self) -> None:
        """The error vocabulary is exactly the published codes adepthood reads, in order."""
        assert [code.value for code in VaultErrorCode] == [
            "invalid_request",
            "unsupported_capability",
            "incompatible_version",
            "temporarily_unavailable",
            "privacy_refused",
            "not_found",
            "unavailable",
        ]

    def test_ingest_actions_are_the_three_upsert_outcomes(self) -> None:
        """An upsert reports exactly one of three actions, and they are wire strings."""
        assert [action.value for action in VaultIngestAction] == [
            "created",
            "updated",
            "unchanged",
        ]


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
            contract_version="9.9.9",
            ontology_version="1.0.0",
            capabilities=frozenset({CreekCapability.HANDSHAKE, CreekCapability.JOURNAL}),
            attestation={"quote": "sentinel-attestation"},
        )
        assert result.available is True
        assert result.contract_version == "9.9.9"
        assert result.ontology_version == "1.0.0"
        assert result.capabilities == frozenset(
            {CreekCapability.HANDSHAKE, CreekCapability.JOURNAL}
        )
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


def test_payload_error_is_a_vault_error_distinct_from_unavailable_and_contract() -> None:
    """An unreadable answer is its own fault: the vault was there, and spoke nonsense.

    It must stay outside both neighbouring types in both directions -- "the vault
    was not there" and "the vault refused our call" send an operator somewhere
    else entirely -- while still being caught by the one hierarchy every read
    service degrades on.
    """
    assert issubclass(CreekVaultPayloadError, creek_vault.CreekVaultError)
    assert not issubclass(CreekVaultPayloadError, creek_vault.CreekVaultUnavailableError)
    assert not issubclass(CreekVaultPayloadError, creek_vault.CreekVaultContractError)
    assert not issubclass(creek_vault.CreekVaultUnavailableError, CreekVaultPayloadError)
    assert not issubclass(creek_vault.CreekVaultContractError, CreekVaultPayloadError)
    with pytest.raises(creek_vault.CreekVaultError):
        raise CreekVaultPayloadError("creek vault returned an unreadable response")


def test_care_escalation_is_not_a_vault_error() -> None:
    """An escalation must escape the hierarchy every read path degrades on, and carry nothing.

    ``VaultResonanceLLM.complete`` catches ``CreekVaultError`` and answers from
    the cloud instead. If an escalation were caught there, Creek's care guard
    would be overridden by exactly the model prose it refused to produce, so the
    escape has to be structural rather than a matter of ordering an ``except``.
    Content-free for the second half of the same reason: Creek's ``reason``, its
    ``care_signal`` message, and its resources are Creek's own copy, and
    adepthood renders only the care surface it reviewed itself.
    """
    assert not issubclass(CreekVaultCareEscalationError, creek_vault.CreekVaultError)
    assert issubclass(CreekVaultCareEscalationError, Exception)

    escalation = CreekVaultCareEscalationError()
    assert not isinstance(escalation, creek_vault.CreekVaultError)
    assert escalation.args == ()
    assert str(escalation) == ""
    assert not vars(escalation)


def test_vault_reflection_is_a_frozen_value_with_the_published_fields() -> None:
    """The seam's reflection value is immutable and carries exactly the published shape.

    ``VaultReflectionStatus`` is pinned against Creek's own ``status`` enum read
    from the vendored schema rather than a copy of it, because the whole point of
    a structured return is that the six reflection outcomes stop collapsing into
    one blank string: a status member adepthood invented would never match a wire
    value and would silently defer every answer it was meant to carry.
    """
    assert {status.value for status in VaultReflectionStatus} == _published_reflection_statuses()
    assert VaultReflectionStatus.OK.value == "ok"
    assert VaultReflectionStatus.EMPTY.value == "empty"

    note = VaultReflectionNote(kind="connection", quote="the river kept moving", note="You return.")
    reflection = VaultReflection(
        status=VaultReflectionStatus.OK,
        notes=(note,),
        essay=None,
        essay_grounded=False,
        routed_tier=VaultTierCeiling.PERSONAL,
    )

    assert tuple(reflection.__dataclass_fields__) == _REFLECTION_FIELDS
    assert reflection.notes == (note,)
    assert reflection.essay is None
    assert reflection.essay_grounded is False
    assert reflection.routed_tier is VaultTierCeiling.PERSONAL
    with pytest.raises(FrozenInstanceError):
        reflection.essay = "an essay this app never renders"  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        note.quote = "a quote the user never wrote"  # type: ignore[misc]


def test_vault_error_code_covers_the_published_codes_we_classify() -> None:
    """The codes the read path classifies on are Creek's own, spelled Creek's way.

    The subset assertion is the load-bearing half: a member adepthood invented
    would never match a wire string, so it would silently drop every response it
    was meant to classify.
    """
    assert VaultErrorCode.PRIVACY_REFUSED.value == "privacy_refused"
    assert VaultErrorCode.NOT_FOUND.value == "not_found"
    assert VaultErrorCode.UNAVAILABLE.value == "unavailable"

    published = _published_error_codes()
    assert len(published) == _PUBLISHED_ERROR_CODE_COUNT
    assert {code.value for code in VaultErrorCode} <= published


def test_unavailable_error_carries_an_optional_code() -> None:
    """An absent vault may name its own reason, and defaults to naming none."""
    uncoded = creek_vault.CreekVaultUnavailableError("creek vault call failed: creek.wheel")
    coded = creek_vault.CreekVaultUnavailableError(
        "creek vault call failed: creek.wheel", code=VaultErrorCode.UNAVAILABLE
    )
    assert uncoded.code is None
    assert coded.code is VaultErrorCode.UNAVAILABLE


def test_vault_ingest_request_round_trips_entry_id_and_tier() -> None:
    """entry_id, tier, and tier_ceiling are readable back unchanged."""
    request = VaultIngestRequest(
        entry_id=42,
        body="a private page",
        tier=VaultTierCeiling.PERSONAL,
        tier_ceiling=VaultTierCeiling.PERSONAL,
        created_at=datetime(2026, 7, 10, tzinfo=UTC),
    )
    assert request.entry_id == 42
    assert request.tier == VaultTierCeiling.PERSONAL
    assert request.tier_ceiling == VaultTierCeiling.PERSONAL


def test_contract_version_constant() -> None:
    """CONTRACT_VERSION pins the version adepthood advertises at handshake.

    It tracks Creek's published contract constant, and the docs restate it.
    """
    assert CONTRACT_VERSION == "0.2.0"


def test_consumer_id_constant() -> None:
    """CONSUMER_ID matches the identifier adepthood presents at handshake."""
    assert CONSUMER_ID == "CREEK_MCP_CONSUMER"
