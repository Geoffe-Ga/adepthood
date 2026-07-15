"""BotMason usage accounting — monthly cap, wallet precedence, reset logic.

Every user gets ``BOTMASON_MONTHLY_CAP`` free BotMason messages each calendar
month.  Once the free allocation is spent, requests fall through to the
``offering_balance`` (purchased / gifted credits, no expiry).  When both
buckets are empty the router returns ``402 insufficient_offerings``.

This module intentionally contains no database access — it is a pure library
of helpers over configuration and datetime arithmetic so the router can wire
atomic SQL statements around them without duplicating policy.
"""

from __future__ import annotations

import os

from domain.dates import compute_next_reset

__all__ = ["DEFAULT_MONTHLY_CAP", "compute_next_reset", "get_monthly_cap"]

# Default monthly cap when ``BOTMASON_MONTHLY_CAP`` is not set.  Chosen as a
# conservative free-tier that covers a handful of reflections per day without
# opening the door to sustained abuse before a purchase is required.
DEFAULT_MONTHLY_CAP = 50

# Minimum allowed configured cap.  A cap of ``0`` is a legitimate
# "pay-as-you-go only" configuration (no free tier, every request draws
# from ``offering_balance``).  Negative values are rejected as clearly
# misconfigured and fall back to the default.
_MIN_CAP = 0


def get_monthly_cap() -> int:
    """Return the configured monthly BotMason message cap.

    Reads ``BOTMASON_MONTHLY_CAP`` from the environment on every call so
    tests can ``monkeypatch.setenv`` without restarting the app.  Falls back
    to :data:`DEFAULT_MONTHLY_CAP` when the variable is unset, empty, or
    malformed.
    """
    raw = os.getenv("BOTMASON_MONTHLY_CAP")
    if raw is None or not raw.strip():
        return DEFAULT_MONTHLY_CAP
    try:
        parsed = int(raw)
    except ValueError:
        return DEFAULT_MONTHLY_CAP
    if parsed < _MIN_CAP:
        return DEFAULT_MONTHLY_CAP
    return parsed
