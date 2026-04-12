"""LLM cost estimation — token counts in, USD out.

Pricing is expressed per one million tokens because that matches how every
provider publishes their rate cards.  The table below is the single source of
truth — updating a price is a one-line change and every caller picks it up on
next request.

Cost estimation is intentionally defensive: unknown models, zero token counts,
and negative/garbage inputs all return ``0.0`` rather than raising.  The usage
log's purpose is observability, and crashing on a surprise model name would be
a regression from "no visibility" to "broken chat" — the opposite of the goal.
"""

from __future__ import annotations

from dataclasses import dataclass

# One million — the denominator for provider rate cards.
_TOKENS_PER_MILLION = 1_000_000


@dataclass(frozen=True, slots=True)
class ModelPricing:
    """Per-million-token pricing for a single model."""

    input_usd_per_million: float
    output_usd_per_million: float


# Public pricing table — update as providers adjust their rate cards.  Values
# are the published list prices at the time of writing; see each provider's
# pricing page for the canonical source.
MODEL_PRICING: dict[str, ModelPricing] = {
    # OpenAI — https://openai.com/api/pricing/
    "gpt-4o-mini": ModelPricing(input_usd_per_million=0.15, output_usd_per_million=0.60),
    "gpt-4o": ModelPricing(input_usd_per_million=2.50, output_usd_per_million=10.00),
    # Anthropic — https://www.anthropic.com/pricing
    "claude-sonnet-4-20250514": ModelPricing(
        input_usd_per_million=3.00, output_usd_per_million=15.00
    ),
    "claude-3-5-sonnet-20241022": ModelPricing(
        input_usd_per_million=3.00, output_usd_per_million=15.00
    ),
    "claude-3-5-haiku-20241022": ModelPricing(
        input_usd_per_million=0.80, output_usd_per_million=4.00
    ),
}


def get_model_pricing(model: str) -> ModelPricing | None:
    """Return the :class:`ModelPricing` for ``model`` or ``None`` when unknown."""
    return MODEL_PRICING.get(model)


def estimate_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    """Estimate the USD cost of a single LLM call.

    Returns ``0.0`` for unknown models or non-positive token counts so that
    observability never breaks the chat path.  The caller is expected to log
    the raw token counts alongside this estimate — cost is derived data, not
    the source of truth.
    """
    pricing = MODEL_PRICING.get(model)
    if pricing is None:
        return 0.0
    safe_prompt = max(prompt_tokens, 0)
    safe_completion = max(completion_tokens, 0)
    input_cost = safe_prompt / _TOKENS_PER_MILLION * pricing.input_usd_per_million
    output_cost = safe_completion / _TOKENS_PER_MILLION * pricing.output_usd_per_million
    return input_cost + output_cost
