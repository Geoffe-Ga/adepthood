"""An agent that may ask a person for access to their vault: one OAuth public client.

Adepthood is the authorization server for a person's vault agents (#3532): an
agent -- Claude Code, a ChatGPT connector, OpenClaw -- registers here, sends the
person to a consent page, and leaves with an authorization code it trades for a
token the vault verifies. This row is the "who is asking" half of that exchange.

Every client is *public*. None holds a secret: an agent on somebody's laptop has
nowhere to keep one, so possession of the PKCE verifier is what binds a code to
the agent that asked for it. That is why this table has no secret column, not
even a hashed one, and why registration answers with none.

A client arrives one of two ways, recorded in ``source``:

* **Dynamic registration** (RFC 7591). The agent POSTs its metadata and is
  handed a minted ``cl_`` identifier. The row is the whole record.
* **A client metadata document** (CIMD). The agent's ``client_id`` *is* an
  ``https`` URL that serves its metadata. The row is a cache of the last fetch,
  stamped with ``metadata_fetched_at`` so a stale copy is fetched again rather
  than trusted for ever. The document, not the cache, is the authority.

Nothing here belongs to an account. A registration is anonymous by design -- an
agent registers before anybody has signed in -- so the row carries no
``user_id`` and is never anybody's personal data. What one person approved for
one agent lives in :class:`~models.agent_grant.AgentGrant`.

``client_name`` and ``logo_uri`` are what the agent *says* about itself. They are
shown on the consent page as the agent's own words and are rendered through an
autoescaping template, because nothing about them has been verified.
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime

from sqlalchemy import JSON, CheckConstraint, Column, DateTime
from sqlmodel import Field, SQLModel

# Wide enough for a client metadata document URL, which is the client id itself,
# and for any redirect or logo address a client reasonably presents. The same
# ceiling the vault URL column uses, for the same reason: untrusted input that is
# carried into a request builder must be bounded.
OAUTH_URI_MAX_LENGTH = 2048

# A display name an agent gives itself. Long enough for "Claude Code (work
# laptop)", short enough that the consent page cannot be flooded with prose.
OAUTH_CLIENT_NAME_MAX_LENGTH = 100

_SOURCE_WIDTH = 8


class OAuthClientSource(enum.StrEnum):
    """How a client came to be known: registered here, or described by its own URL."""

    DYNAMIC_REGISTRATION = "dcr"
    METADATA_DOCUMENT = "cimd"


_SOURCES = ", ".join(f"'{source.value}'" for source in OAuthClientSource)


class OAuthClient(SQLModel, table=True):
    """One public OAuth client: its identifier, its self-description, where it may return."""

    __tablename__ = "oauth_client"
    __table_args__ = (CheckConstraint(f"source IN ({_SOURCES})", name="ck_oauth_client_source"),)

    id: int | None = Field(default=None, primary_key=True)
    client_id: str = Field(max_length=OAUTH_URI_MAX_LENGTH, unique=True, index=True)
    client_name: str = Field(max_length=OAUTH_CLIENT_NAME_MAX_LENGTH)
    logo_uri: str | None = Field(default=None, max_length=OAUTH_URI_MAX_LENGTH)
    # Every redirect URI the client registered, exactly as registered. A JSON
    # list rather than a child table: the set is small, always read whole, and
    # replaced whole when a metadata document is fetched again.
    redirect_uris: list[str] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))
    source: str = Field(max_length=_SOURCE_WIDTH)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    # When a metadata document was last fetched for this client; ``None`` for a
    # dynamically registered one, which is never fetched.
    metadata_fetched_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
