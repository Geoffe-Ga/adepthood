"""UI-flag endpoints for per-user one-time interface state.

A user records lightweight interface flags — whether the welcome flow has been
seen and whether the energy-scaffolding surface has been archived — and the
habit a finished writing session checks off. The caller is resolved from their
JWT, so only that user's own row is read or mutated: no ``user_id`` is ever
accepted from the body or path, and a linked habit id must be the caller's own.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from domain.ui_flags import apply_ui_flags_update, ensure_ui_flags
from error_responses import build_router
from models.user_ui_flags import UserUiFlags
from routers.auth import get_current_user
from schemas.ui_flags import UiFlagsResponse, UiFlagsUpdate

router = build_router(prefix="/ui-flags", tags=["ui-flags"])


def _to_response(flags: UserUiFlags) -> UiFlagsResponse:
    """Project a stored row onto the response DTO (never ``user_id``)."""
    return UiFlagsResponse(
        has_seen_welcome=flags.has_seen_welcome,
        energy_scaffolding_archived=flags.energy_scaffolding_archived,
        writing_session_habit_id=flags.writing_session_habit_id,
    )


@router.get("", response_model=UiFlagsResponse)
async def get_ui_flags(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> UiFlagsResponse:
    """Return the caller's UI flags, provisioning all-false on first access.

    Idempotent: repeated calls return the same state and never create a
    duplicate row.
    """
    flags = await ensure_ui_flags(session, user_id)
    return _to_response(flags)


@router.patch("", response_model=UiFlagsResponse)
async def update_ui_flags(
    payload: UiFlagsUpdate,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> UiFlagsResponse:
    """Partially update the caller's UI flags and return the full new state.

    Only the fields present in the request are applied; unspecified flags keep
    their stored value. An empty body is rejected upstream (422) by
    :class:`~schemas.ui_flags.UiFlagsUpdate`. A ``writing_session_habit_id``
    naming a missing habit is 404 and another user's habit is 403, and either
    refusal writes nothing at all; an explicit ``null`` clears the link.
    """
    flags = await ensure_ui_flags(session, user_id)
    await apply_ui_flags_update(session, flags, payload, user_id)
    await session.commit()
    await session.refresh(flags)
    return _to_response(flags)
