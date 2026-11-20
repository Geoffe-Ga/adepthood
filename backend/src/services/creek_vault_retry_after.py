"""Read the wait a vault's ``Retry-After`` names, as a number and nothing else (#3770).

Creek answers a retryable refusal -- ``503 temporarily_unavailable`` while a
classify or link pass holds its content-mutation lock, or a ``429`` -- and from
Creek-Vault#2121 names how long to wait in ``Retry-After``. That wait is the one
thing a caller needs to turn a refusal into a pause instead of a failure.

Only the delta-seconds form is read. The header's other form, an HTTP date, is
deliberately not parsed: it would put two clocks into the answer, and Creek
publishes integers. Anything that is not a short run of digits -- a date, a sign,
an exponent, an absurdly long number -- answers ``None``, "no wait named", which
the caller replaces with its own default. Nothing from the header but that
number ever leaves this function, so a vault cannot choose any text that
reaches an exception, a log, or a response.
"""

from __future__ import annotations

from typing import Final

#: The header a refusal names its wait in.
RETRY_AFTER_HEADER: Final[str] = "Retry-After"

#: The longest digit run read as a wait. Six digits is over eleven days, far past
#: any wait worth honouring, and bounds the int conversion of hostile input.
_MAX_RETRY_AFTER_DIGITS: Final[int] = 6


def read_retry_after_seconds(raw: str | None) -> int | None:
    """Return the whole seconds ``raw`` names, or ``None`` when it names none we read."""
    if raw is None:
        return None
    value = raw.strip()
    if not value or len(value) > _MAX_RETRY_AFTER_DIGITS:
        return None
    if not (value.isascii() and value.isdigit()):
        return None
    return int(value)
