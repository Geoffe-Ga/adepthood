"""Social sign-in identities — the "this provider account is that user" link.

One row per (provider, provider-subject) pair, pointing at the Adepthood
account it unlocks. A dedicated table rather than columns on ``User`` because a
single account may eventually carry several links (Google today, Apple next)
and because the link's own provenance — which mailbox proved ownership, and
when — is audit data that does not belong in the account row.

Two constraints carry the security of the table:

* ``uq_authidentity_provider_subject`` — no two rows may claim the same
  provider subject. Without it a race could fork one Google account across two
  Adepthood accounts, and thereafter which one a sign-in reached would be
  decided by row order.
* ``ck_authidentity_provider_valid`` — the accepted provider set is derived
  from :class:`AuthProvider` so the database set cannot drift from the Python
  enum.

The unique constraint is a plain ``UniqueConstraint`` rather than a partial
index on purpose: it renders identically through ``metadata.create_all`` on the
SQLite test database and through the migration on PostgreSQL, so the
integrity contract is exercised by the same DDL everywhere.
"""

import enum
from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime, UniqueConstraint
from sqlmodel import Field, SQLModel

# Generous ceiling for the provider discriminator; the longest member
# ("google") is six characters.
_PROVIDER_MAX = 16

# Provider subject identifiers are opaque strings. Google's are ~21 digits and
# Apple's ~44 characters; 255 leaves room without accepting unbounded input.
_SUBJECT_MAX = 255

# Matches ``User.email``'s ceiling so a link can always record the address it
# was made against.
_EMAIL_MAX = 254


class AuthProvider(enum.StrEnum):
    """The identity providers Adepthood accepts a sign-in from.

    Values are the wire spellings the providers themselves use, so the stored
    discriminator reads the same in the database as in a provider's docs.
    """

    GOOGLE = "google"
    APPLE = "apple"


def _provider_check() -> CheckConstraint:
    """CHECK derived from ``AuthProvider`` so the DB set can't drift."""
    quoted = ", ".join(f"'{provider.value}'" for provider in AuthProvider)
    return CheckConstraint(f"provider IN ({quoted})", name="ck_authidentity_provider_valid")


class AuthIdentity(SQLModel, table=True):
    """One provider account, linked to the Adepthood account it signs into.

    ``subject`` is the provider's stable per-application user id and is the
    only field a sign-in may be keyed on: a provider can reassign an email
    address, but never a subject.

    ``email_at_link_time`` is NOT NULL by design. A link is only ever created
    against an address the provider has verified, so recording that address is
    an invariant, not an option — it is the audit answer to "which mailbox
    authorised this link?". It is a snapshot, never a lookup key: the account's
    current address lives on ``User.email`` and may since have changed.
    """

    __table_args__ = (
        _provider_check(),
        UniqueConstraint("provider", "subject", name="uq_authidentity_provider_subject"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    provider: str = Field(max_length=_PROVIDER_MAX)
    subject: str = Field(max_length=_SUBJECT_MAX)
    email_at_link_time: str = Field(max_length=_EMAIL_MAX)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
