"""Weekly reflection prompts API — serve prompts and store responses."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import Select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.timezone import current_user_timezone
from domain.program_calendar import calendar_week, resolve_program_anchor
from domain.stage_progress import get_user_progress
from domain.weekly_prompts import (
    TOTAL_WEEKS,
    WeekPrompt,
    resolve_week_prompt,
    stage_prompts,
)
from errors import conflict, forbidden, not_found, unprocessable
from models.journal_entry import JOURNAL_TITLE_MAX_LENGTH, JournalEntry, JournalTag
from models.prompt_response import PromptResponse
from routers.auth import get_current_user
from schemas.pagination import page_has_more
from schemas.prompt import (
    PROMPT_RESPONSE_MAX_LENGTH,
    PromptDetail,
    PromptListResponse,
    PromptSubmit,
    StagePromptDetail,
    StagePromptsResponse,
)
from security import TextTooLongError, sanitize_user_text

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/prompts", tags=["prompts"])


async def _get_user_week(
    session: AsyncSession, user_id: int, tz: str, *, now: datetime | None = None
) -> int:
    """The user's current week: completion-derived OR calendar, whichever leads.

    Completion model: ``count(responses) + 1`` — the count only ever
    equals the number of contiguously completed weeks (the submit
    endpoint rejects ``week_number > user_week``), so ``count + 1`` is
    the first unfinished week and a single POST cannot skip ahead.

    Calendar model: ``calendar_week(program anchor)`` — the same
    date-derived schedule the frontend renders, so a user eight days into
    the program can read week 2 without having answered week 1.  The week
    is computed in the caller's timezone ``tz`` (the anchor's local
    calendar), so week boundaries flip at the user's local midnight rather
    than UTC.  ``now`` is an injectable clock seam for deterministic tests.

    ``max`` of the two: time opens weeks, completions can run ahead of a
    backdated anchor, and both are server-computed so neither adds a
    skip-ahead vector.  Clamped to ``[1, TOTAL_WEEKS]``.
    """
    result = await session.execute(
        select(func.count()).select_from(PromptResponse).where(PromptResponse.user_id == user_id)
    )
    completed = int(result.scalar() or 0)
    completion_week = completed + 1
    progress = await get_user_progress(session, user_id)
    time_week = calendar_week(resolve_program_anchor(progress), now, tz=tz) if progress else 1
    return int(max(1, min(max(completion_week, time_week), TOTAL_WEEKS)))


async def _check_week_unlocked(
    session: AsyncSession, user_id: int, week_number: int, tz: str
) -> None:
    """Raise 403 when ``week_number`` is past the user's current week.

    Both :func:`get_prompt_by_week` and :func:`submit_prompt_response`
    must gate on this to prevent enumeration of the full 36-week
    curriculum and one-request skip-ahead of the weekly pacing.
    Factored into a shared helper so the two endpoints cannot drift out
    of sync.
    """
    user_week = await _get_user_week(session, user_id, tz)
    if week_number > user_week:
        raise forbidden("week_locked")


async def _find_response(
    session: AsyncSession, user_id: int, week_number: int
) -> PromptResponse | None:
    """The user's stored response for one week, if they have written one."""
    result = await session.execute(
        select(PromptResponse).where(
            PromptResponse.user_id == user_id,
            PromptResponse.week_number == week_number,
        )
    )
    return result.scalars().first()


def _unanswered_detail(resolved: WeekPrompt) -> PromptDetail:
    """Serialize a week the user has not written to yet."""
    return PromptDetail(
        week_number=resolved.week_number,
        question=resolved.question,
        default_title=resolved.default_title,
        prompt_ordinal=resolved.prompt.ordinal,
        has_responded=False,
    )


def _answered_detail(pr: PromptResponse) -> PromptDetail:
    """Serialize a stored response; live content wins, the snapshot is the fallback.

    The row's ``prompt_ordinal`` picks which of its stage's prompts it
    answered, so a stage with four addressable prompts reads back the one that
    was written to rather than the one its week happens to draw. A legacy row
    (``None``) falls back to the week's own prompt, and a row whose ordinal the
    content no longer carries falls back the same way before finally falling
    back to its own snapshot for a week the curriculum has retired.
    """
    resolved = resolve_week_prompt(pr.week_number, pr.prompt_ordinal) or resolve_week_prompt(
        pr.week_number
    )
    return PromptDetail(
        week_number=pr.week_number,
        question=resolved.question if resolved else pr.question,
        default_title=resolved.default_title if resolved else None,
        prompt_ordinal=pr.prompt_ordinal,
        has_responded=True,
        response=pr.response,
        timestamp=pr.timestamp,
    )


