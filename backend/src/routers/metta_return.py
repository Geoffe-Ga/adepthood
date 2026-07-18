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
from models.habit import Habit
from models.metta_return_arc import MettaReturnArc
from models.metta_return_habit_release import MettaReturnHabitRelease
from models.metta_return_offer_dismissal import MettaReturnOfferDismissal
from routers.auth import get_current_user
from schemas.metta_return import (
    MettaReturnStateResponse,
    ReleasedHabitResponse,
    ReleaseHabitsRequest,
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


async def _released_habits(session: AsyncSession, arc_id: int) -> list[ReleasedHabitResponse]:
    """Project an arc's released habits, joined to their habit rows, in a stable order.

    A single join query (never N+1) fetches every release row for the arc with
    its habit's name, icon, and live ``revealed`` flag, ordered by ``released_at``
    then ``habit_id`` so the list is deterministic. ``recommitted`` is derived
    from *both* the release row and the habit itself — ``recommitted_at`` being
    stamped OR the habit currently being ``revealed`` — because ``Habit.revealed``
    is also directly writable through ``PUT /habits/{id}`` (the Habit Settings
    toggle / bulk-reveal flow), so a habit re-enabled outside the Return must not
    keep reading as resting. This keeps ``recommitted`` a faithful projection of
    the single source of truth (``Habit.revealed``) rather than drifting from it.
    No owner key or surrogate row id is projected.
    """
    result = await session.execute(
        select(MettaReturnHabitRelease, Habit)
        .join(Habit, col(Habit.id) == col(MettaReturnHabitRelease.habit_id))
        .where(col(MettaReturnHabitRelease.arc_id) == arc_id)
        .order_by(
            col(MettaReturnHabitRelease.released_at),
            col(MettaReturnHabitRelease.habit_id),
        ),
    )
    return [
        ReleasedHabitResponse(
            habit_id=release.habit_id,
            name=habit.name,
            icon=habit.icon,
            recommitted=release.recommitted_at is not None or habit.revealed,
        )
        for release, habit in result.all()
    ]


async def _releasable_habits(
    session: AsyncSession,
    user_id: int,
    habit_ids: list[int],
) -> list[Habit]:
    """Return the caller's currently-revealed habits among ``habit_ids``.

    One query selects only habits the caller owns that are still unlocked, so an
    unowned, unknown, or already-locked id is dropped here and skipped silently —
    an unowned id is thus indistinguishable from a nonexistent one.
    """
    result = await session.execute(
        select(Habit).where(
            col(Habit.id).in_(habit_ids),
            col(Habit.user_id) == user_id,
            col(Habit.revealed).is_(True),
        ),
    )
    return list(result.scalars().all())


async def _existing_releases_by_habit(
    session: AsyncSession,
    arc_id: int,
    habit_ids: list[int],
) -> dict[int, MettaReturnHabitRelease]:
    """Return this arc's release rows for ``habit_ids``, keyed by habit id.

    Used to keep release idempotent and consistent: a habit already recorded for
    the arc is not inserted a second time (the ``(arc_id, habit_id)`` unique
    constraint is never provoked on the repeat-release path), and a row left
    re-committed is re-armed rather than duplicated when its habit is released
    again.
    """
    if not habit_ids:
        return {}
    result = await session.execute(
        select(MettaReturnHabitRelease).where(
            col(MettaReturnHabitRelease.arc_id) == arc_id,
            col(MettaReturnHabitRelease.habit_id).in_(habit_ids),
        ),
    )
    return {row.habit_id: row for row in result.scalars().all()}


async def _live_releases(
    session: AsyncSession,
    arc_id: int,
    habit_ids: list[int],
) -> list[tuple[MettaReturnHabitRelease, Habit]]:
    """Return this arc's not-yet-recommitted releases among ``habit_ids``, with habits.

    One join query pairs each still-live release (``recommitted_at IS NULL``)
    with its habit, so an id never released in this arc is absent and thus
    ignored, and no habit is loaded in a second round trip.
    """
    result = await session.execute(
        select(MettaReturnHabitRelease, Habit)
        .join(Habit, col(Habit.id) == col(MettaReturnHabitRelease.habit_id))
        .where(
            col(MettaReturnHabitRelease.arc_id) == arc_id,
            col(MettaReturnHabitRelease.recommitted_at).is_(None),
            col(MettaReturnHabitRelease.habit_id).in_(habit_ids),
        ),
    )
    return [(release, habit) for release, habit in result.all()]


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
    released: list[ReleasedHabitResponse],
    now: datetime,
) -> MettaReturnStateResponse:
    """Project the caller's progress and arc onto the full Return state DTO."""
    return MettaReturnStateResponse(
        eligible=is_return_eligible(progress),
        weeks=_sequence_response(),
        arc=_to_arc_response(arc, now) if arc is not None else None,
        offer_dismissed=offer_dismissed,
        released_habits=released,
    )


