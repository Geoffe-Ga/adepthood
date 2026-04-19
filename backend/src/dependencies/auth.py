"""Shared auth dependencies — resolve JWT user_id to full User models and gate admin routes.

The JWT-decoding dependency (:func:`routers.auth.get_current_user`) returns an
``int`` user-id so non-admin routes can avoid a database round-trip.  Admin
gating requires the full :class:`User` row (to read ``is_admin``), so we layer
a thin loader on top and expose :func:`require_admin` as the single source of
truth for the admin boundary.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from errors import forbidden
from models.user import User
from routers.auth import get_current_user


async def get_current_user_model(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> User:
    """Resolve the JWT user-id to the full :class:`User` row.

    Raises 403 ``user_not_found`` when the decoded user-id has no matching
    row — the JWT is authentic but refers to a deleted account, so the caller
    has no authority to act on anyone's behalf.
    """
    user = await session.get(User, user_id)
    if user is None:
        raise forbidden("user_not_found")
    return user


async def require_admin(
    current_user: Annotated[User, Depends(get_current_user_model)],
) -> User:
    """FastAPI dependency: allow only authenticated users with ``is_admin=True``.

    Layered on top of :func:`get_current_user`, so an unauthenticated request
    fails first with 401 (missing/expired/invalid JWT) and only authenticated
    non-admins reach this check and receive 403.  Reuse this dependency for
    every admin-only route — do not inline the ``is_admin`` check.
    """
    if not current_user.is_admin:
        raise forbidden("admin_required")
    return current_user
