"""Invitation-signal endpoints: list pending offers and decline them.

An ``InvitationSignal`` records a resonant moment the system observed to
*offer* a deeper self-chosen ring — never to gate or pressure. This router
lets the caller read their live offers and decline any of them. The caller is
resolved from their JWT, so only that user's own rows are ever read or mutated:
no ``user_id`` is accepted from the body or path, and it is never returned.

``GET`` generates before it lists — it calls the idempotent generation pass
(dismissed rows block re-creation) and then returns the caller's pending rows
(``dismissed_at IS NULL``), so the endpoint is safe to poll on every load.
Dismiss is idempotent: declining an already-declined row is a 200 no-op. A
dismiss for a row the caller does not own — whether it belongs to another user
or does not exist at all — returns the same 404 so the endpoint never confirms
an invitation's existence to a non-owner.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.timezone import current_user_timezone
from errors import not_found
from models.invitation_signal import InvitationSignal
from routers.auth import get_current_user
from schemas.invitations import InvitationResponse
from services.invitations import generate_invitation_signals

router = APIRouter(prefix="/invitations", tags=["invitations"])


def _to_response(signal: InvitationSignal) -> InvitationResponse:
    """Project a stored row onto the enumeration-safe response DTO (no ``user_id``)."""
    signal_id = signal.id
    if signal_id is None:  # pragma: no cover - persisted rows always carry a PK
        raise not_found("invitation")
    return InvitationResponse(
        id=signal_id,
        target_type=signal.target_type,
        target_id=signal.target_id,
        kind=signal.kind,
        created_at=signal.created_at,
    )


@router.get("", response_model=list[InvitationResponse])
async def list_invitations(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_timezone: Annotated[str, Depends(current_user_timezone)],
) -> list[InvitationResponse]:
    """Generate newly-warranted invitations, then return the caller's pending ones.

    The generation pass runs first and is idempotent — it inserts only
    coordinates that have no prior row (dismissed rows included), so polling
    this endpoint never accumulates duplicates. The listing that follows
    returns only the caller's rows with ``dismissed_at IS NULL``, ordered by
    ``created_at``; declined and other users' invitations are excluded.
    """
    await generate_invitation_signals(session, user_id, user_timezone)
    result = await session.execute(
        select(InvitationSignal)
        .where(
            col(InvitationSignal.user_id) == user_id,
            col(InvitationSignal.dismissed_at).is_(None),
        )
        .order_by(col(InvitationSignal.created_at))
    )
    return [_to_response(row) for row in result.scalars().all()]


@router.post("/{invitation_id}/dismiss", response_model=InvitationResponse)
async def dismiss_invitation(
    invitation_id: int,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> InvitationResponse:
    """Decline one of the caller's invitations, idempotently.

    The row is selected by ``id`` *and* owner in a single ``FOR UPDATE`` query,
    never fetched-then-compared: a row the caller does not own is
    indistinguishable from a missing one and both raise the same 404
    (``invitation_not_found``), so existence is never confirmed to a non-owner.
    An already-dismissed row is returned unchanged (200 no-op); otherwise
    ``dismissed_at`` is set to the current UTC instant.
    """
    result = await session.execute(
        select(InvitationSignal)
        .where(
            col(InvitationSignal.id) == invitation_id,
            col(InvitationSignal.user_id) == user_id,
        )
        .with_for_update()
    )
    signal = result.scalars().first()
    if signal is None:
        raise not_found("invitation")
    if signal.dismissed_at is None:
        signal.dismissed_at = datetime.now(UTC)
        session.add(signal)
        await session.commit()
        await session.refresh(signal)
    return _to_response(signal)
