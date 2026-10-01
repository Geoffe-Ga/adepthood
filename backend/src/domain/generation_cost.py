"""p95 provider cost per charged generation: the pure half of the alert (#623 PR3).

The ratified record (``prompts/claude-comms/2026-09-05-resonance-economy-decision.md``)
asks the code to "alert/revisit pricing if p95 provider cost approaches 3.5¢ per
charged generation" (§2), delivered as a "structured warning plus an admin
metric" (§4), and nothing more: "Alerts ship only as structured log warnings or
an admin-visible metric" (§7).

This module holds only the numbers and the arithmetic. The query that gathers
one cost per charged generation, and the warning, live in
:mod:`services.llm_cost_alerts`. The percentile is nearest-rank and computed in
Python, because SQLite (the test database) has no ``percentile_cont``.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

#: The alert threshold in USD. Record §2: "alert/revisit pricing if p95 provider
#: cost approaches 3.5¢ per charged generation". The comparison is ``>=``, so a
#: p95 of exactly 3.5¢ alerts: "approaches" never waits to be exceeded.
P95_CHARGED_GENERATION_COST_ALERT_USD = Decimal("0.035")

#: Which percentile the alert reads. Record §2 names the p95.
GENERATION_COST_PERCENTILE = 95

#: How far back the metric looks, in days. Record §4 maps the alert to a
#: "structured warning plus an admin metric" without naming a window; 30 days
#: matches the monthly allowance's own cycle, so one month's generations are
#: priced together.
GENERATION_COST_WINDOW_DAYS = 30

# Percentages are out of a hundred.
_PERCENT = 100


def nearest_rank_percentile(values: Sequence[Decimal], pct: int) -> Decimal | None:
    """Return the nearest-rank ``pct``-th percentile of ``values``, ``None`` when empty.

    The rank is ``ceil(pct * n / 100)`` (1-based), so the value returned is
    always one that was observed -- never an interpolation between two.
    """
    if not values:
        return None
    ordered = sorted(values)
    rank = -(-pct * len(ordered) // _PERCENT)
    return ordered[rank - 1]


@dataclass(frozen=True, slots=True)
class GenerationCostReport:
    """The admin metric: p95 cost per charged generation over the window.

    ``sample_count`` counts priced charged generations. A generation with any
    unpriced call has no known cost, so it is counted in
    ``unpriced_generation_count`` instead of being sampled as zero.
    """

    window_days: int
    sample_count: int
    unpriced_generation_count: int
    p95_cost_usd: Decimal | None
    threshold_usd: Decimal
    over_threshold: bool


def build_report(
    costs: Sequence[Decimal],
    *,
    unpriced: int,
    window_days: int = GENERATION_COST_WINDOW_DAYS,
) -> GenerationCostReport:
    """Price ``costs`` (one per priced charged generation) against the threshold."""
    p95 = nearest_rank_percentile(costs, GENERATION_COST_PERCENTILE)
    return GenerationCostReport(
        window_days=window_days,
        sample_count=len(costs),
        unpriced_generation_count=unpriced,
        p95_cost_usd=p95,
        threshold_usd=P95_CHARGED_GENERATION_COST_ALERT_USD,
        over_threshold=p95 is not None and p95 >= P95_CHARGED_GENERATION_COST_ALERT_USD,
    )
