"""Domain tests for course-access entitlements: grant, check, revoke.

Contract: at most one ACTIVE course_access entitlement per user, enforced by
a partial unique index on (user_id, kind) WHERE revoked_at IS NULL that the
model also renders on the SQLite test database; grant_course_access is
idempotent and updates the sale link in place; revoke-then-regrant yields a
fresh active row; every grant and revoke emits a structured reason_code log.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

import pytest
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel, col, select

from domain.entitlements import (
    PRODUCT_IDS_ENV_VAR,
    grant_course_access,
    has_course_access,
    is_aptitude_product_id,
    revoke_course_access,
)
from models.entitlement import Entitlement, EntitlementKind
from models.gumroad_sale import GumroadSale
from models.user import User

COURSE_ACCESS_KIND = "course_access"
ENTITLEMENT_TABLE = "entitlement"
METADATA_COLUMN = "metadata"
USER_EMAIL = "seeker@example.com"
SECOND_USER_EMAIL = "other-seeker@example.com"
PRODUCT_ID = "prod_alpha"
SALE_ID = "S-500"
GRANT_REASON_DEFAULT = "signup_redemption"
REVOKE_REASON = "refund"
STUB_USER_ID = 1


def _log_carries_reason(caplog: pytest.LogCaptureFixture, reason: str) -> bool:
    """Return True when a captured log record carries ``reason`` as its reason_code."""
    if f"reason_code={reason}" in caplog.text:
        return True
    return any(getattr(record, "reason_code", None) == reason for record in caplog.records)


async def _persist_user(db_session: AsyncSession, email: str = USER_EMAIL) -> tuple[User, int]:
    """Create and commit a user; return the row plus its non-null id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    if user.id is None:
        msg = "user id missing after commit"
        raise RuntimeError(msg)
    return user, user.id


async def _persist_sale(
    db_session: AsyncSession, sale_id: str = SALE_ID
) -> tuple[GumroadSale, int]:
    """Create and commit a GumroadSale; return the row plus its non-null id."""
    sale = GumroadSale(
        gumroad_sale_id=sale_id,
        product_id=PRODUCT_ID,
        email=USER_EMAIL,
        resource_name="sale",
        raw_payload={"sale_id": sale_id},
    )
    db_session.add(sale)
    await db_session.commit()
    await db_session.refresh(sale)
    if sale.id is None:
        msg = "sale id missing after commit"
        raise RuntimeError(msg)
    return sale, sale.id


async def _count_entitlements(db_session: AsyncSession, user_id: int) -> int:
    """Return the number of Entitlement rows persisted for ``user_id``."""
    result = await db_session.execute(
        select(func.count()).select_from(Entitlement).where(Entitlement.user_id == user_id)
    )
    return int(result.scalar_one())


def test_course_access_kind_is_the_stored_string() -> None:
    """EntitlementKind.COURSE_ACCESS is a StrEnum member equal to its column value."""
    assert EntitlementKind.COURSE_ACCESS == COURSE_ACCESS_KIND
    assert EntitlementKind.COURSE_ACCESS.value == COURSE_ACCESS_KIND


