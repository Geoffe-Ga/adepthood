"""The license-claim seam: one Gumroad sale binds to exactly one active account.

ADR 0008 Decisions 2-4 in test form. The database — not an application
pre-check — refuses a second binding for the same sale; a single account may
hold bindings for as many distinct sales as it has redeemed; and the claim
itself is staged, never committed, so the router can make User + binding +
Entitlement one transaction.
"""

from __future__ import annotations

import pytest
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.license_binding import LicenseBinding
from models.user import User

USER_EMAIL = "seeker@example.com"
OTHER_EMAIL = "someone-else@example.com"
SALE_ID = "S-900"
SECOND_SALE_ID = "S-901"
PRODUCT_ID = "prod_alpha"
DISTINCT_SALE_COUNT = 2


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


async def _count_bindings(db_session: AsyncSession) -> int:
    """Return the number of LicenseBinding rows in the test database."""
    result = await db_session.execute(select(func.count()).select_from(LicenseBinding))
    return int(result.scalar_one())


@pytest.mark.asyncio
async def test_second_binding_for_the_same_sale_is_rejected_by_the_unique_constraint(
    db_session: AsyncSession,
) -> None:
    """The database, not a pre-check, keeps one sale on one account."""
    _first, first_id = await _persist_user(db_session)
    _second, second_id = await _persist_user(db_session, OTHER_EMAIL)
    db_session.add(LicenseBinding(user_id=first_id, gumroad_sale_id=SALE_ID, product_id=PRODUCT_ID))
    await db_session.commit()

    db_session.add(
        LicenseBinding(user_id=second_id, gumroad_sale_id=SALE_ID, product_id=PRODUCT_ID)
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    assert await _count_bindings(db_session) == 1


@pytest.mark.asyncio
async def test_one_account_may_hold_bindings_for_distinct_sales(
    db_session: AsyncSession,
) -> None:
    """Uniqueness is per sale: a buyer who redeemed two receipts keeps both."""
    _user, user_id = await _persist_user(db_session)
    db_session.add(LicenseBinding(user_id=user_id, gumroad_sale_id=SALE_ID, product_id=PRODUCT_ID))
    db_session.add(
        LicenseBinding(user_id=user_id, gumroad_sale_id=SECOND_SALE_ID, product_id=PRODUCT_ID)
    )
    await db_session.commit()

    assert await _count_bindings(db_session) == DISTINCT_SALE_COUNT
