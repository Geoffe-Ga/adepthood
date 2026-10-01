"""Pure settlement helpers in :mod:`services.llm_usage` (#623 PR3).

Record §2 asks to "meter real input/output tokens and corrective attempts";
these helpers turn one generation's provider responses into the counts its
``llm_generation_settled`` line carries, and name the outcome from the same
refund reason the wallet audit row records.
"""

from __future__ import annotations

import logging
from decimal import Decimal

import pytest

from models.wallet_audit import (
    BUCKET_MONTHLY,
    GENERATION_REFUND_REASONS,
    REASON_REFUND_FAILED_ESSAY,
    REASON_REFUND_FAILED_RESONANCE,
    REASON_REFUND_NO_ESSAY,
    REASON_REFUND_NO_NOTES,
)
from services.botmason import STUB_MODEL_NAME, STUB_PROVIDER_NAME, LLMResponse
from services.llm_usage import (
    OUTCOME_FOR_REFUND_REASON,
    GenerationFeature,
    GenerationKey,
    GenerationOutcome,
    GenerationSettlement,
    GenerationUsage,
    log_generation_settled,
    summarize_usage,
)
from services.wallet import SpendResult
from tests.helpers.log_lines import production_line, records_for

_SETTLED = "llm_generation_settled"


def _response(model: str, prompt_tokens: int, completion_tokens: int) -> LLMResponse:
    return LLMResponse(
        text="model prose that must never be logged",
        provider="openai",
        model=model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )


def _stub() -> LLMResponse:
    return LLMResponse(
        text="stub prose",
        provider=STUB_PROVIDER_NAME,
        model=STUB_MODEL_NAME,
        prompt_tokens=7,
        completion_tokens=11,
    )


def test_summarize_sums_real_calls_and_skips_the_stub() -> None:
    """Exact token and cost sums over the real calls; the stub is not a call."""
    usage = summarize_usage(
        [_response("gpt-4o-mini", 1000, 500), _stub(), _response("gpt-4o", 200, 50)]
    )

    assert usage == GenerationUsage(
        calls=2,
        prompt_tokens=1200,
        completion_tokens=550,
        cost_usd=Decimal("0.001450"),
        model="gpt-4o",
    )


def test_summarize_reports_no_cost_when_any_call_is_unpriced() -> None:
    """One unpriced call makes the sum unknown, never an undercount."""
    usage = summarize_usage([_response("gpt-4o-mini", 1000, 500), _response("unpriced", 1, 1)])

    assert usage.cost_usd is None
    assert usage.calls == 2
    assert usage.model == "unpriced"


def test_summarize_of_nothing_is_zero_calls_and_zero_cost() -> None:
    """A generation that never dialled (or only hit the stub) costs nothing known."""
    assert summarize_usage([_stub()]) == GenerationUsage(
        calls=0, prompt_tokens=0, completion_tokens=0, cost_usd=Decimal(0), model=None
    )


def test_a_server_paid_spend_is_a_charged_generation() -> None:
    """``charged`` is exactly "a server-paid deduction committed"."""
    spent = SpendResult(monthly_used=1, offering_balance=0, bucket=BUCKET_MONTHLY)

    charged = GenerationKey.for_spend(spent)
    byok = GenerationKey.for_spend(None)

    assert charged.charged is True
    assert byok.charged is False
    assert GenerationKey.uncharged().charged is False
    assert len(charged.generation_id) == len(byok.generation_id) == 32
    assert charged.generation_id != byok.generation_id


def test_every_generation_refund_reason_names_an_outcome() -> None:
    """The outcome on the log line is derived from the audit reason, never re-decided."""
    assert set(OUTCOME_FOR_REFUND_REASON) == GENERATION_REFUND_REASONS
    assert OUTCOME_FOR_REFUND_REASON == {
        REASON_REFUND_NO_NOTES: GenerationOutcome.REFUNDED_EMPTY,
        REASON_REFUND_FAILED_RESONANCE: GenerationOutcome.REFUNDED_FAILED,
        REASON_REFUND_FAILED_ESSAY: GenerationOutcome.REFUNDED_FAILED,
        REASON_REFUND_NO_ESSAY: GenerationOutcome.REFUSED,
    }


def test_the_settled_line_carries_its_numbers_in_the_formatted_message(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The production formatter drops extras, so the counts must be in the message."""
    caplog.set_level(logging.INFO, logger="services.llm_usage")
    key = GenerationKey(generation_id="a" * 32, charged=True)

    log_generation_settled(
        GenerationSettlement(
            feature=GenerationFeature.RESONANCE,
            user_id=42,
            key=key,
            bucket=BUCKET_MONTHLY,
            outcome=GenerationOutcome.KEPT,
            attempts=2,
            usage=GenerationUsage(
                calls=3,
                prompt_tokens=1200,
                completion_tokens=550,
                cost_usd=Decimal("0.012345"),
                model="gpt-4o",
            ),
        )
    )

    records = records_for(caplog.records, _SETTLED)
    assert len(records) == 1
    record = records[0]
    assert record.levelno == logging.INFO
    line = production_line(record)
    for fragment in (
        "feature=resonance",
        "outcome=kept",
        "charged=True",
        "attempts=2",
        "calls=3",
        "prompt_tokens=1200",
        "completion_tokens=550",
        "cost_usd=0.012345",
    ):
        assert fragment in line
    extra = record.__dict__
    assert extra["user_id"] == 42
    assert extra["generation_id"] == "a" * 32
    assert extra["bucket"] == BUCKET_MONTHLY
    assert extra["model"] == "gpt-4o"
    assert extra["feature"] == "resonance"
    assert extra["outcome"] == "kept"
    assert extra["charged"] is True
    assert extra["attempts"] == 2
    assert extra["calls"] == 3
    assert extra["prompt_tokens"] == 1200
    assert extra["completion_tokens"] == 550
    assert extra["cost_usd"] == "0.012345"


def test_an_unpriced_generation_logs_its_cost_as_none(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An unknown cost is printed as ``None``, never as zero."""
    caplog.set_level(logging.INFO, logger="services.llm_usage")

    log_generation_settled(
        GenerationSettlement(
            feature=GenerationFeature.ESSAY,
            user_id=1,
            key=GenerationKey.for_spend(None),
            bucket=None,
            outcome=GenerationOutcome.REFUSED,
            attempts=1,
            usage=GenerationUsage(
                calls=1, prompt_tokens=1, completion_tokens=1, cost_usd=None, model="x"
            ),
        )
    )

    record = records_for(caplog.records, _SETTLED)[0]
    assert "cost_usd=None" in production_line(record)
    assert "charged=False" in production_line(record)
    assert record.__dict__["cost_usd"] is None
