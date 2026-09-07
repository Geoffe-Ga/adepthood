"""Secret-free public activation DTOs and the internal handoff request."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from models.user_vault_config import VAULT_URL_MAX_LENGTH
from schemas.vault_config import VAULT_API_KEY_MAX_LENGTH

_IDENTIFIER_MAX_LENGTH = 200
_BASE64_12_PATTERN = r"^[A-Za-z0-9_-]{16}$"
_BASE64_32_PATTERN = r"^[A-Za-z0-9_-]{43}$"
_BASE64_48_PATTERN = r"^[A-Za-z0-9_-]{64}$"
_BASE64_64_PATTERN = r"^[A-Za-z0-9_-]{86}$"
_HEX_12_PATTERN = r"^[0-9a-f]{24}$"
_HEX_16_PATTERN = r"^[0-9a-f]{32}$"
_HEX_48_PATTERN = r"^[0-9a-f]{96}$"
VaultActivationStateValue = Literal[
    "inactive",
    "submitting",
    "pending",
    "provisioning",
    "awaiting_key_ceremony",
    "awaiting_handoff",
    "ready",
    "failed",
    "deleting",
    "deleted",
]


class _StrictCeremonyModel(BaseModel):
    """Shared fail-closed shape for every public ceremony DTO."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class VaultKeyCeremonyChallenge(_StrictCeremonyModel):
    """Public Creek challenge relayed without its requester credential."""

    protocol_version: Literal["1.0.0"]
    job_id: str = Field(min_length=1, max_length=_IDENTIFIER_MAX_LENGTH)
    activation_id: str = Field(min_length=1, max_length=_IDENTIFIER_MAX_LENGTH)
    ceremony_id: str = Field(min_length=1, max_length=_IDENTIFIER_MAX_LENGTH)
    server_nonce: str = Field(pattern=_BASE64_32_PATTERN)
    expires_at: datetime

    @field_validator("expires_at")
    @classmethod
    def _timezone_aware(cls, value: datetime) -> datetime:
        """Reject an ambiguous challenge clock before the client trusts it."""
        if value.tzinfo is None:
            raise ValueError("expires_at must be timezone-aware")
        return value


class VaultCeremonyBinding(_StrictCeremonyModel):
    """Public replay binding authenticated by both wrapped VMK copies."""

    protocol_version: Literal["1.0.0"]
    activation_id: str = Field(min_length=1, max_length=_IDENTIFIER_MAX_LENGTH)
    ceremony_id: str = Field(min_length=1, max_length=_IDENTIFIER_MAX_LENGTH)
    server_nonce: str = Field(pattern=_BASE64_32_PATTERN)
    client_nonce: str = Field(pattern=_BASE64_32_PATTERN)


class VaultWrappedCiphertext(_StrictCeremonyModel):
    """One AES-256-GCM nonce and ciphertext-authentication-tag pair."""

    nonce: str = Field(pattern=_HEX_12_PATTERN)
    ciphertext: str = Field(pattern=_HEX_48_PATTERN)


class VaultArgon2idParameters(_StrictCeremonyModel):
    """Fixed protocol-1 passphrase derivation parameters."""

    algorithm: Literal["argon2id"]
    salt: str = Field(pattern=_HEX_16_PATTERN)
    time_cost: Literal[3]
    lanes: Literal[4]
    memory_kib: Literal[65536]


class VaultWrappedKeyArtifact(_StrictCeremonyModel):
    """Ciphertext-only version-2 key vault safe for the backend to relay."""

    version: Literal[2]
    kdf: VaultArgon2idParameters
    passphrase_wrapped: VaultWrappedCiphertext
    recovery_wrapped: VaultWrappedCiphertext
    binding: VaultCeremonyBinding


