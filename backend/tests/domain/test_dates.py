"""Tests for :mod:`domain.dates` -- user-local day math.

The helpers exist to close the BUG-STREAK-002 / BUG-HABIT-006 /
BUG-GOAL-004 family, all of which boil down to "we said ``now()`` when
we meant ``now in the user's timezone``".  Tests deliberately push on
the boundaries that previously broke: near local midnight (UTC-11 and
UTC+14, the widest real-world spread), spring-forward and fall-back DST
jumps, and timestamps from one calendar day in UTC that map to the
prior or following day in the user's zone.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pytest

from domain.dates import (
    day_bounds_in_tz,
    now_in_tz,
    to_user_date,
    today_in_tz,
)


@dataclass
class _StubUser:
    """Minimal duck-type for ``User`` so tests do not need a DB session."""

    timezone: str | None = "UTC"


@contextmanager
def _freeze_now(frozen_utc: datetime) -> Iterator[None]:
    """Force ``datetime.now(tz)`` inside ``domain.dates`` to ``frozen_utc``.

    Mocking ``datetime`` wholesale would swallow the ``astimezone``
    conversion the helper relies on; this stub overrides only ``now`` and
    preserves the zone argument so the test asserts what production runs.
    """

    class _StubDatetime(datetime):
        @classmethod
        def now(cls, tz: ZoneInfo | None = None) -> datetime:  # type: ignore[override]
            if tz is None:
                return frozen_utc.replace(tzinfo=None)
            return frozen_utc.astimezone(tz)

    with patch("domain.dates.datetime", _StubDatetime):
        yield


# ── _resolve_zone (exercised via the public helpers) ──────────────────────


class TestZoneFallback:
    """Unknown / missing zones silently fall back to UTC."""

    def test_string_form_resolves(self) -> None:
        assert today_in_tz("UTC") == datetime.now(UTC).date()

    def test_none_falls_back_to_utc(self) -> None:
        assert today_in_tz(None) == datetime.now(UTC).date()

    def test_user_with_blank_string_falls_back(self) -> None:
        """Empty timezone (legacy row, schema migration not run yet)."""
        user = _StubUser(timezone="")
        assert today_in_tz(user) == datetime.now(UTC).date()

    def test_user_with_none_falls_back(self) -> None:
        """Some legacy ORM rows materialise as ``timezone=None``."""
        user = _StubUser(timezone=None)
        assert today_in_tz(user) == datetime.now(UTC).date()

    def test_unknown_zone_falls_back_silently(self) -> None:
        """A typo'd zone must not raise and lock a user out of completions."""
        user = _StubUser(timezone="Mars/Olympus_Mons")
        assert today_in_tz(user) == datetime.now(UTC).date()


# ── now_in_tz / today_in_tz ───────────────────────────────────────────────


class TestNowInTz:
    """``now_in_tz`` returns a timezone-aware datetime in the user's zone."""

    def test_returns_timezone_aware(self) -> None:
        moment = now_in_tz("America/Los_Angeles")
        assert moment.tzinfo is not None
        assert str(moment.tzinfo) == "America/Los_Angeles"

    def test_pacific_is_consistent_with_utc_instant(self) -> None:
        """Same instant, different wall-clock representation."""
        utc_now = datetime.now(UTC)
        la_now = now_in_tz("America/Los_Angeles")
        delta = (utc_now - la_now.astimezone(UTC)).total_seconds()
        assert -1 <= delta <= 1
        assert utc_now.hour != la_now.hour or utc_now.day != la_now.day


class TestTodayInTzAcrossUtcMidnight:
    """A timestamp near UTC midnight maps to different days per zone."""

    def test_pago_pago_lags_utc_just_after_utc_midnight(self) -> None:
        """At 2026-06-15 00:30 UTC, Pacific/Pago_Pago is still 2026-06-14."""
        with _freeze_now(datetime(2026, 6, 15, 0, 30, tzinfo=UTC)):
            assert today_in_tz("Pacific/Pago_Pago") == date(2026, 6, 14)
            assert today_in_tz("UTC") == date(2026, 6, 15)

    def test_kiritimati_leads_utc_just_before_utc_midnight(self) -> None:
        """At 2026-06-14 23:30 UTC, Pacific/Kiritimati is already 2026-06-15."""
        with _freeze_now(datetime(2026, 6, 14, 23, 30, tzinfo=UTC)):
            assert today_in_tz("Pacific/Kiritimati") == date(2026, 6, 15)
            assert today_in_tz("UTC") == date(2026, 6, 14)


class TestTodayInTzDst:
    """DST boundaries do not corrupt the user-local "today" answer."""

    def test_spring_forward_morning_is_correct_day(self) -> None:
        """LA spring-forward 2026-03-08 02:00 -> 03:00 stays on 2026-03-08."""
        with _freeze_now(datetime(2026, 3, 8, 10, 0, tzinfo=UTC)):
            assert today_in_tz("America/Los_Angeles") == date(2026, 3, 8)

    def test_fall_back_morning_is_correct_day(self) -> None:
        """LA fall-back 2026-11-01 02:00 -> 01:00 stays on 2026-11-01."""
        with _freeze_now(datetime(2026, 11, 1, 9, 30, tzinfo=UTC)):
            assert today_in_tz("America/Los_Angeles") == date(2026, 11, 1)


