"""Data-layer tests for chord journaling (primary_aspect / secondary_aspect).

Covers:
- Persistence with no aspects (both columns None).
- primary + secondary round-trip.
- Out-of-range values raise IntegrityError (DB CHECK).
- Chord-shape violations (secondary without primary, secondary == primary)
  raise IntegrityError.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from models.journal_entry import JournalEntry
from models.user import User


async def _user(session: AsyncSession, email: str = "chord@example.com") -> int:
    """Persist a minimal user and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    return user.id


def _entry(user_id: int, **kwargs: object) -> JournalEntry:
    """Build a JournalEntry with the given overrides (chord fields optional)."""
    base: dict[str, object] = {
        "sender": "user",
        "user_id": user_id,
        "message": "A tagged reflection.",
    }
    base.update(kwargs)
    return JournalEntry(**base)


@pytest.mark.asyncio
async def test_entry_with_no_aspects_persists_both_none(db_session: AsyncSession) -> None:
    """An entry with neither aspect set persists with both columns None."""
    user_id = await _user(db_session)
    db_session.add(_entry(user_id))
    await db_session.commit()

    row = (await db_session.execute(select(JournalEntry))).scalar_one()
    assert row.primary_aspect is None
    assert row.secondary_aspect is None


@pytest.mark.asyncio
async def test_primary_only_persists_and_reads_back(db_session: AsyncSession) -> None:
    """A primary_aspect alone (no secondary) round-trips."""
    user_id = await _user(db_session)
    db_session.add(_entry(user_id, primary_aspect=3))
    await db_session.commit()

    row = (await db_session.execute(select(JournalEntry))).scalar_one()
    assert row.primary_aspect == 3
    assert row.secondary_aspect is None


@pytest.mark.asyncio
async def test_primary_and_secondary_round_trip(db_session: AsyncSession) -> None:
    """A full chord (primary + secondary) persists and reads back exactly."""
    user_id = await _user(db_session)
    db_session.add(_entry(user_id, primary_aspect=3, secondary_aspect=7))
    await db_session.commit()

    row = (await db_session.execute(select(JournalEntry))).scalar_one()
    assert row.primary_aspect == 3
    assert row.secondary_aspect == 7


@pytest.mark.asyncio
async def test_primary_below_range_raises_integrity_error(db_session: AsyncSession) -> None:
    """primary_aspect=0 violates the range CHECK (1..10)."""
    user_id = await _user(db_session)
    db_session.add(_entry(user_id, primary_aspect=0))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_primary_above_range_raises_integrity_error(db_session: AsyncSession) -> None:
    """primary_aspect=11 violates the range CHECK (1..10)."""
    user_id = await _user(db_session)
    db_session.add(_entry(user_id, primary_aspect=11))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_secondary_below_range_raises_integrity_error(db_session: AsyncSession) -> None:
    """secondary_aspect=0 violates the range CHECK (1..10)."""
    user_id = await _user(db_session)
    db_session.add(_entry(user_id, primary_aspect=5, secondary_aspect=0))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_secondary_above_range_raises_integrity_error(db_session: AsyncSession) -> None:
    """secondary_aspect=11 violates the range CHECK (1..10)."""
    user_id = await _user(db_session)
    db_session.add(_entry(user_id, primary_aspect=5, secondary_aspect=11))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_secondary_without_primary_raises_integrity_error(db_session: AsyncSession) -> None:
    """A secondary set with no primary violates the chord-shape CHECK."""
    user_id = await _user(db_session)
    db_session.add(_entry(user_id, secondary_aspect=7))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_secondary_equal_to_primary_raises_integrity_error(db_session: AsyncSession) -> None:
    """secondary_aspect == primary_aspect violates the chord-shape CHECK."""
    user_id = await _user(db_session)
    db_session.add(_entry(user_id, primary_aspect=4, secondary_aspect=4))
    with pytest.raises(IntegrityError):
        await db_session.commit()