@router.get("/current", response_model=PromptDetail)
async def get_current_prompt(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> PromptDetail:
    """Return the prompt for the user's current week in the program."""
    week = await _get_user_week(session, current_user, user_tz)
    resolved = resolve_week_prompt(week)
    if resolved is None:
        raise not_found("prompt")

    existing = await _find_response(session, current_user, week)
    return _answered_detail(existing) if existing else _unanswered_detail(resolved)


@dataclass
class _HistoryFilters:
    """Query parameters for prompt history pagination; ``offset`` is capped by curriculum length."""

    limit: int = Query(default=50, ge=1, le=200)
    offset: int = Query(default=0, ge=0, le=TOTAL_WEEKS)
    include_total: bool = Query(default=True)


async def _maybe_total(
    session: AsyncSession,
    query: Select[tuple[PromptResponse]],
    *,
    include_total: bool,
) -> int | None:
    """Run the count subquery only when the caller opted in; ``None`` signals opt-out."""
    if not include_total:
        return None
    count_query = select(func.count()).select_from(query.subquery())
    return int((await session.execute(count_query)).scalar() or 0)


@router.get("/history", response_model=PromptListResponse)
async def list_prompt_history(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    filters: Annotated[_HistoryFilters, Depends()],
) -> PromptListResponse:
    """List all past prompts and responses for the user, paginated.

    With ``include_total=true`` (default) the count subquery runs and
    ``has_more`` is ``offset + limit < total``.  With
    ``include_total=false`` the response carries ``total=None`` and
    uses a peek pattern -- fetch ``limit + 1`` rows, return at most
    ``limit`` items, set ``has_more`` from whether the peek row
    materialised -- so cursor pagination stays accurate for mid-
    curriculum users without paying for ``COUNT(*)``.
    """
    query = (
        select(PromptResponse)
        .where(PromptResponse.user_id == current_user)
        .order_by(col(PromptResponse.week_number).desc())
    )
    total = await _maybe_total(session, query, include_total=filters.include_total)
    if total is not None:
        page_query = query.offset(filters.offset).limit(filters.limit)
        items = list((await session.execute(page_query)).scalars().all())
        has_more = page_has_more(filters.offset, filters.limit, total)
    else:
        peek_query = query.offset(filters.offset).limit(filters.limit + 1)
        rows = list((await session.execute(peek_query)).scalars().all())
        items = rows[: filters.limit]
        has_more = len(rows) > filters.limit
    return PromptListResponse(
        items=[_answered_detail(pr) for pr in items],
        total=total,
        has_more=has_more,
    )


@router.get("/stage/{stage_number}", response_model=StagePromptsResponse)
async def get_stage_prompts(
    stage_number: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> StagePromptsResponse:
    """Every prompt of one stage, in curriculum order, each with its cadence.

    Weeks and prompts are not 1:1 — a stage carries three to five prompts
    across three or six weeks — so this is the read path the week-scoped
    endpoints cannot express: the 25-curiosities list is a one-time build and
    the Wavelength check-in is a daily, and one undifferentiated question per
    week says neither.

    Gated on the stage's *first* week through the same
    :func:`_check_week_unlocked` the weekly endpoints use, so opening four
    prompts at once cannot leak a stage the user has not reached.  404
    precedes 403 so an unknown stage is never reported as merely locked.
    """
    stage = stage_prompts(stage_number)
    if stage is None:
        raise not_found("stage")
    await _check_week_unlocked(session, current_user, stage.first_week, user_tz)

    return StagePromptsResponse(
        stage=stage.stage,
        stage_name=stage.band,
        prompts=[
            StagePromptDetail(
                ordinal=prompt.ordinal,
                title=prompt.title,
                body=prompt.body,
                cadence=prompt.cadence,
            )
            for prompt in stage.prompts
        ],
    )


@router.get("/{week_number}", response_model=PromptDetail)
async def get_prompt_by_week(
    week_number: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> PromptDetail:
    """Get a specific week's prompt and the user's response (if any).

    Gated on the user's current week.  Without this check a fresh
    (week-1) user could enumerate ``/prompts/1`` … ``/prompts/36`` and
    lift every future question.  404 precedes 403 so unknown weeks
    (outside 1..``TOTAL_WEEKS``) don't get re-interpreted as "locked".
    """
    resolved = resolve_week_prompt(week_number)
    if resolved is None:
        raise not_found("prompt")
    await _check_week_unlocked(session, current_user, week_number, user_tz)

    existing = await _find_response(session, current_user, week_number)
    return _answered_detail(existing) if existing else _unanswered_detail(resolved)


def _resolve_entry_title(payload_title: str | None, resolved: WeekPrompt) -> str:
    """Resolve the journal title mirrored from a prompt submission.

    A non-blank user override is sanitized and used verbatim; a blank,
    whitespace-only, absent, or sanitized-to-empty override falls back to the
    default title of the prompt actually answered
    (:attr:`domain.weekly_prompts.WeekPrompt.default_title`), so a response to
    a stage's third prompt is titled for that prompt rather than for the one
    its week draws. An over-long title surfaces as a 422.
    """
    if payload_title and payload_title.strip():
        try:
            cleaned = sanitize_user_text(payload_title, max_len=JOURNAL_TITLE_MAX_LENGTH)
        except TextTooLongError as exc:
            raise unprocessable("title_too_long") from exc
        if cleaned:
            return cleaned
    return resolved.default_title


@router.post(
    "/{week_number}/respond",
    response_model=PromptDetail,
    status_code=status.HTTP_201_CREATED,
)
async def submit_prompt_response(
    week_number: int,
    payload: PromptSubmit,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> PromptDetail:
    """Submit a response to a weekly prompt. Prevents duplicate responses.

    Refuses ``week_number > user_week`` so a single POST cannot leapfrog
    the weekly pacing by driving ``max(week_number)`` up in one request.
    Paired with the ``count + 1``-based ``_get_user_week`` this makes
    the server-derived week a monotone function of *contiguous*
    completion, not the highest value the client has ever submitted.

    Duplicate submissions are caught exclusively by the
    ``uq_promptresponse_user_week`` constraint and surfaced as 409
    Conflict (BUG-PROMPT-004).  The earlier 400-on-pre-check / 409-on-race
    split exposed clients to two distinct status codes for what is
    semantically one condition; the constraint is the only observer that
    sees both rows in a TOCTOU race anyway, so we let it own the
    decision and the response code stays uniform.

    ``prompt_ordinal`` names which of the stage's prompts the response
    answers; omitted, it is the prompt the week itself draws, so clients
    written against the one-prompt-per-week contract are unaffected.  An
    ordinal the stage does not carry is a 404 — the same shape an unknown week
    already gets — rather than a silent wrap-around onto a different prompt.
    """
    resolved = resolve_week_prompt(week_number, payload.prompt_ordinal)
    if resolved is None:
        raise not_found("prompt")
    await _check_week_unlocked(session, current_user, week_number, user_tz)

    # Sanitize once at the boundary (BUG-PROMPT-003); both PromptResponse and
    # JournalEntry receive the cleaned text so the two rows agree byte-for-byte
    # and neither carries control / zero-width / bidi-override smuggling.
    # NFC normalization can in rare Unicode cases expand a string past the cap;
    # translate that into a 422 so the client sees a uniform length-violation
    # response shape rather than a 500.
    try:
        cleaned_response = sanitize_user_text(
            payload.response,
            max_len=PROMPT_RESPONSE_MAX_LENGTH,
        )
    except TextTooLongError as exc:
        raise unprocessable("response_too_long") from exc

    entry_title = _resolve_entry_title(payload.title, resolved)

    # The *resolved* ordinal is stored, not the one the payload sent: a
    # submission that named none still answered a specific prompt, and
    # recording which makes the row self-describing instead of dependent on a
    # rotation a later content sync could change.
    prompt_response = PromptResponse(
        week_number=week_number,
        prompt_ordinal=resolved.prompt.ordinal,
        question=resolved.question,
        response=cleaned_response,
        user_id=current_user,
    )
    session.add(prompt_response)

    # Mirror the response into the journal stream tagged as a weekly cadence
    # row so stage-scoped aggregates (filtered by STAGE_REFLECTION) do not
    # double-count it.
    journal_entry = JournalEntry(
        message=cleaned_response,
        title=entry_title,
        sender="user",
        user_id=current_user,
        tag=JournalTag.WEEKLY_PROMPT,
    )
    session.add(journal_entry)

    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise conflict("already_responded") from exc

    await session.refresh(prompt_response)

    logger.info(
        "prompt_response_submitted",
        extra={
            "user_id": current_user,
            "week_number": week_number,
            "prompt_ordinal": prompt_response.prompt_ordinal,
        },
    )

    return _answered_detail(prompt_response)
