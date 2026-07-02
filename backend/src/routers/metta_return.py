"""The Return arc lifecycle endpoints (/metta-return).

The Return is a declinable five-week Metta arc, offered only once Blue stage has
been passed (see :func:`domain.metta_return.is_return_eligible`). Accepting it
starts a guided arc the caller can pause, resume, or leave at any time with no
penalty. Every action is scoped to the caller resolved from the JWT — no
``user_id`` is ever accepted from the body or path, nor returned — and none of
the lifecycle actions mutate :class:`StageProgress`.

``GET`` is read-only: it reads (never provisions) stage progress to report
eligibility and projects the caller's active arc, if any. The write handlers
select the caller's active arc ``FOR UPDATE`` so concurrent lifecycle calls
serialize, and an arc the caller does not own is indistinguishable from a
missing one — both raise the same 404.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from domain.metta_return import (
    RETURN_SEQUENCE,
    active_return_week,
    current_offer_episode,
    is_return_complete,
    is_return_eligible,
    resumed_start,
)
from domain.stage_progress import get_user_progress
from errors import conflict, not_found
from models.metta_return_arc import MettaReturnArc
from models.metta_return_offer_dismissal import MettaReturnOfferDismissal
from routers.auth import get_current_user
from schemas.metta_return import (
    MettaReturnStateResponse,
    ReturnArcResponse,
    ReturnWeekResponse,
)

if TYPE_CHECKING:
    from models.stage_progress import StageProgress

router = APIRouter(prefix="/metta-return", tags=["metta-return"])


def _week_focus(week: int) -> str:
    """Return the focus string for a 1-based Return week."""
    return RETURN_SEQUENCE[week - 1].focus.value


def _to_arc_response(arc: MettaReturnArc, now: datetime) -> ReturnArcResponse:
    """Project an arc row onto its owner-key-free DTO with the current week."""
    week = active_return_week(arc.started_at, arc.paused_at, now)
    return ReturnArcResponse(
        started_at=arc.started_at,
        paused=arc.paused_at is not None,
        week=week,
        focus=_week_focus(week),
        complete=is_return_complete(arc.started_at, arc.paused_at, now),
    )


def _sequence_response() -> list[ReturnWeekResponse]:
    """Project the whole Return sequence onto its DTO list, in week order."""
    return [
        ReturnWeekResponse(
            week_number=week.week_number,
            focus=week.focus.value,
            title=week.title,
            framing=week.framing,
        )
        for week in RETURN_SEQUENCE
    ]


async def _active_arc(session: AsyncSession, user_id: int) -> MettaReturnArc | None:
    """Return the caller's active (``left_at IS NULL``) arc, or None — no row lock.

    Used by the read-only ``GET`` handler, which never writes: it must not take
    the exclusive ``FOR UPDATE`` lock the write handlers use, or concurrent GETs
    from one caller would serialize on that caller's arc row for no reason.
    Selecting by owner *and* active-ness means another user's arc is invisible
    here, mirroring :func:`_active_arc_for_update`.
    """
    result = await session.execute(
        select(MettaReturnArc).where(
            col(MettaReturnArc.user_id) == user_id,
            col(MettaReturnArc.left_at).is_(None),
        ),
    )
    return result.scalars().first()


async def _active_arc_for_update(session: AsyncSession, user_id: int) -> MettaReturnArc | None:
    """Return the caller's active (``left_at IS NULL``) arc under a row lock, or None.

    Selecting by owner *and* active-ness in one ``FOR UPDATE`` query means a
    caller can only ever lock their own arc: another user's arc is invisible
    here, so cross-user lifecycle calls fall through to the same 404 as a
    genuinely missing arc.
    """
    result = await session.execute(
        select(MettaReturnArc)
        .where(
            col(MettaReturnArc.user_id) == user_id,
            col(MettaReturnArc.left_at).is_(None),
        )
        .with_for_update()
    )
    return result.scalars().first()


async def _offer_dismissed(session: AsyncSession, user_id: int, episode: str | None) -> bool:
    """Return whether the caller has dismissed the offer for this episode; no row lock.

    A ``None`` episode (ineligible or no progress) can never have been dismissed.
    Otherwise this is a lock-free existence check, mirroring :func:`_active_arc`'s
    plain ``select`` so the read path never serializes on a row.
    """
    if episode is None:
        return False
    result = await session.execute(
        select(MettaReturnOfferDismissal).where(
            col(MettaReturnOfferDismissal.user_id) == user_id,
            col(MettaReturnOfferDismissal.episode_key) == episode,
        ),
    )
    return result.scalars().first() is not None


async def _record_dismissal(session: AsyncSession, user_id: int, episode: str) -> None:
    """Idempotently persist a dismissal for (user, episode), tolerating races.

    A pre-check skips a redundant insert when the episode is already dismissed. A
    truly concurrent double-insert trips the unique index, whose ``IntegrityError``
    is caught and treated as success, since the row now exists either way.
    """
    if await _offer_dismissed(session, user_id, episode):
        return
    session.add(
        MettaReturnOfferDismissal(
            user_id=user_id,
            episode_key=episode,
            dismissed_at=datetime.now(UTC),
        ),
    )
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()


def _build_state(
    progress: StageProgress | None,
    arc: MettaReturnArc | None,
    *,
    offer_dismissed: bool,
    now: datetime,
) -> MettaReturnStateResponse:
    """Project the caller's progress and arc onto the full Return state DTO."""
    return MettaReturnStateResponse(
        eligible=is_return_eligible(progress),
        weeks=_sequence_response(),
        arc=_to_arc_response(arc, now) if arc is not None else None,
        offer_dismissed=offer_dismissed,
    )


