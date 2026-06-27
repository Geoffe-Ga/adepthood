"""Tests for the ``extract_token_count`` helper and ``LLMResponse`` token math."""

from __future__ import annotations

from services.botmason import LLMResponse, extract_token_count


def test_extract_token_count_picks_first_present_attribute() -> None:
    expected = 7

    class Usage:
        prompt_tokens = 42
        input_tokens = expected

    assert extract_token_count(Usage(), "input_tokens", "prompt_tokens") == expected


def test_extract_token_count_falls_back_when_first_missing() -> None:
    expected = 9

    class Usage:
        prompt_tokens = expected

    assert extract_token_count(Usage(), "input_tokens", "prompt_tokens") == expected


def test_extract_token_count_returns_zero_when_source_is_none() -> None:
    assert extract_token_count(None, "prompt_tokens") == 0


def test_extract_token_count_clamps_negatives_to_zero() -> None:
    class Usage:
        prompt_tokens = -3

    assert extract_token_count(Usage(), "prompt_tokens") == 0


def test_extract_token_count_ignores_non_numeric_values() -> None:
    expected = 5

    class Usage:
        prompt_tokens = "not-a-number"
        input_tokens = expected

    assert extract_token_count(Usage(), "prompt_tokens", "input_tokens") == expected


def test_llm_response_total_tokens_derived() -> None:
    prompt = 100
    completion = 25
    response = LLMResponse(
        text="hi",
        provider="openai",
        model="gpt-4o-mini",
        prompt_tokens=prompt,
        completion_tokens=completion,
    )
    assert response.total_tokens == prompt + completion
