"""Domain logic for provisioning and reading user depth preferences."""

from __future__ import annotations

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.user_depth_preferences import UserDepthPreferences


async def _get_depth_preferences(
    session: AsyncSession, user_id: int
) -> UserDepthPreferences | None:
    """Fetch the user's :class:`UserDepthPreferences` row, or ``None``."""
    result = await session.execute(
        select(UserDepthPreferences).where(col(UserDepthPreferences.user_id) == user_id)
    )
    return result.scalars().first()


async def ensure_depth_preferences(session: AsyncSession, user_id: int) -> UserDepthPreferences:
    """Return the user's depth preferences, provisioning an all-true row on first access.

    Commits the new row before returning: a concurrent caller that loses the
    SAVEPOINT race must re-read the winner's committed row, and ``get_session``
    does not auto-commit. Because ``user_id`` is unique, a racing auto-provision
    hits an ``IntegrityError`` and re-reads the winner's row. Mirrors
    ``ensure_user_progress`` in ``stage_progress.py``.
    """
    preferences = await _get_depth_preferences(session, user_id)
    if preferences is not None:
        return preferences
    preferences = UserDepthPreferences(user_id=user_id)
    try:
        async with session.begin_nested():
            session.add(preferences)
        await session.commit()
        await session.refresh(preferences)
    except IntegrityError as exc:
        existing = await _get_depth_preferences(session, user_id)
        if existing is None:
            msg = "UserDepthPreferences creation lost the race but the winner's row is missing"
            raise RuntimeError(msg) from exc
        return existing
    return preferences
