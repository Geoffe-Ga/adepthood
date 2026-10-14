"""Verbatim persistence of Gumroad ping webhooks.

One row per received ping, keyed by Gumroad's ``sale_id`` so webhook replays
collapse onto the existing row. The typed columns cover the fields current
features read; ``raw_payload`` keeps the posted form intact (string values
stay strings) so later features can re-derive anything else without asking
Gumroad to resend history.

The row also carries the token-pack credit claim: ``token_pack_credited_at``
is the exactly-once guard a wallet credit takes before moving any money, and
``token_pack_credited_user_id`` records which account received it.

``revocation_processed_at`` is the mirror-image guard for reversals — the one
claim every refund, dispute, cancellation, and subscription-ended event
competes for, so a purchase is unwound exactly once no matter how many
reversal pings Gumroad delivers.

A membership's life after the purchase is tracked apart from that claim
(#3259). ``subscription_cancelled_at`` is the audit stamp of the first
``cancellation`` ping, which changes no access. ``subscription_ended_at`` and
``subscription_restarted_at`` each hold the latest event time of their kind,
so :func:`subscription_has_ended` answers "which came last?" whatever order
Gumroad delivered them in, and a replay of either is a no-op.

``anonymised_at`` records when account deletion blanked the buyer's identifiers
on a sale linked to the deleted account (#3063 AC15). It starts the receipt's
ratified retention clock; a sale never linked to an account is never stamped.
"""

from datetime import UTC, datetime

from sqlalchemy import JSON, Column, DateTime
from sqlmodel import Field, SQLModel

# Gumroad's ``resource_name`` for a purchase event — the only ping that
# carries an entitlement or wallet side effect. Public so the router and the
# token-pack sweep filter on one spelling.
SALE_RESOURCE_NAME = "sale"


def _timestamp_column() -> Column[datetime]:
    """A nullable, timezone-aware timestamp column (one fresh object per field)."""
    return Column(DateTime(timezone=True), nullable=True)


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
    # The reversal claim guard, shared by every event that unwinds a purchase.
    # NULL means "nothing has reversed this sale yet"; a guarded UPDATE stamps
    # it, so the refund and the cancellation of the same subscription cannot
    # both revoke. Sharing one column rather than one per event kind is the
    # point: the second event to arrive has genuinely nothing left to undo.
    revocation_processed_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    # When account deletion blanked ``email`` and ``raw_payload`` on this sale,
    # because it was linked to the deleted account (a licence binding or a
    # token-pack credit). NULL means never anonymised: the sale was never
    # linked, or no linked account has been deleted. The receipt's ratified
    # retention counts from here (domain.retention, ``gumroadsale``).
    anonymised_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    # The membership's audit and state stamps (#3259), see the module
    # docstring. None of them is a reversal claim: a cancelled or ended
    # membership keeps ``revocation_processed_at`` unspent, so a later refund
    # or dispute still applies in full.
    subscription_cancelled_at: datetime | None = Field(default=None, sa_column=_timestamp_column())
    subscription_ended_at: datetime | None = Field(default=None, sa_column=_timestamp_column())
    subscription_restarted_at: datetime | None = Field(default=None, sa_column=_timestamp_column())


def subscription_has_ended(sale: GumroadSale) -> bool:
    """Whether the latest membership event recorded on ``sale`` is its ending.

    Ordered by Gumroad's own event times, not by arrival, so a restart that
    was delivered before the ending it followed still wins. A tie reads as
    live, the user-protective side.
    """
    ended_at = sale.subscription_ended_at
    if ended_at is None:
        return False
    restarted_at = sale.subscription_restarted_at
    return restarted_at is None or _as_utc(ended_at) > _as_utc(restarted_at)


def _as_utc(moment: datetime) -> datetime:
    """Read a stored stamp as aware UTC (SQLite hands timestamps back naive)."""
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)
