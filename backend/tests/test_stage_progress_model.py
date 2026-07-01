"""Data-layer tests for StageProgress.cycle_number.

Covers:
- Default persistence to 1 when cycle_number is omitted.
- CHECK-constraint rejection of cycle_number=0.
- Named constraint is present on the mapped table.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

from models.stage_progress import StageProgress
from models.user import User


async def _user(session: AsyncSession, email: str = "cycle@example.com") -> int:
    """Persist a minimal user and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    return user.id


def _progress(user_id: int, **kwargs: object) -> StageProgress:
    """Build a StageProgress with sensible defaults and given overrides."""
    base: dict[str, object] = {
        "user_id": user_id,
        "current_stage": 1,
        "completed_stages": [],
    }
    base.update(kwargs)
    return StageProgress(**base)


@pytest.mark.asyncio
async def test_cycle_number_defaults_to_one(db_session: AsyncSession) -> None:
    """A StageProgress created without cycle_number persists with cycle_number == 1."""
    user_id = await _user(db_session)
    db_session.add(_progress(user_id))
    await db_session.commit()

    row = (await db_session.execute(select(StageProgress))).scalar_one()
    assert row.cycle_number == 1


@pytest.mark.asyncio
async def test_cycle_number_zero_violates_check_constraint(db_session: AsyncSession) -> None:
    """Inserting cycle_number=0 must raise IntegrityError via the positive CHECK."""
    user_id = await _user(db_session)
    db_session.add(_progress(user_id, cycle_number=0))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_cycle_number_negative_violates_check_constraint(db_session: AsyncSession) -> None:
    """Inserting a negative cycle_number must raise IntegrityError."""
    user_id = await _user(db_session, email="cycle2@example.com")
    db_session.add(_progress(user_id, cycle_number=-1))
    with pytest.raises(IntegrityError):
        await db_session.commit()


def test_check_constraint_name_is_present_on_table() -> None:
    """The named CHECK constraint must exist on the stageprogress table."""
    table = SQLModel.metadata.tables["stageprogress"]
    names = {c.name for c in table.constraints}
    assert "ck_stageprogress_cycle_number_positive" in names
