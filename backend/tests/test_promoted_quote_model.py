"""Data-layer tests for hierarchical reflection scope and PromotedQuote."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, col

from models.journal_entry import JournalEntry, JournalTag
from models.promoted_quote import PromotedQuote
from models.user import User
from services import journal_encryption as je


async def _user(session: AsyncSession, email: str = "reflect@example.com") -> int:
    """Insert a user row and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    return user.id


def _reflection_entry(user_id: int, **over: object) -> JournalEntry:
    """Build a hierarchical-reflection JournalEntry with sane defaults."""
    base: dict[str, object] = {
        "sender": "user",
        "user_id": user_id,
        "message": "A stage of grief and grace.",
        "tag": JournalTag.HIERARCHICAL_REFLECTION,
        "reflection_level": "stage",
        "reflection_scope_key": "c1:s3",
    }
    base.update(over)
    return JournalEntry(**base)


def _quote(user_id: int, source_entry_id: int, **over: object) -> PromotedQuote:
    """Build a PromotedQuote with sane defaults."""
    base: dict[str, object] = {
        "user_id": user_id,
        "source_entry_id": source_entry_id,
        "anchor_start": 120,
        "anchor_end": 214,
        "anchor_text": "I noticed the anger was really grief",
    }
    base.update(over)
    return PromotedQuote(**base)


def test_hierarchical_reflection_tag_value() -> None:
    """The new tag enum member exists with the expected string value."""
    assert JournalTag.HIERARCHICAL_REFLECTION.value == "hierarchical_reflection"


@pytest.mark.asyncio
async def test_reflection_entry_persists_level_and_scope(db_session: AsyncSession) -> None:
    """A hierarchical-reflection entry round-trips reflection_level and reflection_scope_key."""
    user_id = await _user(db_session)
    db_session.add(_reflection_entry(user_id))
    await db_session.commit()

    row = (await db_session.execute(select(JournalEntry))).scalar_one()
    assert row.reflection_level == "stage"
    assert row.reflection_scope_key == "c1:s3"
    assert row.tag == JournalTag.HIERARCHICAL_REFLECTION


