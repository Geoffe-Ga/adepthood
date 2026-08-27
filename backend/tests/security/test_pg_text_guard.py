"""No code point PostgreSQL cannot store may reach a flush.

PostgreSQL stores no ``text`` value containing U+0000 in any encoding, and no
value containing an unpaired surrogate: asyncpg refuses both with
``CharacterNotInRepertoireError``, raised from inside whatever handler happened
to be writing.  By then it is an unhandled driver error, which the application
turns into a 500 -- and the caller who sent it is told the server broke.

The guard is a ``before_flush`` listener on ``sqlalchemy.orm.Session``.  That
placement, rather than a check inside each router, is the whole point: an
``AsyncSession`` delegates to a sync ``Session``, so one registration covers
every session this application opens, in the app and in this suite alike, and
covers columns nobody thought to guard.  Everything below therefore drives the
listener the way an endpoint would -- by adding or mutating real model
instances and committing -- never by calling a private helper, which would
prove only that the helper works and nothing about whether it is wired up.

The distinction the positive cases defend is the load-bearing one.  A
well-formed surrogate **pair** encodes an astral-plane character and is
perfectly storable; the fuzz bodies that prompted this guard are full of them.
A guard that rejected those would break legitimate text -- emoji, historic
scripts, most of the supplementary planes -- to close a hole that only lone
surrogates and U+0000 open.

The test database is SQLite, which stores every one of these values without
complaint.  Nothing here can therefore be a reproduction of the driver error;
each test pins the guard's own refusal instead, by its exception type and by
the model and attribute it names.
"""

from __future__ import annotations

import json
from datetime import date

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

import database
from models.habit import Habit
from models.user import User
from security.pg_text_guard import (
    UnstorableTextError,
    guard_unstorable_text,
    register_pg_text_guard,
)

# The code point no PostgreSQL text column can hold, written as an explicit
# escape so the file stays plain ASCII and no editor can silently eat it.
_NUL = "\x00"

# The two ends of the surrogate range.  Alone, each is unencodable; paired, the
# two of them are how JSON spells an astral-plane character.
_LONE_HIGH_SURROGATE = chr(0xD800)
_LONE_LOW_SURROGATE = chr(0xDFFF)

# A grinning face, reached two ways: directly, and by decoding the well-formed
# surrogate pair a JSON document would carry it as.  Both must survive.
_ASTRAL_DIRECT = chr(0x1F600)
_ASTRAL_FROM_A_PAIR = json.loads('"\\ud83d\\ude00"')

_HABIT_START = date(2026, 1, 1)
_CLEAN_NAME = "Morning sit"
_CLEAN_DAYS = ["mon", "wed", "fri"]


