"""UI-flag endpoints for per-user one-time interface state.

A user records lightweight interface flags — whether the welcome flow has been
seen and whether the energy-scaffolding surface has been archived. The caller
is resolved from their JWT, so only that user's own row is read or mutated: no
``user_id`` is ever accepted from the body or path.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from domain.ui_flags import ensure_ui_flags
from models.user_ui_flags import UserUiFlags
from routers.auth import get_current_user
from schemas.ui_flags import UiFlagsResponse, UiFlagsUpdate

router = APIRouter(prefix="/ui-flags", tags=["ui-flags"])


def _to_response(flags: UserUiFlags) -> UiFlagsResponse:
    """Project a stored row onto the two-boolean response DTO."""
    return UiFlagsResponse(
        has_seen_welcome=flags.has_seen_welcome,
        energy_scaffolding_archived=flags.energy_scaffolding_archived,
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
    :class:`~schemas.ui_flags.UiFlagsUpdate`.
    """
    flags = await ensure_ui_flags(session, user_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(flags, field, value)
    session.add(flags)
    await session.commit()
    await session.refresh(flags)
    return _to_response(flags)
