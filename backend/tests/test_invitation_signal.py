"""Data-layer tests for the InvitationSignal model (sangha-invitation-01).

Covers:
- Lifecycle: created_at auto-populated, dismissed_at starts None, persists on update.
- Uniqueness: two identical (user_id, target_type, target_id, kind) rows → IntegrityError.
- Uniqueness with target_id=None: partial index catches the duplicate even when target_id is NULL.
- Declined-never-recreated: dismissed row still blocks a fresh duplicate.
- Non-collision: differing target_id, differing kind, and null-vs-non-null target_id coexist.
- Per-user isolation: same coordinates for two users both succeed.
- CASCADE: deleting the parent user removes signal rows (isolated engine so PRAGMA doesn't leak).
- Enum CHECK constraints: invalid target_type and invalid kind both raise IntegrityError.
- Enum value sets pinned exactly.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, col

from models.invitation_signal import InvitationKind, InvitationSignal, InvitationTargetType
from models.user import User

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


async def _user(session: AsyncSession, email: str = "signal@example.com") -> int:
    """Insert a bare User and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    return user.id


def _signal(user_id: int, **overrides: object) -> InvitationSignal:
    """Build an InvitationSignal with sensible defaults and any given overrides."""
    base: dict[str, object] = {
        "user_id": user_id,
        "target_type": InvitationTargetType.HABIT,
        "target_id": 1,
        "kind": InvitationKind.READINESS,
    }
    base.update(overrides)
    return InvitationSignal(**base)


# ---------------------------------------------------------------------------
# 1. Lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lifecycle_created_at_populated_dismissed_at_none(
    db_session: AsyncSession,
) -> None:
    """A fresh signal has created_at set and dismissed_at is None."""
    user_id = await _user(db_session)
    sig = _signal(user_id)
    db_session.add(sig)
    await db_session.commit()

    row = (
        await db_session.execute(
            select(InvitationSignal).where(col(InvitationSignal.user_id) == user_id)
        )
    ).scalar_one()
    assert row.created_at is not None
    assert row.dismissed_at is None


@pytest.mark.asyncio
async def test_lifecycle_dismissed_at_persists(db_session: AsyncSession) -> None:
    """Setting dismissed_at on an existing row round-trips to the DB."""
    user_id = await _user(db_session)
    sig = _signal(user_id)
    db_session.add(sig)
    await db_session.commit()
    await db_session.refresh(sig)

    dismissed_ts = datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC)
    sig.dismissed_at = dismissed_ts
    await db_session.commit()
    await db_session.refresh(sig)

    # SQLite returns a naive datetime; normalise to UTC for the value check.
    assert sig.dismissed_at.replace(tzinfo=UTC) == dismissed_ts


