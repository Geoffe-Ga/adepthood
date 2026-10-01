"""``GET /admin/generation-cost``: p95 provider cost per charged generation (#623 PR3).

Record §2: "alert/revisit pricing if p95 provider cost approaches 3.5¢ per
charged generation". Record §4: "p95 cost ≥ 3.5¢ alert | structured warning
plus an admin metric". Record §7: "Alerts ship only as structured log warnings
or an admin-visible metric" -- so this is an admin route and a WARNING line,
and nothing is sent anywhere else.

A sample is one charged generation: every usage row sharing a
``generation_id`` with ``charged`` true, summed. BYOK rows, uncharged rows,
pre-PR3 rows with no key and rows outside the window are not samples.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from domain.generation_cost import GENERATION_COST_WINDOW_DAYS
from models.llm_usage_log import LLMUsageLog
from models.user import User
from tests.helpers.log_lines import production_line, records_for

_PATH = "/admin/generation-cost"
_WARNING = "llm_generation_cost_p95_over_threshold"
_LOW = Decimal("0.001000")
_HIGH = Decimal("0.500000")


@dataclass(frozen=True, slots=True)
class _Row:
    """One seeded usage row; ``generation`` None is a pre-PR3 row."""

    generation: str | None
    cost: Decimal | None
    charged: bool | None = True
    age_days: float = 1


async def _signup(client: AsyncClient, email: str) -> dict[str, str]:
    resp = await client.post(
        "/auth/signup",
        json={"email": email, "password": "secret12345"},  # pragma: allowlist secret
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _signup_admin(client: AsyncClient, db_session: AsyncSession) -> dict[str, str]:
    email = "cost_admin@example.com"
    headers = await _signup(client, email)
    await db_session.execute(update(User).where(col(User.email) == email).values(is_admin=True))
    await db_session.commit()
    return headers


async def _seed(db_session: AsyncSession, rows: list[_Row]) -> None:
    user = User(email="cost_seed@example.com", password_hash="x")
    db_session.add(user)
    await db_session.flush()
    assert user.id is not None
    now = datetime.now(UTC)
    for row in rows:
        db_session.add(
            LLMUsageLog(
                user_id=user.id,
                timestamp=now - timedelta(days=row.age_days),
                provider="openai",
                model="gpt-4o-mini",
                prompt_tokens=1,
                completion_tokens=1,
                total_tokens=2,
                estimated_cost_usd=row.cost,
                generation_id=row.generation,
                charged=row.charged,
            )
        )
    await db_session.commit()


def _twenty_generations(rank_19: Decimal) -> list[_Row]:
    """Twenty single-call charged generations whose nearest-rank p95 is ``rank_19``."""
    costs = [_HIGH, rank_19, *([_LOW] * 18)]
    return [_Row(generation=f"g{i:02d}", cost=cost) for i, cost in enumerate(costs)]


async def _read(client: AsyncClient, headers: dict[str, str]) -> dict[str, object]:
    resp = await client.get(_PATH, headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    body: dict[str, object] = resp.json()
    return body


@pytest.mark.asyncio
async def test_anonymous_is_401(async_client: AsyncClient) -> None:
    """No token: authentication fails before the admin check."""
    resp = await async_client.get(_PATH)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_a_non_admin_is_403(async_client: AsyncClient) -> None:
    """A signed-in writer is not an operator."""
    headers = await _signup(async_client, "not_admin_cost@example.com")
    resp = await async_client.get(_PATH, headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("rank_19", "over"),
    [("0.034999", False), ("0.035000", True), ("0.035001", True)],
)
async def test_the_metric_reports_the_exact_p95_against_the_threshold(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    rank_19: str,
    *,
    over: bool,
) -> None:
    """Exact nearest-rank p95; the warning fires exactly once at or above 3.5¢."""
    await _seed(db_session, _twenty_generations(Decimal(rank_19)))
    headers = await _signup_admin(async_client, db_session)
    caplog.set_level(logging.WARNING, logger="services.llm_cost_alerts")
    caplog.clear()

    body = await _read(async_client, headers)

    assert body == {
        "window_days": GENERATION_COST_WINDOW_DAYS,
        "sample_count": 20,
        "unpriced_generation_count": 0,
        "p95_cost_usd": rank_19,
        "threshold_usd": "0.035000",
        "over_threshold": over,
    }
    warnings = records_for(caplog.records, _WARNING)
    assert len(warnings) == (1 if over else 0)
    if over:
        assert warnings[0].levelno == logging.WARNING
        line = production_line(warnings[0])
        assert f"p95_usd={rank_19}" in line
        assert "threshold_usd=0.035000" in line
        assert "samples=20" in line
        assert f"window_days={GENERATION_COST_WINDOW_DAYS}" in line


@pytest.mark.asyncio
async def test_a_two_call_generation_is_one_sample_of_its_summed_cost(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A corrective retry is one generation: 0.02 + 0.02 is one sample of 0.04."""
    await _seed(
        db_session,
        [
            _Row(generation="retried", cost=Decimal("0.020000")),
            _Row(generation="retried", cost=Decimal("0.020000")),
        ],
    )
    headers = await _signup_admin(async_client, db_session)

    body = await _read(async_client, headers)

    assert body["sample_count"] == 1
    assert body["p95_cost_usd"] == "0.040000"
    assert body["over_threshold"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "excluded",
    [
        _Row(generation="byok", cost=Decimal("0.900000"), charged=False),
        _Row(generation="unknown", cost=Decimal("0.900000"), charged=None),
        _Row(generation=None, cost=Decimal("0.900000")),
        _Row(generation="old", cost=Decimal("0.900000"), age_days=GENERATION_COST_WINDOW_DAYS + 1),
    ],
    ids=["byok", "charged-null", "pre-pr3", "outside-window"],
)
async def test_rows_that_are_not_charged_generations_in_the_window_are_not_sampled(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    excluded: _Row,
) -> None:
    """BYOK, unflagged, unkeyed and out-of-window rows never move the p95."""
    await _seed(db_session, [_Row(generation="kept", cost=Decimal("0.010000")), excluded])
    headers = await _signup_admin(async_client, db_session)
    caplog.set_level(logging.WARNING, logger="services.llm_cost_alerts")
    caplog.clear()

    body = await _read(async_client, headers)

    assert body["sample_count"] == 1
    assert body["p95_cost_usd"] == "0.010000"
    assert body["over_threshold"] is False
    assert records_for(caplog.records, _WARNING) == []


@pytest.mark.asyncio
async def test_a_generation_with_an_unpriced_call_is_counted_not_sampled(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Its cost is unknown, so it is neither a zero nor a partial sample."""
    await _seed(
        db_session,
        [
            _Row(generation="priced", cost=Decimal("0.010000")),
            _Row(generation="half", cost=Decimal("0.900000")),
            _Row(generation="half", cost=None),
        ],
    )
    headers = await _signup_admin(async_client, db_session)

    body = await _read(async_client, headers)

    assert body["sample_count"] == 1
    assert body["unpriced_generation_count"] == 1
    assert body["p95_cost_usd"] == "0.010000"


@pytest.mark.asyncio
async def test_an_empty_window_reports_no_percentile_and_no_warning(
    async_client: AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """No charged generations: ``None``, not ``0``, and nothing to alert on."""
    headers = await _signup_admin(async_client, db_session)
    caplog.set_level(logging.WARNING, logger="services.llm_cost_alerts")
    caplog.clear()

    body = await _read(async_client, headers)

    assert body["sample_count"] == 0
    assert body["p95_cost_usd"] is None
    assert body["over_threshold"] is False
    assert records_for(caplog.records, _WARNING) == []
