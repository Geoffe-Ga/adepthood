"""User-row helpers — DB-aware lookups against the ``user`` table.

Lives in ``services/`` so ``domain/`` modules can stay model-agnostic
(no import of :class:`models.user.User`).  Putting these helpers in
``domain.dates`` would force an in-function ``from models.user import
User`` to break the otherwise-circular import — keeping the DB lookups
here instead lets every import sit at module top-level.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.user import DEFAULT_USER_TIMEZONE, User


async def get_user_timezone(session: AsyncSession, user_id: int) -> str:
    """Return the user's IANA timezone string, or ``"UTC"`` as fallback.

    Routers call this once per request to resolve the timezone the
    :mod:`domain.dates` helpers consume.  Reading only the single
    ``timezone`` column rather than the full :class:`User` row keeps
    the extra query cheap; daily-completion / streak endpoints fire
    1-2 times per user per day so caching beyond request scope is not
    yet justified.

    Returns ``"UTC"`` when:

    * the user row is missing (deleted-mid-request — the caller will
      surface the underlying 401/404 separately),
    * the column is null (legacy row, schema migration not yet run on
      this DB),
    * the column is empty (default-not-applied edge case).
    """
    result = await session.execute(select(User.timezone).where(User.id == user_id))
    tz = result.scalar_one_or_none()
    return tz or DEFAULT_USER_TIMEZONE