# ---------------------------------------------------------------------------
# 2. Uniqueness — target_id present
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_uniqueness_target_id_present_blocks_duplicate(
    db_session: AsyncSession,
) -> None:
    """Two rows with identical (user_id, target_type, target_id, kind) → IntegrityError."""
    user_id = await _user(db_session)
    db_session.add(
        _signal(
            user_id,
            target_type=InvitationTargetType.HABIT,
            target_id=7,
            kind=InvitationKind.READINESS,
        )
    )
    await db_session.commit()

    db_session.add(
        _signal(
            user_id,
            target_type=InvitationTargetType.HABIT,
            target_id=7,
            kind=InvitationKind.READINESS,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


# ---------------------------------------------------------------------------
# 3. Uniqueness — target_id NULL (highest-value partial-index test)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_uniqueness_target_id_null_blocks_duplicate(
    db_session: AsyncSession,
) -> None:
    """Two rows with target_id=None and identical (user_id, target_type, kind) → IntegrityError.

    A plain UNIQUE across all four columns would NOT catch this because SQL
    treats two NULLs as non-equal in a UNIQUE constraint; only the explicit
    partial index on (user_id, target_type, kind) WHERE target_id IS NULL does.
    """
    user_id = await _user(db_session)
    db_session.add(
        _signal(
            user_id,
            target_type=InvitationTargetType.COURSE,
            target_id=None,
            kind=InvitationKind.MASTERY,
        )
    )
    await db_session.commit()

    db_session.add(
        _signal(
            user_id,
            target_type=InvitationTargetType.COURSE,
            target_id=None,
            kind=InvitationKind.MASTERY,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


# ---------------------------------------------------------------------------
# 4. Declined-never-recreated (both target_id-present and target_id-NULL)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dismissed_row_still_blocks_fresh_duplicate_target_id_present(
    db_session: AsyncSession,
) -> None:
    """A dismissed signal (target_id set) still blocks an identical new row."""
    user_id = await _user(db_session)
    sig = _signal(
        user_id,
        target_type=InvitationTargetType.PRACTICE,
        target_id=3,
        kind=InvitationKind.CONSISTENCY,
    )
    db_session.add(sig)
    await db_session.commit()
    await db_session.refresh(sig)

    sig.dismissed_at = datetime(2026, 5, 1, tzinfo=UTC)
    await db_session.commit()

    db_session.add(
        _signal(
            user_id,
            target_type=InvitationTargetType.PRACTICE,
            target_id=3,
            kind=InvitationKind.CONSISTENCY,
            dismissed_at=None,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_dismissed_row_still_blocks_fresh_duplicate_target_id_null(
    db_session: AsyncSession,
) -> None:
    """A dismissed signal (target_id=None) still blocks an identical new row."""
    user_id = await _user(db_session)
    sig = _signal(
        user_id,
        target_type=InvitationTargetType.SANGHA,
        target_id=None,
        kind=InvitationKind.READINESS,
    )
    db_session.add(sig)
    await db_session.commit()
    await db_session.refresh(sig)

    sig.dismissed_at = datetime(2026, 5, 1, tzinfo=UTC)
    await db_session.commit()

    db_session.add(
        _signal(
            user_id,
            target_type=InvitationTargetType.SANGHA,
            target_id=None,
            kind=InvitationKind.READINESS,
            dismissed_at=None,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


# ---------------------------------------------------------------------------
# 5. Non-collision cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_different_target_id_values_coexist(db_session: AsyncSession) -> None:
    """Rows with the same (user, target_type, kind) but differing target_id coexist."""
    user_id = await _user(db_session)
    db_session.add(
        _signal(
            user_id,
            target_type=InvitationTargetType.HABIT,
            target_id=10,
            kind=InvitationKind.READINESS,
        )
    )
    db_session.add(
        _signal(
            user_id,
            target_type=InvitationTargetType.HABIT,
            target_id=11,
            kind=InvitationKind.READINESS,
        )
    )
    await db_session.commit()

    count = (
        await db_session.execute(
            select(func.count())
            .select_from(InvitationSignal)
            .where(col(InvitationSignal.user_id) == user_id)
        )
    ).scalar_one()
    assert count == 2


@pytest.mark.asyncio
async def test_different_kind_values_coexist(db_session: AsyncSession) -> None:
    """Rows with the same (user, target_type, target_id) but differing kind coexist."""
    user_id = await _user(db_session)
    db_session.add(
        _signal(
            user_id,
            target_type=InvitationTargetType.HABIT,
            target_id=5,
            kind=InvitationKind.READINESS,
        )
    )
    db_session.add(
        _signal(
            user_id,
            target_type=InvitationTargetType.HABIT,
            target_id=5,
            kind=InvitationKind.CONSISTENCY,
        )
    )
    await db_session.commit()

    count = (
        await db_session.execute(
            select(func.count())
            .select_from(InvitationSignal)
            .where(col(InvitationSignal.user_id) == user_id)
        )
    ).scalar_one()
    assert count == 2


@pytest.mark.asyncio
async def test_null_and_non_null_target_id_coexist_same_user_type_kind(
    db_session: AsyncSession,
) -> None:
    """target_id=None and target_id=5 for the same (user, target_type, kind) coexist."""
    user_id = await _user(db_session)
    db_session.add(
        _signal(
            user_id,
            target_type=InvitationTargetType.PRACTICE,
            target_id=None,
            kind=InvitationKind.MASTERY,
        )
    )
    db_session.add(
        _signal(
            user_id,
            target_type=InvitationTargetType.PRACTICE,
            target_id=5,
            kind=InvitationKind.MASTERY,
        )
    )
    await db_session.commit()

    count = (
        await db_session.execute(
            select(func.count())
            .select_from(InvitationSignal)
            .where(col(InvitationSignal.user_id) == user_id)
        )
    ).scalar_one()
    assert count == 2


# ---------------------------------------------------------------------------
# 6. Per-user isolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_per_user_isolation_same_coordinates_succeed(
    db_session: AsyncSession,
) -> None:
    """Same (target_type, target_id, kind) for two different users both succeed."""
    user_a = await _user(db_session, "user_a@example.com")
    user_b = await _user(db_session, "user_b@example.com")
    db_session.add(
        _signal(
            user_a,
            target_type=InvitationTargetType.HABIT,
            target_id=42,
            kind=InvitationKind.READINESS,
        )
    )
    db_session.add(
        _signal(
            user_b,
            target_type=InvitationTargetType.HABIT,
            target_id=42,
            kind=InvitationKind.READINESS,
        )
    )
    await db_session.commit()

    count = (
        await db_session.execute(select(func.count()).select_from(InvitationSignal))
    ).scalar_one()
    assert count == 2


# ---------------------------------------------------------------------------
# 7. CASCADE delete (isolated engine — PRAGMA foreign_keys scoped entirely here)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cascade_delete_removes_signals_on_user_delete() -> None:
    """Deleting the parent user cascades to InvitationSignal rows.

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
            user = User(
                email="cascade_sig@example.com", password_hash="x"
            )  # pragma: allowlist secret
            session.add(user)
            await session.flush()
            assert user.id is not None
            session.add(_signal(user.id))
            await session.commit()

            await session.execute(text("PRAGMA foreign_keys = ON"))
            loaded = await session.get(User, user.id)
            assert loaded is not None
            await session.delete(loaded)
            await session.commit()

            remaining = (
                await session.execute(select(func.count()).select_from(InvitationSignal))
            ).scalar_one()
            assert remaining == 0
    finally:
        await isolated_engine.dispose()


# ---------------------------------------------------------------------------
# 8. Enum CHECK constraints
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invalid_target_type_raises_integrity_error(
    db_session: AsyncSession,
) -> None:
    """A target_type outside the valid set violates ck_invitation_signal_target_type_valid."""
    user_id = await _user(db_session)
    db_session.add(_signal(user_id, target_type="bogus"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_invalid_kind_raises_integrity_error(db_session: AsyncSession) -> None:
    """A kind outside the valid set violates ck_invitation_signal_kind_valid."""
    user_id = await _user(db_session)
    db_session.add(_signal(user_id, kind="bogus"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


# ---------------------------------------------------------------------------
# 9. Enum value sets (pinned contracts)
# ---------------------------------------------------------------------------


def test_invitation_target_type_value_set_is_exact() -> None:
    """InvitationTargetType has exactly the five contracted members."""
    assert {t.value for t in InvitationTargetType} == {
        "habit",
        "practice",
        "course",
        "sangha",
        "embodied_community",
    }


def test_invitation_kind_value_set_is_exact() -> None:
    """InvitationKind has exactly the three contracted members."""
    assert {k.value for k in InvitationKind} == {
        "readiness",
        "consistency",
        "mastery",
    }


# ---------------------------------------------------------------------------
# 10. Table + constraint metadata pins
# ---------------------------------------------------------------------------


def test_table_name_is_invitationsignal() -> None:
    """The SQLModel table name must be 'invitationsignal'."""
    assert "invitationsignal" in SQLModel.metadata.tables


def test_check_constraint_names_are_present() -> None:
    """Both CHECK constraints must carry their contracted names."""
    table = SQLModel.metadata.tables["invitationsignal"]
    names = {c.name for c in table.constraints}
    assert "ck_invitation_signal_target_type_valid" in names
    assert "ck_invitation_signal_kind_valid" in names


def test_partial_unique_index_names_are_present() -> None:
    """Both partial unique indexes must carry their contracted names."""
    table = SQLModel.metadata.tables["invitationsignal"]
    index_names = {idx.name for idx in table.indexes}
    assert "ix_invitation_signal_user_target" in index_names
    assert "ix_invitation_signal_user_target_null" in index_names
