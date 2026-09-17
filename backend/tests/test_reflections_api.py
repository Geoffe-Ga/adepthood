"""Tests for the hierarchical-reflection API: GET /reflections/due and /reflections/sources.

These pin the contract for routers that do not exist yet
(``routers/reflections.py``). Every request below either 404s (route missing)
or the assertion on the (currently absent) response shape fails -- both are
the correct RED state for Gate 1. Underlying domain math
(``domain.reflection_hierarchy``) is already implemented and tested
elsewhere; it is used here only as an oracle to compute expected values, not
under test itself.
"""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.reflection_hierarchy import due_reflection, scope_weeks
from models.journal_entry import EntryStatus, JournalEntry, JournalTag
from models.promoted_quote import PromotedQuote
from models.stage_progress import StageProgress
from models.user import User

_DAYS_PER_WEEK = 7


async def _signup(
    client: AsyncClient, db_session: AsyncSession, username: str = "alice"
) -> tuple[dict[str, str], int]:
    """Create a user, return its auth headers and DB id."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    user = (
        await db_session.execute(select(User).where(col(User.email) == f"{username}@example.com"))
    ).scalar_one()
    assert user.id is not None
    return {"Authorization": f"Bearer {token}"}, user.id


async def _seed_progress(
    db_session: AsyncSession,
    user_id: int,
    *,
    anchor: datetime,
    cycle_number: int = 1,
    current_stage: int = 1,
) -> StageProgress:
    """Plant a StageProgress row anchored at ``anchor``."""
    progress = StageProgress(
        user_id=user_id,
        current_stage=current_stage,
        completed_stages=[],
        stage_started_at=anchor,
        program_started_at=anchor,
        cycle_number=cycle_number,
    )
    db_session.add(progress)
    await db_session.commit()
    await db_session.refresh(progress)
    return progress


async def _seed_looped_progress(
    db_session: AsyncSession,
    user_id: int,
    *,
    anchor: datetime,
    cycle_number: int,
    past_cycle_anchors: list[str | None],
) -> StageProgress:
    """Plant a row that has ALREADY looped, carrying the anchors it retained.

    ``anchor`` is the CURRENT cycle's ``program_started_at``;
    ``past_cycle_anchors`` is what ``begin-again`` kept of the earlier ones
    (issue #2894): element ``i`` is cycle ``i + 1``'s program start as ISO-8601,
    and ``None`` at an index is an anchor destroyed before that fix shipped and
    not recoverable. Separate from :func:`_seed_progress` so the ordinary
    single-cycle seeding stays a four-keyword call.
    """
    progress = await _seed_progress(db_session, user_id, anchor=anchor, cycle_number=cycle_number)
    progress.past_cycle_anchors = past_cycle_anchors
    db_session.add(progress)
    await db_session.commit()
    await db_session.refresh(progress)
    return progress


async def _seed_entry(
    db_session: AsyncSession, user_id: int, message: str, **overrides: object
) -> JournalEntry:
    """Create and persist a JournalEntry, defaulting to a finished user entry."""
    defaults: dict[str, object] = {"sender": "user", "status": EntryStatus.FINISHED}
    defaults.update(overrides)
    entry = JournalEntry(user_id=user_id, message=message, **defaults)
    db_session.add(entry)
    await db_session.commit()
    await db_session.refresh(entry)
    return entry


def _aware(actual_iso: str) -> datetime:
    """Parse a window bound off the wire as a tz-aware instant."""
    actual = datetime.fromisoformat(actual_iso)
    return actual if actual.tzinfo is not None else actual.replace(tzinfo=UTC)


# ── GET /reflections/due ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_due_requires_auth(async_client: AsyncClient) -> None:
    """Unauthenticated callers get 401."""
    resp = await async_client.get("/reflections/due")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_due_with_no_stage_progress_returns_null(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A user with no StageProgress row has nothing due."""
    headers, _user_id = await _signup(async_client, db_session)
    resp = await async_client.get("/reflections/due", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["due"] is None


@pytest.mark.asyncio
async def test_due_not_on_due_day_returns_null(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Three days into week 1 (not day 7) has nothing due."""
    now = datetime.now(UTC)
    anchor = now - timedelta(days=3)
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    resp = await async_client.get("/reflections/due", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["due"] is None


@pytest.mark.asyncio
async def test_due_on_week_boundary_returns_week_scope(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Day 7 of week 1 is due at the WEEK layer, with the correct window."""
    now = datetime.now(UTC)
    anchor = now - timedelta(days=6)
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    resp = await async_client.get("/reflections/due", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    due = resp.json()["due"]
    assert due is not None

    expected = due_reflection(anchor, now=now)
    assert expected is not None
    assert due["level"] == expected.level.value
    assert due["scope_key"] == expected.key
    assert due["existing_entry_id"] is None

    # The window is a CALENDAR span, not an offset from the signup clock: it opens
    # at midnight of the anchor's own day in the caller's zone (UTC here) and runs
    # exactly seven days per program week, end-exclusive. Asserted as a semantic
    # rather than by replaying the router's arithmetic, so a window computed from
    # the wrong clock cannot satisfy it.
    weeks = scope_weeks(expected.level, expected.key)
    window_start = _aware(due["window_start"])
    window_end = _aware(due["window_end"])
    assert window_start == datetime.combine(anchor.date(), time.min, tzinfo=UTC)
    assert window_end - window_start == timedelta(days=_DAYS_PER_WEEK * len(weeks))


@pytest.mark.asyncio
async def test_due_on_stage_boundary_returns_stage_scope(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Week 3 closes stage 1, so the due layer widens to STAGE, not WEEK."""
    now = datetime.now(UTC)
    anchor = now - timedelta(days=20)
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    resp = await async_client.get("/reflections/due", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    due = resp.json()["due"]
    assert due is not None
    assert due["level"] == "stage"
    assert due["scope_key"] == "c1:s1"


@pytest.mark.asyncio
async def test_due_existing_entry_id_toggles_with_soft_delete(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A live hierarchical reflection for the due scope surfaces as existing_entry_id.

    Soft-deleting that entry clears ``existing_entry_id`` back to null.
    """
    now = datetime.now(UTC)
    anchor = now - timedelta(days=6)
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    entry = await _seed_entry(
        db_session,
        user_id,
        "Week one, in review.",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level="week",
        reflection_scope_key="c1:w1",
    )

    resp = await async_client.get("/reflections/due", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["due"]["existing_entry_id"] == entry.id

    entry.deleted_at = datetime.now(UTC)
    db_session.add(entry)
    await db_session.commit()

    resp_after_delete = await async_client.get("/reflections/due", headers=headers)
    assert resp_after_delete.status_code == HTTPStatus.OK
    assert resp_after_delete.json()["due"]["existing_entry_id"] is None


@pytest.mark.asyncio
async def test_due_scope_key_carries_cycle_prefix(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A second-cycle user's due scope key is prefixed ``c2:``, not ``c1:``."""
    now = datetime.now(UTC)
    anchor = now - timedelta(days=6)
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor, cycle_number=2)
    resp = await async_client.get("/reflections/due", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    due = resp.json()["due"]
    assert due is not None
    assert due["scope_key"] == "c2:w1"


# ── GET /reflections/sources ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sources_requires_auth(async_client: AsyncClient) -> None:
    """Unauthenticated callers get 401."""
    resp = await async_client.get(
        "/reflections/sources", params={"level": "week", "scope_key": "c1:w1"}
    )
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_sources_malformed_scope_key_returns_422(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A scope key that fails the ``c{cycle}:{token}`` grammar is 422."""
    headers, _user_id = await _signup(async_client, db_session)
    resp = await async_client.get(
        "/reflections/sources",
        params={"level": "week", "scope_key": "garbage"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_sources_level_key_mismatch_returns_422(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A stage-level request against a week-token key is rejected."""
    headers, _user_id = await _signup(async_client, db_session)
    resp = await async_client.get(
        "/reflections/sources",
        params={"level": "stage", "scope_key": "c1:w5"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_sources_out_of_range_index_returns_422(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Stage 11 doesn't exist (curriculum has 10 stages), so it's 422."""
    headers, _user_id = await _signup(async_client, db_session)
    resp = await async_client.get(
        "/reflections/sources",
        params={"level": "stage", "scope_key": "c1:s11"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_sources_locked_future_scope_returns_403(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Stage 2 (weeks 4-6) is locked for a user still in week 1."""
    now = datetime.now(UTC)
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=now)
    resp = await async_client.get(
        "/reflections/sources",
        params={"level": "stage", "scope_key": "c1:s2"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "scope_locked"


@pytest.mark.asyncio
async def test_sources_locked_future_cycle_scope_returns_403(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A cycle the caller has not reached stays locked exactly as it always was.

    Retaining past-cycle anchors (#2894) relaxes the unlock guard for cycles the
    user has COMPLETED. The relaxation must not leak the other way: ``c2:s2``
    for a cycle-1 user in week 1 is still a scope nobody has lived through, and
    silently turning a 403 into a 200 on an access-control surface would be a
    behaviour change nothing asked for.
    """
    now = datetime.now(UTC)
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=now, cycle_number=1)
    resp = await async_client.get(
        "/reflections/sources",
        params={"level": "stage", "scope_key": "c2:s2"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "scope_locked"


@pytest.mark.asyncio
async def test_due_is_unchanged_by_per_cycle_anchors(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``GET /reflections/due`` still asks only where the user is NOW.

    What comes due is a question about the CURRENT cycle, whose anchor #2894
    leaves untouched. Seeding retained anchors for earlier cycles must therefore
    change the payload in no way at all — asserted on the whole payload, so a
    later refactor that resolved a past cycle's anchor here would be caught.
    """
    # Day 7 of a program week is when a reflection comes due.
    anchor = datetime.now(UTC) - timedelta(days=_DAYS_PER_WEEK - 1)
    cycle_one_anchor = anchor - timedelta(days=400)
    bare_headers, bare_id = await _signup(async_client, db_session, "due_bare")
    await _seed_progress(db_session, bare_id, anchor=anchor, cycle_number=2)
    rich_headers, rich_id = await _signup(async_client, db_session, "due_rich")
    await _seed_looped_progress(
        db_session,
        rich_id,
        anchor=anchor,
        cycle_number=2,
        past_cycle_anchors=[cycle_one_anchor.isoformat()],
    )

    bare = await async_client.get("/reflections/due", headers=bare_headers)
    rich = await async_client.get("/reflections/due", headers=rich_headers)

    assert bare.status_code == HTTPStatus.OK
    assert rich.status_code == HTTPStatus.OK
    assert rich.json() == bare.json()
    # And the seeding was not vacuous: something really was due for both.
    assert bare.json()["due"] is not None


@pytest.mark.asyncio
async def test_sources_week_scope_returns_daily_entries_chronologically(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A week's sources are that week's finished daily entries, oldest first."""
    now = datetime.now(UTC)
    anchor = now - timedelta(days=8)
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    await _seed_entry(
        db_session, user_id, "Second day's thoughts", timestamp=anchor + timedelta(days=2)
    )
    await _seed_entry(
        db_session, user_id, "First day's thoughts", timestamp=anchor + timedelta(days=1)
    )

    resp = await async_client.get(
        "/reflections/sources",
        params={"level": "week", "scope_key": "c1:w1"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    items = resp.json()["items"]
    assert [item["body"] for item in items] == ["First day's thoughts", "Second day's thoughts"]
    assert all(item["kind"] == "entry" for item in items)
    assert all(item["reflection_level"] is None for item in items)


@pytest.mark.asyncio
async def test_sources_excludes_bot_deleted_foreign_and_out_of_window_entries(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Bot, soft-deleted, foreign, and out-of-window entries never appear.

    Each exclusion is paired with a control the feed MUST keep, at the same
    instant where that matters: an assertion that the feed is empty passes for
    any reason at all, including a query that returns nothing, which is how the
    window predicates went unguarded for so long.
    """
    now = datetime.now(UTC)
    anchor = now - timedelta(days=8)
    headers, user_id = await _signup(async_client, db_session)
    _other_headers, other_id = await _signup(async_client, db_session, username="bob")
    await _seed_progress(db_session, user_id, anchor=anchor)

    await _seed_entry(
        db_session, user_id, "Kept body", timestamp=anchor + timedelta(days=1, hours=1)
    )
    await _seed_entry(
        db_session, user_id, "Bot reply", sender="bot", timestamp=anchor + timedelta(days=1)
    )
    deleted = await _seed_entry(
        db_session, user_id, "Deleted body", timestamp=anchor + timedelta(days=1)
    )
    deleted.deleted_at = datetime.now(UTC)
    db_session.add(deleted)
    await db_session.commit()
    await _seed_entry(
        db_session, other_id, "Someone else's body", timestamp=anchor + timedelta(days=1)
    )
    await _seed_entry(
        db_session, user_id, "Outside the window", timestamp=anchor + timedelta(days=30)
    )
    await _seed_entry(
        db_session, user_id, "Before the program began", timestamp=anchor - timedelta(days=2)
    )

    resp = await async_client.get(
        "/reflections/sources",
        params={"level": "week", "scope_key": "c1:w1"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    assert [item["body"] for item in resp.json()["items"]] == ["Kept body"]


@pytest.mark.asyncio
async def test_sources_excludes_draft_status_entries(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A draft (unfinished) entry inside the window is not yet a source.

    Paired with a finished control at the same hour so "excluded" can never be
    satisfied by "the query returned nothing".
    """
    now = datetime.now(UTC)
    anchor = now - timedelta(days=8)
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    await _seed_entry(
        db_session,
        user_id,
        "Still drafting",
        status=EntryStatus.DRAFT,
        timestamp=anchor + timedelta(days=1),
    )
    await _seed_entry(
        db_session, user_id, "Finished alongside it", timestamp=anchor + timedelta(days=1)
    )

    resp = await async_client.get(
        "/reflections/sources",
        params={"level": "week", "scope_key": "c1:w1"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    assert [item["body"] for item in resp.json()["items"]] == ["Finished alongside it"]


@pytest.mark.asyncio
async def test_sources_stage_scope_decomposes_with_week_reflection_standing_in(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A completed week-1 reflection stands in for week 1 within a stage scope.

    Weeks 2 and 3 (no reflection yet) decompose to their raw daily entries.
    """
    now = datetime.now(UTC)
    anchor = now - timedelta(days=30)
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    await _seed_entry(
        db_session,
        user_id,
        "Week one summary",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level="week",
        reflection_scope_key="c1:w1",
        timestamp=anchor + timedelta(days=6),
    )
    await _seed_entry(db_session, user_id, "Week two daily", timestamp=anchor + timedelta(days=8))
    await _seed_entry(
        db_session, user_id, "Week three daily", timestamp=anchor + timedelta(days=15)
    )

    resp = await async_client.get(
        "/reflections/sources",
        params={"level": "stage", "scope_key": "c1:s1"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    items = resp.json()["items"]
    assert len(items) == 3
    assert items[0]["kind"] == "reflection"
    assert items[0]["reflection_level"] == "week"
    assert items[0]["body"] == "Week one summary"
    assert items[1]["kind"] == "entry"
    assert items[1]["body"] == "Week two daily"
    assert items[2]["kind"] == "entry"
    assert items[2]["body"] == "Week three daily"


@pytest.mark.asyncio
async def test_sources_composing_reflection_excluded_from_its_own_sources(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A reflection whose scope equals the requested scope never stands in for itself."""
    now = datetime.now(UTC)
    anchor = now - timedelta(days=30)
    headers, user_id = await _signup(async_client, db_session)
    await _seed_progress(db_session, user_id, anchor=anchor)
    self_reflection = await _seed_entry(
        db_session,
        user_id,
        "This is the stage-1 reflection itself",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level="stage",
        reflection_scope_key="c1:s1",
        timestamp=anchor + timedelta(days=20),
    )
    await _seed_entry(db_session, user_id, "Week one daily", timestamp=anchor + timedelta(days=1))
    await _seed_entry(db_session, user_id, "Week two daily", timestamp=anchor + timedelta(days=8))
    await _seed_entry(
        db_session, user_id, "Week three daily", timestamp=anchor + timedelta(days=15)
    )

    resp = await async_client.get(
        "/reflections/sources",
        params={"level": "stage", "scope_key": "c1:s1"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    items = resp.json()["items"]
    ids = {item["id"] for item in items}
    assert self_reflection.id not in ids
    assert [item["body"] for item in items] == [
        "Week one daily",
        "Week two daily",
        "Week three daily",
    ]
    assert all(item["kind"] == "entry" for item in items)


@pytest.mark.asyncio
async def test_sources_include_promoted_quotes_ordered_with_pending_flag(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A source entry's promoted_quotes are ordered by anchor_start with correct pending flags.

    Another user's quote on the same source entry id must never leak in.
    """
    now = datetime.now(UTC)
    anchor = now - timedelta(days=8)
    headers, user_id = await _signup(async_client, db_session)
    _other_headers, other_id = await _signup(async_client, db_session, username="bob")
    await _seed_progress(db_session, user_id, anchor=anchor)
    entry = await _seed_entry(
        db_session,
        user_id,
        "Grateful for today and for tomorrow",
        timestamp=anchor + timedelta(days=1),
    )
    target = await _seed_entry(
        db_session, user_id, "Target entry for inclusion", timestamp=anchor + timedelta(days=1)
    )

    pending_quote = PromotedQuote(
        user_id=user_id,
        source_entry_id=entry.id,
        anchor_start=10,
        anchor_end=18,
        anchor_text=entry.message[10:18],
        included_in_entry_id=None,
    )
    included_quote = PromotedQuote(
        user_id=user_id,
        source_entry_id=entry.id,
        anchor_start=0,
        anchor_end=9,
        anchor_text=entry.message[0:9],
        included_in_entry_id=target.id,
    )
    foreign_quote = PromotedQuote(
        user_id=other_id,
        source_entry_id=entry.id,
        anchor_start=20,
        anchor_end=27,
        anchor_text=entry.message[20:27],
        included_in_entry_id=None,
    )
    db_session.add_all([pending_quote, included_quote, foreign_quote])
    await db_session.commit()

    resp = await async_client.get(
        "/reflections/sources",
        params={"level": "week", "scope_key": "c1:w1"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    items = resp.json()["items"]
    assert len(items) == 1
    quotes = items[0]["promoted_quotes"]
    assert len(quotes) == 2
    assert quotes[0]["anchor_start"] == 0
    assert quotes[0]["anchor_text"] == entry.message[0:9]
    assert quotes[0]["pending"] is False
    assert quotes[1]["anchor_start"] == 10
    assert quotes[1]["anchor_text"] == entry.message[10:18]
    assert quotes[1]["pending"] is True
    assert foreign_quote.id not in {q["id"] for q in quotes}
