"""Render the three pages an agent's authorization request can show a person (#3532).

Sign in, decide, or be told the request stopped -- each a server-rendered page,
because the person arrives here from an agent's browser hand-off, not from the
app, and nothing about the decision may depend on a client the agent controls.

**Escaping is the template engine's job, not the caller's.** The agent's name is
whatever the agent registered, and the hidden fields carry its request back
verbatim, so every value on these pages is untrusted text. Jinja2 autoescapes
every ``.html`` template; nothing here marks a value safe. The stylesheet is the
one template rendered unescaped, because CSS is not HTML and its only inputs are
this module's own constants.

**Styling is same-origin.** The API's Content-Security-Policy allows stylesheets
from ``'self'`` only and no inline style, so the page links
:data:`STYLESHEET_PATH`, which the router serves from :func:`render_stylesheet`.
The colours are :data:`services.email_templates.PALETTE`, the backend's one copy
of the Candle & Ink tokens.
"""

from __future__ import annotations

import enum
from collections.abc import Iterable, Mapping
from functools import cache
from pathlib import Path
from typing import Final

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

from services import oauth_consent_copy as copy
from services.email_templates import PALETTE
from services.oauth_consent_selection import (
    DEFAULT_SELECTION,
    GRANT_CHECKED_VALUE,
    GRANT_FIELD_PREFIX,
)

_TEMPLATE_DIR: Final = Path(__file__).resolve().parent.parent / "templates" / "oauth"

#: Where the page's stylesheet is served.
STYLESHEET_PATH: Final = "/oauth/consent.css"
#: Where the sign-in form posts.
SIGN_IN_PATH: Final = "/oauth/authorize/sign-in"
#: Where Approve and Decline post.
DECISION_PATH: Final = "/oauth/authorize/decision"

# The reading-surface serif and the interface sans, as the email templates spell
# them: no web font is loaded, so these are the platform stacks.
_SERIF: Final = "Iowan Old Style, Palatino, 'Palatino Linotype', Georgia, serif"
_SANS: Final = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
# A comfortable reading measure on a laptop that still fits a phone.
_CONTENT_WIDTH_PX: Final = 520

_ENVIRONMENT: Final = Environment(
    loader=FileSystemLoader(_TEMPLATE_DIR),
    autoescape=select_autoescape(enabled_extensions=("html",), default=False),
    undefined=StrictUndefined,
    trim_blocks=True,
)


class RefusalKind(enum.StrEnum):
    """Why a request stopped, keyed to the sentence the person is shown."""

    UNKNOWN_AGENT = "unknown_agent"
    UNREGISTERED_RETURN = "unregistered_return"
    MALFORMED = "malformed"
    OTHER_VAULT = "other_vault"
    NO_VAULT = "no_vault"
    EXPIRED = "expired"
    UNAVAILABLE = "unavailable"


def _render(template: str, **context: object) -> str:
    """Render one page with the copy module and the stylesheet path in scope."""
    return _ENVIRONMENT.get_template(template).render(
        copy=copy, stylesheet_path=STYLESHEET_PATH, **context
    )


@cache
def render_stylesheet() -> str:
    """Return the page's stylesheet. Constant for the life of the process."""
    return _ENVIRONMENT.get_template("consent.css").render(
        palette=PALETTE, serif=_SERIF, sans=_SANS, content_width=_CONTENT_WIDTH_PX
    )


def render_sign_in(carried: Mapping[str, str], *, refused: bool) -> str:
    """Render the sign-in page, carrying the authorization request in hidden fields.

    ``refused`` adds the one generic sentence for a failed attempt -- the same
    whether the address is unknown, the password wrong or the account locked,
    exactly as the app's own login answers.
    """
    return _render(
        "sign_in.html", carried=sorted(carried.items()), refused=refused, action=SIGN_IN_PATH
    )


def render_consent(
    *,
    agent_name: str,
    scopes: Iterable[str],
    return_host: str,
    local_program: bool,
    ticket: str,
) -> str:
    """Render the decision page for one validated, signed-in request."""
    named = bool(agent_name)
    return _render(
        "consent.html",
        agent_name=agent_name if named else copy.CONSENT_UNNAMED_AGENT,
        named=named,
        grants=[
            (
                f"{GRANT_FIELD_PREFIX}{scope}",
                copy.GRANT_DESCRIPTIONS[scope],
                scope in DEFAULT_SELECTION,
            )
            for scope in scopes
        ],
        checked_value=GRANT_CHECKED_VALUE,
        return_host=return_host,
        local_program=local_program,
        ticket=ticket,
        action=DECISION_PATH,
    )


def render_refusal(kind: RefusalKind, code: str) -> str:
    """Render the page for a request that stopped, naming its RFC error code for support."""
    return _render("error.html", body=copy.ERROR_BODIES[kind.value], code=code)
