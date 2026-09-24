"""Blank out the shapes of text that are credentials or identities, whoever typed them.

A beta tester describing a failure will paste what they saw. Sometimes what they
saw was a token in a URL bar, an ``Authorization`` header in a dev console, an
API key in an error toast, or their own address in a form they were filling in.
That text is theirs and stays in their report as written -- it is encrypted at
rest and only an administrator reads it. It must not travel on into a GitHub
issue draft, which is written to be pasted somewhere public.

So the draft renderer runs every piece of prose through :func:`redact_secret_shapes`
first. This is a denylist of *shapes*, and it is the second line: the first is
that the draft is built from an allowlisted :class:`domain.feedback_triage.DraftSource`
that has no field for an account id, an address or a correlation id at all.
What this module catches is those things turning up *inside* the prose.

Each pattern replaces its whole match with a fixed, bracketed marker naming the
kind of thing removed, so a reader of the draft can tell something was taken out
and what sort of thing it was, and so a test can look for the marker by name.
Order matters: a URL can contain an address and a token, so URLs go first and
take everything they contain with them.
"""

from __future__ import annotations

import re
from typing import Final

REDACTED_URL: Final = "[redacted-url]"
REDACTED_JWT: Final = "[redacted-token]"
REDACTED_BEARER: Final = "[redacted-bearer]"
REDACTED_KEY: Final = "[redacted-key]"
REDACTED_EMAIL: Final = "[redacted-email]"

# A URL of ANY scheme carrying a query string. The query is where a session
# token, a reset code or a signed download link lives -- whether the scheme is
# ``https``, the app's own ``adepthood`` deep link, Expo's ``exp`` or an Android
# ``intent``. A bare path is left alone because "it broke on /journal" is
# exactly the kind of thing triage needs to read. The scheme grammar is
# RFC 3986's: a letter, then letters, digits, ``+``, ``-`` or ``.``.
_URL_WITH_QUERY: Final = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s?#]*\?\S*", re.IGNORECASE)

# The app's own deep links, whole, query or not. The practice share link
# carries its capability token in the PATH (``adepthood://practices/share/<t>``),
# so for this scheme a query is not the only place a secret can be.
APP_LINK_SCHEME: Final = "adepthood"
_APP_LINK: Final = re.compile(rf"\b{APP_LINK_SCHEME}://\S*", re.IGNORECASE)

# A JSON Web Token: three base64url segments, the first of which always begins
# ``eyJ`` because it is an encoded ``{"``.
_JWT: Final = re.compile(r"\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")

# ``Bearer <token>`` -- the header value copied out of a console. The token must
# be at least eight characters and carry a digit or a punctuation mark, which
# every real token does and "the bearer of bad news" does not.
_BEARER: Final = re.compile(
    r"\bbearer\s+(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}",
    re.IGNORECASE,
)

# Vendor keys with a recognisable prefix: OpenAI-style ``sk-``, GitHub tokens,
# Slack tokens, and AWS access key ids.
_VENDOR_KEY: Final = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{8,}"
    r"|gh[pousr]_[A-Za-z0-9]{16,}"
    r"|github_pat_[A-Za-z0-9_]{16,}"
    r"|xox[abprs]-[A-Za-z0-9-]{8,}"
    r"|AKIA[0-9A-Z]{16})\b"
)

# An email address. Deliberately loose: a false positive costs one word of a
# draft, a false negative puts somebody's address in a public issue.
_EMAIL: Final = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")

# Applied in this order; see the module docstring for why URLs lead.
_PATTERNS: Final[tuple[tuple[re.Pattern[str], str], ...]] = (
    (_URL_WITH_QUERY, REDACTED_URL),
    (_APP_LINK, REDACTED_URL),
    (_JWT, REDACTED_JWT),
    (_BEARER, REDACTED_BEARER),
    (_VENDOR_KEY, REDACTED_KEY),
    (_EMAIL, REDACTED_EMAIL),
)


def redact_secret_shapes(text: str) -> str:
    """Return ``text`` with every credential- or identity-shaped span replaced."""
    for pattern, marker in _PATTERNS:
        text = pattern.sub(marker, text)
    return text