@router.get("", response_model=MettaReturnStateResponse)
async def get_state(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> MettaReturnStateResponse:
    """Return the caller's eligibility, week sequence, active arc, and offer state.

    Read-only: stage progress is fetched (never provisioned), so a brand-new
    user's row is not created as a side effect. ``arc`` is the caller's active
    arc projected to its current week, or ``None`` when there is none, and
    ``offer_dismissed`` reflects any dismissal of the current offer episode.
    """
    progress = await get_user_progress(session, user_id)
    arc = await _active_arc(session, user_id)
    dismissed = await _offer_dismissed(session, user_id, current_offer_episode(progress))
    now = datetime.now(UTC)
    return _build_state(progress, arc, offer_dismissed=dismissed, now=now)


@router.post("/arc", status_code=status.HTTP_201_CREATED, response_model=ReturnArcResponse)
async def start_arc(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ReturnArcResponse:
    """Start a Return arc for an eligible caller, landing on week 1 (focus self).

    Rejected with 409 when the caller has not passed Blue or already has an
    active arc, so a duplicate is never created. On success a fresh arc is
    inserted with ``started_at`` at the current UTC instant. Two truly
    concurrent starts both clear the pre-check (there is no row to lock yet), so
    the partial-unique active-arc index is the real guard: the loser's insert
    raises ``IntegrityError``, which is caught and collapsed to the same 409 the
    sequential path returns.
    """
    progress = await get_user_progress(session, user_id)
    if not is_return_eligible(progress):
        raise conflict("return_not_eligible")
    if await _active_arc_for_update(session, user_id) is not None:
        raise conflict("return_arc_already_active")
    now = datetime.now(UTC)
    arc = MettaReturnArc(user_id=user_id, started_at=now)
    session.add(arc)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise conflict("return_arc_already_active") from exc
    await session.refresh(arc)
    return _to_arc_response(arc, now)


@router.post("/arc/pause", response_model=ReturnArcResponse)
async def pause_arc(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ReturnArcResponse:
    """Pause the caller's active arc, freezing its reported week; idempotent.

    Raises 404 when the caller has no active arc. Pausing an already-paused arc
    is a 200 no-op that keeps the original pause instant, so the frozen week
    does not drift.
    """
    arc = await _active_arc_for_update(session, user_id)
    if arc is None:
        raise not_found("return_arc")
    now = datetime.now(UTC)
    if arc.paused_at is None:
        arc.paused_at = now
        session.add(arc)
        await session.commit()
        await session.refresh(arc)
    return _to_arc_response(arc, now)


@router.post("/arc/resume", response_model=ReturnArcResponse)
async def resume_arc(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ReturnArcResponse:
    """Resume the caller's paused arc so its week advances again; idempotent.

    Raises 404 when the caller has no active arc. Resuming shifts ``started_at``
    forward by the paused duration so no elapsed weeks are lost, then clears the
    pause. Resuming an arc that is not paused is a 200 no-op.
    """
    arc = await _active_arc_for_update(session, user_id)
    if arc is None:
        raise not_found("return_arc")
    now = datetime.now(UTC)
    if arc.paused_at is not None:
        arc.started_at = resumed_start(arc.started_at, arc.paused_at, now)
        arc.paused_at = None
        session.add(arc)
        await session.commit()
        await session.refresh(arc)
    return _to_arc_response(arc, now)


@router.post("/arc/leave", response_model=ReturnArcResponse)
async def leave_arc(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ReturnArcResponse:
    """Leave the caller's active arc, returning its final projected state.

    Raises 404 when the caller has no active arc. Setting ``left_at`` frees the
    partial-unique slot, so the arc no longer counts as active and a fresh arc
    can be started afterward.
    """
    arc = await _active_arc_for_update(session, user_id)
    if arc is None:
        raise not_found("return_arc")
    now = datetime.now(UTC)
    arc.left_at = now
    session.add(arc)
    await session.commit()
    await session.refresh(arc)
    return _to_arc_response(arc, now)


@router.post("/offer/dismiss", response_model=MettaReturnStateResponse)
async def dismiss_offer(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> MettaReturnStateResponse:
    """Dismiss the Return offer for the caller's current episode; idempotent.

    Raises 409 when the caller is not eligible, since there is no offer to
    dismiss. Stage progress is read (never provisioned) and no arc is opened.
    A repeat dismiss of the same episode collapses to the same success backed by
    a single row, and any stage or cycle advance opens a fresh episode whose
    offer surfaces again.
    """
    progress = await get_user_progress(session, user_id)
    episode = current_offer_episode(progress)
    if episode is None:
        raise conflict("return_not_eligible")
    await _record_dismissal(session, user_id, episode)
    # ``_record_dismissal`` may roll back on a concurrent-insert IntegrityError,
    # which expires every ORM instance (including ``progress``). Re-materialize it
    # so the response projection never touches an expired attribute.
    progress = await get_user_progress(session, user_id)
    arc = await _active_arc(session, user_id)
    now = datetime.now(UTC)
    return _build_state(progress, arc, offer_dismissed=True, now=now)
