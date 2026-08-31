"""One HTTPS-provider configuration for every test that must look production-ready.

The sibling of :mod:`tests.helpers.smtp_env`, and it exists for the same reason:
two suites need a deployment whose email backend passes the startup check --
the tests of that check itself, and the sender tests that build the adapter from
the environment. Two copies of the same variables drift silently.

The mapping is keyed by environment-variable name so no local identifier in a
test reads as a credential. The key value carries Resend's real ``re_`` prefix
because a placeholder that does not look like the credential it stands in for
cannot catch a validator that only accepts the shape; nothing here authenticates
against anything, and every test using it intercepts httpx below the socket.
"""

from __future__ import annotations

from typing import Final

# The credential entry is keyed, not named, for the reason the SMTP helper gives:
# an identifier spelling API_KEY reads to the secret scanners as a value rather
# than as the name of a variable.
RESEND_ENV_VALUES: Final[dict[str, str]] = {
    "RESEND_API_KEY": "re_sentinel_not_a_real_credential",  # pragma: allowlist secret
    "EMAIL_FROM": "no-reply@adepthood.invalid",
}
