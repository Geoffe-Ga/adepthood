"""Beta reports are kept for a bounded window, and the sweep is real.

A retention *policy* is a sentence in a document. A retention *sweep* is what
makes the sentence true, and the difference between the two is the whole point
of these tests: the privacy policy tells a reporter their words are deleted
after a fixed number of days, and nothing but a working sweep keeps that
promise.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.feedback import FEEDBACK_RETENTION_DAYS, FeedbackReport
from models.user import User
from services.feedback import delete_expired_feedback_reports


async def _signup(client: AsyncClient, email: str) -> tuple[int, dict[str, str]]:
    """Create an account and return its id and auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={"email": email, "password": "secret12345"},  # pragma: allowlist secret
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return int(body["user_id"]), {"Authorization": f"Bearer {body['token']}"}


async def _signup_admin(
    client: AsyncClient, db_session: AsyncSession
) -> tuple[int, dict[str, str]]:
    """Create an account and promote it to admin."""
    user_id, headers = await _signup(client, "admin@example.com")
    await db_session.execute(
        update(User).where(col(User.email) == "admin@example.com").values(is_admin=True)
    )
    await db_session.commit()
    return user_id, headers


def _report(user_id: int, *, age_days: int, public_id: str) -> FeedbackReport:
    """A minimal report aged ``age_days`` into the past."""
    return FeedbackReport(
        user_id=user_id,
        public_id=public_id,
        category="broken",
        impact="blocked",
        platform="ios",
        viewport_class="compact",
        summary="Something went wrong.",
        screen="journal.shelf",
        app_build="1.4.2",
        created_at=datetime.now(UTC) - timedelta(days=age_days),
    )


@pytest.mark.asyncio
async def test_the_sweep_removes_rows_past_the_horizon_and_keeps_rows_inside_it(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Both halves, because a sweep that deletes everything also passes half of this."""
    user_id, _ = await _signup(async_client, "sweep@example.com")
    db_session.add_all(
        [
            _report(user_id, age_days=FEEDBACK_RETENTION_DAYS + 1, public_id="FB-23456789"),
            _report(user_id, age_days=FEEDBACK_RETENTION_DAYS - 1, public_id="FB-34567892"),
        ]
    )
    await db_session.commit()

    deleted = await delete_expired_feedback_reports(db_session)

    assert deleted == 1
    surviving = (await db_session.execute(select(FeedbackReport))).scalars().all()
    assert [report.public_id for report in surviving] == ["FB-34567892"]


@pytest.mark.asyncio
async def test_the_sweep_refuses_a_non_positive_window(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``<= 0`` would put the cutoff at or after now and erase everything.

    Refused rather than clamped: a caller who passes zero has a bug, and
    silently treating it as "delete nothing" hides the bug while silently
    treating it as "delete everything" is a catastrophe.
    """
    user_id, _ = await _signup(async_client, "guard@example.com")
    db_session.add(_report(user_id, age_days=1, public_id="FB-45678923"))
    await db_session.commit()

    with pytest.raises(ValueError, match="older_than_days"):
        await delete_expired_feedback_reports(db_session, older_than_days=0)

    assert (await db_session.execute(select(FeedbackReport))).scalars().all()


@pytest.mark.asyncio
async def test_the_admin_maintenance_route_runs_the_sweep(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The cron-reachable integration point, reporting what it did."""
    admin_id, headers = await _signup_admin(async_client, db_session)
    db_session.add_all(
        [
            _report(admin_id, age_days=FEEDBACK_RETENTION_DAYS + 5, public_id="FB-56789234"),
            _report(admin_id, age_days=2, public_id="FB-67892345"),
        ]
    )
    await db_session.commit()

    resp = await async_client.post("/admin/maintenance/feedback-reports", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"deleted": 1, "older_than_days": FEEDBACK_RETENTION_DAYS}
    remaining = (await db_session.execute(select(FeedbackReport))).scalars().all()
    assert len(remaining) == 1


@pytest.mark.asyncio
async def test_the_admin_maintenance_route_requires_an_admin(async_client: AsyncClient) -> None:
    """An ordinary account cannot sweep anybody's reports, including its own."""
    await _signup(async_client, "plain@example.com")
    _, headers = await _signup(async_client, "plain2@example.com")

    resp = await async_client.post("/admin/maintenance/feedback-reports", headers=headers)

    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_the_admin_maintenance_route_refuses_a_non_positive_window(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The declared query bound refuses zero before the route body runs."""
    _, headers = await _signup_admin(async_client, db_session)

    resp = await async_client.post(
        "/admin/maintenance/feedback-reports",
        params={"older_than_days": 0},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"][0]["loc"] == ["query", "older_than_days"]