def test_is_aptitude_product_id_matches_only_allowlisted_products(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The shared allowlist check accepts a listed id and rejects everything else."""
    monkeypatch.setenv(PRODUCT_IDS_ENV_VAR, f" {PRODUCT_ID} , prod_beta ")
    assert is_aptitude_product_id(PRODUCT_ID) is True
    assert is_aptitude_product_id("prod_beta") is True
    assert is_aptitude_product_id("prod_not_listed") is False


def test_is_aptitude_product_id_rejects_blank_and_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A blank id, and any id under an unset allowlist, fail closed to False."""
    monkeypatch.setenv(PRODUCT_IDS_ENV_VAR, PRODUCT_ID)
    assert is_aptitude_product_id("") is False
    assert is_aptitude_product_id(None) is False
    monkeypatch.delenv(PRODUCT_IDS_ENV_VAR, raising=False)
    assert is_aptitude_product_id(PRODUCT_ID) is False


def test_new_entitlement_defaults_to_active_course_access() -> None:
    """A bare Entitlement defaults to active course_access with tz-aware granted_at."""
    row = Entitlement(user_id=STUB_USER_ID)
    assert row.kind == COURSE_ACCESS_KIND
    assert row.revoked_at is None
    assert row.entitlement_metadata == {}
    assert row.granted_at is not None
    assert row.granted_at.tzinfo is not None


def test_metadata_attribute_maps_to_metadata_db_column() -> None:
    """The Python attribute entitlement_metadata is stored in a column named metadata."""
    columns = SQLModel.metadata.tables[ENTITLEMENT_TABLE].c
    assert METADATA_COLUMN in columns


@pytest.mark.asyncio
async def test_grant_creates_active_entitlement_linked_to_sale(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Granting with a sale links source_sale_id and product_id and logs the reason."""
    caplog.set_level(logging.DEBUG)
    user, user_id = await _persist_user(db_session)
    sale, sale_id = await _persist_sale(db_session)

    entitlement = await grant_course_access(db_session, user, sale)

    assert entitlement.user_id == user_id
    assert entitlement.kind == COURSE_ACCESS_KIND
    assert entitlement.source_sale_id == sale_id
    assert entitlement.product_id == sale.product_id
    assert entitlement.revoked_at is None
    assert entitlement.granted_at is not None
    assert await _count_entitlements(db_session, user_id) == 1
    assert _log_carries_reason(caplog, GRANT_REASON_DEFAULT)


@pytest.mark.asyncio
async def test_grant_is_idempotent_and_updates_sale_link_in_place(
    db_session: AsyncSession,
) -> None:
    """A second grant for the same user updates the existing row, never duplicates."""
    user, user_id = await _persist_user(db_session)
    first = await grant_course_access(db_session, user)
    sale, sale_id = await _persist_sale(db_session)

    second = await grant_course_access(db_session, user, sale)

    assert second.id == first.id
    assert second.source_sale_id == sale_id
    assert second.product_id == PRODUCT_ID
    assert await _count_entitlements(db_session, user_id) == 1


@pytest.mark.asyncio
async def test_grant_requires_a_persisted_user(db_session: AsyncSession) -> None:
    """Granting for a user that was never committed (no id) is a programmer error."""
    unsaved_user = User(email=USER_EMAIL, password_hash="x")  # pragma: allowlist secret

    with pytest.raises(ValueError, match="user id"):
        await grant_course_access(db_session, unsaved_user)


@pytest.mark.asyncio
async def test_revoke_without_active_grant_is_a_silent_no_op(db_session: AsyncSession) -> None:
    """Revoking when there is no active entitlement neither raises nor writes a row."""
    _user, user_id = await _persist_user(db_session)

    await revoke_course_access(db_session, user_id, REVOKE_REASON)

    assert await has_course_access(db_session, user_id) is False
    assert await _count_entitlements(db_session, user_id) == 0


@pytest.mark.asyncio
async def test_has_course_access_reflects_grant_and_revoke(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """has_course_access flips False -> True on grant and back to False on revoke."""
    caplog.set_level(logging.DEBUG)
    user, user_id = await _persist_user(db_session)
    assert await has_course_access(db_session, user_id) is False

    await grant_course_access(db_session, user)
    assert await has_course_access(db_session, user_id) is True

    await revoke_course_access(db_session, user_id, REVOKE_REASON)
    assert await has_course_access(db_session, user_id) is False
    assert _log_carries_reason(caplog, REVOKE_REASON)


@pytest.mark.asyncio
async def test_revoke_then_regrant_creates_fresh_active_row(
    db_session: AsyncSession,
) -> None:
    """Regranting after a revoke adds a new active row and keeps the revoked one."""
    user, user_id = await _persist_user(db_session)
    original = await grant_course_access(db_session, user)
    original_id = original.id
    await revoke_course_access(db_session, user_id, REVOKE_REASON)

    regranted = await grant_course_access(db_session, user)

    assert regranted.id != original_id
    assert regranted.revoked_at is None
    assert await has_course_access(db_session, user_id) is True
    result = await db_session.execute(
        select(Entitlement).where(col(Entitlement.revoked_at).is_not(None))
    )
    revoked_rows = result.scalars().all()
    assert len(revoked_rows) == 1
    assert revoked_rows[0].id == original_id
    assert await _count_entitlements(db_session, user_id) == 2


@pytest.mark.asyncio
async def test_second_active_row_is_rejected_by_partial_unique_index(
    db_session: AsyncSession,
) -> None:
    """Inserting a second active course_access row for one user raises IntegrityError."""
    _user, user_id = await _persist_user(db_session)
    db_session.add(Entitlement(user_id=user_id))
    await db_session.commit()

    db_session.add(Entitlement(user_id=user_id))
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    assert await _count_entitlements(db_session, user_id) == 1


@pytest.mark.asyncio
async def test_revoked_row_does_not_block_a_new_active_row(
    db_session: AsyncSession,
) -> None:
    """The partial index only guards active rows, so revoked history can coexist."""
    _user, user_id = await _persist_user(db_session)
    db_session.add(Entitlement(user_id=user_id, revoked_at=datetime.now(UTC)))
    await db_session.commit()

    db_session.add(Entitlement(user_id=user_id))
    await db_session.commit()

    assert await _count_entitlements(db_session, user_id) == 2


@pytest.mark.asyncio
async def test_distinct_users_hold_active_entitlements_simultaneously(
    db_session: AsyncSession,
) -> None:
    """The unique index is scoped per user, not global per kind."""
    _first, first_id = await _persist_user(db_session)
    _second, second_id = await _persist_user(db_session, email=SECOND_USER_EMAIL)
    db_session.add(Entitlement(user_id=first_id))
    db_session.add(Entitlement(user_id=second_id))
    await db_session.commit()

    assert await _count_entitlements(db_session, first_id) == 1
    assert await _count_entitlements(db_session, second_id) == 1
