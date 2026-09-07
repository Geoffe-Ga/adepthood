"""Durable private-vault activation and content-free teardown receipts."""

from __future__ import annotations

import enum
from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime, Index
from sqlmodel import Field, SQLModel

_IDENTITY_WIDTH = 200
_STATE_WIDTH = 32
_REASON_WIDTH = 64


class VaultActivationState(enum.StrEnum):
    """Stable Adepthood lifecycle states exposed to an activated account."""

    SUBMITTING = "submitting"
    PENDING = "pending"
    PROVISIONING = "provisioning"
    AWAITING_KEY_CEREMONY = "awaiting_key_ceremony"
    AWAITING_HANDOFF = "awaiting_handoff"
    READY = "ready"
    FAILED = "failed"
    DELETING = "deleting"
    DELETED = "deleted"


def _quoted(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


_ACTIVATION_STATES = tuple(state.value for state in VaultActivationState)
_TEARDOWN_STATES = (
    VaultActivationState.DELETING.value,
    VaultActivationState.DELETED.value,
    VaultActivationState.FAILED.value,
)


class VaultActivation(SQLModel, table=True):
    """One explicit, idempotent Creek provisioning activation per account."""

    __tablename__ = "vaultactivation"
    __table_args__ = (
        CheckConstraint(
            f"state IN ({_quoted(_ACTIVATION_STATES)})",
            name="ck_vaultactivation_state_valid",
        ),
        Index("ix_vaultactivation_state_id", "state", "id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, ondelete="CASCADE")
    activation_id: str = Field(max_length=_IDENTITY_WIDTH, unique=True)
    consumer_identity: str = Field(max_length=_IDENTITY_WIDTH, unique=True)
    creek_job_id: str | None = Field(default=None, max_length=_IDENTITY_WIDTH, unique=True)
    state: str = Field(default=VaultActivationState.SUBMITTING.value, max_length=_STATE_WIDTH)
    retryable: bool = Field(default=False, nullable=False)
    failure_reason: str | None = Field(default=None, max_length=_REASON_WIDTH)
    credential_received_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    attested_confidential: bool | None = Field(default=None, nullable=True)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )


class VaultTeardownReceipt(SQLModel, table=True):
    """Content-free upstream deletion state retained after local erasure."""

    __tablename__ = "vaultteardownreceipt"
    __table_args__ = (
        CheckConstraint(
            f"state IN ({_quoted(_TEARDOWN_STATES)})",
            name="ck_vaultteardownreceipt_state_valid",
        ),
        CheckConstraint(
            "attempts >= 0",
            name="ck_vaultteardownreceipt_attempts_range",
        ),
        Index("ix_vaultteardownreceipt_state_updated", "state", "updated_at"),
    )

    id: int | None = Field(default=None, primary_key=True)
    creek_job_id: str = Field(max_length=_IDENTITY_WIDTH, unique=True)
    state: str = Field(default=VaultActivationState.DELETING.value, max_length=_STATE_WIDTH)
    attempts: int = Field(default=0, ge=0, nullable=False)
    retryable: bool = Field(default=False, nullable=False)
    failure_reason: str | None = Field(default=None, max_length=_REASON_WIDTH)
    requested_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    confirmed_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
