"""What ``GET /vault/agents/activity`` answers (#3535): four fields per call, and no more.

Settings renders these under "Agents that may read your vault" as "Recent
activity": who asked the vault for something, in plain words; what for, in
plain words; when; and whether the vault admitted it.

Both models forbid extra fields, so the content-free promise is a property of
the type rather than of a handler remembering to omit something: there is no
field here to put an argument, a fragment id, a path or a line of prose in, and
constructing a row with one is a validation error. ``agent`` and ``tool_label``
are always adepthood's own words (``services.vault_agent_activity_copy``) or
the name an agent gave itself on the consent page -- never a string the vault
chose.

``status`` is ``unavailable`` whenever the vault could not be read -- nothing
connected, a vault that does not offer the read, one that refused or answered
off-schema -- and the screen says so rather than claiming nothing happened.
"""

from __future__ import annotations

import enum
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from domain.creek_vault import VaultAgentActivityOutcome

_CLOSED = ConfigDict(extra="forbid", frozen=True)


class AgentActivityStatus(enum.StrEnum):
    """Whether the vault's activity could be read at all."""

    OK = "ok"
    UNAVAILABLE = "unavailable"


class AgentActivityRowResponse(BaseModel):
    """One call against the vault: who, what, when and whether."""

    model_config = _CLOSED

    agent: str
    tool_label: str
    at: datetime
    outcome: VaultAgentActivityOutcome


class AgentActivityResponse(BaseModel):
    """The most recent calls, newest first, or why there is nothing to show."""

    model_config = _CLOSED

    status: AgentActivityStatus
    rows: list[AgentActivityRowResponse]
