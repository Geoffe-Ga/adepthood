"""Tests for the Gumroad ping webhook (POST /webhooks/gumroad/ping).

Contract: shared-secret query param checked (constant-time) before the form
body is parsed; valid pings persist exactly one GumroadSale row keyed by
gumroad_sale_id (idempotent replay); unknown resource_name values still
persist but log reason_code=unhandled_event; malformed payloads are rejected
with 400 and write nothing.
"""

from __future__ import annotations

import logging
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.gumroad_sale import GumroadSale

WEBHOOK_PATH = "/webhooks/gumroad/ping"
WEBHOOK_SECRET = "gumroad-webhook-shared-secret-test-only"  # pragma: allowlist secret


def _sale_payload(**overrides: str) -> dict[str, str]:
    """Build a form-encoded Gumroad ping payload, with optional overrides."""
    payload = {
        "sale_id": "S-100",
        "product_id": "prod_abc123",
        "email": "buyer@example.com",
        "resource_name": "sale",
        "is_recurring_charge": "false",
        "refunded": "false",
    }
    payload.update(overrides)
    return payload


async def _count_sales(db_session: AsyncSession) -> int:
    """Return the number of GumroadSale rows in the test database."""
    result = await db_session.execute(select(func.count()).select_from(GumroadSale))
    return int(result.scalar_one())


@pytest.fixture
def webhook_secret(monkeypatch: pytest.MonkeyPatch) -> str:
    """Set GUMROAD_WEBHOOK_SECRET for the duration of a test."""
    monkeypatch.setenv("GUMROAD_WEBHOOK_SECRET", WEBHOOK_SECRET)
    return WEBHOOK_SECRET


