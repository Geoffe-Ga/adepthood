"""The ``programpass`` table holds one row per pass and refuses an impossible one (#3723)."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

from models.program_pass import PassOrigin, ProgramPass
from models.user import User

_STARTED_ON = date(2026, 1, 5)


def test_programpass_schema_is_registered() -> None:
    """The table is unprefixed, its owner column is indexed and cascades with the account."""
    table = SQLModel.metadata.tables["programpass"]

    assert table.c.user_id.index is True
    assert {key.ondelete for key in table.c.user_id.foreign_keys} == {"CASCADE"}
    assert table.c.ended_on.nullable is True
    assert table.c.reached_stage.nullable is True
    assert table.c.reached_week.nullable is True
    assert table.c.started_on.nullable is False
    assert table.c.completed.nullable is False


def test_the_origin_vocabulary_is_the_four_ways_a_pass_begins() -> None:
    """``rescaffold`` is accepted now even though nothing in this issue writes it."""
    assert {origin.value for origin in PassOrigin} == {
        "first_run",
        "rescaffold",
        "begin_again",
        "backfill",
    }


def test_a_new_pass_is_live_and_not_complete() -> None:
    """Nothing is reached until the pass is closed."""
    pass_ = ProgramPass(
        user_id=1, pass_number=1, started_on=_STARTED_ON, origin=PassOrigin.FIRST_RUN
    )

    assert pass_.ended_on is None
    assert pass_.reached_stage is None
    assert pass_.reached_week is None
    assert pass_.completed is False


async def _user(session: AsyncSession) -> int:
    """Persist a bare account and return its id."""
    user = User(email="passes@example.com", password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user.id


async def _insert(session: AsyncSession, **fields: object) -> None:
    """Insert one pass as a raw row, so the database alone judges it."""
    values: dict[str, object] = {
        "pass_number": 1,
        "started_on": _STARTED_ON,
        "origin": PassOrigin.FIRST_RUN.value,
    }
    values.update(fields)
    await session.execute(insert(ProgramPass).values(**values))
    await session.commit()


@pytest.mark.asyncio
async def test_pass_numbers_are_unique_per_user(db_session: AsyncSession) -> None:
    """A second pass 1 for the same account is refused."""
    user_id = await _user(db_session)
    await _insert(db_session, user_id=user_id)

    with pytest.raises(IntegrityError):
        await _insert(db_session, user_id=user_id)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fields",
    [
        pytest.param({"pass_number": 0}, id="pass-number-zero"),
        pytest.param({"origin": "traversal"}, id="unknown-origin"),
        pytest.param({"reached_stage": 0}, id="stage-below-one"),
        pytest.param({"reached_stage": 11}, id="stage-above-ten"),
        pytest.param({"reached_week": 0}, id="week-below-one"),
        pytest.param({"reached_week": 37}, id="week-above-thirty-six"),
    ],
)
async def test_an_impossible_pass_is_refused(
    db_session: AsyncSession, fields: dict[str, object]
) -> None:
    """The CHECK constraints hold the pass to the program's own shape."""
    user_id = await _user(db_session)

    with pytest.raises(IntegrityError):
        await _insert(db_session, user_id=user_id, **fields)
