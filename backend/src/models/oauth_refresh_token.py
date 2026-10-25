"""A refresh token an agent holds, stored only as its digest (#3533).

An agent that a person approved once keeps working by trading a refresh token
for a fresh ten-minute access token. Each trade *rotates* the refresh token:
the presented one is spent (``rotated_at``) and a new one is issued in the same
``family_id``. A family is every refresh token descending from one code
exchange, so:

* presenting a token that was already rotated away is evidence that two parties
  hold it -- the agent and whoever copied it -- and the whole family is revoked
  (``revoked_at`` on every row), OAuth 2.1 section 4.3.1's reuse detection;
* revoking one token (RFC 7009) or the grant it belongs to (#3534) revokes its
  family, so no rotation of it survives.

The token itself is never stored. ``token_hash`` is its SHA-256: 256 random
bits need no slow hash, and the endpoint needs an indexed lookup. ``grant_id``
ties the family to the standing :class:`~models.agent_grant.AgentGrant` it was
issued under, which is where the agent, the account, the grants and the vault
it may name live; ``user_id`` is restated so the account's erasure and export
policy can name the table by its own column.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime
from sqlmodel import Field, SQLModel

from models.oauth_authorization_code import CODE_HASH_LENGTH

#: A family id is a UUID's 32 hex digits.
FAMILY_ID_LENGTH = 32


class OAuthRefreshToken(SQLModel, table=True):
    """One refresh token in one rotation family: live, rotated away, or revoked."""

    __tablename__ = "oauth_refresh_token"

    id: int | None = Field(default=None, primary_key=True)
    token_hash: str = Field(max_length=CODE_HASH_LENGTH, unique=True, index=True)
    family_id: str = Field(max_length=FAMILY_ID_LENGTH, index=True)
    grant_id: int = Field(foreign_key="agent_grant.id", ondelete="CASCADE", index=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    expires_at: datetime = Field(sa_column=Column(DateTime(timezone=True), nullable=False))
    rotated_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    revoked_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
