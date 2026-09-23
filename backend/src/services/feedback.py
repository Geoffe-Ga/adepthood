"""Retention sweep for private beta reports.

``feedbackreport`` rows have no TTL of their own, and unkeyed submissions are
not deduplicated, so the table grows for as long as the beta runs. The policy
this enforces is the one the privacy policy states, read from the same constant
so the document and the code cannot drift.

It lives in ``services`` rather than in the router for the reason the energy
sweep does: ``routers/admin.py`` imports ``dependencies.*``, ``domain.*``,
``models.*``, ``schemas.*`` and ``services.*``, and has no ``from routers.``
import at all. Its existing maintenance route reaches ``services.energy``, and
this one reaches here.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from models.feedback import FEEDBACK_RETENTION_DAYS, FeedbackReport
from services.feedback_triage import purge_feedback_reports

logger = logging.getLogger(__name__)


async def delete_expired_feedback_reports(
    session: AsyncSession,
    *,
    older_than_days: int = FEEDBACK_RETENTION_DAYS,
) -> int:
    """Delete feedback reports older than ``older_than_days`` and commit.

    Returns the number of rows removed. ``older_than_days`` must be positive --
    ``<= 0`` would put the cutoff at or after "now" and erase every report in
    the table, including ones submitted a moment ago, so it is refused rather
    than clamped.
    """
    if older_than_days <= 0:
        msg = "older_than_days must be positive"
        raise ValueError(msg)
    cutoff = datetime.now(UTC) - timedelta(days=older_than_days)
    # The reports' notes, triage events and inbound duplicate links go first,
    # in the same transaction (see ``purge_feedback_reports``).
    deleted = await purge_feedback_reports(session, lambda: col(FeedbackReport.created_at) < cutoff)
    await session.commit()
    if deleted < 0:
        # The driver doesn't report rowcount; surface it rather than silently
        # claiming zero deletions.
        logger.warning("feedbackreport cleanup ran but the driver did not report a row count")
        return 0
    return deleted
