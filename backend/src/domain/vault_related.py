"""Creek contracts 0.35 and 0.36: whose voice wrote a reply, and the threads it touches (#3778).

0.35 (Creek-Vault#2126) writes a reflection or a letter in the owner's own voice
-- grounded in their own writing, never in adepthood's earlier output -- for a
caller declaring 0.35 or later, and reports which voice it used. 0.36
(Creek-Vault#2127) names the narrative threads an entry belongs to, and on a
letter the praxis, eddies and threads its entry touches. Both are read only on
the two keyed generation calls, which declare 0.36 only to a vault listing it
(:func:`services.creek_vault_key_rejected.keyed_generation_minor`); the base
pin does not move.

Kept apart from :mod:`domain.creek_vault` so that module imports these values
rather than growing them, the way :mod:`domain.vault_export` is.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Final

#: The first minor whose reflections and letters carry the 0.36 related fields
#: -- and, since 0.35 is below it, the owner's voice. A literal, compared
#: against the vault's ``supported_contract_minors``.
RELATED_SURFACES_SINCE_MINOR: Final = "0.36"


class VaultReplyVoice(enum.StrEnum):
    """Which voice wrote a reflection or a letter, spelled Creek's way (``ReplyVoice``).

    ``OWNER`` when the owner's own style shaped it, ``HIGHER_SELF`` otherwise.
    A vault that sends neither -- an older one, or a value outside this set --
    is read as no claim at all, so nothing is ever labelled the writer's voice
    on a guess.
    """

    OWNER = "owner"
    HIGHER_SELF = "higher_self"


class VaultThreadStatus(enum.StrEnum):
    """Where a narrative thread sits, spelled Creek's way (``ThreadLifecycle``)."""

    ACTIVE = "active"
    DORMANT = "dormant"
    RESOLVED = "resolved"


@dataclass(frozen=True)
class VaultRelatedThread:
    """One narrative thread -- a current running through the writer's own fragments.

    Only the three labels Creek publishes: the page's own ``id``, its ``title``
    and its lifecycle. Never its body, description or member count, which Creek
    does not send.
    """

    id: str
    title: str
    status: VaultThreadStatus