@pytest.mark.asyncio
async def test_invalid_reflection_level_is_rejected(db_session: AsyncSession) -> None:
    """A reflection_level outside the ReflectionLevel set violates the CHECK constraint."""
    user_id = await _user(db_session)
    db_session.add(_reflection_entry(user_id, reflection_level="galaxy"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_level_without_scope_key_is_rejected(db_session: AsyncSession) -> None:
    """reflection_level set with reflection_scope_key NULL violates the pairing CHECK."""
    user_id = await _user(db_session)
    db_session.add(_reflection_entry(user_id, reflection_scope_key=None))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_scope_key_without_level_is_rejected(db_session: AsyncSession) -> None:
    """reflection_scope_key set with reflection_level NULL violates the pairing CHECK."""
    user_id = await _user(db_session)
    db_session.add(_reflection_entry(user_id, reflection_level=None))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_duplicate_live_scope_key_is_rejected(db_session: AsyncSession) -> None:
    """Two live entries sharing (user_id, reflection_scope_key) violate the partial unique index."""
    user_id = await _user(db_session)
    db_session.add(_reflection_entry(user_id))
    await db_session.commit()

    db_session.add(_reflection_entry(user_id))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_same_scope_key_allowed_across_users(db_session: AsyncSession) -> None:
    """The partial unique index is per-user: two users may share one scope key."""
    first_user = await _user(db_session, email="one@example.com")
    second_user = await _user(db_session, email="two@example.com")
    db_session.add_all([_reflection_entry(first_user), _reflection_entry(second_user)])
    await db_session.commit()

    count = (await db_session.execute(select(func.count()).select_from(JournalEntry))).scalar_one()
    assert count == 2


@pytest.mark.asyncio
async def test_soft_deleted_scope_key_frees_it_for_reuse(db_session: AsyncSession) -> None:
    """A soft-deleted entry does not count toward the live partial unique index."""
    user_id = await _user(db_session)
    first = _reflection_entry(user_id)
    db_session.add(first)
    await db_session.commit()

    first.deleted_at = datetime.now(UTC)
    await db_session.commit()

    db_session.add(_reflection_entry(user_id))
    await db_session.commit()

    live_count = (
        await db_session.execute(
            select(func.count())
            .select_from(JournalEntry)
            .where(col(JournalEntry.deleted_at).is_(None)),
        )
    ).scalar_one()
    assert live_count == 1


@pytest.mark.asyncio
async def test_null_scope_key_entries_never_collide(db_session: AsyncSession) -> None:
    """Two entries with reflection_scope_key NULL never collide (partial index excludes NULLs)."""
    user_id = await _user(db_session)
    db_session.add_all(
        [
            JournalEntry(sender="user", user_id=user_id, message="freeform one"),
            JournalEntry(sender="user", user_id=user_id, message="freeform two"),
        ],
    )
    await db_session.commit()

    count = (await db_session.execute(select(func.count()).select_from(JournalEntry))).scalar_one()
    assert count == 2


@pytest.mark.asyncio
async def test_promoted_quote_persists_and_reads_back(db_session: AsyncSession) -> None:
    """A PromotedQuote row persists and its anchor fields round-trip."""
    user_id = await _user(db_session)
    entry = _reflection_entry(user_id)
    db_session.add(entry)
    await db_session.flush()
    assert entry.id is not None

    db_session.add(_quote(user_id, entry.id))
    await db_session.commit()

    row = (await db_session.execute(select(PromotedQuote))).scalar_one()
    assert row.anchor_start == 120
    assert row.anchor_end == 214
    assert row.anchor_text == "I noticed the anger was really grief"
    assert row.included_in_entry_id is None
    assert row.created_at is not None
    assert row.updated_at is not None


@pytest.mark.asyncio
async def test_promoted_quote_defaults_to_not_stale(db_session: AsyncSession) -> None:
    """A freshly created PromotedQuote defaults stale to False."""
    user_id = await _user(db_session)
    entry = _reflection_entry(user_id)
    db_session.add(entry)
    await db_session.flush()
    assert entry.id is not None

    db_session.add(_quote(user_id, entry.id))
    await db_session.commit()

    row = (await db_session.execute(select(PromotedQuote))).scalar_one()
    assert row.stale is False


@pytest.mark.asyncio
async def test_anchor_text_is_encrypted_at_rest(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With encryption configured, the raw column holds ciphertext, not the plaintext quote."""
    monkeypatch.setenv("JOURNAL_ENCRYPTION_KEYS", Fernet.generate_key().decode())
    je.reset_cache()
    try:
        user_id = await _user(db_session)
        entry = _reflection_entry(user_id)
        db_session.add(entry)
        await db_session.flush()
        assert entry.id is not None

        db_session.add(_quote(user_id, entry.id))
        await db_session.commit()

        raw = (await db_session.execute(text("SELECT anchor_text FROM promotedquote"))).scalar_one()
        assert raw != "I noticed the anger was really grief"
        assert "grief" not in raw
        assert je.decrypt(raw) == "I noticed the anger was really grief"
    finally:
        je.reset_cache()


@pytest.mark.asyncio
async def test_negative_anchor_start_is_rejected(db_session: AsyncSession) -> None:
    """anchor_start must be non-negative (CHECK constraint)."""
    user_id = await _user(db_session)
    entry = _reflection_entry(user_id)
    db_session.add(entry)
    await db_session.flush()
    assert entry.id is not None

    db_session.add(_quote(user_id, entry.id, anchor_start=-1))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_inverted_anchor_span_is_rejected(db_session: AsyncSession) -> None:
    """anchor_end must be greater than anchor_start (CHECK constraint)."""
    user_id = await _user(db_session)
    entry = _reflection_entry(user_id)
    db_session.add(entry)
    await db_session.flush()
    assert entry.id is not None

    db_session.add(_quote(user_id, entry.id, anchor_start=100, anchor_end=100))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_source_entry_delete_cascades_to_quotes(db_session: AsyncSession) -> None:
    """Deleting the source journal entry removes its promoted quotes (delete-orphan)."""
    user_id = await _user(db_session)
    entry = _reflection_entry(user_id)
    db_session.add(entry)
    await db_session.flush()
    assert entry.id is not None
    entry_id = entry.id

    db_session.add(_quote(user_id, entry_id))
    await db_session.commit()

    loaded = await db_session.get(JournalEntry, entry_id)
    assert loaded is not None
    await db_session.delete(loaded)
    await db_session.commit()

    remaining = (
        await db_session.execute(select(func.count()).select_from(PromotedQuote))
    ).scalar_one()
    assert remaining == 0


@pytest.mark.asyncio
async def test_deleting_included_entry_sets_quote_back_to_pending() -> None:
    """Deleting the reflection entry a quote was included in nulls out included_in_entry_id.

    Uses a dedicated in-memory engine so PRAGMA foreign_keys = ON is scoped
    entirely to this test and never leaks to the shared test_engine.
    """
    isolated_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    factory = async_sessionmaker(isolated_engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with isolated_engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
            await conn.execute(text("PRAGMA foreign_keys = ON"))

        async with factory() as session:
            user_id = await _user(session)
            source = _reflection_entry(user_id, reflection_scope_key="c1:s3")
            session.add(source)
            await session.flush()
            assert source.id is not None
            source_id = source.id

            included = _reflection_entry(user_id, reflection_scope_key="c1:s4")
            session.add(included)
            await session.flush()
            assert included.id is not None
            included_id = included.id

            quote = _quote(user_id, source_id, included_in_entry_id=included_id)
            session.add(quote)
            await session.commit()

            await session.execute(text("PRAGMA foreign_keys = ON"))
            loaded = await session.get(JournalEntry, included_id)
            assert loaded is not None
            await session.delete(loaded)
            await session.commit()

            await session.refresh(quote)
            assert quote.included_in_entry_id is None

            remaining = (
                await session.execute(select(func.count()).select_from(PromotedQuote))
            ).scalar_one()
            assert remaining == 1
    finally:
        await isolated_engine.dispose()
