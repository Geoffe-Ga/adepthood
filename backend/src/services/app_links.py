"""Where this deployment's web front end lives, for links the app mails out.

Nothing inside a running server can derive its own public web origin. The one
value that claims to -- the request's ``Host`` header, and the ``X-Forwarded-*``
pair behind a proxy -- is chosen by whoever sent the request, so building a
password-reset link from it hands an attacker the ability to point a victim's
reset mail at a server of their choosing, token included. The origin is
therefore deployment configuration, read from ``APP_BASE_URL`` and never from
anything that arrived on the wire.

Read per call rather than cached at import, matching
``SECURITY_CONTACT_ADDRESS`` in ``routers.auth``: an operator repointing a
staging deploy should not need a code change, and a test should not need a
process restart.

Outside production the value is optional and falls back to the Expo web dev
server, so reading a reset link out of the local log still yields something a
browser can open. Production has no such fallback -- ``main.validate_app_base_url_config``
refuses a boot without it, because a link nobody can follow is delivery that
does not recover the account.
"""

from __future__ import annotations

import os
from typing import Final

# Public because the startup refusal in ``main`` names this variable back to the
# operator, and a refusal that spells it differently from the string this module
# reads sends them to edit a setting nothing consults.
APP_BASE_URL_ENV_VAR: Final = "APP_BASE_URL"

# The only scheme an emailed link may carry. Named here, beside the variable's
# own spelling, so the boot refusal in ``main`` and this module cannot disagree
# about what a usable origin is -- the disagreement would certify a boot whose
# delivered links nobody can open.
REQUIRED_WEB_BASE_URL_SCHEME: Final = "https://"

# Expo serves the web build on 8081 by default, which is where a developer
# following the frontend README lands. Only ever used outside production.
DEV_WEB_BASE_URL: Final = "http://localhost:8081"


def configured_web_base_url() -> str:
    """Return the configured origin with trailing slashes removed, or ``""``.

    Empty and unset are one case on purpose: an ``APP_BASE_URL=`` exported by a
    platform's variable editor is not a configured origin, and treating it as
    one only moves the failure into the delivered email. The trailing slash is
    stripped here rather than trusted to be typed one way -- ``https://host//reset-password``
    is a different path from ``https://host/reset-password``, and the servers
    that redirect between them drop the query string on the way, which lands on
    the user as a dead link and on the operator as nothing at all.
    """
    return os.getenv(APP_BASE_URL_ENV_VAR, "").strip().rstrip("/")


def web_base_url() -> str:
    """Return the origin outbound links point at, falling back to the dev server."""
    return configured_web_base_url() or DEV_WEB_BASE_URL


def is_usable_web_base_url(value: str) -> bool:
    """Return whether ``value`` is an origin a mailed link can actually be followed to.

    Presence is not usability, and the difference is the whole outage. A bare
    hostname is the likeliest wrong value in the building -- ``PROD_DOMAIN``,
    the CORS setting a few rows away in the same platform variable editor, is
    one -- and ``app.aptitude.guru/reset-password?token=...`` is a string no
    mail client linkifies and no browser resolves. Mail delivered, endpoint
    answers 202, user still locked out: byte for byte the failure this variable
    exists to prevent, arriving through the check written to prevent it.

    ``http://`` is refused for a second reason. The link is a bearer credential
    with a thirty-minute life, and plaintext puts it on the wire.
    """
    return value.startswith(REQUIRED_WEB_BASE_URL_SCHEME)
