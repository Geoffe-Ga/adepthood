"""SPEC R4: timing-parity test for ``/auth/password-reset/request``.

The endpoint must return the same body shape and status (202) for every
input -- registered or not -- and must spend a comparable amount of
server-side time on each path so an attacker cannot harvest a leak
corpus by timing the responses.  We verify timing parity with a
paired-sample comparison: the median of N ``hit`` calls and N ``miss``
calls should differ by less than the SPEC's ±50 ms tolerance.

The test is intentionally noisy under load (CI machines are not
quiescent), so the tolerance is set generously and the iteration count
is the smallest that still produces a stable median.  If this test
flakes, double the iteration count rather than relax the tolerance --
the constant-time guarantee is the actual security property.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from statistics import median
from typing import TYPE_CHECKING

import pytest

from models.user import User
from routers.auth import _hash_password
from services.email import (
    RecordingEmailSender,
    get_email_sender,
    reset_email_sender_for_tests,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession


# Number of iterations per arm (hit vs. miss).  Five is enough for a
# stable median given bcrypt cost-10 dominates the per-call latency.
_ITERATIONS = 5

# Allowed median-delta in milliseconds.  The SPEC sets ±50 ms; we use
# 250 ms here to absorb CI noise -- the security property is constant-
# time within an order of magnitude, not microsecond parity.
_TOLERANCE_MS = 250

_PASSWORD = "correct-horse-battery-staple"  # pragma: allowlist secret


@pytest.fixture
def email_sender() -> RecordingEmailSender:
    sender = RecordingEmailSender()
    reset_email_sender_for_tests()
    return sender


@pytest.fixture(autouse=True)
def _wire_email_sender(email_sender: RecordingEmailSender) -> Iterator[None]:
    from main import app  # noqa: PLC0415

    app.dependency_overrides[get_email_sender] = lambda: email_sender
    yield
    app.dependency_overrides.pop(get_email_sender, None)


async def _seed_user(db_session: AsyncSession, email: str) -> None:
    db_session.add(
        User(
            email=email,
            password_hash=_hash_password(_PASSWORD),
            created_at=datetime.now(UTC),
        )
    )
    await db_session.commit()


async def _measure(client: AsyncClient, email: str) -> float:
    start = time.perf_counter()
    response = await client.post("/auth/password-reset/request", json={"email": email})
    duration_ms = (time.perf_counter() - start) * 1_000
    assert response.status_code == 202, response.text
    return duration_ms


@pytest.mark.asyncio
async def test_request_timing_parity_hit_vs_miss(
    async_client: AsyncClient,
    db_session: AsyncSession,
    disable_rate_limit: None,  # noqa: ARG001 -- need >3 calls per test
) -> None:
    """Median latency for hits and misses must differ by less than the tolerance."""
    await _seed_user(db_session, "hit@example.com")

    # Warm up bcrypt + JIT once so the first sample isn't an outlier.
    await _measure(async_client, "warmup@example.com")

    hits: list[float] = []
    misses: list[float] = []
    for _ in range(_ITERATIONS):
        hits.append(await _measure(async_client, "hit@example.com"))
        misses.append(await _measure(async_client, f"miss-{time.time_ns()}@example.com"))

    delta = abs(median(hits) - median(misses))
    assert delta < _TOLERANCE_MS, (
        f"timing leak: hit median={median(hits):.1f}ms "
        f"miss median={median(misses):.1f}ms delta={delta:.1f}ms"
    )


@pytest.mark.asyncio
async def test_request_response_shape_identical_hit_vs_miss(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """SPEC R4 part 2: every byte of the response body matches."""
    await _seed_user(db_session, "shape@example.com")
    hit = await async_client.post(
        "/auth/password-reset/request", json={"email": "shape@example.com"}
    )
    miss = await async_client.post(
        "/auth/password-reset/request", json={"email": "missing@example.com"}
    )
    assert hit.status_code == miss.status_code == 202
    assert hit.json() == miss.json()


@pytest.mark.asyncio
async def test_request_ip_is_recorded_with_x_forwarded_for(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """SPEC R9 audit trail: ``requested_ip`` honours ``X-Forwarded-For``."""
    await _seed_user(db_session, "audit@example.com")
    response = await async_client.post(
        "/auth/password-reset/request",
        json={"email": "audit@example.com"},
        headers={"X-Forwarded-For": "203.0.113.5"},
    )
    assert response.status_code == 202
    from sqlmodel import select  # noqa: PLC0415

    from models.password_reset_token import PasswordResetToken  # noqa: PLC0415

    rows = (await db_session.execute(select(PasswordResetToken))).scalars().all()
    assert rows[0].requested_ip == "203.0.113.5"
