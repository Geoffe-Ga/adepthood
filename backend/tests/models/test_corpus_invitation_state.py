"""The shape of the corpus-invitation record (#2407).

One row per account, and the row is content-free: a count of completed passes,
the count at the last "Not now", when that was, and whether the account asked
not to be asked. Nothing of the writing, nothing of the reflection. The
constraints pinned here are the ones the service leans on -- one row per user,
counts that cannot go negative, and database-side defaults so a row inserted
with only ``user_id`` is a complete, quiet state.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.corpus_invitation_state import CorpusInvitationState
from models.user import User


async def _user(session: AsyncSession, email: str) -> int:
    """Insert a bare User and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    return user.id


@pytest.mark.asyncio
async def test_the_table_is_named_explicitly_for_the_censuses() -> None:
    """The deletion POLICY and export MANIFEST key on this exact name."""
    assert CorpusInvitationState.__tablename__ == "corpusinvitationstate"


@pytest.mark.asyncio
async def test_one_row_per_account(db_session: AsyncSession) -> None:
    """A second state row for the same account violates the unique constraint."""
    user_id = await _user(db_session, "one-row@example.com")
    db_session.add(CorpusInvitationState(user_id=user_id))
    await db_session.commit()

    db_session.add(CorpusInvitationState(user_id=user_id))
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_a_row_inserted_with_only_the_owner_is_a_complete_quiet_state(
    db_session: AsyncSession,
) -> None:
    """Server defaults: zero passes, zero at dismissal, never dismissed, still askable."""
    user_id = await _user(db_session, "defaults@example.com")
    await db_session.execute(
        text("INSERT INTO corpusinvitationstate (user_id) VALUES (:u)"), {"u": user_id}
    )
    await db_session.commit()

    row = (
        await db_session.execute(
            select(CorpusInvitationState).where(col(CorpusInvitationState.user_id) == user_id)
        )
    ).scalar_one()
    assert row.completed_passes == 0
    assert row.passes_at_dismissal == 0
    assert row.dismissed_at is None
    assert row.do_not_ask_again is False


# One literal statement per counter, so the SQL is never assembled from a value.
_NEGATIVE_INSERTS = {
    "completed_passes": (
        "INSERT INTO corpusinvitationstate (user_id, completed_passes) VALUES (:u, -1)"
    ),
    "passes_at_dismissal": (
        "INSERT INTO corpusinvitationstate (user_id, passes_at_dismissal) VALUES (:u, -1)"
    ),
}


@pytest.mark.asyncio
@pytest.mark.parametrize("column", sorted(_NEGATIVE_INSERTS))
async def test_a_count_cannot_go_negative(db_session: AsyncSession, column: str) -> None:
    """Both counters carry a named CHECK, so a bug cannot store a sentinel nobody defined."""
    user_id = await _user(db_session, f"negative-{column}@example.com")
    with pytest.raises(IntegrityError):
        await db_session.execute(text(_NEGATIVE_INSERTS[column]), {"u": user_id})
    await db_session.rollback()
