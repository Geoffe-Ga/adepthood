"""Shared fixtures-as-functions for the admin feedback triage suites.

Accounts are inserted straight into the database and handed a minted token
rather than signed up over HTTP, and reports are written through the ORM rather
than ``POST /feedback/``: both of those routes carry tight rate limits (signup a
handful per minute, feedback ten an hour per account), and a triage suite needs
more accounts and far more reports than either budget allows. Nothing here is
under test -- the triage routes are -- so going around the intake limits costs
no coverage.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.feedback import FeedbackReport, mint_public_id
from models.feedback_triage import FeedbackNote, FeedbackTriageEvent
from models.user import User
from routers.auth import _create_token

# The prose every seeded report carries unless a test overrides it. Distinct
# words per field so a leak can be traced to the column it came from.
SEED_SUMMARY = "The habit card vanished when I tapped the offer."
SEED_INTENT = "I was trying to log the sit I had just finished."
SEED_EXPECTED = "The card stays on the shelf."
SEED_ACTUAL = "The whole row went blank."


@dataclass(frozen=True)
class Account:
    """One seeded account: its id, its address, and the headers that act as it."""

    user_id: int
    email: str
    headers: dict[str, str]


async def make_account(session: AsyncSession, email: str, *, admin: bool = False) -> Account:
    """Insert a user directly and mint a bearer token for it."""
    user = User(email=email, password_hash="x", is_admin=admin)
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    token, _ = _create_token(user.id)
    return Account(user_id=user.id, email=email, headers={"Authorization": f"Bearer {token}"})


# The report every seed starts from; a test overrides only what it is about.
_REPORT_DEFAULTS: dict[str, str | None] = {
    "category": "broken",
    "impact": "blocked",
    "platform": "ios",
    "viewport_class": "compact",
    "summary": SEED_SUMMARY,
    "intent": SEED_INTENT,
    "expected": SEED_EXPECTED,
    "actual": SEED_ACTUAL,
    "screen": "journal.shelf",
    "control": "habit_offer.accept",
    "app_build": "1.4.2+318",
    "locale": "en-US",
    "correlation_id": None,
    "idem_key": None,
}


async def seed_report(
    session: AsyncSession,
    user_id: int,
    **overrides: str | datetime | None,
) -> FeedbackReport:
    """Write one report through the ORM and return it, refreshed.

    ``overrides`` replaces any column of :data:`_REPORT_DEFAULTS`, and may add
    ``created_at`` to pin the timestamp a paging test needs to tie.
    """
    values: dict[str, str | datetime | None] = {
        **_REPORT_DEFAULTS,
        "created_at": datetime.now(UTC),
        **overrides,
    }
    report = FeedbackReport(user_id=user_id, public_id=mint_public_id(), **values)
    session.add(report)
    await session.commit()
    await session.refresh(report)
    return report


async def force_status(session: AsyncSession, report_id: int, status: str) -> None:
    """Put a report into ``status`` directly, writing no event.

    The FSM matrix tests need every source state, and reaching ``planned`` over
    HTTP would spend two mutations and write two events before the one under
    test -- which both muddies the event-delta assertion and makes the test
    depend on the rate limiter.
    """
    await session.execute(
        update(FeedbackReport).where(col(FeedbackReport.id) == report_id).values(status=status)
    )
    await session.commit()


async def row_count(session: AsyncSession, model: type[FeedbackNote | FeedbackTriageEvent]) -> int:
    """How many rows ``model``'s table holds, read past the identity map."""
    session.expire_all()
    total = await session.scalar(select(func.count()).select_from(model))
    return int(total or 0)


async def report_state(session: AsyncSession, report_id: int) -> tuple[str, int | None]:
    """``(status, duplicate_of_id)`` for one report, read fresh."""
    session.expire_all()
    row = (
        await session.execute(
            select(FeedbackReport.status, FeedbackReport.duplicate_of_id).where(
                col(FeedbackReport.id) == report_id
            )
        )
    ).one()
    return str(row[0]), row[1]
