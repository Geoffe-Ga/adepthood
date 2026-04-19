"""Tests for the admin usage stats endpoint.

Covers the three layers the endpoint puts together: the per-user admin gate
(anonymous / non-admin / admin), SQL aggregates, and JSON response shape.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from models.journal_entry import JournalEntry
from models.llm_usage_log import LLMUsageLog
from models.user import User


@dataclass(frozen=True, slots=True)
class _UsageLogSpec:
    """Fixture knobs for seeded :class:`LLMUsageLog` rows.

    Grouping the optional attributes on a dataclass keeps ``_seed_usage_log``
    below ruff's argument-count limit without forcing every caller to pass a
    fully populated record.
    """

    provider: str = "openai"
    model: str = "gpt-4o-mini"
    prompt_tokens: int = 100
    completion_tokens: int = 50
    estimated_cost_usd: float = 0.01


async def _signup(client: AsyncClient, email: str, password: str = "secret12345") -> dict[str, str]:
    """Sign up a user and return Authorization headers bearing their JWT."""
    resp = await client.post("/auth/signup", json={"email": email, "password": password})
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _promote_to_admin(db_session: AsyncSession, email: str) -> None:
    """Flip ``is_admin`` for the user with the given email."""
    await db_session.execute(update(User).where(col(User.email) == email).values(is_admin=True))
    await db_session.commit()


async def _signup_admin(
    client: AsyncClient, db_session: AsyncSession, email: str = "admin@example.com"
) -> dict[str, str]:
    """Sign up a user, promote them to admin, and return their Authorization headers."""
    headers = await _signup(client, email)
    await _promote_to_admin(db_session, email)
    return headers


async def _seed_user_and_journal_entry(
    db_session: AsyncSession, email: str = "seed@example.com"
) -> tuple[int, int]:
    """Create a user + a single journal entry; return their ids."""
    user = User(email=email, password_hash="x")
    db_session.add(user)
    await db_session.flush()
    assert user.id is not None

    journal = JournalEntry(
        sender="bot", user_id=user.id, message="hello", timestamp=datetime.now(UTC)
    )
    db_session.add(journal)
    await db_session.flush()
    assert journal.id is not None
    return user.id, journal.id


async def _seed_usage_log(
    db_session: AsyncSession,
    *,
    user_id: int,
    journal_entry_id: int,
    spec: _UsageLogSpec | None = None,
) -> None:
    """Append a single :class:`LLMUsageLog` row.  ``spec`` defaults to the OpenAI fixture."""
    log = spec or _UsageLogSpec()
    db_session.add(
        LLMUsageLog(
            user_id=user_id,
            provider=log.provider,
            model=log.model,
            prompt_tokens=log.prompt_tokens,
            completion_tokens=log.completion_tokens,
            total_tokens=log.prompt_tokens + log.completion_tokens,
            estimated_cost_usd=log.estimated_cost_usd,
            journal_entry_id=journal_entry_id,
        )
    )
    await db_session.flush()


# ── Auth gate ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_endpoint_rejects_anonymous(async_client: AsyncClient) -> None:
    """No Authorization header → 401, not 403 (distinguish auth from authz)."""
    resp = await async_client.get("/admin/usage-stats")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_admin_endpoint_rejects_non_admin(async_client: AsyncClient) -> None:
    """Authenticated but ``is_admin=False`` → 403 ``admin_required``."""
    headers = await _signup(async_client, "normal@example.com")
    resp = await async_client.get("/admin/usage-stats", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "admin_required"


@pytest.mark.asyncio
async def test_admin_endpoint_accepts_admin(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await _signup_admin(async_client, db_session)
    resp = await async_client.get("/admin/usage-stats", headers=headers)
    assert resp.status_code == HTTPStatus.OK


# ── Response shape with empty data ────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_endpoint_empty_totals(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await _signup_admin(async_client, db_session)
    resp = await async_client.get("/admin/usage-stats", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["total_calls"] == 0
    assert data["total_prompt_tokens"] == 0
    assert data["total_completion_tokens"] == 0
    assert data["total_tokens"] == 0
    assert data["total_estimated_cost_usd"] == 0.0
    assert data["per_user"] == []
    assert data["per_model"] == []


# ── Aggregates ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_endpoint_sums_totals(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    headers = await _signup_admin(async_client, db_session)
    user_id, journal_id = await _seed_user_and_journal_entry(db_session)
    await _seed_usage_log(
        db_session,
        user_id=user_id,
        journal_entry_id=journal_id,
        spec=_UsageLogSpec(prompt_tokens=100, completion_tokens=50, estimated_cost_usd=0.01),
    )
    await _seed_usage_log(
        db_session,
        user_id=user_id,
        journal_entry_id=journal_id,
        spec=_UsageLogSpec(prompt_tokens=200, completion_tokens=25, estimated_cost_usd=0.02),
    )
    await db_session.commit()

    resp = await async_client.get("/admin/usage-stats", headers=headers)
    data = resp.json()
    assert data["total_calls"] == 2
    assert data["total_prompt_tokens"] == 300
    assert data["total_completion_tokens"] == 75
    assert data["total_tokens"] == 375
    assert data["total_estimated_cost_usd"] == pytest.approx(0.03)


@pytest.mark.asyncio
async def test_admin_endpoint_per_user_breakdown_ordered_by_cost(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Users are returned highest-spend first so the dashboard top row is hottest."""
    headers = await _signup_admin(async_client, db_session)
    low_user_id, j1 = await _seed_user_and_journal_entry(db_session, "low@example.com")
    high_user_id, j2 = await _seed_user_and_journal_entry(db_session, "high@example.com")
    await _seed_usage_log(
        db_session,
        user_id=low_user_id,
        journal_entry_id=j1,
        spec=_UsageLogSpec(estimated_cost_usd=0.05),
    )
    await _seed_usage_log(
        db_session,
        user_id=high_user_id,
        journal_entry_id=j2,
        spec=_UsageLogSpec(estimated_cost_usd=1.50),
    )
    await db_session.commit()

    resp = await async_client.get("/admin/usage-stats", headers=headers)
    data = resp.json()
    assert len(data["per_user"]) == 2
    assert data["per_user"][0]["user_id"] == high_user_id
    assert data["per_user"][0]["estimated_cost_usd"] == pytest.approx(1.50)
    assert data["per_user"][1]["user_id"] == low_user_id


