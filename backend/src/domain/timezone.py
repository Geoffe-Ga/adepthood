"""Shared IANA timezone validation for the signup and profile-update boundaries.

Both ``POST /auth/signup`` and ``PUT /users/me/timezone`` accept an inbound
IANA timezone name and must apply identical rules: blank / whitespace input
coerces to the column default, names wider than the ``User.timezone`` column
are rejected, and names that :mod:`zoneinfo` cannot resolve are rejected.
Centralising the logic here keeps the two trust boundaries from drifting apart.
"""

from __future__ import annotations

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Cap matches the ``User.timezone`` column width.  IANA names are at most 33
# chars today (``America/Argentina/ComodRivadavia``); 64 leaves headroom.
MAX_TIMEZONE_LENGTH = 64


def coerce_timezone_input(value: object) -> str | None:
    """Normalise an inbound ``timezone`` value to ``str | None``.

    Returns ``None`` for inputs that should fall back to the column default
    (missing, non-string, empty / whitespace-only); otherwise the trimmed
    string, ready for downstream validation.
    """
    if value is None or not isinstance(value, str):
        return None
    candidate = value.strip()
    return candidate or None


def check_timezone_resolves(candidate: str) -> None:
    """Raise ``ValueError`` if ``candidate`` is too long or unknown to ``zoneinfo``."""
    if len(candidate) > MAX_TIMEZONE_LENGTH:
        msg = f"timezone must be {MAX_TIMEZONE_LENGTH} chars or fewer"
        raise ValueError(msg)
    try:
        ZoneInfo(candidate)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        msg = f"unknown IANA timezone: {candidate!r}"
        raise ValueError(msg) from exc


def normalize_timezone(value: object, default: str) -> str:
    """Coerce, default, and validate an inbound timezone value.

    Blank / missing input returns ``default``; otherwise the trimmed name is
    validated and returned, raising ``ValueError`` on an unknown or oversized
    name so the trust boundary surfaces a 422 instead of storing bad data.
    """
    candidate = coerce_timezone_input(value)
    if candidate is None:
        return default
    check_timezone_resolves(candidate)
    return candidate
