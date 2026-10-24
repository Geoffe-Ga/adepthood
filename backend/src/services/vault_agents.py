"""The agents one account has let read its vault, and stopping one (#3534).

Settings, under "Where your writing lives", lists every agent a person approved
on the consent page (#3532) and lets them revoke it. This module is the policy
half of that: which rows are listed, what each one says, and what revoking
writes. The router holds only HTTP; ownership of a grant id is decided by
:func:`dependencies.ownership.resolve_owned_agent_grant` before anything here
runs.

**Listed means standing.** A revoked grant is not listed: it can do nothing,
and showing it beside the agents that can would ask a person to tell the two
apart. Approving the same agent again is a new consent (A1 clears
``revoked_at`` and restarts ``created_at``), so it reappears then as the agent
it is.

**Revoking is two writes and one commit.** ``agent_grant.revoked_at`` is set
and every live refresh token under the grant is revoked
(:func:`services.oauth_tokens.revoke_grant_tokens`). Either alone already stops
the agent's next refresh at the token endpoint (#3533); both together leave
nothing live to argue about. An access token already issued is not recalled --
the vault verifies those offline -- so the agent stops within one access-token
lifetime (ten minutes), which is the promise the epic makes.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import cast
from urllib.parse import urlsplit

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.dates import ensure_aware
from models.agent_grant import AgentGrant
from models.oauth_client import OAuthClient
from schemas.vault_agents import ConnectedAgentResponse
from services.oauth_tokens import revoke_grant_tokens


def redirect_host(redirect_uris: Sequence[str]) -> str | None:
    """The host of the first registered redirect, or ``None`` if there is none to read.

    The first, because a client lists the redirect it uses first and the
    consent page named that host to the person when they approved. ``None``
    rather than an empty string for a client with no readable redirect, so the
    screen has one absence to handle.
    """
    if not redirect_uris:
        return None
    return urlsplit(redirect_uris[0]).hostname or None


def _to_response(grant: AgentGrant, client: OAuthClient) -> ConnectedAgentResponse:
    """Project one grant and the client it names onto the response row.

    Timestamps are re-anchored to UTC because SQLite drops ``tzinfo`` on a
    round trip; the instant stored is always the UTC one written. The id is
    cast rather than checked: a row read from storage always carries its key.
    """
    return ConnectedAgentResponse(
        id=cast("int", grant.id),
        name=client.client_name or None,
        grants=list(grant.grants),
        created_at=ensure_aware(grant.created_at),
        last_used_at=ensure_aware(grant.last_used_at) if grant.last_used_at else None,
        redirect_host=redirect_host(client.redirect_uris),
    )


async def list_connected_agents(
    session: AsyncSession, user_id: int
) -> list[ConnectedAgentResponse]:
    """Every agent ``user_id`` has approved and not revoked, newest approval first.

    One query: each grant joined to the client it names, for the agent's name
    and redirect. The account is the caller's own, from their token; nothing a
    request carries can widen it.
    """
    result = await session.execute(
        select(AgentGrant, OAuthClient)
        .join(OAuthClient, col(OAuthClient.client_id) == col(AgentGrant.client_id))
        .where(col(AgentGrant.user_id) == user_id)
        .where(col(AgentGrant.revoked_at).is_(None))
        .order_by(col(AgentGrant.created_at).desc(), col(AgentGrant.id).desc())
    )
    return [_to_response(grant, client) for grant, client in result.all()]


async def revoke_agent(session: AsyncSession, grant: AgentGrant) -> None:
    """Stop ``grant``'s agent: mark it revoked, revoke its refresh tokens, commit.

    Idempotent. A grant already revoked keeps the moment it was first revoked,
    so a double press or a retried request changes nothing a person or an
    auditor could see; its tokens are swept again, which finds none live.
    """
    now = datetime.now(UTC)
    if grant.revoked_at is None:
        grant.revoked_at = now
        session.add(grant)
    await revoke_grant_tokens(session, cast("int", grant.id), now)
    await session.commit()