@pytest.mark.asyncio
async def test_admin_endpoint_per_model_breakdown(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    headers = await _signup_admin(async_client, db_session)
    user_id, journal_id = await _seed_user_and_journal_entry(db_session)
    await _seed_usage_log(
        db_session,
        user_id=user_id,
        journal_entry_id=journal_id,
        spec=_UsageLogSpec(
            provider="openai",
            model="gpt-4o-mini",
            prompt_tokens=100,
            completion_tokens=50,
            estimated_cost_usd=0.01,
        ),
    )
    await _seed_usage_log(
        db_session,
        user_id=user_id,
        journal_entry_id=journal_id,
        spec=_UsageLogSpec(
            provider="anthropic",
            model="claude-sonnet-4-20250514",
            prompt_tokens=200,
            completion_tokens=100,
            estimated_cost_usd=2.00,
        ),
    )
    await db_session.commit()

    resp = await async_client.get("/admin/usage-stats", headers=headers)
    data = resp.json()
    assert len(data["per_model"]) == 2
    # Ordered by descending cost: claude (2.00) before gpt-4o-mini (0.01).
    assert data["per_model"][0]["provider"] == "anthropic"
    assert data["per_model"][0]["model"] == "claude-sonnet-4-20250514"
    assert data["per_model"][0]["total_tokens"] == 300
    assert data["per_model"][1]["provider"] == "openai"
    assert data["per_model"][1]["model"] == "gpt-4o-mini"


@pytest.mark.asyncio
async def test_admin_endpoint_rejects_deleted_admin(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A valid JWT whose user has since been deleted is treated as unauthorized.

    Regression for the privilege-boundary edge case: an admin whose row was
    removed (or a stale token minted before an account purge) must not be
    able to reach the admin surface.
    """
    headers = await _signup_admin(async_client, db_session)
    await db_session.execute(delete(User).where(col(User.email) == "admin@example.com"))
    await db_session.commit()

    resp = await async_client.get("/admin/usage-stats", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "user_not_found"
