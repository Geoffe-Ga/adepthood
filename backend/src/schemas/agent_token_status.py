"""Wire shapes for the vault's per-call agent-token status lookup (R3-2, #3585).

Creek's control plane asks with the three claims of an access token it has
already verified offline (Creek-Vault#2005) and is answered with one boolean.
The question carries no token: the claims are enough to decide, and a token
that never leaves the vault cannot be replayed from this server's logs or
memory. The answer carries nothing about the person -- not whether the subject
exists, not why the answer is ``false`` -- so both models refuse extra fields.
"""

from __future__ import annotations

from typing import Annotated, Final

from pydantic import BaseModel, ConfigDict, Field

from models.oauth_client import OAUTH_URI_MAX_LENGTH

#: The widest ``sub`` this server signs: a provisioned consumer identity's column.
SUBJECT_MAX_LENGTH: Final = 200
#: 3000-01-01T00:00:00Z. Far past any token this server could have minted, and
#: well inside what :class:`datetime.datetime` can add a lifetime to.
LATEST_ISSUED_AT: Final = 32_503_680_000


class AgentTokenStatusRequest(BaseModel):
    """The claims of one verified access token: whose, which agent's, and when issued."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    sub: Annotated[str, Field(min_length=1, max_length=SUBJECT_MAX_LENGTH)]
    client_id: Annotated[str, Field(min_length=1, max_length=OAUTH_URI_MAX_LENGTH)]
    iat: Annotated[int, Field(strict=True, ge=0, le=LATEST_ISSUED_AT)]


class AgentTokenStatusResponse(BaseModel):
    """Whether the vault may serve the call: RFC 7662's ``active`` and nothing else."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    active: bool
