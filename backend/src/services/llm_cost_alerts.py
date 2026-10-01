"""The p95 charged-generation cost metric and its warning (#623 PR3).

Record §2 of ``prompts/claude-comms/2026-09-05-resonance-economy-decision.md``:
"alert/revisit pricing if p95 provider cost approaches 3.5¢ per charged
generation". Record §4 delivers it as a "structured warning plus an admin
metric", and §7 limits it to exactly that: "Alerts ship only as structured log
warnings or an admin-visible metric". So this computes the metric on an
explicit admin read and logs one WARNING when it is over the threshold; it
pages, mails and posts nothing.

A sample is one charged generation: the usage rows sharing a
``generation_id`` whose ``charged`` flag is true, summed. Rows written before
the key existed (``NULL``), BYOK and uncharged rows, and rows older than the
window are not samples. A generation with any unpriced call is counted apart,
never sampled as zero.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import func, select
from sqlmodel import col

from domain.generation_cost import (
    GENERATION_COST_WINDOW_DAYS,
    GenerationCostReport,
    build_report,
)
from models.llm_usage_log import LLMUsageLog

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# Six decimal places: the storage scale of ``LLMUsageLog.estimated_cost_usd``
# and the admin wire format, so the warning and the metric print one value.
_USD_QUANTUM = Decimal("0.000001")


def _usd(value: Decimal | None) -> str | None:
    """Render a cost as the admin endpoints do: fixed-point, six places."""
    return None if value is None else format(value.quantize(_USD_QUANTUM), "f")


async def _generation_costs(session: AsyncSession, since: datetime) -> tuple[list[Decimal], int]:
    """Return one summed cost per priced charged generation, and the unpriced count."""
    rows = (
        await session.execute(
            select(
                func.sum(col(LLMUsageLog.estimated_cost_usd)),
                func.count(col(LLMUsageLog.id)),
                func.count(col(LLMUsageLog.estimated_cost_usd)),
            )
            .where(
                col(LLMUsageLog.charged).is_(True),
                col(LLMUsageLog.generation_id).is_not(None),
                col(LLMUsageLog.timestamp) >= since,
            )
            .group_by(col(LLMUsageLog.generation_id))
        )
    ).all()
    costs = [Decimal(cost) for cost, calls, priced in rows if priced == calls]
    return costs, len(rows) - len(costs)


async def charged_generation_cost_report(
    session: AsyncSession, *, now: datetime
) -> GenerationCostReport:
    """Compute the p95 cost per charged generation; warn once when it is over.

    The warning's numbers are in its message, not only in ``extra``, because
    the production formatter prints only the message.
    """
    since = now - timedelta(days=GENERATION_COST_WINDOW_DAYS)
    costs, unpriced = await _generation_costs(session, since)
    report = build_report(costs, unpriced=unpriced)
    if report.over_threshold:
        logger.warning(
            "llm_generation_cost_p95_over_threshold p95_usd=%s threshold_usd=%s samples=%d"
            " window_days=%d",
            _usd(report.p95_cost_usd),
            _usd(report.threshold_usd),
            report.sample_count,
            report.window_days,
            extra={
                "p95_usd": _usd(report.p95_cost_usd),
                "threshold_usd": _usd(report.threshold_usd),
                "samples": report.sample_count,
                "unpriced_generations": report.unpriced_generation_count,
                "window_days": report.window_days,
            },
        )
    return report
