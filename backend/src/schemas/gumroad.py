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
    # Gumroad's documented "Verify" license example (app.gumroad.com/api) reports
    # reversal state as four independent booleans on the purchase object, spelled
    # exactly ``refunded``, ``disputed``, ``dispute_won``, and ``chargebacked``;
    # a verify call still answers ``success: true`` for any of them unless the
    # seller enabled auto-disable, so each is parsed and checked. Every flag
    # defaults to ``False`` so a response that omits one degrades to "not known
    # reversed" instead of raising a ValidationError that would 500 the signup
    # happy path — absence must never block a legitimate signup. The reversal
    # gate is best-effort pre-grant screening only; revoking an already-granted
    # entitlement after a later refund is separate, deferred work.
    refunded: bool = False
    disputed: bool = False
    dispute_won: bool = False
    chargebacked: bool = False


class GumroadLicenseResult(BaseModel):
    """Top-level body of a successful ``/v2/licenses/verify`` response."""

    model_config = ConfigDict(extra="allow")

    success: bool
    uses: int
    purchase: GumroadPurchase
