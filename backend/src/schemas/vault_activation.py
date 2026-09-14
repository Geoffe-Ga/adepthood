"""Secret-free public activation DTOs and the internal handoff request."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from models.user_vault_config import VAULT_URL_MAX_LENGTH
from schemas.vault_config import VAULT_API_KEY_MAX_LENGTH

_IDENTIFIER_MAX_LENGTH = 200
VaultActivationStateValue = Literal[
    "inactive",
    "submitting",
    "pending",
    "provisioning",
    "awaiting_handoff",
    "ready",
    "failed",
    "deleting",
    "deleted",
]

VaultCustodyModeValue = Literal["provider_managed", "wrapped_artifact_only"]


VaultFailureReason = Literal[
    "provider_unavailable",
    "provider_rejected",
    "handoff_failed",
    "internal_error",
    "malformed_completion",
]


class VaultActivationResponse(BaseModel):
    """Everything the frontend may learn about managed-vault progress."""

    active: bool
    state: VaultActivationStateValue
    new_activation_available: bool
    retryable: bool
    failure_reason: VaultFailureReason | None
    credential_received: bool
    attested_confidential: bool | None
    custody_mode: VaultCustodyModeValue | None


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
