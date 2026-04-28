"""Append-only audit log for every wallet mutation (BUG-BM-011).

One row per ``offering_balance`` / ``monthly_messages_used`` change so an
operator can answer "who debited this user's wallet, when, and why" with
a single ``SELECT``.  The table is intentionally not exposed via the API:
it's a forensic surface read by ops via direct SQL, not a feature.

Append-only is enforced at the application layer: :mod:`services.wallet`
only ever calls ``session.add`` to insert a fresh row alongside the
underlying ``UPDATE``; nothing in the codebase issues ``UPDATE`` /
``DELETE`` against ``walletaudit``.  Operators that want defence-in-depth
at the database layer should ``REVOKE UPDATE, DELETE`` from the
application role in their deployment script — the role name is
environment-specific (CI uses ``aptitude``, production uses
``adepthood``), so we do not embed it in the migration.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import Column, DateTime, Numeric, String, func
from sqlmodel import Field, SQLModel

# Wallet-mutation reason tokens.  Kept as module constants so the service
# layer references symbolic names rather than free-form strings — this
# keeps the audit query interface small and lets future analytics group
# rows by reason without touching prose.  Only the tokens used by code
# in this PR are defined here; new flows (refunds, monthly resets, etc.)
# should add their own constant *with their first call site*, not as
# speculative scaffolding.
REASON_SPEND_MONTHLY = "spend_monthly"
REASON_SPEND_OFFERING = "spend_offering"
# ``admin_grant`` — an admin granted credits to ANOTHER user
# (``actor_user_id != user_id``).  Distinct from ``self_grant`` so a
# future non-admin call site (Stripe webhook, referral credit) cannot
# silently mis-label its audit rows as admin-initiated; an analyst
# filtering by reason gets a clean signal of who did the granting.
REASON_ADMIN_GRANT = "admin_grant"
REASON_SELF_GRANT = "self_grant"
# ``monthly_reset`` — first-of-the-month rollover that zeroes
# ``monthly_messages_used``.  Recording this is what makes
# reconciliation possible: without it an operator diffing
# ``User.monthly_messages_used`` across the boundary would see an
# unexplained drop with no audit row, and the "every wallet mutation
# is audited" contract above would be a lie.  ``actor_user_id`` is
# the same as ``user_id`` for resets — they're scheduled
# system-initiated mutations rather than admin actions.
REASON_MONTHLY_RESET = "monthly_reset"

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
    # ``server_default=now()`` mirrors the migration's defence-in-depth
    # default so a direct SQL ``INSERT`` from ops tooling that omits
    # ``created_at`` lands cleanly.  Application writes still supply
    # ``datetime.now(UTC)`` via ``default_factory`` so behaviour is
    # identical between ORM and raw paths.
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(
            DateTime(timezone=True),
            server_default=func.now(),
            nullable=False,
            index=True,
        ),
    )
