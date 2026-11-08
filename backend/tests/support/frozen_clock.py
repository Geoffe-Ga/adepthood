"""One frozen wall clock for date-coupled tests.

``domain.dates.now_in_tz`` is the single wall-clock seam the person's "today"
is read through: ``today_in_tz`` resolves it through the module namespace, so
patching it there freezes every caller at once without touching call sites.
A test that reasons about a particular instant -- a zone boundary, a recency
grace window, a weekly bucket -- pins the clock here instead of reading the
live one, which would make its verdict depend on the hour the suite runs.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pytest

import domain.dates as dates_module

_FALLBACK_ZONE = "UTC"


def zone_for(user_or_tz: object) -> ZoneInfo:
    """Resolve an IANA zone from a tz string or user-like object, UTC on failure.

    A self-contained mirror of ``domain.dates``' private resolver, so the
    stand-in stays faithful without reaching into module internals: an unknown
    or missing zone falls back to UTC just as the real helper does.
    """
    candidate = user_or_tz if isinstance(user_or_tz, str) else getattr(user_or_tz, "timezone", None)
    try:
        return ZoneInfo(candidate) if candidate else ZoneInfo(_FALLBACK_ZONE)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(_FALLBACK_ZONE)


def frozen_now_in_tz(instant: datetime) -> Callable[..., datetime]:
    """A stand-in for ``domain.dates.now_in_tz`` that always answers ``instant``."""

    def now_in_tz(user_or_tz: object = None) -> datetime:
        """``instant`` as the wall clock reads in the zone ``user_or_tz`` names."""
        return instant.astimezone(zone_for(user_or_tz))

    return now_in_tz


def freeze_domain_clock(monkeypatch: pytest.MonkeyPatch, instant: datetime) -> datetime:
    """Pin ``domain.dates``' wall clock to ``instant`` and return it for assertions."""
    monkeypatch.setattr(dates_module, "now_in_tz", frozen_now_in_tz(instant))
    return instant
