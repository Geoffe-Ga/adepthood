"""Every sentence the agent consent page shows a person (#3532).

The page is where somebody decides whether a program may read their writing, so
its copy is held to the same register as the "Where your writing lives" Settings
surface (``frontend/src/features/Settings/vaultCopy.ts``): plain words, no
transport or protocol vocabulary, no pressure, no loss framing, and the floor
stated every time. The strings live here, in one module, so
``tests/services/test_oauth_consent_copy.py`` can sweep all of them the way the
frontend's ``vaultCopy`` guards sweep that deck.

Two things the page shows are *not* copy and are deliberately absent here: the
agent's name, which is the agent's own words and is labelled as such, and the
host approval sends the person back to, which is a fact about this request.

Grant descriptions are keyed by the scope names in
:data:`services.oauth_authorization.SUPPORTED_SCOPES`; the copy test fails if a
scope is added without a sentence for it.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Final

#: The browser tab and the wordmark above every page.
PAGE_TITLE: Final = "Adepthood"

# --- signing in --------------------------------------------------------------

SIGN_IN_HEADING: Final = "Sign in to continue"
SIGN_IN_INTRO: Final = (
    "An agent would like to work with your writing. Sign in to Adepthood to see what it is "
    "asking for. Nothing is shared until you choose."
)
SIGN_IN_EMAIL_LABEL: Final = "Email"
SIGN_IN_CREDENTIAL_LABEL: Final = "Password"
SIGN_IN_BUTTON: Final = "Continue"
SIGN_IN_REFUSED: Final = "That email and password did not match. Check them and try again."

# --- deciding ---------------------------------------------------------------

#: Follows the agent's name: "Claude Code would like to work with your vault".
CONSENT_HEADING_SUFFIX: Final = "would like to work with your vault"

#: Stands in for the name of an agent that registered without one.
CONSENT_UNNAMED_AGENT: Final = "An agent that did not give its name"

#: Under the name, so nobody mistakes the agent's word for Adepthood's.
CONSENT_NAME_NOTE: Final = "That is the name the agent gave itself."

CONSENT_GRANTS_HEADING: Final = "Choose what this agent may do"
CONSENT_GRANTS_NOTE: Final = "Only the checked choices are shared. You can uncheck any of them."

#: What each grant lets an agent do, in the person's terms.
GRANT_DESCRIPTIONS: Final = MappingProxyType(
    {
        "vault:read": "Read and search your Open and Personal writing",
        "vault:desk": "Draft and reflect from your Open and Personal writing",
        "vault:journal": "Add journal entries",
        "vault:pipeline": "Re-sort your vault",
        "offline_access": "Stay connected without asking you again",
    }
)

#: The floor, on every consent page whatever was asked for.
CONSENT_FLOOR: Final = "Intimate entries are never included."

#: Precedes the host approval sends the person back to.
CONSENT_RETURN_PREFIX: Final = "Choosing either way sends you back to"

#: Shown when that host is this computer, as the authorization spec asks.
CONSENT_LOCAL_PROGRAM_NOTE: Final = (
    "That is a program running on this computer. Approve only if you started this agent "
    "yourself just now."
)

CONSENT_APPROVE: Final = "Approve"
CONSENT_DECLINE: Final = "Decline"

# --- when the request cannot go on -------------------------------------------

ERROR_HEADING: Final = "This request stopped here"

#: The plain reason for each refusal the page can show, keyed by refusal kind.
ERROR_BODIES: Final = MappingProxyType(
    {
        "unknown_agent": (
            "Adepthood could not tell which agent sent you here. Go back to it and try "
            "connecting again. Nothing was shared."
        ),
        "unregistered_return": (
            "The agent asked to send you somewhere it had not said it would, so the request "
            "stopped here. Nothing was shared."
        ),
        "malformed": (
            "The agent's request was missing something Adepthood looks for. Go back to it and "
            "try connecting again. Nothing was shared."
        ),
        "other_vault": (
            "This request named a vault that is not the one connected to your account. "
            "Nothing was shared."
        ),
        "no_vault": (
            "Your account has no vault connected yet, so there is nothing for an agent to work "
            "with. You can add one in Settings, under Where your writing lives."
        ),
        "expired": (
            "This page was open for a while, so it stopped waiting. Go back to the agent and "
            "start again. Nothing was shared."
        ),
        "unavailable": "Connecting agents is not available here yet. Nothing was shared.",
    }
)
