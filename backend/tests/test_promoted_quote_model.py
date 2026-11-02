"""Data-layer tests for hierarchical reflection scope and PromotedQuote."""

from __future__ import annotations

import importlib.util
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import CheckConstraint, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, col

from models.course_stage import CourseStage
from models.journal_entry import JournalEntry, JournalTag
from models.marginalia import Marginalia, MarginaliaKind
from models.promoted_quote import (
    CK_PROMOTED_QUOTE_SOURCE_KIND_VALID,
    CK_PROMOTED_QUOTE_SOURCE_MATCHES_KIND,
    CK_PROMOTED_QUOTE_SOURCE_TITLE_COURSE_ONLY,
    PromotedQuote,
    PromotedQuoteSourceKind,
)
from models.stage_content import StageContent
from models.user import User
from services import journal_encryption as je

_SOURCE_KIND_MIGRATION = (
    Path(__file__).parent.parent
    / "migrations"
    / "versions"
    / "e5c1a8f3b7d2_promoted_quote_source_kind.py"
)


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


# --- source kinds: entry, course, letter (#3656) -------------------------------

_CHAPTER_TITLE = "Survival"
_LETTER_ANCHOR = "a letter's line"


@dataclass(frozen=True)
class _Sources:
    """One of each thing a quote can be lifted from, all owned by ``user_id``."""

    user_id: int
    entry_id: int
    content_id: int
    marginalia_id: int


async def _seed_sources(session: AsyncSession) -> _Sources:
    """A user with an entry, a Course chapter, and a margin note carrying a letter."""
    user_id = await _user(session)
    entry = JournalEntry(sender="user", user_id=user_id, message="A page with a letter.")
    stage = CourseStage(
        title="Beige",
        subtitle="Agency",
        stage_number=1,
        overview_url="https://example.com/beige",
        category="test",
        aspect="test-aspect",
        spiral_dynamics_color="beige",
        growing_up_stage="archaic",
        divine_gender_polarity="masculine",
        relationship_to_free_will="active",
        free_will_description="Active Yes-And-Ness",
    )
    session.add_all([entry, stage])
    await session.flush()
    assert entry.id is not None
    assert stage.id is not None
    chapter = StageContent(
        course_stage_id=stage.id,
        title=_CHAPTER_TITLE,
        content_type="chapter",
        release_day=0,
        url="content://beige-1",
    )
    letter = Marginalia(
        journal_entry_id=entry.id,
        user_id=user_id,
        kind=MarginaliaKind.THEME,
        anchor_start=0,
        anchor_end=4,
        anchor_text="page",
        note="A note.",
        essay=f"The essay holds {_LETTER_ANCHOR}.",
        essay_generated_at=datetime.now(UTC),
    )
    session.add_all([chapter, letter])
    await session.flush()
    assert chapter.id is not None
    assert letter.id is not None
    return _Sources(user_id, entry.id, chapter.id, letter.id)


def _sourced_quote(
    sources: _Sources, kind: str, links: frozenset[str], *, titled: bool = False
) -> PromotedQuote:
    """A quote of ``kind`` carrying exactly the source links named in ``links``."""
    return PromotedQuote(
        user_id=sources.user_id,
        source_kind=kind,
        source_entry_id=sources.entry_id if "entry" in links else None,
        source_content_id=sources.content_id if "content" in links else None,
        source_marginalia_id=sources.marginalia_id if "marginalia" in links else None,
        source_title=_CHAPTER_TITLE if titled else None,
        anchor_start=0,
        anchor_end=len(_LETTER_ANCHOR),
        anchor_text=_LETTER_ANCHOR,
    )


def test_a_quote_comes_from_an_entry_a_course_chapter_or_a_letter() -> None:
    """The three source kinds, and nothing else."""
    assert [kind.value for kind in PromotedQuoteSourceKind] == ["entry", "course", "letter"]