@pytest.mark.asyncio
async def test_valid_sale_ping_persists_one_row_with_verbatim_payload(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """A valid secret + sale payload returns 200 and stores the payload verbatim."""
    payload = _sale_payload()
    response = await async_client.post(
        WEBHOOK_PATH, params={"secret": webhook_secret}, data=payload
    )

    assert response.status_code == HTTPStatus.OK
    assert await _count_sales(db_session) == 1

    row = (await db_session.execute(select(GumroadSale))).scalar_one()
    assert row.gumroad_sale_id == "S-100"
    assert row.product_id == "prod_abc123"
    assert row.email == "buyer@example.com"
    assert row.resource_name == "sale"
    assert row.is_recurring_charge is False
    assert row.refunded is False
    assert row.raw_payload == payload
    assert row.created_at is not None


@pytest.mark.asyncio
async def test_replaying_identical_payload_keeps_exactly_one_row(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """Replaying the same sale_id returns 200 both times but writes one row."""
    payload = _sale_payload()

    first = await async_client.post(WEBHOOK_PATH, params={"secret": webhook_secret}, data=payload)
    second = await async_client.post(WEBHOOK_PATH, params={"secret": webhook_secret}, data=payload)

    assert first.status_code == HTTPStatus.OK
    assert second.status_code == HTTPStatus.OK
    assert await _count_sales(db_session) == 1


@pytest.mark.asyncio
async def test_wrong_secret_returns_401_and_writes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A wrong secret is rejected with 401, logged, and persists zero rows."""
    assert webhook_secret == WEBHOOK_SECRET
    caplog.set_level(logging.DEBUG)

    response = await async_client.post(
        WEBHOOK_PATH,
        params={"secret": "not-the-secret"},  # pragma: allowlist secret
        data=_sale_payload(),
    )

    assert response.status_code == HTTPStatus.UNAUTHORIZED
    assert "reason_code=invalid_signature" in caplog.text
    assert await _count_sales(db_session) == 0


@pytest.mark.asyncio
async def test_missing_secret_returns_401_and_writes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """A ping without the secret query param is rejected with 401, zero rows."""
    assert webhook_secret == WEBHOOK_SECRET

    response = await async_client.post(WEBHOOK_PATH, data=_sale_payload())

    assert response.status_code == HTTPStatus.UNAUTHORIZED
    assert await _count_sales(db_session) == 0


@pytest.mark.asyncio
async def test_secret_is_checked_before_body_parsing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """A wrong secret with a malformed body still yields 401, not 400."""
    assert webhook_secret == WEBHOOK_SECRET
    malformed = _sale_payload()
    del malformed["sale_id"]

    response = await async_client.post(
        WEBHOOK_PATH,
        params={"secret": "not-the-secret"},  # pragma: allowlist secret
        data=malformed,
    )

    assert response.status_code == HTTPStatus.UNAUTHORIZED
    assert await _count_sales(db_session) == 0


@pytest.mark.asyncio
async def test_unknown_resource_name_is_persisted_and_flagged(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An unknown resource_name still persists the row and logs unhandled_event."""
    caplog.set_level(logging.DEBUG)
    payload = _sale_payload(resource_name="weird_event", is_recurring_charge="true")

    response = await async_client.post(
        WEBHOOK_PATH, params={"secret": webhook_secret}, data=payload
    )

    assert response.status_code == HTTPStatus.OK
    assert "reason_code=unhandled_event" in caplog.text
    assert await _count_sales(db_session) == 1

    row = (await db_session.execute(select(GumroadSale))).scalar_one()
    assert row.resource_name == "weird_event"
    assert row.is_recurring_charge is True
    assert row.raw_payload == payload


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "resource_name",
    ["refund", "dispute", "cancellation", "subscription_ended"],
)
async def test_known_event_persists_without_unhandled_flag(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
    caplog: pytest.LogCaptureFixture,
    resource_name: str,
) -> None:
    """Each known event type returns 200, persists one row, no unhandled log."""
    caplog.set_level(logging.DEBUG)
    payload = _sale_payload(resource_name=resource_name)

    response = await async_client.post(
        WEBHOOK_PATH, params={"secret": webhook_secret}, data=payload
    )

    assert response.status_code == HTTPStatus.OK
    assert "reason_code=unhandled_event" not in caplog.text
    assert await _count_sales(db_session) == 1

    row = (await db_session.execute(select(GumroadSale))).scalar_one()
    assert row.resource_name == resource_name


@pytest.mark.asyncio
async def test_payload_missing_sale_id_returns_400_and_writes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A payload without sale_id is rejected with 400 and persists zero rows."""
    caplog.set_level(logging.DEBUG)
    malformed = _sale_payload()
    del malformed["sale_id"]

    response = await async_client.post(
        WEBHOOK_PATH, params={"secret": webhook_secret}, data=malformed
    )

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert "reason_code=malformed_payload" in caplog.text
    assert await _count_sales(db_session) == 0


@pytest.mark.asyncio
async def test_concurrent_replay_collapses_via_unique_constraint(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the dedupe pre-check misses a race, the unique index still wins.

    Forcing ``_sale_already_recorded`` to report "new" simulates two concurrent
    replays where neither saw the other's row yet. The second insert must hit
    the unique constraint, roll back cleanly (200, not 500), and leave one row.
    """
    payload = _sale_payload()
    first = await async_client.post(WEBHOOK_PATH, params={"secret": webhook_secret}, data=payload)
    assert first.status_code == HTTPStatus.OK

    async def _never_recorded(_session: AsyncSession, _sale_id: str) -> bool:
        return False

    monkeypatch.setattr("routers.gumroad._sale_already_recorded", _never_recorded)
    second = await async_client.post(WEBHOOK_PATH, params={"secret": webhook_secret}, data=payload)

    assert second.status_code == HTTPStatus.OK
    assert await _count_sales(db_session) == 1


def test_gumroad_sale_created_at_defaults_to_timezone_aware() -> None:
    """A freshly constructed GumroadSale gets a timezone-aware created_at."""
    row = GumroadSale(
        gumroad_sale_id="S-200",
        product_id="prod_abc123",
        email="buyer@example.com",
        resource_name="sale",
        is_recurring_charge=False,
        refunded=False,
        raw_payload={"sale_id": "S-200"},
    )
    assert row.created_at is not None
    assert row.created_at.tzinfo is not None
