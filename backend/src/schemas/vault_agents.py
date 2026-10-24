"""What a person is told about the agents that may read their vault (#3534).

One row per agent they approved on the consent page (#3532) and have not
stopped: who it says it is, what it may do, when they approved it, when it last
signed in, and the host approval sent them back to. Settings renders these
under "Where your writing lives".

What is deliberately absent is as much the design as what is present. No
account id -- :class:`OwnedResourcePublic` refuses one -- and no client id,
resource URL or redirect list: the id a row carries is the grant's own, which is
all Revoke needs, and the person's own vault address is on
``GET /vault/connection`` already.

``grants`` are scope names (``vault:read``, ``offline_access``, ...) in the
server's order, never prose. The screen maps each to the same plain phrase the
consent page used (``services.oauth_consent_copy.GRANT_DESCRIPTIONS``), so one
mapping speaks for both surfaces; see ``docs/creek-vault-mcp-contract.md``.
"""

from __future__ import annotations

from datetime import datetime

from schemas._base import OwnedResourcePublic


class ConnectedAgentResponse(OwnedResourcePublic):
    """One agent this account has approved and not revoked.

    ``name`` is the agent's own word for itself, unverified, and ``None`` when it
    gave none -- the screen says so in its own words rather than showing a
    blank. ``last_used_at`` is stamped by the token endpoint on every code
    exchange and refresh (#3533), so it moves roughly every ten minutes while an
    agent is working, not on every call it makes to the vault; ``None`` means it
    has not signed in since it was approved. ``redirect_host`` is the host of the
    first redirect the agent registered -- ``127.0.0.1`` for a program on the
    person's own computer, a site's name for a hosted connector -- or ``None`` if
    none can be read.
    """

    id: int
    name: str | None
    grants: list[str]
    created_at: datetime
    last_used_at: datetime | None
    redirect_host: str | None
