"""Calendar-window contract for ``GET /reflections/sources`` (issue #2886).

The sources feed used to decide membership twice, with two clocks that
disagree: the SQL bounds were ``anchor + timedelta(days=N*7)`` — an instant
offset carrying the program anchor's wall-clock time of day — while every
fetched row was filed under ``elapsed_days(anchor, ts) // 7 + 1``, which
subtracts local calendar dates.  Entries fell between the two and vanished
from every review.  These tests pin the single calendar the endpoint must
now use: seven LOCAL midnights per program week, in the caller's own IANA
timezone, declared back to the client on the response.

Every assertion here names the bodies it expects.  None asserts an empty
list alone — that shape is exactly what let the previous suite stay green
with both window predicates deleted.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, time, timedelta
from http import HTTPStatus
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.dates import to_user_date
from domain.reflection_hierarchy import ReflectionLevel, scope_weeks
from models.journal_entry import EntryStatus, JournalTag
from models.user import User
from tests.test_reflections_api import (
    _seed_entry,
    _seed_looped_progress,
    _seed_progress,
    _signup,
)

_PACIFIC = "America/Los_Angeles"
_EASTERN = "America/New_York"

# Every token the current key grammar admits, narrowest first.  The tests
# discover which token belongs to which level by asking ``scope_weeks``
# rather than hard-coding level names, so a later vocabulary change (#2866)
# only has to extend this tuple.
_SCOPE_TOKENS = ("w", "s", "p", "t", "prog")


def _scope_key(level: ReflectionLevel, index: int) -> str | None:
    """Return the cycle-1 key naming scope ``index`` at ``level``, or None.

    Discovered from the key grammar itself: the token that ``scope_weeks``
    accepts for this level is the right one.  ``None`` means the level has
    no such scope (the program carries no index, so only index 1 exists).
    """
    for token in _SCOPE_TOKENS:
        if token == "prog" and index != 1:
            continue  # The program carries no index, so it has no second scope.
        key = f"c1:{token}" if token == "prog" else f"c1:{token}{index}"
        try:
            scope_weeks(level, key)
        except ValueError:
            continue
        return key
    return None


def _require_scope_key(level: ReflectionLevel, index: int) -> str:
    """Like :func:`_scope_key` but assert the scope exists."""
    key = _scope_key(level, index)
    assert key is not None, f"no scope {index} for {level}"
    return key


async def _set_timezone(db_session: AsyncSession, user_id: int, tz: str) -> None:
    """Give the user an IANA timezone; there is no fixture for this."""
    user = (await db_session.execute(select(User).where(col(User.id) == user_id))).scalar_one()
    user.timezone = tz
    db_session.add(user)
    await db_session.commit()


async def _sources(
    client: AsyncClient, headers: dict[str, str], level: ReflectionLevel, scope_key: str
) -> dict[str, object]:
    """GET the sources feed for one scope, asserting a 200."""
    resp = await client.get(
        "/reflections/sources",
        params={"level": level.value, "scope_key": scope_key},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert isinstance(body, dict)
    return body


async def _bodies(
    client: AsyncClient, headers: dict[str, str], level: ReflectionLevel, scope_key: str
) -> list[str]:
    """The message bodies the feed serves for one scope, in feed order."""
    payload = await _sources(client, headers, level, scope_key)
    items = payload["items"]
    assert isinstance(items, list)
    return [item["body"] for item in items]


def _parse(moment: str) -> datetime:
    """Parse a tz-aware ISO-8601 instant from the wire."""
    parsed = datetime.fromisoformat(moment)
    assert parsed.tzinfo is not None, f"{moment!r} is not timezone-aware"
    return parsed


def _instant(moment: str) -> datetime:
    """Parse a stored entry timestamp, re-tagging UTC when SQLite dropped the offset.

    The test DB is SQLite, which reads a ``DateTime(timezone=True)`` column back
    naive; the stored instant is still the UTC one that was written. Only the
    window bounds, which the router computes rather than reads, are required to
    arrive already tz-aware.
    """
    parsed = datetime.fromisoformat(moment)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


# ── the window the server declares ───────────────────────────────────────


@pytest.mark.asyncio
async def test_sources_declares_the_window_it_filtered_on(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The response names the scope and the half-open window it queried.

    Without this the client has nothing to trust: ``/reflections/due`` only
    answers on a week-closing day, so a reopened review has no server window
    at all and any period shown would be a client re-derivation.
    """
    anchor = datetime.now(UTC) - timedelta(days=8)
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    await _seed_entry(db_session, user_id, "mid week one", timestamp=anchor + timedelta(days=2))

    payload = await _sources(async_client, headers, ReflectionLevel.WEEK, "c1:w1")

    assert payload["level"] == ReflectionLevel.WEEK.value
    assert payload["scope_key"] == "c1:w1"
    window_start = _parse(str(payload["window_start"]))
    window_end = _parse(str(payload["window_end"]))
    assert window_start < window_end
    items = payload["items"]
    assert isinstance(items, list)
    assert [item["body"] for item in items] == ["mid week one"]
    for item in items:
        assert window_start <= _instant(item["timestamp"]) < window_end


