"""Data-layer tests for the Marginalia model (journal-resonance-01)."""

from __future__ import annotations

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.journal_entry import EntryStatus, JournalEntry
from models.marginalia import Marginalia, MarginaliaKind, MarginaliaStatus
from models.user import User


async def _user(session: AsyncSession, email: str = "marg@example.com") -> int:
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    return user.id


async def _entry(session: AsyncSession, user_id: int) -> int:
    entry = JournalEntry(sender="user", user_id=user_id, message="a page of thoughts")
    session.add(entry)
    await session.flush()
    assert entry.id is not None
    return entry.id


def _marginalia(entry_id: int, user_id: int, **over: object) -> Marginalia:
    base: dict[str, object] = {
        "journal_entry_id": entry_id,
        "user_id": user_id,
        "kind": MarginaliaKind.THEME,
        "anchor_start": 0,
        "anchor_end": 4,
        "anchor_text": "page",
        "note": "Recurring theme of beginnings.",
    }
    base.update(over)
    return Marginalia(**base)


@pytest.mark.asyncio
async def test_insert_and_read(db_session: AsyncSession) -> None:
    """A marginalia row persists and reads back with its defaults."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    db_session.add(_marginalia(entry_id, user_id))
    await db_session.commit()

    row = (await db_session.execute(select(Marginalia))).scalar_one()
    assert row.journal_entry_id == entry_id
    assert row.anchor_text == "page"
    # status defaults to active; essay is optional.
    assert row.status == MarginaliaStatus.ACTIVE
    assert row.essay is None
    assert row.created_at is not None


@pytest.mark.asyncio
async def test_kind_and_status_round_trip(db_session: AsyncSession) -> None:
    """Non-default kind/status values survive a write/read cycle."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    db_session.add(
        _marginalia(
            entry_id,
            user_id,
            kind=MarginaliaKind.CONNECTION,
            status=MarginaliaStatus.STALE,
            essay="A longer expansion.",
        ),
    )
    await db_session.commit()

    row = (await db_session.execute(select(Marginalia))).scalar_one()
    assert row.kind == MarginaliaKind.CONNECTION
    assert row.status == MarginaliaStatus.STALE
    assert row.essay == "A longer expansion."


@pytest.mark.asyncio
async def test_parent_delete_cascades(db_session: AsyncSession) -> None:
    """Deleting the parent journal entry removes its marginalia (delete-orphan)."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    db_session.add_all(
        [
            _marginalia(entry_id, user_id),
            _marginalia(entry_id, user_id, kind=MarginaliaKind.SYMBOL, note="A candle recurs."),
        ],
    )
    await db_session.commit()

    loaded = await db_session.get(JournalEntry, entry_id)
    assert loaded is not None
    await db_session.delete(loaded)
    await db_session.commit()

    remaining = (
        await db_session.execute(select(func.count()).select_from(Marginalia))
    ).scalar_one()
    assert remaining == 0


@pytest.mark.asyncio
async def test_updated_at_advances_on_mutate(db_session: AsyncSession) -> None:
    """updated_at advances when the row is flushed after a mutation (onupdate)."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    row = _marginalia(entry_id, user_id)
    db_session.add(row)
    await db_session.commit()
    # Refresh so ``original`` is the stored value (SQLite returns naive datetimes,
    # so capturing the in-memory tz-aware value would make the comparison invalid).
    await db_session.refresh(row)
    original = row.updated_at

    row.note = "Revised note."
    await db_session.commit()
    await db_session.refresh(row)
    assert row.updated_at > original


def test_enum_values() -> None:
    """The enum value sets match the contract."""
    assert {k.value for k in MarginaliaKind} == {"theme", "connection", "symbol"}
    assert {s.value for s in MarginaliaStatus} == {"active", "stale"}
    assert {e.value for e in EntryStatus} == {"draft", "finished"}
