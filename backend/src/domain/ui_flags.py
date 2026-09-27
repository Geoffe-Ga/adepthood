"""Domain logic for provisioning, reading and updating per-user UI flags."""

from __future__ import annotations

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select, update

from dependencies.ownership import resolve_owned_habit
from models.user_ui_flags import UserUiFlags
from schemas.ui_flags import UiFlagsUpdate

# The one field of :class:`UiFlagsUpdate` that names another row, and so the
# one whose value must be authorised before anything is written.
_WRITING_HABIT_FIELD = "writing_session_habit_id"


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


async def apply_ui_flags_update(
    session: AsyncSession, flags: UserUiFlags, update_body: UiFlagsUpdate, user_id: int
) -> None:
    """Apply the fields the caller set onto ``flags``, authorising a habit link first.

    Ownership is decided *before* any field is assigned, so a refused link
    (404 missing / 403 another user's habit) leaves the whole row untouched --
    a boolean sent in the same body is not applied either. An explicit ``null``
    link needs no authorisation: clearing your own link names no other row.
    The caller commits.
    """
    changes = update_body.model_dump(exclude_unset=True)
    habit_id = changes.get(_WRITING_HABIT_FIELD)
    if habit_id is not None:
        await resolve_owned_habit(session, habit_id, user_id)
    for field, value in changes.items():
        setattr(flags, field, value)
    session.add(flags)


async def clear_writing_habit_links(session: AsyncSession, habit_id: int) -> None:
    """Unlink every writing timer pointing at ``habit_id``, ahead of deleting it.

    The column's ``ON DELETE SET NULL`` is the backstop; this makes the rule hold
    wherever foreign keys are not enforced (SQLite without the pragma) and keeps
    it visible at the one place a habit is deleted. The caller commits.
    """
    await session.execute(
        update(UserUiFlags)
        .where(col(UserUiFlags.writing_session_habit_id) == habit_id)
        .values(writing_session_habit_id=None)
    )