# ── the anchor's time of day must not move any boundary ──────────────────


@pytest.mark.asyncio
async def test_an_entry_earlier_in_the_day_than_the_anchor_is_in_week_one(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A program day is a calendar day, not an offset from the signup clock.

    ``program_started_at`` is the instant the user signed up.  An entry made
    earlier that same morning is still day one of the program, and used to be
    excluded by ``timestamp >= anchor`` while being bucketed into week one —
    so it appeared in no feed whatsoever.
    """
    anchor = (datetime.now(UTC) - timedelta(days=8)).replace(
        hour=14, minute=30, second=0, microsecond=0
    )
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    await _seed_entry(db_session, user_id, "D0-0900", timestamp=anchor.replace(hour=9))
    await _seed_entry(db_session, user_id, "D3-1200", timestamp=anchor + timedelta(days=3))

    assert await _bodies(async_client, headers, ReflectionLevel.WEEK, "c1:w1") == [
        "D0-0900",
        "D3-1200",
    ]


@pytest.mark.asyncio
async def test_no_entry_falls_between_two_weekly_feeds(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A stage feed can never hold material no weekly feed holds.

    The union invariant names no window, no timezone and no boundary instant,
    so no implementation detail can be mirrored into it: whatever calendar the
    feed uses, week one, two and three together must be exactly stage one.
    """
    anchor = (datetime.now(UTC) - timedelta(days=30)).replace(
        hour=14, minute=30, second=0, microsecond=0
    )
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    await _seed_entry(db_session, user_id, "D3-1200", timestamp=anchor + timedelta(days=3))
    await _seed_entry(
        db_session, user_id, "D7-0900", timestamp=(anchor + timedelta(days=7)).replace(hour=9)
    )

    weekly = [
        set(
            await _bodies(
                async_client,
                headers,
                ReflectionLevel.WEEK,
                _require_scope_key(ReflectionLevel.WEEK, week),
            )
        )
        for week in (1, 2, 3)
    ]
    stage = set(
        await _bodies(
            async_client,
            headers,
            ReflectionLevel.STAGE,
            _require_scope_key(ReflectionLevel.STAGE, 1),
        )
    )

    assert sum("D7-0900" in feed for feed in weekly) == 1
    assert weekly[0] | weekly[1] | weekly[2] == stage
    assert stage == {"D3-1200", "D7-0900"}


# ── the caller's own midnight ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_local_late_night_entry_belongs_to_that_local_week(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """11:30pm on the writer's Sunday is still their week one, not week two."""
    anchor = datetime(2026, 1, 5, 8, 0, tzinfo=UTC)  # Jan 5 00:00 PST
    headers, user_id = await _signup(async_client, db_session)
    await _set_timezone(db_session, user_id, _PACIFIC)
    await _seed_progress(db_session, user_id, anchor=anchor)
    await _seed_entry(
        db_session,
        user_id,
        "sun-2330-local-day7",
        timestamp=datetime(2026, 1, 12, 7, 30, tzinfo=UTC),
    )
    await _seed_entry(
        db_session,
        user_id,
        "mon-0030-local-day8",
        timestamp=datetime(2026, 1, 12, 8, 30, tzinfo=UTC),
    )

    assert await _bodies(async_client, headers, ReflectionLevel.WEEK, "c1:w1") == [
        "sun-2330-local-day7"
    ]
    assert await _bodies(async_client, headers, ReflectionLevel.WEEK, "c1:w2") == [
        "mon-0030-local-day8"
    ]


@pytest.mark.asyncio
async def test_dst_spring_forward_does_not_open_a_dead_hour(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A program week is seven local midnights, not one hundred sixty-eight hours.

    US spring-forward is 2026-03-08, so from week two on local midnight is
    07:00Z while a fixed ``timedelta(days=7)`` step keeps the edges at 08:00Z.
    Both entries below used to fall into that one-hour hole.
    """
    anchor = datetime(2026, 3, 1, 8, 0, tzinfo=UTC)  # Mar 1 00:00 PST
    headers, user_id = await _signup(async_client, db_session)
    await _set_timezone(db_session, user_id, _PACIFIC)
    await _seed_progress(db_session, user_id, anchor=anchor)
    await _seed_entry(
        db_session, user_id, "mar14-2330-pdt", timestamp=datetime(2026, 3, 15, 6, 30, tzinfo=UTC)
    )
    await _seed_entry(
        db_session, user_id, "mar15-0030-pdt", timestamp=datetime(2026, 3, 15, 7, 30, tzinfo=UTC)
    )

    assert await _bodies(async_client, headers, ReflectionLevel.WEEK, "c1:w2") == ["mar14-2330-pdt"]
    assert await _bodies(async_client, headers, ReflectionLevel.WEEK, "c1:w3") == ["mar15-0030-pdt"]


@pytest.mark.asyncio
async def test_dst_fall_back_keeps_each_local_day_in_its_own_week(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The twin of spring-forward: a 25-hour local day moves no boundary either.

    US fall-back is 2025-11-02, so from week two on local midnight is 08:00Z
    rather than 07:00Z and the fixed-offset edges drift the other way.
    """
    anchor = datetime(2025, 10, 26, 7, 0, tzinfo=UTC)  # Oct 26 00:00 PDT
    headers, user_id = await _signup(async_client, db_session)
    await _set_timezone(db_session, user_id, _PACIFIC)
    await _seed_progress(db_session, user_id, anchor=anchor)
    await _seed_entry(
        db_session, user_id, "nov8-2330-pst", timestamp=datetime(2025, 11, 9, 7, 30, tzinfo=UTC)
    )
    await _seed_entry(
        db_session, user_id, "nov9-0030-pst", timestamp=datetime(2025, 11, 9, 8, 30, tzinfo=UTC)
    )

    assert await _bodies(async_client, headers, ReflectionLevel.WEEK, "c1:w2") == ["nov8-2330-pst"]
    assert await _bodies(async_client, headers, ReflectionLevel.WEEK, "c1:w3") == ["nov9-0030-pst"]


# ── half-open at both ends, for every level that exists ──────────────────


async def _seed_boundary_distractors(
    db_session: AsyncSession, owner_id: int, other_id: int, moment: datetime, label: str
) -> None:
    """Seed the four never-a-source rows at ``moment`` so a boundary cannot pass vacuously."""
    await _seed_entry(db_session, owner_id, f"{label}-bot", sender="bot", timestamp=moment)
    deleted = await _seed_entry(db_session, owner_id, f"{label}-deleted", timestamp=moment)
    deleted.deleted_at = datetime.now(UTC)
    db_session.add(deleted)
    await db_session.commit()
    await _seed_entry(db_session, other_id, f"{label}-foreign", timestamp=moment)
    await _seed_entry(
        db_session, owner_id, f"{label}-draft", status=EntryStatus.DRAFT, timestamp=moment
    )


@pytest.mark.parametrize("level", list(ReflectionLevel))
@pytest.mark.asyncio
async def test_window_boundaries_are_half_open(
    async_client: AsyncClient, db_session: AsyncSession, level: ReflectionLevel
) -> None:
    """Every level's window is ``[start, end)`` at local midnight in the caller's zone.

    The two semantic assertions — the start IS a local midnight, and the span
    is exactly seven local days per program week — cannot be satisfied by a
    test that mirrors the router's arithmetic, which is what made the previous
    boundary coverage worthless.
    """
    zone = ZoneInfo(_EASTERN)
    anchor = (datetime.now(UTC) - timedelta(days=250)).replace(
        hour=14, minute=30, second=0, microsecond=0
    )
    headers, user_id = await _signup(async_client, db_session)
    _other, other_id = await _signup(async_client, db_session, username="bob")
    await _set_timezone(db_session, user_id, _EASTERN)
    await _seed_progress(db_session, user_id, anchor=anchor, current_stage=10)
    scope_key = _require_scope_key(level, 1)

    declared = await _sources(async_client, headers, level, scope_key)
    start = _parse(str(declared["window_start"]))
    end = _parse(str(declared["window_end"]))
    assert start.astimezone(zone).time() == time.min
    assert end.astimezone(zone).time() == time.min
    weeks = scope_weeks(level, scope_key)
    assert to_user_date(_EASTERN, end) - to_user_date(_EASTERN, start) == timedelta(
        days=7 * len(weeks)
    )

    for moment, label in (
        (start - timedelta(microseconds=1), "before"),
        (start, "at-start"),
        (end - timedelta(microseconds=1), "last-instant"),
        (end, "at-end"),
    ):
        await _seed_entry(db_session, user_id, label, timestamp=moment)
        await _seed_boundary_distractors(db_session, user_id, other_id, moment, label)

    assert await _bodies(async_client, headers, level, scope_key) == ["at-start", "last-instant"]

    adjacent = _scope_key(level, 2)
    if adjacent is not None:
        assert "at-end" in await _bodies(async_client, headers, level, adjacent)


# ── cycles ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_past_cycle_scope_never_serves_the_current_cycles_entries(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Beginning again does not re-label this cycle's entries as the last one's.

    ``begin-again`` re-stamps ``program_started_at``, so windowing a ``c1:``
    key against the current anchor served cycle two's dailies under cycle
    one's heading — the most literal form of "the wrong time period".  A
    past-cycle scope is now windowed on THAT cycle's own retained anchor
    (issue #2894) and so serves that cycle's dailies and never this one's;
    the row seeded here retained none, so its cycle-1 feed is empty.  A
    surviving child review from that cycle still stands in either way,
    because reflections match by exact key rather than by window.
    """
    anchor = (datetime.now(UTC) - timedelta(days=30)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor, cycle_number=2)
    await _seed_entry(
        db_session, user_id, "cycle2-week1", timestamp=anchor + timedelta(days=1, hours=9)
    )
    await _seed_entry(
        db_session,
        user_id,
        "cycle one, week one, in review",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level=ReflectionLevel.WEEK.value,
        reflection_scope_key="c1:w1",
        timestamp=anchor - timedelta(days=100),
    )

    assert "cycle2-week1" not in await _bodies(async_client, headers, ReflectionLevel.WEEK, "c1:w1")
    assert "cycle2-week1" not in await _bodies(async_client, headers, ReflectionLevel.WEEK, "c9:w1")
    assert await _bodies(async_client, headers, ReflectionLevel.WEEK, "c2:w1") == ["cycle2-week1"]
    assert await _bodies(async_client, headers, ReflectionLevel.STAGE, "c1:s1") == [
        "cycle one, week one, in review"
    ]


@pytest.mark.asyncio
async def test_a_past_cycle_scope_serves_that_cycles_own_dailies(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A retained cycle-1 anchor re-opens cycle 1's own week, with its own entries.

    This is the whole point of #2894: the corpus was never lost, only the map
    from a past review to the days it was written about.  With that map back,
    reopening ``c1:w1`` shows cycle one's dailies — and the unlock guard stops
    403-ing a week the user demonstrably already lived through.
    """
    cycle_two_anchor = (datetime.now(UTC) - timedelta(days=30)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    cycle_one_anchor = cycle_two_anchor - timedelta(days=370)
    headers, user_id = await _signup(async_client, db_session)
    await _seed_looped_progress(
        db_session,
        user_id,
        anchor=cycle_two_anchor,
        cycle_number=2,
        past_cycle_anchors=[cycle_one_anchor.isoformat()],
    )
    await _seed_entry(
        db_session, user_id, "cycle1-week1", timestamp=cycle_one_anchor + timedelta(days=2, hours=9)
    )
    await _seed_entry(
        db_session, user_id, "cycle2-week1", timestamp=cycle_two_anchor + timedelta(days=1, hours=9)
    )
    # Deep into cycle one: week 30 is reachable ONLY if the row is labelled off
    # cycle one's anchor.  Labelled off the live anchor it would floor to week 1
    # (``elapsed_days`` clamps at zero) and vanish from this feed entirely.
    await _seed_entry(
        db_session,
        user_id,
        "cycle1-week30",
        timestamp=cycle_one_anchor + timedelta(days=29 * 7 + 2, hours=9),
    )

    assert await _bodies(async_client, headers, ReflectionLevel.WEEK, "c1:w1") == ["cycle1-week1"]
    assert "cycle2-week1" not in await _bodies(async_client, headers, ReflectionLevel.WEEK, "c1:w1")
    assert await _bodies(async_client, headers, ReflectionLevel.WEEK, "c1:w30") == ["cycle1-week30"]
    # Stage 10 spans weeks 31-36, which the cycle-1 calendar reached long ago:
    # the guard must read the SCOPE's cycle, not the caller's current week.
    payload = await _sources(async_client, headers, ReflectionLevel.STAGE, "c1:s10")
    assert payload["anchor_status"] == "recorded"


@pytest.mark.asyncio
async def test_a_past_cycle_window_stops_at_the_loop_point(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A cycle abandoned early ends at the loop DAY's local midnight, not weeks later.

    ``begin-again`` unlocks the moment the final stage is reached, which can be
    long before week 36 arrives.  Two things follow, and both are asserted here.
    The week the loop fell in ends at that day's LOCAL MIDNIGHT — the same
    instant the next cycle's week 1 opens — so the entry written at 08:00 that
    morning belongs to ``c2:w1`` and to nothing in cycle one.  Clamping at the
    raw loop instant instead would put it in both.  And a week cycle one never
    reached windows to nothing rather than reaching forward into cycle two.
    """
    tz = _PACIFIC
    cycle_two_anchor = (datetime.now(UTC) - timedelta(days=20)).replace(
        hour=16, minute=0, second=0, microsecond=0
    )
    # Cycle one ran 80 days — into week 12, mid-week — and then the user looped.
    cycle_one_anchor = cycle_two_anchor - timedelta(days=80)
    headers, user_id = await _signup(async_client, db_session)
    await _set_timezone(db_session, user_id, tz)
    await _seed_looped_progress(
        db_session,
        user_id,
        anchor=cycle_two_anchor,
        cycle_number=2,
        past_cycle_anchors=[cycle_one_anchor.isoformat()],
    )
    # 08:00 Pacific on the loop day — after local midnight, before the loop instant.
    loop_local_date = to_user_date(tz, cycle_two_anchor)
    morning = datetime.combine(loop_local_date, time(8, 0), tzinfo=ZoneInfo(tz)).astimezone(UTC)
    await _seed_entry(db_session, user_id, "cycle2-morning", timestamp=morning)

    loop_week = await _sources(async_client, headers, ReflectionLevel.WEEK, "c1:w12")
    current = await _sources(async_client, headers, ReflectionLevel.WEEK, "c2:w1")

    loop_week_end = _parse(str(loop_week["window_end"]))
    local_midnight = datetime.combine(loop_local_date, time.min, tzinfo=ZoneInfo(tz)).astimezone(
        UTC
    )
    assert loop_week_end == local_midnight, "the clamp must land on a LOCAL MIDNIGHT"
    assert loop_week_end == _parse(str(current["window_start"])), (
        "the cycles must abut at one shared instant, never overlap"
    )
    assert _parse(str(loop_week["window_start"])) < loop_week_end
    loop_week_items = loop_week["items"]
    assert isinstance(loop_week_items, list)
    assert [item["body"] for item in loop_week_items] == [], (
        "the loop morning belongs to the NEW cycle only"
    )
    assert "cycle2-morning" in await _bodies(async_client, headers, ReflectionLevel.WEEK, "c2:w1")

    # A week cycle one never reached windows to nothing, rather than reaching
    # forward past the loop into cycle two.
    unreached = await _sources(async_client, headers, ReflectionLevel.WEEK, "c1:w36")
    assert _parse(str(unreached["window_start"])) == _parse(str(unreached["window_end"]))
    assert unreached["items"] == []


@pytest.mark.asyncio
async def test_an_unrecorded_past_cycle_is_declared_unreconstructable(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An anchor destroyed before #2894 is reported as unknown, never guessed.

    The row looped once already, so cycle 1 happened — but its anchor is gone
    and nothing can restore it.  The response says which of the four causes
    applies so the client can tell "nothing was written then" apart from "we
    cannot rebuild that period".
    """
    cycle_two_anchor = (datetime.now(UTC) - timedelta(days=30)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    headers, user_id = await _signup(async_client, db_session)
    await _seed_looped_progress(
        db_session,
        user_id,
        anchor=cycle_two_anchor,
        cycle_number=2,
        past_cycle_anchors=[None],
    )
    await _seed_entry(
        db_session, user_id, "cycle2-week1", timestamp=cycle_two_anchor + timedelta(days=1, hours=9)
    )

    payload = await _sources(async_client, headers, ReflectionLevel.WEEK, "c1:w1")

    assert payload["items"] == []
    assert payload["window_start"] is None
    assert payload["window_end"] is None
    assert payload["anchor_status"] == "unrecorded"
    # The live cycle is unaffected and still names a real window.
    live = await _sources(async_client, headers, ReflectionLevel.WEEK, "c2:w1")
    assert live["anchor_status"] == "recorded"
    assert live["window_start"] is not None


@pytest.mark.asyncio
async def test_a_stored_scope_key_the_grammar_cannot_parse_does_not_break_the_feed(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One unparseable stored key must not 500 the whole feed.

    ``_reflection_ref_from`` runs ``scope_weeks`` over every scoped row the
    caller owns, so a single key the current grammar rejects took the entire
    endpoint down.  That surface is exactly the one a future key migration
    rewrites, so it has to degrade before the migration runs.
    """
    anchor = (datetime.now(UTC) - timedelta(days=8)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    await _seed_entry(db_session, user_id, "plain", timestamp=anchor + timedelta(days=1))
    await _seed_entry(
        db_session,
        user_id,
        "a key from another grammar",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level=ReflectionLevel.WEEK.value,
        reflection_scope_key="c1:x2",
        timestamp=anchor + timedelta(days=2),
    )

    assert await _bodies(async_client, headers, ReflectionLevel.WEEK, "c1:w1") == ["plain"]


# ── diagnostics, without journal content ─────────────────────────────────


@pytest.mark.asyncio
async def test_sources_logs_scope_and_window_without_journal_content(
    async_client: AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """One structured record per call — scope, cycle, window, timezone, counts.

    Never the writer's words: the endpoint returns raw journal bodies, so the
    diagnostics that make a wrong window debuggable must not themselves leak
    the material.
    """
    anchor = (datetime.now(UTC) - timedelta(days=8)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    await _seed_entry(
        db_session,
        user_id,
        "the-quiet-lamp-sentinel",
        title="sentinel-title",
        timestamp=anchor + timedelta(days=1),
    )

    with caplog.at_level(logging.INFO):
        assert await _bodies(async_client, headers, ReflectionLevel.WEEK, "c1:w1") == [
            "the-quiet-lamp-sentinel"
        ]

    resolved = [record for record in caplog.records if record.getMessage() == "sources_resolved"]
    assert len(resolved) == 1
    fields = resolved[0].__dict__
    for field in ("level", "scope_key", "cycle", "window_start", "window_end", "timezone"):
        assert field in fields, f"missing {field}"
    assert fields["level"] == ReflectionLevel.WEEK.value
    assert fields["scope_key"] == "c1:w1"
    assert fields["cycle"] == 1
    assert fields["timezone"] == "UTC"
    assert fields["entry_count"] == 1
    assert fields["reflection_count"] == 0

    haystack = "\n".join(f"{item.getMessage()} {item.__dict__}" for item in caplog.records)
    assert "the-quiet-lamp-sentinel" not in haystack
    assert "sentinel-title" not in haystack


@pytest.mark.asyncio
async def test_due_and_sources_agree_on_the_window(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The period the invitation promises is the period the feed delivers.

    Asserted byte-for-byte rather than within a tolerance: the two surfaces
    must read one helper, not two derivations that happen to agree.
    """
    anchor = (datetime.now(UTC) - timedelta(days=6)).replace(
        hour=14, minute=30, second=0, microsecond=0
    )
    headers, user_id = await _signup(async_client, db_session)
    await _set_timezone(db_session, user_id, _EASTERN)
    await _seed_progress(db_session, user_id, anchor=anchor)

    due_resp = await async_client.get("/reflections/due", headers=headers)
    assert due_resp.status_code == HTTPStatus.OK
    due = due_resp.json()["due"]
    assert due is not None

    payload = await _sources(
        async_client, headers, ReflectionLevel(due["level"]), str(due["scope_key"])
    )
    assert _parse(str(payload["window_start"])) == _parse(due["window_start"])
    assert _parse(str(payload["window_end"])) == _parse(due["window_end"])


# ── a child review covers exactly its own span ───────────────────────────


@pytest.mark.asyncio
async def test_a_child_review_substitutes_only_for_its_own_span_at_the_boundary(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A weekly review swallows its own week's dailies and nothing either side.

    The substitution boundary is where the old mis-bucketing showed: the last
    instant of the covered week must be swallowed, and the first instant of
    the next week must survive as a raw daily, exactly once.
    """
    anchor = (datetime.now(UTC) - timedelta(days=30)).replace(
        hour=14, minute=30, second=0, microsecond=0
    )
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    payload = await _sources(async_client, headers, ReflectionLevel.WEEK, "c1:w2")
    week_two_start = _parse(str(payload["window_start"]))
    week_two_end = _parse(str(payload["window_end"]))

    await _seed_entry(db_session, user_id, "week-one daily", timestamp=anchor + timedelta(hours=20))
    await _seed_entry(
        db_session, user_id, "week-two last instant", timestamp=week_two_end - timedelta(seconds=1)
    )
    await _seed_entry(db_session, user_id, "week-three first instant", timestamp=week_two_end)
    await _seed_entry(
        db_session,
        user_id,
        "week two, in review",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level=ReflectionLevel.WEEK.value,
        reflection_scope_key="c1:w2",
        timestamp=week_two_start + timedelta(days=6),
    )

    feed = await _bodies(async_client, headers, ReflectionLevel.STAGE, "c1:s1")
    assert feed == ["week-one daily", "week two, in review", "week-three first instant"]


@pytest.mark.asyncio
async def test_a_soft_deleted_child_review_does_not_swallow_its_span(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Deleting a weekly review hands its week back to its raw dailies.

    Asked at the STAGE layer, where the weekly review is a CHILD candidate: at
    its own layer the composing-reflection exclusion would hide it anyway, so
    the question of whether soft-deletion alone keeps it out would not be put.
    """
    anchor = (datetime.now(UTC) - timedelta(days=30)).replace(
        hour=14, minute=30, second=0, microsecond=0
    )
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    await _seed_entry(
        db_session, user_id, "week-two daily", timestamp=anchor + timedelta(days=8, hours=9)
    )
    deleted = await _seed_entry(
        db_session,
        user_id,
        "week two, in review",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level=ReflectionLevel.WEEK.value,
        reflection_scope_key="c1:w2",
        timestamp=anchor + timedelta(days=13),
    )
    deleted.deleted_at = datetime.now(UTC)
    db_session.add(deleted)
    await db_session.commit()

    assert await _bodies(async_client, headers, ReflectionLevel.STAGE, "c1:s1") == [
        "week-two daily"
    ]


@pytest.mark.asyncio
async def test_a_draft_child_review_does_not_swallow_its_span(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A review still being drafted is not yet a summary of its week.

    Its span therefore decomposes to that week's raw dailies, the same as a
    week with no review at all — a half-written page must not hide the
    material it was going to be written from. Asked at the STAGE layer, where
    the weekly review is a CHILD candidate rather than the composing one.
    """
    anchor = (datetime.now(UTC) - timedelta(days=30)).replace(
        hour=14, minute=30, second=0, microsecond=0
    )
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    await _seed_entry(
        db_session, user_id, "week-two daily", timestamp=anchor + timedelta(days=8, hours=9)
    )
    await _seed_entry(
        db_session,
        user_id,
        "week two, still drafting",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level=ReflectionLevel.WEEK.value,
        reflection_scope_key="c1:w2",
        status=EntryStatus.DRAFT,
        timestamp=anchor + timedelta(days=13),
    )

    assert await _bodies(async_client, headers, ReflectionLevel.STAGE, "c1:s1") == [
        "week-two daily"
    ]


@pytest.mark.asyncio
async def test_a_wide_feed_mixes_reviews_and_dailies_without_repeating_either(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Nested layers decompose to reviews where they exist and dailies where they do not.

    A tier scope walks components, stages and weeks in turn. Wherever a review
    already stands for a span it stands alone; every gap falls through to its
    raw dailies. No entry may appear twice, and none inside a covered span may
    appear at all.
    """
    anchor = (datetime.now(UTC) - timedelta(days=200)).replace(
        hour=14, minute=30, second=0, microsecond=0
    )
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor, current_stage=10)
    stage_one = scope_weeks(ReflectionLevel.STAGE, _require_scope_key(ReflectionLevel.STAGE, 1))
    swallowed_week = stage_one.start
    open_week = stage_one.stop

    await _seed_entry(
        db_session,
        user_id,
        "daily inside the reviewed stage",
        timestamp=anchor + timedelta(days=(swallowed_week - 1) * 7 + 1, hours=9),
    )
    await _seed_entry(
        db_session,
        user_id,
        "daily in an unreviewed week",
        timestamp=anchor + timedelta(days=(open_week - 1) * 7 + 1, hours=9),
    )
    await _seed_entry(
        db_session,
        user_id,
        "stage one, in review",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level=ReflectionLevel.STAGE.value,
        reflection_scope_key=_require_scope_key(ReflectionLevel.STAGE, 1),
        timestamp=anchor + timedelta(days=stage_one.stop * 7 - 1),
    )

    feed = await _bodies(
        async_client, headers, ReflectionLevel.TIER, _require_scope_key(ReflectionLevel.TIER, 1)
    )

    assert feed.count("stage one, in review") == 1
    assert feed.count("daily in an unreviewed week") == 1
    assert "daily inside the reviewed stage" not in feed
