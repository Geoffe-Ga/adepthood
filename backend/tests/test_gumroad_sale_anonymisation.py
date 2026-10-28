"""Account deletion anonymises the sales linked to the account (#3063 AC15).

The owner ratified the purchase receipt's lifetime on 2026-10-13: at account
deletion, blank the buyer's ``email`` and ``raw_payload`` on every sale linked
to the account, keep the receipt, and stamp ``anonymised_at`` -- the instant
the receipt's 180-day retention counts from. A sale is *linked* when the
account holds its licence binding or received its token-pack credit, the same
join the admin summary uses. A sale never linked to an account keeps its email:
that address is its only claim path.

Each test reads the rows back after a real ``DELETE /users/me``, so the order
matters and is pinned too: the links are only visible before the sweep erases
the binding and clears the credit column.
"""

from __future__ import annotations

from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.retention import REDACT_INSTEAD_OF_DELETE
from models.gumroad_sale import SALE_RESOURCE_NAME, GumroadSale
from models.license_binding import LicenseBinding

_PASSWORD = "securepassword123"  # pragma: allowlist secret
_PAYLOAD = {"sale_id": "placeholder", "email": "placeholder", "price": "1200"}


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int, str]:
    """Create an account; return ``(auth headers, user id, email)``."""
    email = f"{username}@example.com"
    resp = await client.post("/auth/signup", json={"email": email, "password": _PASSWORD})
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"], email


def _sale(sale_id: str, email: str, *, credited_to: int | None = None) -> GumroadSale:
    return GumroadSale(
        gumroad_sale_id=sale_id,
        product_id="prod",
        email=email,
        resource_name=SALE_RESOURCE_NAME,
        raw_payload={**_PAYLOAD, "sale_id": sale_id, "email": email},
        token_pack_credited_at=None if credited_to is None else datetime.now(UTC),
        token_pack_credited_user_id=credited_to,
    )


async def _delete(client: AsyncClient, headers: dict[str, str], email: str) -> None:
    resp = await client.request(
        "DELETE", "/users/me", json={"confirm_email": email}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK


async def _read(session: AsyncSession, sale_id: str) -> GumroadSale:
    session.expire_all()
    result = await session.execute(
        select(GumroadSale).where(col(GumroadSale.gumroad_sale_id) == sale_id)
    )
    return result.scalar_one()


def _assert_anonymised(sale: GumroadSale, *, after: datetime, before: datetime) -> None:
    assert sale.email == ""
    assert sale.raw_payload == {}
    assert sale.anonymised_at is not None
    stamped = sale.anonymised_at.replace(tzinfo=sale.anonymised_at.tzinfo or UTC)
    assert after <= stamped <= before


def _assert_untouched(sale: GumroadSale, email: str) -> None:
    assert sale.email == email
    assert sale.raw_payload["email"] == email
    assert sale.anonymised_at is None


@pytest.mark.asyncio
async def test_a_licence_bound_sale_is_blanked_stamped_and_kept(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The licence path: the binding links the sale, so deletion anonymises it."""
    headers, user_id, email = await _signup(async_client, "licensed")
    db_session.add(_sale("bound-sale", email))
    db_session.add(LicenseBinding(user_id=user_id, gumroad_sale_id="bound-sale", product_id="p"))
    await db_session.commit()

    started = datetime.now(UTC)
    await _delete(async_client, headers, email)

    _assert_anonymised(
        await _read(db_session, "bound-sale"), after=started, before=datetime.now(UTC)
    )


@pytest.mark.asyncio
async def test_a_token_pack_sale_is_blanked_and_keeps_its_credit_guard(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The token-pack path: the credit links the sale; the exactly-once guard survives."""
    headers, user_id, email = await _signup(async_client, "packer")
    db_session.add(_sale("pack-sale", email, credited_to=user_id))
    await db_session.commit()

    started = datetime.now(UTC)
    await _delete(async_client, headers, email)

    sale = await _read(db_session, "pack-sale")
    _assert_anonymised(sale, after=started, before=datetime.now(UTC))
    assert sale.token_pack_credited_at is not None
    assert sale.token_pack_credited_user_id is None


@pytest.mark.asyncio
async def test_an_unlinked_sale_keeps_its_email_even_under_the_deleted_address(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Never linked, so never anonymised: the address is its only claim path.

    The sale carries the deleted account's own address, so a sweep matching on
    email rather than on the link would blank it -- this is the case that
    tells the two apart.
    """
    headers, _, email = await _signup(async_client, "unclaimed")
    db_session.add(_sale("unclaimed-sale", email))
    await db_session.commit()

    await _delete(async_client, headers, email)

    _assert_untouched(await _read(db_session, "unclaimed-sale"), email)


@pytest.mark.asyncio
async def test_another_accounts_linked_sale_is_untouched(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Only the deleted account's links count; a bystander's receipts keep everything."""
    headers, _, email = await _signup(async_client, "leaver")
    _, bystander_id, bystander_email = await _signup(async_client, "stayer")
    db_session.add(_sale("stayer-pack", bystander_email, credited_to=bystander_id))
    db_session.add(_sale("stayer-licence", bystander_email))
    db_session.add(
        LicenseBinding(user_id=bystander_id, gumroad_sale_id="stayer-licence", product_id="p")
    )
    await db_session.commit()

    await _delete(async_client, headers, email)

    _assert_untouched(await _read(db_session, "stayer-pack"), bystander_email)
    _assert_untouched(await _read(db_session, "stayer-licence"), bystander_email)


def test_the_blanked_columns_are_the_registry_redaction() -> None:
    """The deletion path blanks exactly the columns the retention rule names."""
    assert REDACT_INSTEAD_OF_DELETE["gumroadsale"] == ("email", "raw_payload")
