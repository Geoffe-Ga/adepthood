"""Unit tests for LLM cost estimation."""

from __future__ import annotations

import pytest

from services.llm_pricing import (
    MODEL_PRICING,
    ModelPricing,
    estimate_cost_usd,
    get_model_pricing,
)


class TestEstimateCostUsd:
    """Cost estimation converts token counts + model name into a USD figure."""

    def test_known_openai_model(self) -> None:
        # gpt-4o-mini: $0.15 / 1M input, $0.60 / 1M output
        # 1,000,000 input + 1,000,000 output = $0.15 + $0.60 = $0.75
        cost = estimate_cost_usd("gpt-4o-mini", 1_000_000, 1_000_000)
        assert cost == pytest.approx(0.75)

    def test_known_anthropic_model(self) -> None:
        # claude-sonnet-4-20250514: $3.00 / 1M input, $15.00 / 1M output
        cost = estimate_cost_usd("claude-sonnet-4-20250514", 1_000_000, 1_000_000)
        assert cost == pytest.approx(18.0)

    def test_partial_million_tokens_proportional(self) -> None:
        # 1,500 input tokens at $0.15/1M = $0.000225
        # 500 output tokens at $0.60/1M = $0.0003
        # Total = $0.000525
        cost = estimate_cost_usd("gpt-4o-mini", 1_500, 500)
        assert cost == pytest.approx(0.000525)

    def test_zero_tokens_zero_cost(self) -> None:
        assert estimate_cost_usd("gpt-4o-mini", 0, 0) == 0.0

    def test_unknown_model_returns_zero(self) -> None:
        """Unknown models log $0 so tokens are still captured without guessing price."""
        assert estimate_cost_usd("mystery-model-v99", 1_000, 500) == 0.0

    def test_stub_model_returns_zero(self) -> None:
        """The stub provider reports ``stub`` as its model and must cost nothing."""
        assert estimate_cost_usd("stub", 0, 0) == 0.0

    def test_negative_tokens_treated_as_zero(self) -> None:
        """Defensive: never produce a negative cost even if upstream returns junk."""
        assert estimate_cost_usd("gpt-4o-mini", -5, -5) == 0.0


class TestGetModelPricing:
    def test_returns_pricing_for_known_model(self) -> None:
        pricing = get_model_pricing("gpt-4o-mini")
        assert pricing is not None
        assert pricing.input_usd_per_million > 0
        assert pricing.output_usd_per_million > 0

    def test_returns_none_for_unknown_model(self) -> None:
        assert get_model_pricing("unknown-model") is None


class TestModelPricingTable:
    def test_table_contains_expected_providers(self) -> None:
        """Sanity-check that the bundled pricing table covers both providers."""
        openai_models = [m for m in MODEL_PRICING if m.startswith("gpt-")]
        anthropic_models = [m for m in MODEL_PRICING if m.startswith("claude-")]
        assert openai_models, "expected at least one OpenAI model in pricing table"
        assert anthropic_models, "expected at least one Anthropic model in pricing table"

    def test_all_prices_non_negative(self) -> None:
        for model, pricing in MODEL_PRICING.items():
            assert pricing.input_usd_per_million >= 0, f"{model} input cost is negative"
            assert pricing.output_usd_per_million >= 0, f"{model} output cost is negative"

    def test_model_pricing_is_frozen(self) -> None:
        """``ModelPricing`` is a frozen dataclass so the table cannot be mutated."""
        pricing = ModelPricing(input_usd_per_million=1.0, output_usd_per_million=2.0)
        with pytest.raises(AttributeError):
            pricing.input_usd_per_million = 99.0  # type: ignore[misc]