@pytest.mark.asyncio
async def test_a_quote_built_without_a_kind_is_an_entry_quote(db_session: AsyncSession) -> None:
    """Every existing writer builds an entry quote without naming the kind."""
    user_id = await _user(db_session)
    entry = _reflection_entry(user_id)
    db_session.add(entry)
    await db_session.flush()
    assert entry.id is not None

    db_session.add(_quote(user_id, entry.id))
    await db_session.commit()

    row = (await db_session.execute(select(PromotedQuote))).scalar_one()
    assert row.source_kind == PromotedQuoteSourceKind.ENTRY
    assert row.source_content_id is None
    assert row.source_marginalia_id is None
    assert row.source_title is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("kind", "links", "titled"),
    [
        pytest.param("entry", frozenset({"entry"}), False, id="entry"),
        pytest.param("course", frozenset({"content"}), True, id="course"),
        # A pruned chapter SET NULLs the link and leaves the snapshot title.
        pytest.param("course", frozenset(), True, id="course-chapter-pruned"),
        pytest.param("letter", frozenset({"marginalia"}), False, id="letter"),
    ],
)
async def test_each_kind_persists_with_its_own_source(
    db_session: AsyncSession, kind: str, links: frozenset[str], *, titled: bool
) -> None:
    """A quote whose links match its kind is accepted."""
    sources = await _seed_sources(db_session)
    db_session.add(_sourced_quote(sources, kind, links, titled=titled))
    await db_session.commit()

    row = (await db_session.execute(select(PromotedQuote))).scalar_one()
    assert row.source_kind == kind


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("kind", "links", "titled"),
    [
        pytest.param("vault", frozenset({"entry"}), False, id="unknown-kind"),
        pytest.param("entry", frozenset(), False, id="entry-without-entry"),
        pytest.param("entry", frozenset({"entry", "content"}), False, id="entry-with-chapter"),
        pytest.param("entry", frozenset({"entry", "marginalia"}), False, id="entry-with-letter"),
        pytest.param("entry", frozenset({"entry"}), True, id="entry-with-title"),
        pytest.param("course", frozenset({"content", "entry"}), True, id="course-with-entry"),
        pytest.param("course", frozenset({"content", "marginalia"}), True, id="course-with-letter"),
        pytest.param("letter", frozenset(), False, id="letter-without-letter"),
        pytest.param("letter", frozenset({"marginalia", "entry"}), False, id="letter-with-entry"),
        pytest.param(
            "letter", frozenset({"marginalia", "content"}), False, id="letter-with-chapter"
        ),
        pytest.param("letter", frozenset({"marginalia"}), True, id="letter-with-title"),
    ],
)
async def test_a_quote_whose_links_contradict_its_kind_is_rejected(
    db_session: AsyncSession, kind: str, links: frozenset[str], *, titled: bool
) -> None:
    """The DB refuses every inconsistent kind/link combination, so no writer can store one.

    ``source_title`` is plaintext and holds a published chapter title only, so a
    title on an entry or letter quote -- which could only be the writer's own
    words -- is refused too.
    """
    sources = await _seed_sources(db_session)
    db_session.add(_sourced_quote(sources, kind, links, titled=titled))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@asynccontextmanager
async def _enforcing_session() -> AsyncIterator[AsyncSession]:
    """A session on a private in-memory database with foreign keys enforced.

    SQLite ships with ``PRAGMA foreign_keys`` off; a dedicated engine keeps the
    pragma from leaking onto the shared test engine.
    """
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
        async with factory() as session:
            await session.execute(text("PRAGMA foreign_keys = ON"))
            yield session
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_deleting_a_letter_deletes_the_quotes_lifted_from_it() -> None:
    """A letter quote cascades with its margin note, as an entry quote does with its entry."""
    async with _enforcing_session() as session:
        sources = await _seed_sources(session)
        session.add(_sourced_quote(sources, "letter", frozenset({"marginalia"})))
        await session.commit()

        await session.execute(
            text("DELETE FROM marginalia WHERE id = :id"), {"id": sources.marginalia_id}
        )
        await session.commit()

        remaining = (
            await session.execute(select(func.count()).select_from(PromotedQuote))
        ).scalar_one()
        assert remaining == 0


@pytest.mark.asyncio
async def test_removing_a_chapter_keeps_its_quotes_and_their_title() -> None:
    """Re-pinned published content never erases a writer's gathered quote (SET NULL)."""
    async with _enforcing_session() as session:
        sources = await _seed_sources(session)
        session.add(_sourced_quote(sources, "course", frozenset({"content"}), titled=True))
        await session.commit()

        await session.execute(
            text("DELETE FROM stagecontent WHERE id = :id"), {"id": sources.content_id}
        )
        await session.commit()

        row = (
            await session.execute(
                select(col(PromotedQuote.source_content_id), col(PromotedQuote.source_title))
            )
        ).one()
        assert tuple(row) == (None, _CHAPTER_TITLE)


def _load_source_kind_migration() -> ModuleType:
    """Import the source-kind revision by path (versions/ is not a package)."""
    spec = importlib.util.spec_from_file_location("source_kind_migration", _SOURCE_KIND_MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_model_mirrors_the_migrations_checks_exactly() -> None:
    """Model and migration state the same three CHECKs, so neither can drift alone.

    The migration freezes its SQL rather than importing it from ``src``; this
    pins today's enum-derived model text to that frozen copy.
    """
    migration = _load_source_kind_migration()
    checks = {
        constraint.name: str(constraint.sqltext)
        for constraint in SQLModel.metadata.tables["promotedquote"].constraints
        if isinstance(constraint, CheckConstraint)
    }

    assert checks[CK_PROMOTED_QUOTE_SOURCE_KIND_VALID] == migration.KIND_CONDITION
    assert checks[CK_PROMOTED_QUOTE_SOURCE_MATCHES_KIND] == migration.SOURCE_CONDITION
    assert checks[CK_PROMOTED_QUOTE_SOURCE_TITLE_COURSE_ONLY] == migration.TITLE_CONDITION
