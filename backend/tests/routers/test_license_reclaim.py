"""Reclaiming a licence after the account that held it is deleted (ADR 0008 D3).

Contract: while the first account lives, its key cannot grant a second one —
the refusal is byte-identical to an unknown key's. Once the account is erased
the binding goes with it, so the same key may be redeemed by exactly one new
account. Only access transfers: the new account inherits none of the deleted
account's rows, its wallet starts at zero, and the anonymised purchase receipt
is the one place the old address survives.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from http import HTTPStatus

import pytest
import sqlalchemy as sa
from httpx import AsyncClient, Response
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel, col, select

from models.entitlement import Entitlement
from models.license_binding import LicenseBinding
from models.user import User
from schemas.gumroad import GumroadLicenseResult, GumroadPurchase
from tests.helpers.account_seed import SeedAccount, seed_one_row_everywhere, seed_shared_tables

pytestmark = pytest.mark.real_license_gate

SIGNUP_PATH = "/auth/signup"
DELETE_PATH = "/users/me"
PRODUCT_IDS_ENV = "GUMROAD_APTITUDE_PRODUCT_IDS"
VERIFY_SEAM = "domain.entitlements.verify_license"
PRODUCT_ID = "prod_reclaim"
LICENSE_KEY = "RECLAIM-SUITE-LICENSE-KEY"  # pragma: allowlist secret
UNKNOWN_LICENSE_KEY = "RECLAIM-UNKNOWN-KEY"  # pragma: allowlist secret
CONTROL_LICENSE_KEY = "RECLAIM-CONTROL-KEY"  # pragma: allowlist secret
SALE_ID = "S-RECLAIM-1"
CONTROL_SALE_ID = "S-RECLAIM-2"
PURCHASE_EMAIL = "gift-buyer@example.com"
FIRST_EMAIL = "first-holder@example.com"
SECOND_EMAIL = "second-holder@example.com"
CONTROL_EMAIL = "control-holder@example.com"
PASSWORD = "securepassword123"  # pragma: allowlist secret
LICENSE_USES = 1
DETAIL_INVALID_LICENSE = "invalid_license"
# The only column a deleted account's address may survive in: the receipt.
SURVIVING_EMAIL_COLUMNS = {"gumroadsale.email"}


@pytest.fixture(autouse=True)
def _allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    """Put the suite's product on the APTITUDE allowlist."""
    monkeypatch.setenv(PRODUCT_IDS_ENV, PRODUCT_ID)


@pytest.fixture(autouse=True)
def _keyed_verifier(monkeypatch: pytest.MonkeyPatch) -> None:
    """Report ``LICENSE_KEY`` and ``CONTROL_LICENSE_KEY`` as two distinct live sales."""
    monkeypatch.setattr(
        VERIFY_SEAM,
        _make_verify_stub({LICENSE_KEY: SALE_ID, CONTROL_LICENSE_KEY: CONTROL_SALE_ID}),
    )


def _make_verify_stub(
    sales_by_key: dict[str, str],
) -> Callable[..., Awaitable[GumroadLicenseResult | None]]:
    """Build a verify_license stand-in keyed on the licence key, alpha product only."""

    async def _verify(
        product_id: str,
        license_key: str,
        **_kwargs: object,
    ) -> GumroadLicenseResult | None:
        sale_id = sales_by_key.get(license_key)
        if product_id != PRODUCT_ID or sale_id is None:
            return None
        return GumroadLicenseResult(
            success=True,
            uses=LICENSE_USES,
            purchase=GumroadPurchase(
                email=PURCHASE_EMAIL,
                product_id=PRODUCT_ID,
                sale_id=sale_id,
                refunded=False,
                chargebacked=False,
            ),
        )

    return _verify


@dataclass(frozen=True)
class _Holder:
    """A signed-up account: its id, address and the bearer token it was handed."""

    user_id: int
    email: str
    token: str

    def seed_account(self) -> SeedAccount:
        """The seeder's view of this account."""
        return SeedAccount(user_id=self.user_id, email=self.email)


async def _signup(client: AsyncClient, email: str, license_key: str = LICENSE_KEY) -> Response:
    """POST a licence-gated signup."""
    return await client.post(
        SIGNUP_PATH,
        json={"email": email, "password": PASSWORD, "license_key": license_key},
    )


async def _signed_up(client: AsyncClient, email: str, license_key: str = LICENSE_KEY) -> _Holder:
    """Sign ``email`` up successfully and return the account plus its bearer token."""
    response = await _signup(client, email, license_key)
    assert response.status_code == HTTPStatus.OK, response.text
    body = response.json()
    return _Holder(user_id=int(body["user_id"]), email=email, token=str(body["token"]))


async def _delete(client: AsyncClient, account: _Holder) -> None:
    """Erase ``account`` through the real deletion route."""
    response = await client.request(
        "DELETE",
        DELETE_PATH,
        json={"confirm_email": account.email},
        headers={"Authorization": f"Bearer {account.token}"},
    )
    assert response.status_code == HTTPStatus.OK, response.text


def _fingerprint(response: Response) -> tuple[int, str | None, bytes]:
    """Return everything an unauthenticated observer can see about a rejection."""
    return (response.status_code, response.headers.get("content-type"), response.content)


