"""Date / timezone helpers — single source of truth for user-local day math.

Every router or service that needs to know "what day is it for this user?"
should ask :func:`today_in_tz` rather than re-deriving from
``datetime.now(UTC).date()``.  Mixing the two surfaces the off-by-one
boundary bug (BUG-STREAK-002, BUG-HABIT-006, BUG-GOAL-004): a habit
completed at 11:30 PM Pacific is recorded with a UTC timestamp that the
naive ``.date()`` call labels as the *next* day, so streaks tick over
prematurely on the West Coast and idempotency checks fail near midnight.

This module is intentionally narrow.  It does NOT format dates for
display, parse user input, or convert between zones — those live at the
trust-boundary serializers and on the frontend.  Backend code should
deal in :class:`date` and timezone-aware :class:`datetime` only; we
never produce a naive datetime.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Protocol, runtime_checkable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# IANA fallback when a user row predates the ``User.timezone`` column or
# carries an unknown / corrupt value.  ``"UTC"`` is always present in
# ``zoneinfo`` regardless of whether ``tzdata`` is installed, so this is
# the safest fallback.  Kept in sync with ``User.DEFAULT_USER_TIMEZONE``
# but duplicated here so this module has no import cycle on the User
# model — the DB-aware lookup ``get_user_timezone`` lives in
# :mod:`services.users` precisely so this module stays import-free.
_FALLBACK_TZ = "UTC"


@runtime_checkable
class _HasTimezone(Protocol):
    """Structural type for any object exposing a ``timezone`` attribute.

    Lets the helpers accept both the real :class:`models.user.User` and
    lightweight test stubs without a full ORM instantiation, while still
    type-checking call sites.  ``timezone`` is allowed to be ``None`` so
    legacy ORM rows without the column populated still pass through.
    """

    timezone: str | None


def _extract_tz_string(user_or_tz: _HasTimezone | str | None) -> str:
    """Pull an IANA timezone string out of any of the accepted input shapes.

    Splits the type-discrimination out of :func:`_resolve_zone` so the
    latter stays at xenon rank A.  Returns the fallback string for any
    case where the input cannot supply a usable timezone (``None``, a
    user row missing the column, an empty string).
    """
    if user_or_tz is None:
        return _FALLBACK_TZ
    if isinstance(user_or_tz, str):
        return user_or_tz or _FALLBACK_TZ
    # ``User`` instance — read ``.timezone`` defensively.
    return getattr(user_or_tz, "timezone", None) or _FALLBACK_TZ


def _resolve_zone(user_or_tz: _HasTimezone | str | None) -> ZoneInfo:
    """Coerce a User / IANA string / ``None`` into a :class:`ZoneInfo`.

    Unknown zones (typo, out-of-date ``tzdata``) silently fall back to
    UTC rather than raising; the caller's day math is still correct,
    just less personalized.  The fallback is intentional: a single bad
    zone string should never lock a user out of completing a habit.
    """
    candidate = _extract_tz_string(user_or_tz)
    try:
        return ZoneInfo(candidate)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(_FALLBACK_TZ)


def ensure_aware(value: datetime) -> datetime:
    """Return ``value`` tagged as UTC when naive; pass aware values through.

    SQLite (the test DB) drops ``tzinfo`` when round-tripping a column
    declared timezone-aware, so a value written as ``datetime.now(UTC)``
    reads back naive.  The stored instant is always the UTC one we wrote,
    so re-anchoring UTC is correct rather than a band-aid.  Aware values
    keep their own offset unchanged (identical object returned).
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def compute_next_reset(now: datetime) -> datetime:
    """Return the first moment of the calendar month following ``now`` in UTC.

    Example: ``2026-04-15T12:34:56Z`` → ``2026-05-01T00:00:00Z``.  The result
    is always timezone-aware (UTC) so it can be compared safely against
    ``datetime.now(UTC)`` in SQL WHERE clauses.
    """
    utc = ensure_aware(now).astimezone(UTC)
    year, month = utc.year, utc.month
    if month == 12:  # noqa: PLR2004 - December rolls to January of next year
        return datetime(year + 1, 1, 1, tzinfo=UTC)
    return datetime(year, month + 1, 1, tzinfo=UTC)


