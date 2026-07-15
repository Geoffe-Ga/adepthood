"""Domain logic for provisioning and reading per-user UI flags."""

from __future__ import annotations

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.user_ui_flags import UserUiFlags


async def _get_ui_flags(session: AsyncSession, user_id: int) -> UserUiFlags | None:
    """Fetch the user's :class:`UserUiFlags` row, or ``None``."""
    result = await session.execute(select(UserUiFlags).where(col(UserUiFlags.user_id) == user_id))
    return result.scalars().first()


async def ensure_ui_flags(session: AsyncSession, user_id: int) -> UserUiFlags:
    """Return the user's UI flags, provisioning an all-false row on first access.

    Commits the new row before returning: a concurrent caller that loses the
    SAVEPOINT race must re-read the winner's committed row, and ``get_session``
    does not auto-commit. Because ``user_id`` is unique, a racing auto-provision
    hits an ``IntegrityError`` and re-reads the winner's row. Mirrors
    ``ensure_depth_preferences`` in ``depth_preferences.py``.
    """
    flags = await _get_ui_flags(session, user_id)
    if flags is not None:
        return flags
    flags = UserUiFlags(user_id=user_id)
    try:
        async with session.begin_nested():
            session.add(flags)
        await session.commit()
        await session.refresh(flags)
    except IntegrityError as exc:
        existing = await _get_ui_flags(session, user_id)
        if existing is None:
            msg = "UserUiFlags creation lost the race but the winner's row is missing"
            raise RuntimeError(msg) from exc
        return existing
    return flags
