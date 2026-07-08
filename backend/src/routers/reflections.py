"""Hierarchical-reflection API — what is due, and the material that composes it.

Two read surfaces over the nested APTITUDE reflection calendar:

* ``GET /reflections/due`` peeks at the widest layer that has just closed for the
  caller (if any) and hands back its calendar window plus any reflection already
  claiming that scope.
* ``GET /reflections/sources`` returns the ordered source material feeding a
  reflection at a given ``(level, scope_key)`` — child reflections standing in for
  their spans, and the raw daily entries of every gap.

All schedule math lives in :mod:`domain.reflection_hierarchy`; this router only
turns program weeks into datetime windows and shuttles rows to and from it.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Annotated, cast

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from domain.program_calendar import calendar_week, elapsed_days, resolve_program_anchor
from domain.reflection_hierarchy import (
    EntryRef,
    ReflectionLevel,
    ReflectionRef,
    SourceItem,
    SourceKind,
    due_reflection,
    resolve_sources,
    scope_weeks,
)
from domain.stage_progress import get_user_progress
from errors import forbidden, unprocessable
from models.journal_entry import EntryStatus, JournalEntry
from models.promoted_quote import PromotedQuote
from models.stage_progress import StageProgress
from routers.auth import get_current_user
from schemas.reflection import (
    PromotedQuoteSummary,
    ReflectionDue,
    ReflectionDueResponse,
    ReflectionSourceItem,
    ReflectionSourcesResponse,
)

# Seven days to a program week; the window math is a multiple of this.
_DAYS_PER_WEEK = 7

# A user with no StageProgress row has not started the program, so the calendar
# unlock check treats them as sitting in week 1.
_UNSTARTED_USER_WEEK = 1

router = APIRouter(prefix="/reflections", tags=["reflections"])


def _due_window(anchor: datetime, level: ReflectionLevel, key: str) -> tuple[datetime, datetime]:
    """Turn a due reflection's week span into its (start, end) datetime window.

    The span comes from :func:`scope_weeks`; the start is the first day of its
    first week and the end is the last day of its final week, both offset off the
    program anchor.
    """
    weeks = scope_weeks(level, key)
    start_week = weeks.start
    end_week = weeks.stop - 1
    window_start = anchor + timedelta(days=(start_week - 1) * _DAYS_PER_WEEK)
    window_end = anchor + timedelta(days=end_week * _DAYS_PER_WEEK)
    return window_start, window_end


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


@router.get("/due", response_model=ReflectionDueResponse)
async def get_due_reflection(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ReflectionDueResponse:
    """Return the reflection that has just come due for the caller, if any.

    A user with no program progress, or whose current day is not a week-closing
    day, has nothing due (``due`` is ``None``). Otherwise the widest layer that
    closes today wins, carried with its calendar window and any reflection
    already claiming its scope.
    """
    progress = await get_user_progress(session, current_user)
    if progress is None:
        return ReflectionDueResponse(due=None)
    anchor = resolve_program_anchor(progress)
    due = due_reflection(anchor, cycle=progress.cycle_number)
    if due is None:
        return ReflectionDueResponse(due=None)
    window_start, window_end = _due_window(anchor, due.level, due.key)
    existing_entry_id = await _existing_scope_entry_id(session, current_user, due.key)
    return ReflectionDueResponse(
        due=ReflectionDue(
            level=due.level.value,
            scope_key=due.key,
            window_start=window_start,
            window_end=window_end,
            existing_entry_id=existing_entry_id,
        )
    )


def _validated_scope_weeks(level: ReflectionLevel, scope_key: str) -> range:
    """Return the scope's week span, mapping a bad key/level pairing to 422.

    :func:`scope_weeks` rejects a malformed key, a level/token mismatch, and an
    out-of-range index alike; all three surface here as ``invalid_scope``.
    """
    try:
        return scope_weeks(level, scope_key)
    except ValueError as exc:
        raise unprocessable("invalid_scope") from exc


def _guard_scope_unlocked(weeks: range, progress: StageProgress | None) -> None:
    """Reject a scope whose first week the caller's calendar has not yet reached.

    An unstarted user sits in week 1, so only scopes opening at week 1 are
    readable for them; everyone else is gated by their date-derived week.
    """
    user_week = (
        calendar_week(resolve_program_anchor(progress))
        if progress is not None
        else _UNSTARTED_USER_WEEK
    )
    if weeks.start > user_week:
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


async def _load_reflection_refs(
    session: AsyncSession, user_id: int, scope_key: str
) -> list[ReflectionRef]:
    """Load the caller's finished, live, scoped reflections other than the composing one.

    A reflection whose scope equals the requested one is excluded so it never
    stands in for itself.
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
    return [_reflection_ref_from(row) for row in result.scalars().all()]


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


def _entry_ref_from(anchor: datetime, row: JournalEntry) -> EntryRef:
    """Build a domain :class:`EntryRef`, tagging the row with its program week."""
    week = elapsed_days(anchor, row.timestamp) // _DAYS_PER_WEEK + 1
    return EntryRef(id=cast("int", row.id), week=week, date=row.timestamp.date())


async def _load_entry_refs(
    session: AsyncSession, user_id: int, anchor: datetime, weeks: range
) -> list[EntryRef]:
    """Load the caller's finished, live, scopeless daily entries inside the scope's window.

    The half-open window runs from the first day of the span's first week up to
    (but not including) the day after its final week. Entries already being
    composed into a reflection are excluded.
    """
    window_start = anchor + timedelta(days=(weeks.start - 1) * _DAYS_PER_WEEK)
    window_end = anchor + timedelta(days=(weeks.stop - 1) * _DAYS_PER_WEEK)
    excluded = await _inclusion_target_ids(session, user_id)
    query = select(JournalEntry).where(
        JournalEntry.user_id == user_id,
        col(JournalEntry.status) == EntryStatus.FINISHED,
        col(JournalEntry.deleted_at).is_(None),
        col(JournalEntry.sender) == "user",
        col(JournalEntry.reflection_scope_key).is_(None),
        col(JournalEntry.timestamp) >= window_start,
        col(JournalEntry.timestamp) < window_end,
    )
    if excluded:
        query = query.where(col(JournalEntry.id).not_in(excluded))
    result = await session.execute(query)
    return [_entry_ref_from(anchor, row) for row in result.scalars().all()]


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
    Otherwise the hierarchy is walked top-down: an existing child reflection
    stands in for its whole span, and every gap decomposes to that week's raw
    daily entries, yielding a chronological feed with each promoted quote flagged
    pending or included.
    """
    weeks = _validated_scope_weeks(level, scope_key)
    progress = await get_user_progress(session, current_user)
    _guard_scope_unlocked(weeks, progress)
    if progress is None:
        return ReflectionSourcesResponse(items=[])
    anchor = resolve_program_anchor(progress)
    reflection_refs = await _load_reflection_refs(session, current_user, scope_key)
    entry_refs = await _load_entry_refs(session, current_user, anchor, weeks)
    resolved = resolve_sources(level, scope_key, existing=reflection_refs, entries=entry_refs)
    entries_by_id = await _batch_entries(session, current_user, resolved)
    quotes_by_entry = await _quotes_by_entry(session, current_user, resolved)
    items = [
        _to_source_item(item, entries_by_id[item.id], quotes_by_entry.get(item.id, []))
        for item in resolved
        if item.id in entries_by_id
    ]
    return ReflectionSourcesResponse(items=items)