async def _seed_user(session: AsyncSession, email: str) -> int:
    """Create a user row and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user.id


def _habit(user_id: int, **overrides: object) -> Habit:
    """Build an otherwise-clean habit for ``user_id``, with fields overridden."""
    fields: dict[str, object] = {
        "name": _CLEAN_NAME,
        "icon": "candle",
        "start_date": _HABIT_START,
        "energy_cost": 10,
        "energy_return": 20,
        "user_id": user_id,
    }
    fields.update(overrides)
    return Habit(**fields)


@pytest.mark.asyncio
async def test_a_nul_in_a_text_attribute_is_refused_at_flush(db_session: AsyncSession) -> None:
    """A NUL inside a plain string attribute must stop the write and name itself."""
    user_id = await _seed_user(db_session, "nul-text@example.com")
    db_session.add(_habit(user_id, name=f"Sit{_NUL}here"))

    with pytest.raises(UnstorableTextError) as caught:
        await db_session.commit()
    await db_session.rollback()

    assert caught.value.model == "Habit"
    assert caught.value.attribute == "name"


@pytest.mark.asyncio
async def test_the_refusal_never_carries_the_offending_text(db_session: AsyncSession) -> None:
    """The error must name where the value was, never what it was.

    The guard sits on the write path of every column in the application,
    including the ones holding a person's prose.  An exception message that
    quoted the value would put that prose into a log line, a Sentry event, and
    on the way out through a 422 into whatever the client does with an error
    body.
    """
    user_id = await _seed_user(db_session, "no-echo@example.com")
    secret = f"{_NUL}the quick brown fox"
    db_session.add(_habit(user_id, name=secret))

    with pytest.raises(UnstorableTextError) as caught:
        await db_session.commit()
    await db_session.rollback()

    assert "the quick brown fox" not in str(caught.value)
    assert "the quick brown fox" not in repr(caught.value)
    assert _NUL not in str(caught.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("surrogate", [_LONE_HIGH_SURROGATE, _LONE_LOW_SURROGATE])
async def test_a_lone_surrogate_is_refused_at_flush(
    db_session: AsyncSession, surrogate: str
) -> None:
    """Neither end of the surrogate range may be written on its own.

    Unpaired surrogates are not characters; no UTF-8 encoder will emit them, so
    a column that receives one fails at the driver rather than at the schema.
    """
    user_id = await _seed_user(db_session, "surrogate@example.com")
    db_session.add(_habit(user_id, name=f"Sit{surrogate}"))

    with pytest.raises(UnstorableTextError) as caught:
        await db_session.commit()
    await db_session.rollback()

    assert caught.value.attribute == "name"


@pytest.mark.asyncio
@pytest.mark.parametrize("astral", [_ASTRAL_DIRECT, _ASTRAL_FROM_A_PAIR])
async def test_an_astral_character_is_stored_unchanged(
    db_session: AsyncSession, astral: str
) -> None:
    """A well-formed pair is a real character and must pass through untouched.

    The assertion that keeps the guard honest: the bodies that motivated it
    were full of astral-plane characters, every one of them a valid pair, and a
    guard that rejected them would be refusing text people actually write.
    """
    user_id = await _seed_user(db_session, f"astral-{ord(astral)}@example.com")
    habit = _habit(user_id, name=f"Sit{astral}", notification_days=[astral])
    db_session.add(habit)

    await db_session.commit()
    await db_session.refresh(habit)

    assert habit.name == f"Sit{astral}"
    assert habit.notification_days == [astral]


@pytest.mark.asyncio
async def test_a_nul_inside_a_string_array_is_refused_at_flush(db_session: AsyncSession) -> None:
    """A NUL in one element of a text array must stop the write.

    ``notification_days`` is a PostgreSQL text array, and every element of it is
    a text value with the same restriction as a scalar column.  A guard that
    only inspected strings would look straight past the list this defect was
    actually reported through.
    """
    user_id = await _seed_user(db_session, "nul-array@example.com")
    db_session.add(_habit(user_id, notification_days=["mon", f"{_NUL}wed", "fri"]))

    with pytest.raises(UnstorableTextError) as caught:
        await db_session.commit()
    await db_session.rollback()

    assert caught.value.model == "Habit"
    assert caught.value.attribute == "notification_days"


@pytest.mark.asyncio
async def test_a_nul_introduced_by_an_update_is_refused_at_flush(
    db_session: AsyncSession,
) -> None:
    """An edit to an already-stored row is guarded exactly as its insert was.

    A listener that only walked ``session.new`` would let every PUT and PATCH in
    the application through -- which is most of the write surface, and the half
    of it a fuzz run reaches last.
    """
    user_id = await _seed_user(db_session, "nul-update@example.com")
    habit = _habit(user_id)
    db_session.add(habit)
    await db_session.commit()

    habit.name = f"Sit{_NUL}later"
    with pytest.raises(UnstorableTextError) as caught:
        await db_session.commit()
    await db_session.rollback()

    assert caught.value.attribute == "name"


@pytest.mark.asyncio
async def test_clean_values_are_written_through_untouched(db_session: AsyncSession) -> None:
    """Ordinary text must reach the row byte for byte.

    A guard is free to reject; it is not free to edit.  Silently stripping the
    offending code point would turn a refusal nobody can miss into a corruption
    nobody can see.
    """
    user_id = await _seed_user(db_session, "clean@example.com")
    habit = _habit(user_id, name=_CLEAN_NAME, notification_days=list(_CLEAN_DAYS))
    db_session.add(habit)

    await db_session.commit()
    await db_session.refresh(habit)

    assert habit.name == _CLEAN_NAME
    assert habit.notification_days == _CLEAN_DAYS


def test_the_guard_is_registered_exactly_once() -> None:
    """Importing ``database`` installs the listener, and installing it again is a no-op.

    Registration at module scope is what makes the guard unforgettable, and
    idempotence is what keeps a second import -- or a test that reloads a
    module -- from stacking a duplicate listener onto every session in the
    process.  ``register_pg_text_guard`` reports whether it installed anything,
    which is the only way to tell "already registered once" from "registered
    twice": ``event.contains`` answers True for both.
    """
    assert database.engine is not None, "importing the database module is what installs the guard"
    assert event.contains(Session, "before_flush", guard_unstorable_text), (
        "the guard is not installed on the Session class, so no session is covered"
    )
    assert register_pg_text_guard() is False, (
        "registering a second time reported an install, so the listener is now stacked"
    )

    try:
        event.remove(Session, "before_flush", guard_unstorable_text)
        assert not event.contains(Session, "before_flush", guard_unstorable_text), (
            "a single removal left a listener behind, so it had been registered twice"
        )
        assert register_pg_text_guard() is True, (
            "registering onto a bare Session class reported no install"
        )
    finally:
        if not event.contains(Session, "before_flush", guard_unstorable_text):
            register_pg_text_guard()

    assert event.contains(Session, "before_flush", guard_unstorable_text)
