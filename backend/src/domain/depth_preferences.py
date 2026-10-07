"""Domain logic for provisioning and reading user depth preferences.

Besides provisioning, this module owns the *ring vocabulary*: a stored
``UserDepthPreferences`` row is projected onto a frozenset of
:class:`DepthRing` members, so every server-side gate that must honour a
declined depth (invitation generation and listing, the contraction reflection)
asks the same question — "is this ring enabled?" — of the same value.
"""

from __future__ import annotations

import enum
from typing import Final

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.user_depth_preferences import UserDepthPreferences


class DepthRing(enum.StrEnum):
    """One of the four optional, self-chosen depths a user may decline."""

    HABITS = "habits"
    PRACTICES = "practices"
    COURSE = "course"
    SANGHA = "sangha"


ALL_RINGS: Final[frozenset[DepthRing]] = frozenset(DepthRing)


def enabled_rings(preferences: UserDepthPreferences | None) -> frozenset[DepthRing]:
    """Project a preferences row onto the set of rings the user has left enabled.

    ``None`` (no row stored yet) reads exactly like a freshly defaulted row, so
    an unprovisioned user is treated the same as one who has never touched the
    toggles.
    """
    effective = preferences if preferences is not None else UserDepthPreferences(user_id=0)
    flags = {
        DepthRing.HABITS: effective.enable_habits,
        DepthRing.PRACTICES: effective.enable_practices,
        DepthRing.COURSE: effective.enable_course,
        DepthRing.SANGHA: effective.enable_sangha,
    }
    return frozenset(ring for ring, enabled in flags.items() if enabled)


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


async def load_enabled_rings(session: AsyncSession, user_id: int) -> frozenset[DepthRing]:
    """Read the caller's enabled rings without provisioning or committing.

    Safe on polled GETs and the resonance happy path: unlike
    :func:`ensure_depth_preferences` it never inserts a row, so reading a
    preference is never a hidden write.
    """
    return enabled_rings(await _get_depth_preferences(session, user_id))