async def _released_for_arc(
    session: AsyncSession,
    arc: MettaReturnArc | None,
) -> list[ReleasedHabitResponse]:
    """Project the arc's released habits, or an empty list when there is no arc."""
    if arc is None or arc.id is None:
        return []
    return await _released_habits(session, arc.id)


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
    released = await _released_for_arc(session, arc)
    now = datetime.now(UTC)
    return _build_state(progress, arc, offer_dismissed=dismissed, released=released, now=now)


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


def _apply_release(
    session: AsyncSession,
    user_id: int,
    arc_id: int,
    habit: Habit,
    existing: dict[int, MettaReturnHabitRelease],
) -> None:
    """Pause one habit and record or re-arm its release row for this arc.

    A habit with no row for this arc gets a fresh one; a habit whose prior row
    was re-committed is re-armed (its ``recommitted_at`` cleared) so a released
    habit is never projected as re-committed; a still-live row is left untouched.
    """
    habit.revealed = False
    session.add(habit)
    row = existing.get(habit.id) if habit.id is not None else None
    if row is None:
        session.add(
            MettaReturnHabitRelease(
                user_id=user_id,
                arc_id=arc_id,
                habit_id=habit.id,
                released_at=datetime.now(UTC),
            ),
        )
    elif row.recommitted_at is not None:
        row.recommitted_at = None
        session.add(row)


async def _record_releases(
    session: AsyncSession,
    user_id: int,
    arc_id: int,
    habits: list[Habit],
) -> None:
    """Pause each releasable habit and record (or re-arm) its release row.

    Every releasable habit is flipped to ``revealed=False`` (a soft pause that
    keeps its goals and completions), so repeat releases stay idempotent while a
    re-committed habit released again is re-armed rather than duplicated.
    """
    existing = await _existing_releases_by_habit(
        session,
        arc_id,
        [habit.id for habit in habits if habit.id is not None],
    )
    for habit in habits:
        _apply_release(session, user_id, arc_id, habit, existing)


@router.post("/arc/release", response_model=list[ReleasedHabitResponse])
async def release_habits(
    request: ReleaseHabitsRequest,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[ReleasedHabitResponse]:
    """Release a batch of the caller's habits within their active Return arc.

    Raises 404 when the caller has no active arc. Each named habit that the
    caller owns and that is still unlocked is softly paused (``revealed`` flips
    to False, preserving its goals and completions) and recorded as released for
    the arc; ids that are unowned, unknown, or already locked are skipped
    silently. Returns the arc's full released list.

    The arc is locked ``FOR UPDATE`` (:func:`_active_arc_for_update`) so two
    releases for the same arc fully serialize: the second waits on the arc row,
    and by the time it runs its ``_existing_releases_by_habit`` pre-check already
    sees the first's committed rows, so it never re-inserts. The
    ``(arc_id, habit_id)`` unique constraint is therefore never provoked here,
    and no ``IntegrityError`` catch is needed — one (which would abort the whole
    transaction, not a single item) would be dead code that misleadingly implies
    per-item recovery.
    """
    arc = await _active_arc_for_update(session, user_id)
    if arc is None or arc.id is None:
        raise not_found("return_arc")
    arc_id = arc.id
    habits = await _releasable_habits(session, user_id, request.habit_ids)
    await _record_releases(session, user_id, arc_id, habits)
    await session.commit()
    return await _released_habits(session, arc_id)


@router.post("/arc/recommit", response_model=list[ReleasedHabitResponse])
async def recommit_habits(
    request: ReleaseHabitsRequest,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[ReleasedHabitResponse]:
    """Re-commit a batch of the caller's habits released in their active arc.

    Raises 404 when the caller has no active arc. Each named habit that was
    released in this arc and not yet re-committed is unlocked (``revealed`` flips
    back to True) and stamped with ``recommitted_at``; an id never released in
    this arc is ignored, and re-committing an already-recommitted habit is a
    no-op, so the call is idempotent. Works while the arc is time-complete but
    not yet left. Returns the arc's full released list.
    """
    arc = await _active_arc_for_update(session, user_id)
    if arc is None or arc.id is None:
        raise not_found("return_arc")
    arc_id = arc.id
    now = datetime.now(UTC)
    for release, habit in await _live_releases(session, arc_id, request.habit_ids):
        release.recommitted_at = now
        habit.revealed = True
        session.add(release)
        session.add(habit)
    await session.commit()
    return await _released_habits(session, arc_id)


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
    released = await _released_for_arc(session, arc)
    now = datetime.now(UTC)
    return _build_state(progress, arc, offer_dismissed=True, released=released, now=now)
