"""Append-only audit log for every wallet mutation (BUG-BM-011).

One row per ``offering_balance`` / ``monthly_messages_used`` change so an
operator can answer "who debited this user's wallet, when, and why" with
a single ``SELECT``.  The table is intentionally not exposed via the API:
it's a forensic surface read by ops via direct SQL, not a feature.

Append-only is enforced two ways:

1. The Python service layer never updates or deletes a row — it only
   ``session.add`` s a fresh record alongside the underlying ``UPDATE``.
2. The Alembic migration that creates the table grants only ``INSERT``
   on it to the application role; ``UPDATE`` / ``DELETE`` privileges
   stay with the migration role so a rogue route handler cannot rewrite
   history.  In tests on SQLite the role split is a no-op (single
   user); the privilege grant lives in the migration so deployment
   inherits it automatically.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import Column, DateTime, Numeric, String
from sqlmodel import Field, SQLModel

# Wallet-mutation reason tokens.  Kept as module constants so the service
# layer references symbolic names rather than free-form strings — this
# keeps the audit query interface small and lets future analytics group
# rows by reason without touching prose.
REASON_SPEND_MONTHLY = "spend_monthly"
REASON_SPEND_OFFERING = "spend_offering"
REASON_ADMIN_GRANT = "admin_grant"
REASON_REFUND = "refund"

# Bucket tokens — which side of the wallet was changed.  ``monthly`` is
# the free per-calendar-month allocation; ``offering`` is the durable
# paid / gifted credit balance.  ``balance_usd`` is reserved for a
# future monetary balance (today the buckets are message counts only).
BUCKET_MONTHLY = "monthly"
BUCKET_OFFERING = "offering"

# Maximum length for the symbolic columns.  64 is comfortably above the
# longest token name we plan to emit and matches the tzdata-friendly
# 64-char width already used elsewhere in the schema.
_TOKEN_COLUMN_WIDTH = 64

# 18 / 6 covers any per-message credit grant we will ever issue
# (max ~100 trillion) at six decimal places of precision — enough for
# a future fractional-credit world without losing pennies.
_AMOUNT_PRECISION = 18
_AMOUNT_SCALE = 6


class WalletAudit(SQLModel, table=True):
    """One row per wallet mutation; immutable from the application's POV.

    ``actor_user_id`` is the identity that initiated the change — usually
    the same as ``user_id`` (a user spending their own wallet) but
    different when an admin grants credits to someone else
    (BUG-BM-011 / BUG-ADMIN-004).  ``before`` and ``after`` are stored
    as ``Decimal`` so even fractional-credit balances reconcile exactly.
    """

    __tablename__ = "walletaudit"

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    actor_user_id: int = Field(foreign_key="user.id", index=True)
    bucket: str = Field(
        sa_column=Column(String(_TOKEN_COLUMN_WIDTH), nullable=False, index=True),
    )
    reason: str = Field(
        sa_column=Column(String(_TOKEN_COLUMN_WIDTH), nullable=False, index=True),
    )
    delta: Decimal = Field(
        sa_column=Column(Numeric(precision=_AMOUNT_PRECISION, scale=_AMOUNT_SCALE), nullable=False),
    )
    balance_before: Decimal = Field(
        sa_column=Column(Numeric(precision=_AMOUNT_PRECISION, scale=_AMOUNT_SCALE), nullable=False),
    )
    balance_after: Decimal = Field(
        sa_column=Column(Numeric(precision=_AMOUNT_PRECISION, scale=_AMOUNT_SCALE), nullable=False),
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False, index=True),
    )
