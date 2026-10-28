"""What one person has let one agent do with their vault.

One row per (account, client): the standing answer a person gave on the consent
page (#3532). Settings lists these rows and its Revoke control sets
``revoked_at`` (#3534); the token endpoint refuses a revoked grant at code
exchange and at refresh (#3533) and stamps ``last_used_at`` on each issuance.

**One row, not one per approval.** A person approving the same agent again --
a reinstall, a second laptop running the same client -- is restating one
relationship, so the row is updated in place: ``grants`` become what they just
approved and ``resource`` the vault they approved it for. A person
re-approving an agent they had revoked is a *new* consent, so ``revoked_at`` is
cleared and ``created_at`` restarts at that moment; anything minted under the
earlier consent predates ``created_at`` and the token endpoint must treat it as
belonging to the revoked one.

``grants`` holds scope names (``vault:read``, ``vault:desk``, ...), never prose,
and ``resource`` is this account's own vault MCP URL -- the audience every token
under this grant names. Neither column is anything the person wrote.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, Column, DateTime, UniqueConstraint
from sqlmodel import Field, SQLModel

from models.oauth_client import OAUTH_URI_MAX_LENGTH


class AgentGrant(SQLModel, table=True):
    """One account's standing approval of one agent: its grants, and whether it holds."""

    __tablename__ = "agent_grant"
    __table_args__ = (UniqueConstraint("user_id", "client_id", name="uq_agent_grant_user_client"),)

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    client_id: str = Field(
        max_length=OAUTH_URI_MAX_LENGTH,
        foreign_key="oauth_client.client_id",
        ondelete="CASCADE",
    )
    grants: list[str] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))
    resource: str = Field(max_length=OAUTH_URI_MAX_LENGTH)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    last_used_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    revoked_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
