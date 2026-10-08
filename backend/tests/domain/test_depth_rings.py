"""Tests for the depth-ring vocabulary in :mod:`domain.depth_preferences`.

A user's ``UserDepthPreferences`` row is projected onto a frozenset of
:class:`DepthRing` members so every gate (invitation generation and listing,
the contraction reflection) asks one question: "is this ring enabled?". The
read-only loader must never provision a row: it runs on polled GETs and on the
resonance happy path, where a provisioning commit would be a hidden write.
"""

from __future__ import annotations

import itertools

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.depth_preferences import (
    ALL_RINGS,
    DepthRing,
    enabled_rings,
    load_enabled_rings,
)
from models.user import User
from models.user_depth_preferences import UserDepthPreferences

_FLAG_FOR_RING = {
    DepthRing.HABITS: "enable_habits",
    DepthRing.PRACTICES: "enable_practices",
    DepthRing.COURSE: "enable_course",
    DepthRing.SANGHA: "enable_sangha",
}

_ALL_FLAG_COMBOS = list(itertools.product((True, False), repeat=len(_FLAG_FOR_RING)))


def test_ring_vocabulary_is_exactly_the_four_optional_rings() -> None:
    """The ring enum names exactly the four optional depths, with stable values."""
    assert {ring.value for ring in DepthRing} == {"habits", "practices", "course", "sangha"}
    assert frozenset(DepthRing) == ALL_RINGS


@pytest.mark.parametrize("flags", _ALL_FLAG_COMBOS)
def test_enabled_rings_maps_each_flag_exactly(flags: tuple[bool, bool, bool, bool]) -> None:
    """Every one of the 16 flag combinations projects onto exactly its enabled rings."""
    rings = list(_FLAG_FOR_RING)
    prefs = UserDepthPreferences(
        user_id=1, **{_FLAG_FOR_RING[ring]: flag for ring, flag in zip(rings, flags, strict=True)}
    )
    expected = frozenset(ring for ring, flag in zip(rings, flags, strict=True) if flag)

    assert enabled_rings(prefs) == expected


def test_enabled_rings_none_equals_default_model() -> None:
    """No stored row reads exactly like a freshly-defaulted row (today: all on)."""
    assert enabled_rings(None) == enabled_rings(UserDepthPreferences(user_id=1))


async def _make_user(session: AsyncSession, email: str) -> int:
    """Insert a bare user row and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user.id


async def _prefs_row_count(session: AsyncSession) -> int:
    """Count every stored depth-preferences row."""
    result = await session.execute(select(func.count()).select_from(UserDepthPreferences))
    return int(result.scalar_one())


@pytest.mark.asyncio
async def test_load_enabled_rings_never_provisions(db_session: AsyncSession) -> None:
    """With no stored row the loader reports the default rings and writes nothing."""
    user_id = await _make_user(db_session, "rings_noprov@example.com")

    rings = await load_enabled_rings(db_session, user_id)

    assert rings == enabled_rings(None)
    assert await _prefs_row_count(db_session) == 0


@pytest.mark.asyncio
async def test_load_enabled_rings_reads_stored_declines(db_session: AsyncSession) -> None:
    """A stored row with rings declined is read back exactly."""
    user_id = await _make_user(db_session, "rings_stored@example.com")
    db_session.add(UserDepthPreferences(user_id=user_id, enable_habits=False, enable_course=False))
    await db_session.commit()

    rings = await load_enabled_rings(db_session, user_id)

    assert rings == frozenset({DepthRing.PRACTICES, DepthRing.SANGHA})