def now_in_tz(user_or_tz: _HasTimezone | str | None) -> datetime:
    """Return ``datetime.now`` in the user's IANA timezone.

    Always timezone-aware so callers never accidentally compare against a
    naive UTC value.  Use this when you need the wall-clock time the user
    sees right now (e.g. for ``stage_started_at`` audit fields that are
    user-facing).  Internal-only timestamps (JWT ``iat``/``exp``, audit
    logs read by ops) should keep using ``datetime.now(UTC)`` so they
    correlate across users.
    """
    return datetime.now(_resolve_zone(user_or_tz))


def today_in_tz(user_or_tz: _HasTimezone | str | None) -> date:
    """Return the calendar date the user perceives as "today".

    This is the single source of truth for daily-bucket math.  Streak,
    daily-completion idempotency, and habit-start-date logic all funnel
    through here; calling sites that re-implement
    ``datetime.now(UTC).date()`` are exactly the bug surface the helper
    closes.
    """
    return now_in_tz(user_or_tz).date()


def day_bounds_in_tz(
    user_or_tz: _HasTimezone | str | None,
    day: date,
) -> tuple[datetime, datetime]:
    """Return ``[start, end)`` UTC-normalized bounds for ``day`` in the user's TZ.

    Boundaries are computed at local midnight in the user's zone and then
    converted to UTC (issue #412).  Postgres ``timestamptz`` compares
    instants, so either representation works there — but SQLite stores
    ``DateTime(timezone=True)`` as ISO strings and compares **lexically**,
    ignoring the offset suffix, so bounds pinned to a non-UTC zone
    mis-ordered against the UTC-rendered stored values.  Normalizing both
    bounds to UTC makes every rendered string share the ``+00:00`` offset,
    so the lexical comparison is also the chronological one.  ``end`` is
    the start of the *next* day so range queries stay half-open: ``WHERE
    col >= start AND col < end`` correctly groups all timestamps that
    fall inside the user's local calendar day, including the edge case
    where the local day spans a DST jump (``end - start`` may be 23 or
    25 hours, never 24 in DST-active zones).
    """
    zone = _resolve_zone(user_or_tz)
    start = datetime.combine(day, time.min, tzinfo=zone)
    end = datetime.combine(day + timedelta(days=1), time.min, tzinfo=zone)
    return start.astimezone(UTC), end.astimezone(UTC)


def to_user_date(
    user_or_tz: _HasTimezone | str | None,
    moment: datetime,
) -> date:
    """Convert a stored timestamp to the calendar date the user perceived.

    ``moment`` must be timezone-aware (we never accept naive datetimes;
    callers passing one are bugs we want to surface fast).  Use this to
    turn ``GoalCompletion.timestamp`` (stored as UTC by Postgres
    ``timestamptz``) into the user's local "what day did this happen?"
    label so streaks and history views stay consistent across midnight.
    """
    if moment.tzinfo is None:
        msg = "to_user_date refuses naive datetimes; pass tzinfo-aware values"
        raise ValueError(msg)
    return moment.astimezone(_resolve_zone(user_or_tz)).date()


def to_user_date_bucket(ts: datetime | str, user_or_tz: _HasTimezone | str | None) -> date:
    """Bucket a *stored* timestamp into the user's local calendar day.

    Unlike :func:`to_user_date` (which demands a tz-aware datetime), this is the
    storage-boundary helper: it accepts either a :class:`datetime` (the Postgres
    ``timestamptz`` path) or an ISO-8601 string (SQLite returns these for tz-aware
    columns), and coerces a naive value to UTC — acceptable here because the
    source column is declared timezone-aware and SQLite merely lies about its
    storage. The single canonical owner of this coercion (was duplicated in the
    streak service and the subtractive domain).
    """
    parsed = ts if isinstance(ts, datetime) else datetime.fromisoformat(ts)
    return to_user_date(user_or_tz, ensure_aware(parsed))