# ── day_bounds_in_tz ──────────────────────────────────────────────────────


class TestDayBoundsInTz:
    """``day_bounds_in_tz`` returns half-open ``[start, end)`` instants."""

    def test_utc_day_is_24_hours(self) -> None:
        start, end = day_bounds_in_tz("UTC", date(2026, 6, 15))
        assert (end - start) == timedelta(hours=24)
        assert start == datetime(2026, 6, 15, 0, 0, tzinfo=UTC)
        assert end == datetime(2026, 6, 16, 0, 0, tzinfo=UTC)

    def test_pacific_day_starts_seven_hours_after_utc_in_pdt(self) -> None:
        """A user-local PDT day begins at 07:00 UTC."""
        start, _end = day_bounds_in_tz("America/Los_Angeles", date(2026, 6, 15))
        assert start.astimezone(UTC) == datetime(2026, 6, 15, 7, 0, tzinfo=UTC)

    def test_spring_forward_day_is_23_hours(self) -> None:
        """The spring-forward local day in LA loses an hour."""
        start, end = day_bounds_in_tz("America/Los_Angeles", date(2026, 3, 8))
        assert (end.astimezone(UTC) - start.astimezone(UTC)) == timedelta(hours=23)

    def test_fall_back_day_is_25_hours(self) -> None:
        """The fall-back local day in LA gains an hour."""
        start, end = day_bounds_in_tz("America/Los_Angeles", date(2026, 11, 1))
        assert (end.astimezone(UTC) - start.astimezone(UTC)) == timedelta(hours=25)

    def test_pago_pago_day_starts_eleven_hours_after_utc(self) -> None:
        """Pacific/Pago_Pago is UTC-11 with no DST."""
        start, _end = day_bounds_in_tz("Pacific/Pago_Pago", date(2026, 6, 15))
        assert start.astimezone(UTC) == datetime(2026, 6, 15, 11, 0, tzinfo=UTC)


# ── to_user_date ──────────────────────────────────────────────────────────


class TestToUserDate:
    """Stored timestamps map to the calendar date the user perceived."""

    def test_naive_datetime_raises(self) -> None:
        """Naive datetimes almost always indicate a missing UTC upstream."""
        with pytest.raises(ValueError, match="naive"):
            to_user_date("UTC", datetime(2026, 6, 15, 12, 0))  # noqa: DTZ001

    def test_utc_timestamp_maps_to_local_calendar(self) -> None:
        """06:30 UTC on 2026-06-15 is 19:30 the prior day in Pago_Pago."""
        moment = datetime(2026, 6, 15, 6, 30, tzinfo=UTC)
        assert to_user_date("Pacific/Pago_Pago", moment) == date(2026, 6, 14)
        assert to_user_date("UTC", moment) == date(2026, 6, 15)

    def test_kiritimati_user_sees_the_next_day(self) -> None:
        """23:30 UTC on 2026-06-14 is 13:30 on 2026-06-15 in Kiritimati."""
        moment = datetime(2026, 6, 14, 23, 30, tzinfo=UTC)
        assert to_user_date("Pacific/Kiritimati", moment) == date(2026, 6, 15)

    def test_already_in_user_zone_is_idempotent(self) -> None:
        """Datetime already in the target zone returns the same date."""
        zone = ZoneInfo("America/Los_Angeles")
        moment = datetime(2026, 6, 15, 14, 0, tzinfo=zone)
        assert to_user_date("America/Los_Angeles", moment) == date(2026, 6, 15)

    def test_user_object_is_accepted(self) -> None:
        """A duck-typed user with ``.timezone`` works."""
        user = _StubUser(timezone="America/Los_Angeles")
        moment = datetime(2026, 6, 15, 6, 0, tzinfo=UTC)  # 23:00 prior PDT
        assert to_user_date(user, moment) == date(2026, 6, 14)


# ── Edge cases: year-boundary, leap-day ──────────────────────────────────


class TestYearAndLeapBoundaries:
    """The user-local "today" answer crosses year boundaries cleanly."""

    def test_kiritimati_new_year_lead(self) -> None:
        """Kiritimati greets the new year 14 hours ahead of UTC."""
        with _freeze_now(datetime(2026, 12, 31, 11, 0, tzinfo=UTC)):
            assert today_in_tz("Pacific/Kiritimati") == date(2027, 1, 1)
            assert today_in_tz("UTC") == date(2026, 12, 31)

    def test_pago_pago_new_year_lag(self) -> None:
        """Pago Pago is the last populated zone to roll over."""
        with _freeze_now(datetime(2026, 1, 1, 10, 0, tzinfo=UTC)):
            assert today_in_tz("Pacific/Pago_Pago") == date(2025, 12, 31)
            assert today_in_tz("UTC") == date(2026, 1, 1)

    def test_leap_day_is_addressable(self) -> None:
        """2024-02-29 round-trips through the bounds helper."""
        start, end = day_bounds_in_tz("UTC", date(2024, 2, 29))
        assert start.day == 29
        assert end.day == 1
