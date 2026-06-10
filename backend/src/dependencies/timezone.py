"""Per-request cached resolution of the caller's IANA timezone (issue #262).

PR #260 had every endpoint call ``services.users.get_user_timezone``
imperatively inside the handler body.  Each call is a cheap single-column
PK SELECT, but the pattern compounds when several dependencies in one
request need the zone.  FastAPI caches dependency results within a request
scope (``use_cache=True`` is the default), so routing every consumer
through :func:`current_user_timezone` guarantees at most one lookup per
request no matter how many handlers / sub-dependencies read it.

``routers/auth.py::refresh_token`` deliberately keeps its direct
``get_user_timezone`` call: this module imports
:func:`routers.auth.get_current_user`, so importing back into
``routers.auth`` would be circular — and that handler performs exactly one
lookup per request already.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from routers.auth import get_current_user
from services.users import get_user_timezone


async def current_user_timezone(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> str:
    """Resolve the authenticated caller's IANA timezone, once per request.

    Returns ``"UTC"`` for missing / null / empty stored values — the same
    fallback contract as :func:`services.users.get_user_timezone`, which
    this wraps.
    """
    return await get_user_timezone(session, user_id)