async def _count(session: AsyncSession, model: type[SQLModel]) -> int:
    """Return the number of ``model`` rows in the test database."""
    result = await session.execute(select(func.count()).select_from(model))
    return int(result.scalar_one())


async def _count_where(
    session: AsyncSession, table: sa.Table, clause: sa.ColumnElement[bool]
) -> int:
    """How many rows of ``table`` satisfy ``clause``."""
    result = await session.execute(sa.select(sa.func.count()).select_from(table).where(clause))
    return int(result.scalar_one())


def _holds_text(column: sa.Column[object]) -> bool:
    """Whether a column stores strings (SQLModel's AutoString hides its python type)."""
    if isinstance(column.type, sa.String):
        return True
    try:
        return column.type.python_type is str
    except NotImplementedError:
        return True


async def _references_to(session: AsyncSession, user_id: int) -> set[str]:
    """Every ``table.column`` pointing at ``user.id`` that still names ``user_id``."""
    named = set()
    for table in SQLModel.metadata.sorted_tables:
        for column in table.columns:
            if not any(fk.column.table.name == "user" for fk in column.foreign_keys):
                continue
            if await _count_where(session, table, column == user_id):
                named.add(f"{table.name}.{column.name}")
    return named


async def _rows_mentioning(session: AsyncSession, email: str) -> set[str]:
    """Every text ``table.column`` that still holds ``email``."""
    named = set()
    for table in SQLModel.metadata.sorted_tables:
        for column in table.columns:
            if _holds_text(column) and await _count_where(session, table, column == email):
                named.add(f"{table.name}.{column.name}")
    return named


async def _binding_holders(session: AsyncSession) -> list[tuple[int, str]]:
    """Every ``(user_id, sale_id)`` binding, oldest first."""
    result = await session.execute(select(LicenseBinding).order_by(col(LicenseBinding.id)))
    return [(row.user_id, row.gumroad_sale_id) for row in result.scalars().all()]


@pytest.mark.asyncio
async def test_a_key_cannot_grant_a_second_account_while_the_first_lives(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The bound key's refusal is the unknown key's refusal, byte for byte."""
    first = await _signed_up(async_client, FIRST_EMAIL)

    bound = await _signup(async_client, SECOND_EMAIL)
    unknown = await _signup(async_client, SECOND_EMAIL, UNKNOWN_LICENSE_KEY)

    assert bound.status_code == HTTPStatus.BAD_REQUEST
    assert bound.json()["detail"] == DETAIL_INVALID_LICENSE
    assert _fingerprint(bound) == _fingerprint(unknown)
    assert await _count(db_session, User) == 1
    assert await _binding_holders(db_session) == [(first.user_id, SALE_ID)]


@pytest.mark.asyncio
async def test_a_deleted_accounts_key_can_be_claimed_by_one_new_account(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Deletion releases the binding; the same key then unlocks exactly one new account."""
    first = await _signed_up(async_client, FIRST_EMAIL)
    await _delete(async_client, first)

    second = await _signed_up(async_client, SECOND_EMAIL)
    third = await _signup(async_client, CONTROL_EMAIL)

    assert third.status_code == HTTPStatus.BAD_REQUEST
    assert await _count(db_session, User) == 1
    assert await _count(db_session, Entitlement) == 1
    assert await _binding_holders(db_session) == [(second.user_id, SALE_ID)]
    entitlement = (await db_session.execute(select(Entitlement))).scalar_one()
    assert entitlement.user_id == second.user_id
    assert entitlement.revoked_at is None


@pytest.mark.asyncio
async def test_reclaiming_a_key_transfers_access_and_nothing_else(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The new holder gets course access and inherits none of the erased account.

    The first account is given a row in every table the schema allows before
    it is erased. Afterwards the reclaiming account must look exactly like a
    control account created with a different key: the same set of populated
    user references, no more; the old address surviving only on the receipt;
    an empty wallet. The control account exists before the deletion so the
    test database cannot hand the erased id straight back to the reclaimer.
    """
    shared_ids = await seed_shared_tables(db_session)
    first = await _signed_up(async_client, FIRST_EMAIL)
    control = await _signed_up(async_client, CONTROL_EMAIL, CONTROL_LICENSE_KEY)
    await seed_one_row_everywhere(db_session, first.seed_account(), shared_ids)
    assert len(await _references_to(db_session, first.user_id)) > len(SURVIVING_EMAIL_COLUMNS)
    await _delete(async_client, first)

    second = await _signed_up(async_client, SECOND_EMAIL)

    assert second.user_id not in {first.user_id, control.user_id}
    assert await _references_to(db_session, first.user_id) == set()
    reclaimed = await _references_to(db_session, second.user_id)
    assert reclaimed == await _references_to(db_session, control.user_id)
    assert {"entitlement.user_id", "licensebinding.user_id"} <= reclaimed
    assert await _rows_mentioning(db_session, first.email) == SURVIVING_EMAIL_COLUMNS
    second_row = await db_session.get(User, second.user_id)
    assert second_row is not None
    await db_session.refresh(second_row)
    assert second_row.offering_balance == 0
    assert sorted(await _binding_holders(db_session)) == sorted(
        [(second.user_id, SALE_ID), (control.user_id, CONTROL_SALE_ID)]
    )
