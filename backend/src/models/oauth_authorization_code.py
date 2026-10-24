"""A one-time authorization code: what a person approved, waiting to be exchanged.

When a person approves an agent on the consent page, the agent is sent back with
a short-lived code (#3532). The token endpoint (#3533) trades that code for an
access token, and everything the token may say is decided *here*, at approval
time, rather than at exchange time:

* ``client_id`` and ``redirect_uri`` -- the exchange must present both again and
  they must match exactly, so a code intercepted on its way back cannot be spent
  by anybody else or redirected anywhere else;
* ``code_challenge`` -- the S256 PKCE challenge; the exchange must present the
  verifier that hashes to it, which only the agent that started the flow holds;
* ``resource`` -- the vault MCP URL the token will name as its audience, already
  checked to be this account's own vault;
* ``scope`` -- the grants the person approved, space-separated, in the order the
  server lists them;
* ``user_id`` -- whose vault this is.

The code itself is never stored. ``code_hash`` is its SHA-256 digest, so a read
of this table yields nothing an attacker could present. A code is 256 bits of
randomness, so a fast digest is enough -- the slow-hash reasoning that applies
to a password does not apply to a value nobody chose.

``consumed_at`` is set by the exchange. A code is spendable once, until
``expires_at``, and never again.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime
from sqlmodel import Field, SQLModel

from models.oauth_client import OAUTH_URI_MAX_LENGTH

# A hex SHA-256 digest.
CODE_HASH_LENGTH = 64

# RFC 7636 bounds a code verifier at 128 characters; an S256 challenge is the
# 43-character base64url digest of one. The column admits the RFC's ceiling.
CODE_CHALLENGE_MAX_LENGTH = 128

_CHALLENGE_METHOD_WIDTH = 8

# Every supported scope, space-separated, fits with room to spare.
SCOPE_MAX_LENGTH = 256


class OAuthAuthorizationCode(SQLModel, table=True):
    """One approved authorization request, bound to everything the approval covered."""

    __tablename__ = "oauth_authorization_code"

    id: int | None = Field(default=None, primary_key=True)
    code_hash: str = Field(max_length=CODE_HASH_LENGTH, unique=True, index=True)
    client_id: str = Field(
        max_length=OAUTH_URI_MAX_LENGTH,
        foreign_key="oauth_client.client_id",
        ondelete="CASCADE",
    )
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    redirect_uri: str = Field(max_length=OAUTH_URI_MAX_LENGTH)
    code_challenge: str = Field(max_length=CODE_CHALLENGE_MAX_LENGTH)
    code_challenge_method: str = Field(max_length=_CHALLENGE_METHOD_WIDTH)
    resource: str = Field(max_length=OAUTH_URI_MAX_LENGTH)
    scope: str = Field(max_length=SCOPE_MAX_LENGTH)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    expires_at: datetime = Field(sa_column=Column(DateTime(timezone=True), nullable=False))
    consumed_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
