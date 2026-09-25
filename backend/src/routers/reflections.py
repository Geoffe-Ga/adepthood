"""Hierarchical-reflection API — what is due, and the material that composes it.

Three read surfaces over the nested APTITUDE reflection calendar:

* ``GET /reflections/due`` peeks at the widest layer that has just closed for the
  caller (if any) and hands back its calendar window plus any reflection already
  claiming that scope.
* ``GET /reflections/current`` lists every layer still in progress today, each
  shaped exactly like the due peek, so a writer can begin a review early — on
  any day, not only a review day (issue #2867).
* ``GET /reflections/sources`` returns the ordered source material feeding a
  reflection at a given ``(level, scope_key)`` — child reflections standing in for
  their spans, and the raw daily entries of every gap — alongside the calendar
  window it filtered on, so the composer can name the period rather than guess it.

All schedule math lives in :mod:`domain.reflection_hierarchy`; this router only
turns program weeks into datetime windows and shuttles rows to and from it. Those
windows come from one helper, :func:`domain.program_calendar.program_week_bounds`,
counted in the caller's own timezone — a program week is seven LOCAL midnights,
never an offset from whatever o'clock the user happened to sign up at. The
same holds for deciding what day it IS: ``/due`` and ``/current`` both read the
caller's clock through :func:`domain.dates.now_in_tz` and count days in their
zone, so the due invitation and the early-review picker turn over together at
the caller's own midnight rather than UTC's.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, cast

from fastapi import Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from domain.constants import DAYS_PER_WEEK
from domain.cycle_calendar import CycleAnchorStatus, cycle_week_bounds, resolve_cycle_window
from domain.dates import ensure_aware, now_in_tz, to_user_date
from domain.program_calendar import (
    calendar_week,
    elapsed_days,
    program_week_bounds,
    resolve_program_anchor,
)
from domain.reflection_hierarchy import (
    EntryRef,
    ReflectionLevel,
    ReflectionRef,
    SourceItem,
    SourceKind,
    current_scopes,
    due_reflection,
    resolve_sources,
    scope_cycle,
    scope_weeks,
)
from domain.stage_progress import get_user_progress
from error_responses import build_router
from errors import forbidden, unprocessable
from models.journal_entry import EntryStatus, JournalEntry
from models.promoted_quote import PromotedQuote
from models.stage_progress import StageProgress
from routers.auth import get_current_user
from schemas.reflection import (
    PromotedQuoteSummary,
    ReflectionCurrentResponse,
    ReflectionCurrentScope,
    ReflectionDue,
    ReflectionDueResponse,
    ReflectionSourceItem,
    ReflectionSourcesResponse,
)
from services.users import get_user_timezone

logger = logging.getLogger(__name__)

# A user with no StageProgress row has not started the program, so the calendar
# unlock check treats them as sitting in week 1.
_UNSTARTED_USER_WEEK = 1

router = build_router(prefix="/reflections", tags=["reflections"])


def _due_window(
    anchor: datetime, level: ReflectionLevel, key: str, tz: str
) -> tuple[datetime, datetime]:
    """Turn a due reflection's week span into its half-open ``[start, end)`` window.

    The span comes from :func:`scope_weeks` and the bounds from the one shared
    :func:`program_week_bounds` helper, so the period this invitation promises
    is byte-for-byte the period ``GET /reflections/sources`` filters on.
    ``window_end`` is EXCLUSIVE — the first instant of the day after the span's
    final day, not that final day itself.
    """
    return program_week_bounds(anchor, scope_weeks(level, key), tz=tz)


async def _existing_scope_entry_id(
    session: AsyncSession, user_id: int, scope_key: str
) -> int | None:
    """Return the caller's live reflection id claiming ``scope_key``, or None.

    Soft-deleted rows are excluded, so deleting a reflection frees the scope and
    this drops back to None.
    """
    result = await session.execute(
        select(JournalEntry.id).where(
            JournalEntry.user_id == user_id,
            col(JournalEntry.reflection_scope_key) == scope_key,
            col(JournalEntry.deleted_at).is_(None),
        )
    )
    return result.scalars().first()


async def _scope_payload(
    session: AsyncSession,
    user_id: int,
    anchor: datetime,
    scope: tuple[ReflectionLevel, str],
    tz: str,
) -> tuple[datetime, datetime, int | None]:
    """One scope's window and live claiming review, as ``/due`` and ``/current`` report it.

    One helper for both surfaces, so a scope offered as due and the same scope
    offered in the picker declare the same period and the same review. Returns
    a neutral tuple rather than either wire type so neither schema is coupled
    to the other through it.
    """
    level, key = scope
    window_start, window_end = _due_window(anchor, level, key, tz)
    existing_entry_id = await _existing_scope_entry_id(session, user_id, key)
    return window_start, window_end, existing_entry_id


@router.get("/due", response_model=ReflectionDueResponse)
async def get_due_reflection(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ReflectionDueResponse:
    """Return the reflection that has just come due for the caller, if any.

    A user with no program progress, or whose current day is not a review day,
    has nothing due (``due`` is ``None``). Otherwise the widest layer that
    closes today wins, carried with its calendar window and any reflection
    already claiming its scope. "Today" is the caller's own calendar day.
    """
    progress = await get_user_progress(session, current_user)
    if progress is None:
        return ReflectionDueResponse(due=None)
    tz = await get_user_timezone(session, current_user)
    anchor = resolve_program_anchor(progress)
    due = due_reflection(anchor, now_in_tz(tz), cycle=progress.cycle_number, tz=tz)
    if due is None:
        return ReflectionDueResponse(due=None)
    window_start, window_end, existing_entry_id = await _scope_payload(
        session, current_user, anchor, (due.level, due.key), tz
    )
    return ReflectionDueResponse(
        due=ReflectionDue(
            level=due.level.value,
            scope_key=due.key,
            window_start=window_start,
            window_end=window_end,
            existing_entry_id=existing_entry_id,
        )
    )


@router.get("/current", response_model=ReflectionCurrentResponse)
async def get_current_reflections(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ReflectionCurrentResponse:
    """Return every reflection scope in progress for the caller today.

    Lets a writer open a review on any day rather than only the day it falls
    due (issue #2867). Each scope carries the same window ``/due`` and
    ``/sources`` declare for it and the caller's own live review claiming it,
    if any. A caller who has not started the program has nothing in progress;
    past the program's end only the course remains open.
    """
    progress = await get_user_progress(session, current_user)
    if progress is None:
        return ReflectionCurrentResponse(scopes=[])
    tz = await get_user_timezone(session, current_user)
    anchor = resolve_program_anchor(progress)
    scopes: list[ReflectionCurrentScope] = []
    for level, key in current_scopes(anchor, now_in_tz(tz), progress.cycle_number, tz=tz):
        window_start, window_end, existing_entry_id = await _scope_payload(
            session, current_user, anchor, (level, key), tz
        )
        scopes.append(
            ReflectionCurrentScope(
                level=level.value,
                scope_key=key,
                window_start=window_start,
                window_end=window_end,
                existing_entry_id=existing_entry_id,
            )
        )
    return ReflectionCurrentResponse(scopes=scopes)


def _validated_scope_weeks(level: ReflectionLevel, scope_key: str) -> range:
    """Return the scope's week span, mapping a bad key/level pairing to 422.

    :func:`scope_weeks` rejects a malformed key, a level/token mismatch, and an
    out-of-range index alike; all three surface here as ``invalid_scope``.
    """
    try:
        return scope_weeks(level, scope_key)
    except ValueError as exc:
        raise unprocessable("invalid_scope") from exc


def _gate_week_for(progress: StageProgress | None, cycle: int, tz: str) -> int | None:
    """The week a scope must open at or before, or None when no gate applies.

    An unstarted user sits in week 1, so only scopes opening at week 1 are
    readable for them; everyone else is gated by their date-derived week, counted
    in their OWN zone so the gate lifts at their midnight rather than UTC's.

    A COMPLETED cycle is the one exception: the user demonstrably lived through
    every week of it, so no week of it can be "not yet reached" (issue #2894).
    The relaxation is deliberately narrow — it fires only for
    ``cycle < progress.cycle_number``. The current cycle and any future one fall
    through to exactly the comparison this guard always made, so a cycle-1 user
    asking for ``c2:s2`` is still refused.
    """
    if progress is None:
        return _UNSTARTED_USER_WEEK
    if cycle < progress.cycle_number:
        return None
    return calendar_week(resolve_program_anchor(progress), tz=tz)


def _guard_scope_unlocked(
    weeks: range, progress: StageProgress | None, cycle: int, tz: str
) -> None:
    """Reject a scope whose first week the caller's calendar has not yet reached."""
    gate_week = _gate_week_for(progress, cycle, tz)
    if gate_week is not None and weeks.start > gate_week:
        raise forbidden("scope_locked")


def _reflection_ref_from(row: JournalEntry) -> ReflectionRef:
    """Build a domain :class:`ReflectionRef` from a scoped reflection row.

    Callers pass rows whose ``reflection_level`` / ``reflection_scope_key`` are
    non-null (the query filters on it), so the string casts are typing hints.
    """
    level = ReflectionLevel(cast("str", row.reflection_level))
    key = cast("str", row.reflection_scope_key)
    return ReflectionRef(
        id=cast("int", row.id), level=level, key=key, week=scope_weeks(level, key).stop - 1
    )


def _parsed_reflection_ref(row: JournalEntry) -> ReflectionRef | None:
    """Parse one stored reflection row, or None when its key is not this grammar's.

    ``scope_weeks`` raises for any key the current grammar does not admit, and
    this query loads EVERY scoped row the caller owns — so one stale or
    part-migrated key used to 500 the whole feed. Skipping it degrades the one
    row instead of the endpoint. The warning carries the key (grammar, not
    journal content) so a bad row is findable without reading anyone's words.
    """
    try:
        return _reflection_ref_from(row)
    except ValueError:
        logger.warning(
            "reflection_scope_key_unparsed",
            extra={"entry_id": row.id, "scope_key": row.reflection_scope_key},
        )
        return None


async def _load_reflection_refs(
    session: AsyncSession, user_id: int, scope_key: str
) -> list[ReflectionRef]:
    """Load the caller's finished, live, scoped reflections other than the composing one.

    A reflection whose scope equals the requested one is excluded so it never
    stands in for itself. Rows whose stored key the current grammar cannot parse
    are skipped rather than crashing the feed.
    """
    result = await session.execute(
        select(JournalEntry).where(
            JournalEntry.user_id == user_id,
            col(JournalEntry.status) == EntryStatus.FINISHED,
            col(JournalEntry.deleted_at).is_(None),
            col(JournalEntry.sender) == "user",
            col(JournalEntry.reflection_scope_key).is_not(None),
            col(JournalEntry.reflection_scope_key) != scope_key,
        )
    )
    parsed = (_parsed_reflection_ref(row) for row in result.scalars().all())
    return [ref for ref in parsed if ref is not None]


async def _inclusion_target_ids(session: AsyncSession, user_id: int) -> list[int]:
    """Return the entry ids the caller has folded promoted quotes into.

    Such an entry is a reflection under composition, not raw source material, so
    the daily-entry query excludes it even when it carries no scope key yet.
    """
    result = await session.execute(
        select(PromotedQuote.included_in_entry_id).where(
            PromotedQuote.user_id == user_id,
            col(PromotedQuote.included_in_entry_id).is_not(None),
        )
    )
    return [cast("int", target_id) for target_id in result.scalars().all() if target_id is not None]


def _entry_ref_from(anchor: datetime, row: JournalEntry, tz: str) -> EntryRef:
    """Build a domain :class:`EntryRef`, tagging the row with its program week.

    Both the week label and the within-week sort date are read in the caller's
    own zone, matching the local-midnight bounds :func:`program_week_bounds`
    draws — the two used to be computed from different clocks.
    """
    week = elapsed_days(anchor, row.timestamp, tz=tz) // DAYS_PER_WEEK + 1
    return EntryRef(
        id=cast("int", row.id), week=week, date=to_user_date(tz, ensure_aware(row.timestamp))
    )


@dataclass(frozen=True)
class _SourcesScope:
    """Everything one ``GET /reflections/sources`` call needs to know about its scope.

    Built once by :func:`_scope_for_request` so the window the feed filters on
    and the window the response declares are the same pair of instants rather
    than two derivations that happen to agree.
    """

    user_id: int
    level: ReflectionLevel
    scope_key: str
    weeks: range
    timezone: str
    #: The anchor of the SCOPE's own cycle — not necessarily the caller's
    #: current one. ``None`` whenever ``anchor_status`` names a reason there is
    #: no window: the feed is then empty rather than windowed against a cycle
    #: the key does not belong to (issue #2886).
    anchor: datetime | None
    #: Which of the four causes explains a missing window, so the client can say
    #: the true thing instead of one indistinguishable empty feed (issue #2894).
    anchor_status: CycleAnchorStatus
    window_start: datetime | None
    window_end: datetime | None


async def _scope_for_request(
    session: AsyncSession, user_id: int, level: ReflectionLevel, scope_key: str
) -> _SourcesScope:
    """Validate the requested scope, resolve the caller's calendar, and bound the window.

    Raises 422 ``invalid_scope`` for a key the grammar rejects and 403
    ``scope_locked`` for a scope the caller's calendar has not reached. The
    window is drawn against the SCOPE's own cycle, so a past cycle is measured
    from the anchor it was actually lived under and clamped at the loop point
    (issue #2894); a cycle with no anchor on record is left unset and says why.
    """
    weeks = _validated_scope_weeks(level, scope_key)
    tz = await get_user_timezone(session, user_id)
    progress = await get_user_progress(session, user_id)
    cycle = scope_cycle(scope_key)
    _guard_scope_unlocked(weeks, progress, cycle, tz)
    cycle_window, anchor_status = resolve_cycle_window(progress, cycle)
    window: tuple[datetime | None, datetime | None] = (None, None)
    if cycle_window is not None:
        window = cycle_week_bounds(cycle_window, weeks, tz=tz)
    return _SourcesScope(
        user_id=user_id,
        level=level,
        scope_key=scope_key,
        weeks=weeks,
        timezone=tz,
        anchor=None if cycle_window is None else cycle_window.started_at,
        anchor_status=anchor_status,
        window_start=window[0],
        window_end=window[1],
    )


async def _load_entry_refs(
    session: AsyncSession, scope: _SourcesScope, anchor: datetime
) -> list[EntryRef]:
    """Load the caller's finished, live, scopeless daily entries inside the scope's window.

    The window is the half-open ``[start, end)`` pair the scope already carries —
    local midnight of the span's first day up to local midnight of the day after
    its last. Entries already being composed into a reflection are excluded.
    """
    excluded = await _inclusion_target_ids(session, scope.user_id)
    query = select(JournalEntry).where(
        JournalEntry.user_id == scope.user_id,
        col(JournalEntry.status) == EntryStatus.FINISHED,
        col(JournalEntry.deleted_at).is_(None),
        col(JournalEntry.sender) == "user",
        col(JournalEntry.reflection_scope_key).is_(None),
        col(JournalEntry.timestamp) >= scope.window_start,
        col(JournalEntry.timestamp) < scope.window_end,
    )
    if excluded:
        query = query.where(col(JournalEntry.id).not_in(excluded))
    result = await session.execute(query)
    return [_entry_ref_from(anchor, row, scope.timezone) for row in result.scalars().all()]


async def _resolve_entry_refs(session: AsyncSession, scope: _SourcesScope) -> list[EntryRef]:
    """The scope's raw dailies, read against the anchor of the scope's OWN cycle.

    The lesson of issue #2886 stands unchanged: windowing one cycle's key
    against another cycle's anchor serves the wrong period's entries under the
    old review's heading. What changed is how it is honoured. ``begin-again``
    now retains each outgoing cycle's ``program_started_at`` (issue #2894), so
    :func:`domain.cycle_calendar.resolve_cycle_window` can hand back the scope's
    own anchor and a window clamped at the instant that cycle closed — and the
    same anchor labels each row's program week, so bounds and labels are read
    from one clock rather than two.

    A cycle with no anchor on record (destroyed before #2894, or never reached)
    contributes no raw material at all rather than a guessed period; its own
    child reviews, matched by exact key rather than by window, still stand in.
    """
    if scope.anchor is None or scope.window_start is None or scope.window_end is None:
        return []
    return await _load_entry_refs(session, scope, scope.anchor)


async def _batch_entries(
    session: AsyncSession, user_id: int, resolved: list[SourceItem]
) -> dict[int, JournalEntry]:
    """Load the caller's own rows behind the resolved source ids, keyed by id.

    Re-scoping to ``user_id`` and live rows is defense-in-depth: the refs already
    came from the caller's data, but this guards against a resolver returning an
    id that has since been deleted or does not belong to them.
    """
    ids = [item.id for item in resolved]
    if not ids:
        return {}
    result = await session.execute(
        select(JournalEntry).where(
            col(JournalEntry.id).in_(ids),
            JournalEntry.user_id == user_id,
            col(JournalEntry.deleted_at).is_(None),
        )
    )
    return {cast("int", row.id): row for row in result.scalars().all()}


async def _quotes_by_entry(
    session: AsyncSession, user_id: int, resolved: list[SourceItem]
) -> dict[int, list[PromotedQuote]]:
    """Group the caller's promoted quotes for the resolved source entries by source id.

    Ordered by ``anchor_start`` so each entry's quotes come back in reading
    order; another user's quotes on the same source id are filtered out.
    """
    ids = [item.id for item in resolved]
    if not ids:
        return {}
    result = await session.execute(
        select(PromotedQuote)
        .where(
            col(PromotedQuote.source_entry_id).in_(ids),
            PromotedQuote.user_id == user_id,
        )
        .order_by(col(PromotedQuote.anchor_start))
    )
    grouped: dict[int, list[PromotedQuote]] = {}
    for quote in result.scalars().all():
        grouped.setdefault(quote.source_entry_id, []).append(quote)
    return grouped


def _quote_summary(quote: PromotedQuote) -> PromotedQuoteSummary:
    """Map a promoted-quote row to its summary DTO; pending == not yet folded in."""
    return PromotedQuoteSummary(
        id=cast("int", quote.id),
        anchor_start=quote.anchor_start,
        anchor_end=quote.anchor_end,
        anchor_text=quote.anchor_text,
        pending=quote.included_in_entry_id is None,
    )


def _to_source_item(
    item: SourceItem, entry: JournalEntry, quotes: list[PromotedQuote]
) -> ReflectionSourceItem:
    """Map a resolved :class:`SourceItem` plus its row and quotes to the response DTO.

    ``reflection_level`` is carried only for a REFLECTION item (naming the child
    layer that stood in); a raw entry leaves it ``None``.
    """
    is_reflection = item.kind is SourceKind.REFLECTION and item.level is not None
    return ReflectionSourceItem(
        kind=item.kind.value,
        id=item.id,
        title=entry.title,
        timestamp=entry.timestamp,
        body=entry.message,
        reflection_level=item.level.value if is_reflection and item.level is not None else None,
        promoted_quotes=[_quote_summary(quote) for quote in quotes],
    )


def _log_sources_resolved(scope: _SourcesScope, items: list[ReflectionSourceItem]) -> None:
    """Record which scope, cycle and window produced which counts — never the words.

    The endpoint returns raw journal bodies, so a diagnostic that made a wrong
    window debuggable by quoting the feed would be a privacy regression. Titles,
    bodies and quoted spans are all deliberately absent.
    """
    logger.info(
        "sources_resolved",
        extra={
            "level": scope.level.value,
            "scope_key": scope.scope_key,
            "cycle": scope_cycle(scope.scope_key),
            "anchor_status": scope.anchor_status.value,
            "window_start": scope.window_start,
            "window_end": scope.window_end,
            "timezone": scope.timezone,
            "entry_count": sum(1 for item in items if item.reflection_level is None),
            "reflection_count": sum(1 for item in items if item.reflection_level is not None),
        },
    )


@router.get("/sources", response_model=ReflectionSourcesResponse)
async def get_reflection_sources(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    level: Annotated[ReflectionLevel, Query()],
    scope_key: Annotated[str, Query()],
) -> ReflectionSourcesResponse:
    """Return the ordered source material feeding the reflection at ``(level, scope_key)``.

    A malformed key, a level/token mismatch, or an out-of-range index is 422; a
    scope whose first week the caller has not yet reached is 403 ``scope_locked``.
    Every week of a cycle the caller has already completed counts as reached.
    Otherwise the hierarchy is walked top-down: an existing child reflection
    stands in for its whole span, and every gap decomposes to that week's raw
    daily entries, yielding a chronological feed with each promoted quote flagged
    pending or included.

    A scope naming an EARLIER cycle is windowed against that cycle's own
    retained anchor and clamped at the instant it closed (issue #2894). When
    that anchor is not on record — destroyed by ``begin-again`` before #2894
    shipped, and not reconstructable — the feed comes back empty with no bounds
    and ``anchor_status`` set to ``unrecorded``, so the client can say the
    period cannot be rebuilt rather than implying nothing was written in it.
    """
    scope = await _scope_for_request(session, current_user, level, scope_key)
    reflection_refs = await _load_reflection_refs(session, current_user, scope_key)
    entry_refs = await _resolve_entry_refs(session, scope)
    resolved = resolve_sources(level, scope_key, existing=reflection_refs, entries=entry_refs)
    entries_by_id = await _batch_entries(session, current_user, resolved)
    quotes_by_entry = await _quotes_by_entry(session, current_user, resolved)
    items = [
        _to_source_item(item, entries_by_id[item.id], quotes_by_entry.get(item.id, []))
        for item in resolved
        if item.id in entries_by_id
    ]
    _log_sources_resolved(scope, items)
    return ReflectionSourcesResponse(
        level=level.value,
        scope_key=scope_key,
        window_start=scope.window_start,
        window_end=scope.window_end,
        anchor_status=scope.anchor_status,
        items=items,
    )
