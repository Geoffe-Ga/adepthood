"""What agents asked a person's vault for, in plain words (#3535).

``GET /vault/agents/activity`` reads Creek's ``GET /v1/agent-activity`` (contract
0.22) through the caller's own resolved vault client and re-projects every row
onto ``{agent, tool_label, at, outcome}``. This module is that projection; the
router holds only HTTP.

**Nothing the vault chose is passed through.** A row's ``consumer`` stamp and
``tool`` name are keys, looked up in tables this account and this module own,
and a key that matches nothing becomes a generic phrase -- never itself. So the
response cannot carry an argument, a path or a sentence of anyone's writing
however a vault shapes its answer; the adapter's strict parse
(:mod:`services.creek_vault_activity_wire`) refuses anything beyond the four
published fields before this module sees it.

**Who asked.** Matched in this order, each a stamp only this account can own:

1. a ``client_id`` of one of the account's grants -- the agent's own name (or
   the consent page's words for one that gave none), or "an agent you stopped"
   once revoked. Since Creek-Vault#1976, this is how Creek stamps every
   agent call;
2. ``adepthood``, the app's own calls on a self-connected vault;
3. the account's managed-vault consumer identity, which the app's calls carry
   and every agent's ``sub`` carried before Creek-Vault#1976 -- "Adepthood or
   one of your agents", or just "Adepthood" while no agent has ever been
   approved;
4. the account's derived agent subject (a self-connected vault's ``sub``, on
   calls stamped before Creek-Vault#1976) -- "one of your agents", since the
   stamp cannot say which;
5. anything else: "something else with access to your vault".

**Degrading.** No vault, a vault that does not advertise the read, and every
failure the adapter can raise become one ``unavailable`` answer, logged through
:func:`services.creek_vault_read.log_read_degraded` with content-free fields
only. Settings shows "could not check", never an error page.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.creek_vault import (
    CreekCapability,
    CreekVaultAgentActivityClient,
    CreekVaultError,
    VaultAgentActivity,
    VaultAgentActivityRow,
)
from models.agent_grant import AgentGrant
from models.oauth_client import OAuthClient
from schemas.vault_agent_activity import (
    AgentActivityResponse,
    AgentActivityRowResponse,
    AgentActivityStatus,
)
from services.creek_vault_read import log_read_degraded
from services.oauth_consent_copy import CONSENT_UNNAMED_AGENT
from services.oauth_tokens import derived_subject, managed_consumer_identity
from services.vault_agent_activity_copy import (
    ACTIVITY_ADEPTHOOD,
    ACTIVITY_ADEPTHOOD_OR_AN_AGENT,
    ACTIVITY_ONE_OF_YOUR_AGENTS,
    ACTIVITY_OTHER_TOOL,
    ACTIVITY_SOMETHING_ELSE,
    ACTIVITY_STOPPED_AGENT,
    TOOL_LABELS,
)

#: The stamp a self-connected vault gives the app's own ``/v1`` calls, when its
#: owner named that consumer as Creek's documentation and fixtures do.
ADEPTHOOD_CONSUMER: Final = "adepthood"

#: How many calls a request asks for when it names no ``limit`` (#3535).
DEFAULT_ACTIVITY_LIMIT: Final = 50


@dataclass(frozen=True)
class _Attribution:
    """Every stamp this account can place, and the words each one earns."""

    by_stamp: Mapping[str, str]

    def agent_for(self, consumer: str) -> str:
        """The words for ``consumer``, or the generic phrase -- never ``consumer`` itself."""
        return self.by_stamp.get(consumer, ACTIVITY_SOMETHING_ELSE)


def _grant_name(grant: AgentGrant, client: OAuthClient) -> str:
    """What one of this account's grants is called in a row."""
    if grant.revoked_at is not None:
        return ACTIVITY_STOPPED_AGENT
    name = (client.client_name or "").strip()
    return name or CONSENT_UNNAMED_AGENT


async def _grant_names(session: AsyncSession, user_id: int) -> dict[str, str]:
    """Every grant this account ever held, stopped ones included, by client id."""
    result = await session.execute(
        select(AgentGrant, OAuthClient)
        .join(OAuthClient, col(OAuthClient.client_id) == col(AgentGrant.client_id))
        .where(col(AgentGrant.user_id) == user_id)
    )
    return {grant.client_id: _grant_name(grant, client) for grant, client in result.all()}


async def _attribution(session: AsyncSession, user_id: int, secret: str) -> _Attribution:
    """Build the stamp table, lowest precedence first so a later rule overrides.

    Committed before returning, so the pooled connection is given back before
    the vault is dialled rather than held across that round trip.
    """
    grants = await _grant_names(session, user_id)
    managed = await managed_consumer_identity(session, user_id)
    await session.commit()
    by_stamp: dict[str, str] = {
        derived_subject(user_id, secret): ACTIVITY_ONE_OF_YOUR_AGENTS,
        ADEPTHOOD_CONSUMER: ACTIVITY_ADEPTHOOD,
    }
    if managed is not None:
        by_stamp[managed] = ACTIVITY_ADEPTHOOD_OR_AN_AGENT if grants else ACTIVITY_ADEPTHOOD
    by_stamp.update(grants)
    return _Attribution(by_stamp=by_stamp)


async def _read(client: CreekVaultAgentActivityClient, limit: int) -> VaultAgentActivity | None:
    """The vault's activity, or ``None`` for every way there is none to show.

    Gated as the wheel read is: a handshake first, and a vault that is
    unavailable or does not advertise the read degrades before any call.
    """
    await client.handshake()
    if not (client.is_available() and client.supports(CreekCapability.AGENT_ACTIVITY)):
        return None
    try:
        return await client.agent_activity(limit)
    except CreekVaultError as error:
        log_read_degraded(CreekCapability.AGENT_ACTIVITY, error)
        return None


def _row(row: VaultAgentActivityRow, attribution: _Attribution) -> AgentActivityRowResponse:
    """Re-project one vault row onto the four fields Settings renders."""
    return AgentActivityRowResponse(
        agent=attribution.agent_for(row.consumer),
        tool_label=TOOL_LABELS.get(row.tool, ACTIVITY_OTHER_TOOL),
        at=row.at,
        outcome=row.outcome,
    )


async def read_agent_activity(
    session: AsyncSession,
    user_id: int,
    client: CreekVaultAgentActivityClient,
    *,
    limit: int,
    secret: str,
) -> AgentActivityResponse:
    """The account's recent vault activity, newest first, at most ``limit`` rows.

    ``secret`` is the deployment secret the account's agent subject is derived
    from (:func:`services.oauth_tokens.derived_subject`); it is used to compute
    one stamp and goes nowhere else.
    """
    attribution = await _attribution(session, user_id, secret)
    activity = await _read(client, limit)
    if activity is None:
        return AgentActivityResponse(status=AgentActivityStatus.UNAVAILABLE, rows=[])
    return AgentActivityResponse(
        status=AgentActivityStatus.OK,
        rows=[_row(row, attribution) for row in activity.rows[:limit]],
    )
