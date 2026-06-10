"""User profile endpoints.

Currently exposes a single ``PUT /users/me/timezone`` route so a user can
correct the IANA timezone stored at signup (issue #261) — needed when they
travel, immigrate, or signed up on a device whose clock / zone was wrong.
Without it, streak and daily-completion math would use the original zone
forever, re-introducing the off-by-one boundary bug PR #260 closed.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from dependencies.auth import get_current_user_model
from models.user import User
from schemas.timezone import TimezoneRead, TimezoneUpdate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["users"])


@router.put("/me/timezone", response_model=TimezoneRead)
async def update_my_timezone(
    payload: TimezoneUpdate,
    current_user: Annotated[User, Depends(get_current_user_model)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TimezoneRead:
    """Update the authenticated caller's IANA timezone.

    Validation mirrors signup (see :class:`~schemas.timezone.TimezoneUpdate`):
    an unknown or oversized name is rejected with 422 and blank input coerces
    to ``"UTC"``.  The dependency resolves the caller from their JWT, so only
    that user's own row is ever mutated.
    """
    previous = current_user.timezone
    current_user.timezone = payload.timezone
    session.add(current_user)
    await session.commit()
    logger.info(
        "timezone_changed",
        extra={
            "user_id": current_user.id,
            "old_timezone": previous,
            "new_timezone": payload.timezone,
        },
    )
    return TimezoneRead(timezone=payload.timezone)
