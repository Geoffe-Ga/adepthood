"""Depth-preference endpoints for the optional program rings.

A user records which self-chosen depths — habit scaffolding, the practice
ramp, the course reading, and the Digital Sangha — they have enabled. Nothing
is gated; these toggles simply let the user quiet rings they have not chosen.
The caller is resolved from their JWT, so only that user's own row is read or
mutated: no ``user_id`` is ever accepted from the body or path.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from domain.depth_preferences import ensure_depth_preferences
from models.user_depth_preferences import UserDepthPreferences
from routers.auth import get_current_user
from schemas.depth_preferences import DepthPreferencesResponse, DepthPreferencesUpdate

router = APIRouter(prefix="/depth-preferences", tags=["depth-preferences"])


def _to_response(preferences: UserDepthPreferences) -> DepthPreferencesResponse:
    """Project a stored row onto the four-boolean response DTO."""
    return DepthPreferencesResponse(
        enable_habits=preferences.enable_habits,
        enable_practices=preferences.enable_practices,
        enable_course=preferences.enable_course,
        enable_sangha=preferences.enable_sangha,
    )


@router.get("", response_model=DepthPreferencesResponse)
async def get_depth_preferences(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> DepthPreferencesResponse:
    """Return the caller's depth preferences, provisioning all-true on first access.

    Idempotent: repeated calls return the same state and never create a
    duplicate row.
    """
    preferences = await ensure_depth_preferences(session, user_id)
    return _to_response(preferences)


@router.patch("", response_model=DepthPreferencesResponse)
async def update_depth_preferences(
    payload: DepthPreferencesUpdate,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> DepthPreferencesResponse:
    """Partially update the caller's ring toggles and return the full new state.

    Only the fields present in the request are applied; unspecified rings keep
    their stored value. An empty body is rejected upstream (422) by
    :class:`~schemas.depth_preferences.DepthPreferencesUpdate`.
    """
    preferences = await ensure_depth_preferences(session, user_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(preferences, field, value)
    session.add(preferences)
    await session.commit()
    await session.refresh(preferences)
    return _to_response(preferences)
