"""Verbatim persistence of Gumroad ping webhooks.

One row per received ping, keyed by Gumroad's ``sale_id`` so webhook replays
collapse onto the existing row. The typed columns cover the fields current
features read; ``raw_payload`` keeps the posted form intact (string values
stay strings) so later features can re-derive anything else without asking
Gumroad to resend history.

The row also carries the token-pack credit claim: ``token_pack_credited_at``
is the exactly-once guard a wallet credit takes before moving any money, and
``token_pack_credited_user_id`` records which account received it.
"""

from datetime import UTC, datetime

from sqlalchemy import JSON, Column, DateTime
from sqlmodel import Field, SQLModel

# Gumroad's ``resource_name`` for a purchase event — the only ping that
# carries an entitlement or wallet side effect. Public so the router and the
# token-pack sweep filter on one spelling.
SALE_RESOURCE_NAME = "sale"


class GumroadSale(SQLModel, table=True):
    """A single Gumroad ping webhook, stored verbatim plus typed hot fields."""

    id: int | None = Field(default=None, primary_key=True)
    # Gumroad's sale_id — the idempotency key for webhook replays.
    gumroad_sale_id: str = Field(index=True, unique=True)
    product_id: str
    email: str
    resource_name: str
    is_recurring_charge: bool = Field(default=False)
    refunded: bool = Field(default=False)
    # The posted form dict exactly as received — Gumroad sends booleans as
    # the strings "true"/"false", and those strings are preserved here.
    raw_payload: dict[str, str] = Field(
        default_factory=dict,
        sa_column=Column(JSON, nullable=False),
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    # The token-pack claim guard. NULL means "no wallet credit has been taken
    # for this sale yet"; a guarded UPDATE stamps it, so only one writer can
    # ever move the credits. It deliberately outlives the crediting account:
    # a deleted-then-re-registered email must not re-mint the same pack.
    token_pack_credited_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    # Provenance for the credit — which account the pack landed in. ``SET
    # NULL`` on user deletion mirrors ``WalletAudit.actor_user_id``: the
    # financial trail survives the account, and the guard above still blocks
    # a second credit.
    token_pack_credited_user_id: int | None = Field(
        default=None,
        foreign_key="user.id",
        ondelete="SET NULL",
        index=True,
        nullable=True,
    )
