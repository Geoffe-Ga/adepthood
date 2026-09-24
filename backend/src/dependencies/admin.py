"""The administrator request context: the session and the acting admin, together.

Moved out of ``routers/admin.py`` when a second admin router needed it, so
neither router imports a private name from the other. Every route that takes
an :class:`AdminContext` is gated by :func:`dependencies.auth.require_admin`
through :func:`admin_context` -- the gate is inside the dependency, so a route
cannot hold the context without having passed it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from dependencies.auth import require_admin
from models.user import User


@dataclass(frozen=True)
class AdminContext:
    """The session and the acting admin, which always travel together.

    Bundled into one dependency so rate-limited admin routes stay under ruff's
    ``PLR0913`` argument cap without dropping either the audit actor or the
    rate-limiter's ``request`` -- the same restructure-don't-suppress move as
    :class:`services.wallet._AuditEntry` and the ``domain.streaks`` kwarg
    bundle.
    """

    session: AsyncSession
    admin: User


async def admin_context(
    session: Annotated[AsyncSession, Depends(get_session)],
    admin: Annotated[User, Depends(require_admin)],
) -> AdminContext:
    """Resolve the admin gate and the session as a single dependency."""
    return AdminContext(session=session, admin=admin)
