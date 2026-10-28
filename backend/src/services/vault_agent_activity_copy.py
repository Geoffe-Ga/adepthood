"""Every word ``GET /vault/agents/activity`` puts in front of a person (#3535).

The route turns Creek's audit identifiers -- a consumer stamp and a tool name --
into the two strings Settings renders under "Agents that may read your vault":
who asked, and what for. Neither identifier is ever passed through, so these
are the only words a row can carry beside its time and outcome.

The register is the agents section's own (``frontend/src/features/Settings/
agentsCopy.ts``): plain words, no transport or authorization vocabulary, no
pressure. ``frontend/src/features/Settings/__tests__/agentActivityDrift.test.ts``
reads this module back and holds every string here to that section's bans, so a
label added on this side is swept the day it is added.

**Who asked, honestly.** Creek stamps each call with the bearer's consumer name
or, for an agent, the agent's ``client_id`` (Creek-Vault#1976). Before #1976 an
agent's calls carried the token's ``sub``, which names the *person*, not the
agent. So a row is named after an agent only when its stamp is one of the
account's own grant client ids; a row stamped with the person's own ``sub`` is
said for what it is ("one of your agents"), and on a managed vault, where the
app's own calls carry that same stamp, for what it might be.

**What it asked for.** Each tool name the vault audits gets one past-tense
phrase. A tool with no phrase yet is "Other" rather than its name, so a person
never reads ``creek.compile``.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Final

#: The app's own calls, under the stamp a self-connected vault gives them.
ACTIVITY_ADEPTHOOD: Final = "Adepthood"

#: The person's own agent subject: an agent of theirs, though not which one.
ACTIVITY_ONE_OF_YOUR_AGENTS: Final = "One of your agents"

#: A managed vault's one stamp: the app's, and every agent's before Creek-Vault#1976.
ACTIVITY_ADEPTHOOD_OR_AN_AGENT: Final = "Adepthood or one of your agents"

#: An agent this person approved and later stopped.
ACTIVITY_STOPPED_AGENT: Final = "An agent you stopped"

#: Any stamp this account cannot place: never echoed, only named this way.
ACTIVITY_SOMETHING_ELSE: Final = "Something else with access to your vault"

#: A tool with no plain words yet.
ACTIVITY_OTHER_TOOL: Final = "Other"

#: What each audited tool asked the vault for, keyed by the name Creek audits it under.
TOOL_LABELS: Final = MappingProxyType(
    {
        "creek.draft": "Drafted an essay",
        "creek.author": "Wrote a piece in your voice",
        "creek.reflect": "Asked for a reflection",
        "creek.mine": "Looked for seeds in your writing",
        "creek.link": "Tried to re-sort the vault",
        "creek.classify": "Tried to re-label your writing",
        "creek.ingest": "Tried to bring in new material",
        "creek.compile": "Tried to rebuild the vault's pages",
        "creek.purge.vault": "Tried to delete from the vault",
        "creek.purge.source": "Tried to delete from the vault",
        "creek.purge.fragment": "Tried to delete from the vault",
        "creek.purge.daterange": "Tried to delete from the vault",
        "creek.purge.classifications": "Tried to delete from the vault",
        "creek.jobs.read": "Checked on a draft in progress",
        "creek.wheel": "Looked at the balance of your writing",
        "creek.handshake": "Checked that the vault was there",
        "creek.journal": "Saved a journal entry",
        "creek.journal.withdraw": "Removed a journal entry",
        "creek.upload": "Added a document",
        "creek.voice-draft.upsert": "Saved a draft",
        "creek.voice-draft.delete": "Removed a draft",
        "creek.letter.write": "Wrote a letter for a margin note",
    }
)
