"""Durable operator paper trail and replay guard for wallet adjustments."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, Index, String, func
from sqlmodel import Field, SQLModel

from security.idempotency import IDEMPOTENCY_DIGEST_COLUMN_WIDTH

ADMIN_ADJUSTMENT_REASON_MAX_LENGTH = 500
_SOURCE_IP_MAX_LENGTH = 45
_REQUEST_FINGERPRINT_WIDTH = 64
_IDEMPOTENCY_COLUMN = Column(
    "idempotency_key",
    String(IDEMPOTENCY_DIGEST_COLUMN_WIDTH),
    nullable=True,
)


class AdminBalanceAdjustment(SQLModel, table=True):
    """One intentional admin mutation, including enough state to replay it safely.

    The symbolic :class:`~models.wallet_audit.WalletAudit` row reconciles the
    wallet. This companion retains the operator's human reason, source address,
    and request fingerprint. The raw idempotency key is never stored.
    """

    __tablename__ = "adminbalanceadjustment"
    __table_args__ = (
        Index(
            "ix_adminbalanceadjustment_actor_idem_key",
            "actor_admin_id",
            "idempotency_key",
            unique=True,
            postgresql_where=_IDEMPOTENCY_COLUMN.is_not(None),
            sqlite_where=_IDEMPOTENCY_COLUMN.is_not(None),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    target_user_id: int = Field(foreign_key="user.id", index=True, ondelete="CASCADE")
    actor_admin_id: int | None = Field(
        default=None,
        foreign_key="user.id",
        index=True,
        ondelete="SET NULL",
        nullable=True,
    )
    delta: int = Field(nullable=False)
    balance_after: int = Field(nullable=False)
    reason: str = Field(
        sa_column=Column(String(ADMIN_ADJUSTMENT_REASON_MAX_LENGTH), nullable=False),
    )
    source_ip: str = Field(sa_column=Column(String(_SOURCE_IP_MAX_LENGTH), nullable=False))
    idempotency_key: str | None = Field(
        default=None,
        sa_column=Column(String(IDEMPOTENCY_DIGEST_COLUMN_WIDTH), nullable=True),
    )
    request_fingerprint: str = Field(
        sa_column=Column(String(_REQUEST_FINGERPRINT_WIDTH), nullable=False),
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(
            DateTime(timezone=True),
            server_default=func.now(),
            nullable=False,
            index=True,
        ),
    )
