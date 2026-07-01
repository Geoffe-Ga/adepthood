"""Data-layer tests for the JournalClassification tier (issue #894).

Covers:
- Default persistence to ``personal`` when classification is omitted.
- Explicit ``intimate`` / ``public`` round-trips.
- CHECK-constraint rejection of an invalid value.
- Exact enum value set: {public, personal, intimate}.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from models.journal_entry import JournalClassification, JournalEntry
from models.user import User


async def _user(session: AsyncSession, email: str = "classif@example.com") -> int:
    """Persist a minimal user and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    return user.id


def _entry(user_id: int, **kwargs: object) -> JournalEntry:
    """Build a JournalEntry with the given overrides (classification optional)."""
    base: dict[str, object] = {
        "sender": "user",
        "user_id": user_id,
        "message": "A private thought.",
    }
    base.update(kwargs)
    return JournalEntry(**base)


@pytest.mark.asyncio
async def test_classification_defaults_to_personal(db_session: AsyncSession) -> None:
    """A JournalEntry created without classification persists as 'personal'."""
    user_id = await _user(db_session)
    db_session.add(_entry(user_id))
    await db_session.commit()

    row = (await db_session.execute(select(JournalEntry))).scalar_one()
    assert row.classification == JournalClassification.PERSONAL
    assert row.classification == "personal"


@pytest.mark.asyncio
async def test_classification_intimate_persists_and_reads_back(db_session: AsyncSession) -> None:
    """An explicit 'intimate' classification survives the round-trip."""
    user_id = await _user(db_session)
    db_session.add(_entry(user_id, classification=JournalClassification.INTIMATE))
    await db_session.commit()

    row = (await db_session.execute(select(JournalEntry))).scalar_one()
    assert row.classification == JournalClassification.INTIMATE
    assert row.classification == "intimate"


@pytest.mark.asyncio
async def test_classification_public_persists_and_reads_back(db_session: AsyncSession) -> None:
    """An explicit 'public' classification survives the round-trip."""
    user_id = await _user(db_session)
    db_session.add(_entry(user_id, classification=JournalClassification.PUBLIC))
    await db_session.commit()

    row = (await db_session.execute(select(JournalEntry))).scalar_one()
    assert row.classification == JournalClassification.PUBLIC
    assert row.classification == "public"


@pytest.mark.asyncio
async def test_invalid_classification_raises_integrity_error(db_session: AsyncSession) -> None:
    """A value outside the enum set violates the CHECK constraint at the DB layer."""
    user_id = await _user(db_session)
    db_session.add(_entry(user_id, classification="secret"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


def test_classification_enum_value_set_is_exact() -> None:
    """JournalClassification contains exactly {public, personal, intimate} — no more, no less."""
    assert {c.value for c in JournalClassification} == {"public", "personal", "intimate"}
