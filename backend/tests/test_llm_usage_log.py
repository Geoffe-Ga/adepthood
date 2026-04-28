"""Tests for LLM usage logging — one row per chat call, cost estimated + persisted."""

from __future__ import annotations

from decimal import Decimal
from http import HTTPStatus
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

import services.botmason as botmason_mod
from models.llm_usage_log import LLMUsageLog
from services.botmason import LLMResponse, extract_token_count

# A realistic-looking OpenAI-style key that passes the format validator.
_VALID_OPENAI_KEY = "sk-abcdef1234567890abcdef1234567890"  # pragma: allowlist secret

# Fixed token counts used by OpenAI mock-call tests — extracted as named
# constants so the USD-cost assertions stay readable.
_OPENAI_PROMPT_TOKENS = 1_000
_OPENAI_COMPLETION_TOKENS = 500
_UNKNOWN_MODEL_PROMPT_TOKENS = 100
_UNKNOWN_MODEL_COMPLETION_TOKENS = 50


async def _signup(client: AsyncClient, username: str = "alice") -> dict[str, str]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _fetch_all_logs(db_session: AsyncSession) -> list[LLMUsageLog]:
    result = await db_session.execute(select(LLMUsageLog).order_by(col(LLMUsageLog.id)))
    return list(result.scalars().all())


# ── Stub provider: logs are created with zero tokens and zero cost ───────


@pytest.mark.asyncio
async def test_stub_chat_creates_log_with_zero_cost(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    headers = await _signup(async_client)

    resp = await async_client.post("/journal/chat", json={"message": "hi there"}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED

    logs = await _fetch_all_logs(db_session)
    assert len(logs) == 1
    log = logs[0]
    assert log.provider == "stub"
    assert log.model == "stub"
    assert log.prompt_tokens == 0
    assert log.completion_tokens == 0
    assert log.total_tokens == 0
    # BUG-BM-008: the stub model is unknown to the pricing table so the
    # cost is ``None`` (was a silent ``0.0`` previously).  Tokens are
    # still captured -- observability never breaks chat -- but the
    # admin dashboard can now distinguish "free model" from "we forgot
    # to price this model".
    assert log.estimated_cost_usd is None
    # FK points at the bot's journal entry, not the user's input.
    assert log.journal_entry_id == resp.json()["bot_entry_id"]


@pytest.mark.asyncio
async def test_every_chat_appends_one_log(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    headers = await _signup(async_client)
    for msg in ("a", "b", "c"):
        r = await async_client.post("/journal/chat", json={"message": msg}, headers=headers)
        assert r.status_code == HTTPStatus.CREATED

    logs = await _fetch_all_logs(db_session)
    assert len(logs) == 3


@pytest.mark.asyncio
async def test_failed_chat_does_not_log(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 402 (cap reached, no balance) must not insert a usage-log row."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "0")
    headers = await _signup(async_client)

    resp = await async_client.post("/journal/chat", json={"message": "hi"}, headers=headers)
    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED

    logs = await _fetch_all_logs(db_session)
    assert logs == []


# ── OpenAI provider: tokens extracted and cost calculated ────────────────


@pytest.mark.asyncio
async def test_openai_chat_logs_tokens_and_cost(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A successful OpenAI call logs prompt/completion tokens and estimated cost."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", _VALID_OPENAI_KEY)

    headers = await _signup(async_client)
    mock_call = AsyncMock(
        return_value=LLMResponse(
            text="response text",
            provider="openai",
            model="gpt-4o-mini",
            prompt_tokens=_OPENAI_PROMPT_TOKENS,
            completion_tokens=_OPENAI_COMPLETION_TOKENS,
        )
    )
    with patch.object(botmason_mod, "_call_openai", mock_call):
        resp = await async_client.post("/journal/chat", json={"message": "hello"}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED

    logs = await _fetch_all_logs(db_session)
    assert len(logs) == 1
    log = logs[0]
    assert log.provider == "openai"
    assert log.model == "gpt-4o-mini"
    assert log.prompt_tokens == _OPENAI_PROMPT_TOKENS
    assert log.completion_tokens == _OPENAI_COMPLETION_TOKENS
    assert log.total_tokens == _OPENAI_PROMPT_TOKENS + _OPENAI_COMPLETION_TOKENS
    # gpt-4o-mini: $0.15/1M input + $0.60/1M output.  1000 input + 500 output
    # => 1000 * 0.15/1_000_000 + 500 * 0.60/1_000_000 = $0.000450 (Decimal).
    assert log.estimated_cost_usd == Decimal("0.000450")


@pytest.mark.asyncio
async def test_log_survives_unknown_model_as_null_cost(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unknown models log tokens but a NULL cost — observability never breaks chat.

    BUG-BM-008: previously the cost defaulted to ``0.0``, which made
    unrated models look like freebies in the per-model dashboard.
    Today the column is nullable and a missing rate stores ``NULL``
    so an operator can spot the gap in a SQL ``WHERE estimated_cost_usd IS NULL``.
    """
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", _VALID_OPENAI_KEY)

    headers = await _signup(async_client)
    mock_call = AsyncMock(
        return_value=LLMResponse(
            text="ok",
            provider="openai",
            model="gpt-future-unreleased-model",
            prompt_tokens=_UNKNOWN_MODEL_PROMPT_TOKENS,
            completion_tokens=_UNKNOWN_MODEL_COMPLETION_TOKENS,
        )
    )
    with patch.object(botmason_mod, "_call_openai", mock_call):
        resp = await async_client.post("/journal/chat", json={"message": "?"}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED

    logs = await _fetch_all_logs(db_session)
    assert len(logs) == 1
    assert logs[0].model == "gpt-future-unreleased-model"
    assert logs[0].prompt_tokens == _UNKNOWN_MODEL_PROMPT_TOKENS
    assert logs[0].completion_tokens == _UNKNOWN_MODEL_COMPLETION_TOKENS
    assert logs[0].estimated_cost_usd is None


# ── Unit tests for the extract_token_count helper ────────────────────────


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
