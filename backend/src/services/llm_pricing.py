"""LLM cost estimation — token counts in, USD :class:`Decimal` out.

Pricing is expressed per one million tokens because that matches how every
provider publishes their rate cards.  The table below is the single source of
truth — updating a price is a one-line change and every caller picks it up on
next request.

BUG-BM-008 / BUG-ADMIN-004: every monetary value flows through
:class:`Decimal` so admin aggregates sum without floating-point drift.
The function never silently returns ``0.0`` for unknown models — that
collapsed "the model is free" and "we forgot to price this model" into
the same value, which made the dashboard's per-model cost view useless.
Today an unknown model returns ``None`` and emits a structured warning
log so ops can either add the price or confirm the freebie intent.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal

logger = logging.getLogger(__name__)

# One million — the denominator for provider rate cards.  ``Decimal``
# constants are constructed via ``str`` so ``Decimal(1_000_000)`` does
# not accidentally absorb float-precision noise — the literal is exact.
_TOKENS_PER_MILLION = Decimal(1000000)

# Six decimal places of precision for stored cost — same scale used by
# :class:`models.llm_usage_log.LLMUsageLog`.  Quantising at write time
# keeps every persisted value reproducible byte-for-byte against the
# pricing table for audit reconciliation.
_COST_QUANTUM = Decimal("0.000001")


@dataclass(frozen=True, slots=True)
class ModelPricing:
    """Per-million-token pricing for a single model.

    ``input_usd_per_million`` and ``output_usd_per_million`` are
    :class:`Decimal` so a 1 USD input price is exactly one dollar — not
    ``0.9999999999998`` after a few rounds of float arithmetic
    (BUG-BM-008).  Each call site builds the value via ``Decimal(str(...))``
    rather than ``Decimal(float)`` to avoid float-binary-precision noise.
    """

    input_usd_per_million: Decimal
    output_usd_per_million: Decimal


def _price(input_value: str, output_value: str) -> ModelPricing:
    """Build a :class:`ModelPricing` from string-quoted decimal literals.

    Helper so the ``MODEL_PRICING`` table reads as cleanly as the
    provider pricing pages it mirrors — no ``Decimal("...")`` clutter
    inline.  Strings (not floats) are mandatory: ``Decimal(0.15)``
    silently absorbs float noise and produces ``Decimal('0.1499999...')``.
    """
    return ModelPricing(
        input_usd_per_million=Decimal(input_value),
        output_usd_per_million=Decimal(output_value),
    )


# Public pricing table — update as providers adjust their rate cards.
# Values are the published list prices at the time of writing; see each
# provider's pricing page for the canonical source.
MODEL_PRICING: dict[str, ModelPricing] = {
    # OpenAI — https://openai.com/api/pricing/
    "gpt-4o-mini": _price("0.15", "0.60"),
    "gpt-4o": _price("2.50", "10.00"),
    # Anthropic — https://www.anthropic.com/pricing
    "claude-sonnet-4-20250514": _price("3.00", "15.00"),
    "claude-3-5-sonnet-20241022": _price("3.00", "15.00"),
    "claude-3-5-haiku-20241022": _price("0.80", "4.00"),
}


def get_model_pricing(model: str) -> ModelPricing | None:
    """Return the :class:`ModelPricing` for ``model`` or ``None`` when unknown."""
    return MODEL_PRICING.get(model)


def estimate_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> Decimal | None:
    """Estimate the USD cost of a single LLM call as a quantised :class:`Decimal`.

    Returns ``None`` for unknown models (BUG-BM-008) so the caller can
    distinguish "we did not record a cost" from "the cost was zero".
    A structured warning is logged so ops can add the missing rate.
    Negative or non-positive token counts are clamped to zero rather
    than rejected — the usage log is observability infrastructure and
    losing a row to a defensive ``ValueError`` would defeat its purpose.

    The returned value is quantised to :data:`_COST_QUANTUM` (six
    decimal places) so the persisted column matches the pricing-table
    arithmetic byte-for-byte during audit reconciliation.
    """
    pricing = MODEL_PRICING.get(model)
    if pricing is None:
        # Structured ``extra`` so dashboards can group "missing-rate"
        # warnings by model without parsing the message string.
        logger.warning(
            "llm_pricing_unknown_model",
            extra={
                "model": model,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
            },
        )
        return None
    safe_prompt = Decimal(max(prompt_tokens, 0))
    safe_completion = Decimal(max(completion_tokens, 0))
    input_cost = safe_prompt / _TOKENS_PER_MILLION * pricing.input_usd_per_million
    output_cost = safe_completion / _TOKENS_PER_MILLION * pricing.output_usd_per_million
    return (input_cost + output_cost).quantize(_COST_QUANTUM)
