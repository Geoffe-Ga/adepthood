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
from datetime import UTC, datetime

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


def compute_next_reset(now: datetime) -> datetime:
    """Return the first moment of the calendar month following ``now`` in UTC.

    Example: ``2026-04-15T12:34:56Z`` → ``2026-05-01T00:00:00Z``.  The result
    is always timezone-aware (UTC) so it can be compared safely against
    ``datetime.now(UTC)`` in SQL WHERE clauses.
    """
    aware = now if now.tzinfo is not None else now.replace(tzinfo=UTC)
    utc = aware.astimezone(UTC)
    year, month = utc.year, utc.month
    if month == 12:  # noqa: PLR2004 - December rolls to January of next year
        return datetime(year + 1, 1, 1, tzinfo=UTC)
    return datetime(year, month + 1, 1, tzinfo=UTC)
