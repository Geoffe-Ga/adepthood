"""One relay configuration for every test that has to look production-ready.

Two suites need an ``EMAIL_BACKEND=smtp`` deployment that passes the startup
check: the tests of that check itself, and the lifespan tests whose subject is
some *other* production rule and which would otherwise be refused before they
reach it. Two copies of the same five variables drift silently -- the day a
sixth is required, the suite that still lists five fails for a reason that has
nothing to do with what it is testing.

The mapping is keyed by environment-variable name so no local identifier in a
test reads as a credential. Every value is an inert placeholder on an
``.invalid`` domain (RFC 2606 guarantees it never resolves); nothing here
connects to anything.
"""

from __future__ import annotations

from typing import Final

SMTP_ENV_VALUES: Final[dict[str, str]] = {
    "SMTP_HOST": "smtp.relay.invalid",
    "SMTP_PORT": "587",
    "SMTP_USERNAME": "mailer@adepthood.invalid",
    "SMTP_PASSWORD": "sentinel-not-a-real-credential",  # pragma: allowlist secret
    "EMAIL_FROM": "no-reply@adepthood.invalid",
}
