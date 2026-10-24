"""The agents a person has let read their vault: list them, stop one (#3534).

Two verbs under "Where your writing lives" in Settings:

* ``GET /vault/agents`` -- every agent this account approved on the consent page
  (#3532) and has not revoked, with its grants and when it last signed in;
* ``DELETE /vault/agents/{agent_id}`` -- Revoke: the grant is marked revoked and
  its refresh tokens with it, so the agent's next refresh at the token endpoint
  (#3533) is ``invalid_grant`` and it stops within one access-token lifetime.

The account is the caller's own, from their bearer token; no account id is read
from a path or a body. The one id a request carries is the grant's, and
:func:`dependencies.ownership.require_owned_agent_grant` answers another
account's grant with the same 404 as a missing one.

There is deliberately no create verb. Agents arrive only through consent, so
nothing here mints a key or a grant.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from dependencies.ownership import require_owned_agent_grant
from error_responses import build_router
from models.agent_grant import AgentGrant
from routers.auth import get_current_user
from schemas.vault_agents import ConnectedAgentResponse
from services.vault_agents import list_connected_agents, revoke_agent

router = build_router(prefix="/vault", tags=["vault"])


@router.get("/agents", response_model=list[ConnectedAgentResponse])
async def list_vault_agents(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[ConnectedAgentResponse]:
    """Every agent this account has approved and not revoked, newest approval first.

    An empty list for an account that has approved nobody -- an answer about a
    set every account has, never a 404 -- so the screen renders its empty state
    straight from the reply.
    """
    return await list_connected_agents(session, user_id)


@router.delete("/agents/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_vault_agent(
    grant: Annotated[AgentGrant, Depends(require_owned_agent_grant)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    """Stop one agent. ``204`` again for an agent already stopped; ``404`` for one not yours."""
    await revoke_agent(session, grant)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
