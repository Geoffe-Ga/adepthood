"""Pydantic mirrors of Gumroad's license-verification response payloads.

Both models allow extra fields: Gumroad adds fields to its JSON without
notice, and the client must keep parsing when it does.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class GumroadPurchase(BaseModel):
    """The ``purchase`` object nested in a verify-license response."""

    model_config = ConfigDict(extra="allow")

    email: str
    product_id: str
    sale_id: str
    # Gumroad reports refunds and chargebacks as two independent booleans on the
    # purchase; a verify call still answers ``success: true`` for either state
    # unless the seller enabled auto-disable, so both are parsed and checked.
    refunded: bool
    chargebacked: bool


class GumroadLicenseResult(BaseModel):
    """Top-level body of a successful ``/v2/licenses/verify`` response."""

    model_config = ConfigDict(extra="allow")

    success: bool
    uses: int
    purchase: GumroadPurchase
