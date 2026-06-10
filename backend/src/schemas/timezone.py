"""Request / response schemas for the user timezone-update endpoint (issue #261)."""

from __future__ import annotations

from pydantic import BaseModel, field_validator

from domain.timezone import normalize_timezone
from models.user import DEFAULT_USER_TIMEZONE


class TimezoneUpdate(BaseModel):
    """Inbound payload for ``PUT /users/me/timezone``.

    The same trust-boundary rules as signup apply (see
    :func:`domain.timezone.normalize_timezone`): blank / whitespace input
    coerces to ``"UTC"``; an unknown or oversized IANA name is rejected
    with 422 before it can reach the database.
    """

    timezone: str = DEFAULT_USER_TIMEZONE

    @field_validator("timezone", mode="before")
    @classmethod
    def _validate_timezone(cls, value: object) -> str:
        """Reject malformed IANA strings before they reach the DB."""
        return normalize_timezone(value, DEFAULT_USER_TIMEZONE)


class TimezoneRead(BaseModel):
    """Response echoing the IANA timezone now stored for the caller."""

    timezone: str
