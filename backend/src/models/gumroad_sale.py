"""Verbatim persistence of Gumroad ping webhooks.

One row per received ping, keyed by Gumroad's ``sale_id`` so webhook replays
collapse onto the existing row. The typed columns cover the fields current
features read; ``raw_payload`` keeps the posted form intact (string values
stay strings) so later features can re-derive anything else without asking
Gumroad to resend history.
"""

from datetime import UTC, datetime

from sqlalchemy import JSON, Column, DateTime
from sqlmodel import Field, SQLModel


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