class VaultAttestationStatement(_StrictCeremonyModel):
    """Public measured-recipient statement signed by Creek's trust root."""

    format: Literal["creek-ed25519-x25519-v1"]
    measurement: str = Field(min_length=1, max_length=_IDENTIFIER_MAX_LENGTH)
    challenge_nonce: str = Field(pattern=_BASE64_32_PATTERN)
    recipient_public_key: str = Field(pattern=_BASE64_32_PATTERN)
    issued_at: datetime
    expires_at: datetime
    signature: str = Field(pattern=_BASE64_64_PATTERN)

    @model_validator(mode="after")
    def _valid_window(self) -> VaultAttestationStatement:
        """Require one finite, timezone-aware attestation window."""
        if self.issued_at.tzinfo is None or self.expires_at.tzinfo is None:
            raise ValueError("attestation timestamps must be timezone-aware")
        if self.expires_at <= self.issued_at:
            raise ValueError("attestation expiry must follow issuance")
        return self


class VaultKeyReleaseEnvelope(_StrictCeremonyModel):
    """Opaque VMK envelope addressed to an attested X25519 recipient."""

    algorithm: Literal["x25519-hkdf-sha256-aes256gcm"]
    recipient_public_key: str = Field(pattern=_BASE64_32_PATTERN)
    ephemeral_public_key: str = Field(pattern=_BASE64_32_PATTERN)
    nonce: str = Field(pattern=_BASE64_12_PATTERN)
    ciphertext: str = Field(pattern=_BASE64_48_PATTERN)


class VaultKeyCeremonySubmission(_StrictCeremonyModel):
    """Strict ciphertext-only completion body relayed to Creek."""

    protocol_version: Literal["1.0.0"]
    ceremony_id: str = Field(min_length=1, max_length=_IDENTIFIER_MAX_LENGTH)
    server_nonce: str = Field(pattern=_BASE64_32_PATTERN)
    recovery_saved: Literal[True]
    wrapped_artifact: VaultWrappedKeyArtifact
    attestation: VaultAttestationStatement | None
    key_release: VaultKeyReleaseEnvelope | None

    @field_validator("recovery_saved", mode="before")
    @classmethod
    def _literal_confirmation(cls, value: object) -> object:
        """Reject truthy coercions; the acknowledgement must be JSON true."""
        if value is not True:
            raise ValueError("recovery_saved must be exactly true")
        return value

    @model_validator(mode="after")
    def _paired_attestation_release(self) -> VaultKeyCeremonySubmission:
        """Require attestation and its addressed release envelope together."""
        if (self.attestation is None) != (self.key_release is None):
            raise ValueError("attestation and key_release must be supplied together")
        return self


VaultFailureReason = Literal[
    "provider_unavailable",
    "provider_rejected",
    "handoff_failed",
    "internal_error",
    "malformed_completion",
]


class VaultActivationResponse(BaseModel):
    """Everything the frontend may learn about private-vault progress."""

    active: bool
    state: VaultActivationStateValue
    retryable: bool
    failure_reason: VaultFailureReason | None
    credential_received: bool
    attested_confidential: bool | None


class CreekConnectionHandoff(BaseModel):
    """Internal one-way delivery; no response schema contains these values."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    job_id: str = Field(min_length=1, max_length=_IDENTIFIER_MAX_LENGTH)
    consumer_identity: str = Field(min_length=1, max_length=_IDENTIFIER_MAX_LENGTH)
    vault_url: str = Field(min_length=1, max_length=VAULT_URL_MAX_LENGTH)
    consumer_credential: str = Field(min_length=1, max_length=VAULT_API_KEY_MAX_LENGTH)

    @field_validator("job_id", "consumer_identity", "vault_url", "consumer_credential")
    @classmethod
    def _reject_outer_whitespace(cls, value: str) -> str:
        """Keep identifiers and secrets byte-exact rather than repairing a callback."""
        if value != value.strip():
            raise ValueError("value must not contain outer whitespace")
        return value


class VaultTeardownStatus(BaseModel):
    """Content-free reconciliation state visible only to operations."""

    creek_job_id: str
    state: Literal["deleting", "deleted", "failed"]
    attempts: int
    retryable: bool
    failure_reason: VaultFailureReason | None
