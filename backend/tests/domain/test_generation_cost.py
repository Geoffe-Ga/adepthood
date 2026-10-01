"""Pure p95 math for the charged-generation cost alert (#623 PR3).

Record §2: "alert/revisit pricing if p95 provider cost approaches 3.5¢ per
charged generation". Record §4: "p95 cost ≥ 3.5¢ alert | structured warning
plus an admin metric". The percentile is nearest-rank, computed in Python
because SQLite has no ``percentile_cont``.
"""

from __future__ import annotations

import inspect
from decimal import Decimal

import pytest

from domain import generation_cost
from domain.generation_cost import (
    GENERATION_COST_PERCENTILE,
    GENERATION_COST_WINDOW_DAYS,
    P95_CHARGED_GENERATION_COST_ALERT_USD,
    GenerationCostReport,
    build_report,
    nearest_rank_percentile,
)

_LOW = Decimal("0.001000")
_HIGH = Decimal("0.500000")


def _twenty_with_rank_19(value: Decimal) -> list[Decimal]:
    """Twenty samples whose 19th-smallest -- the nearest-rank p95 -- is ``value``."""
    return [_HIGH, value, *([_LOW] * 18)]


def test_the_alert_constants_carry_the_ratified_numbers() -> None:
    """3.5¢, the 95th percentile, and a 30-day window -- named, never inline."""
    assert Decimal("0.035") == P95_CHARGED_GENERATION_COST_ALERT_USD
    assert GENERATION_COST_PERCENTILE == 95
    assert GENERATION_COST_WINDOW_DAYS == 30
    source = inspect.getsource(generation_cost)
    assert "3.5¢ per charged generation" in source
    assert "structured warning plus an admin metric" in source


def test_no_samples_has_no_percentile() -> None:
    """An empty window reports nothing rather than a zero cost."""
    assert nearest_rank_percentile([], 95) is None


def test_one_sample_is_its_own_percentile() -> None:
    """Nearest rank of one value is that value."""
    assert nearest_rank_percentile([Decimal("0.02")], 95) == Decimal("0.02")


def test_twenty_samples_take_the_nineteenth_smallest() -> None:
    """ceil(0.95 * 20) = 19: the 19th value, not the 20th."""
    values = _twenty_with_rank_19(Decimal("0.030000"))
    assert nearest_rank_percentile(values, 95) == Decimal("0.030000")


def test_a_fractional_rank_rounds_up() -> None:
    """ceil(0.95 * 10) = 10: rounding the rank down would read the 9th value."""
    values = [Decimal(n) / 100 for n in range(1, 11)]
    assert nearest_rank_percentile(values, 95) == Decimal("0.10")


@pytest.mark.parametrize(
    ("p95", "over"),
    [
        (Decimal("0.034999"), False),
        (Decimal("0.035000"), True),
        (Decimal("0.035001"), True),
    ],
)
def test_the_report_alerts_at_or_above_the_threshold(p95: Decimal, *, over: bool) -> None:
    """The alert fires at 3.5¢ itself ("approaches"), never just below."""
    report = build_report(_twenty_with_rank_19(p95), unpriced=2)

    assert report == GenerationCostReport(
        window_days=GENERATION_COST_WINDOW_DAYS,
        sample_count=20,
        unpriced_generation_count=2,
        p95_cost_usd=p95,
        threshold_usd=P95_CHARGED_GENERATION_COST_ALERT_USD,
        over_threshold=over,
    )


def test_an_empty_report_is_never_over_threshold() -> None:
    """No charged generations in the window: no percentile, no alert."""
    report = build_report([], unpriced=0)

    assert report.p95_cost_usd is None
    assert report.sample_count == 0
    assert report.over_threshold is False
