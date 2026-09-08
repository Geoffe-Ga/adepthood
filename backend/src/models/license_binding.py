"""The active-license binding — which account a Gumroad sale has been redeemed by.

One row per redeemed sale, keyed by Gumroad's stable ``sale_id``. The
``UNIQUE`` constraint on that column is the whole invariant of ADR 0008
Decision 2: a licence unlocks exactly one active account, and it is the
database — never an application pre-check — that refuses the second claimant,
so two racing first claims produce one winner and no double entitlement.

Lifecycle:

* **Created on the first successful claim**, in the same transaction as the
  account and its ``course_access`` entitlement, whichever path created the
  account (password signup, Google, Apple) or the sale webhook.
* **Survives revocation** (Decision 4). A refund or cancellation revokes the
  entitlement it funded but leaves the binding, so a reactivated sale cannot
  be silently bound to a second account while the first still lives.
* **Erased with the account** (Decision 3). ``ON DELETE CASCADE`` plus the
  deletion policy release the sale, and the same key may then be redeemed by
  exactly one new account — access transfers, nothing else does.

There is deliberately no foreign key to ``gumroadsale.id``: a signup can beat
the webhook, so the sale row may not exist yet when the binding is written.
The raw licence key is never stored here or anywhere; the sale id is the
identity.
"""

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, UniqueConstraint
from sqlmodel import Field, SQLModel

# Gumroad sale ids are opaque strings; 255 leaves room without accepting
# unbounded input, matching ``AuthIdentity.subject``.
_SALE_ID_MAX = 255
_PRODUCT_ID_MAX = 255


class LicenseBinding(SQLModel, table=True):
    """One redeemed Gumroad sale, bound to the single account that holds it."""

    __table_args__ = (
        UniqueConstraint("gumroad_sale_id", name="uq_licensebinding_gumroad_sale_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    gumroad_sale_id: str = Field(max_length=_SALE_ID_MAX)
    product_id: str = Field(max_length=_PRODUCT_ID_MAX)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
