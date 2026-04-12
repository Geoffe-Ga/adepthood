"""Tests for the BotMason AI chat API — metered AI conversations."""

from __future__ import annotations

import asyncio
import logging
import pathlib
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from http import HTTPStatus
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

import routers.botmason as botmason_router_mod
import services.botmason as botmason_mod
from models.user import User
from routers.botmason import LLM_API_KEY_HEADER
from services.botmason import (
    LLM_API_KEY_MAX_LENGTH,
    LLMResponse,
    generate_response,
    get_system_prompt,
    validate_llm_api_key_format,
)
from services.usage import (
    DEFAULT_MONTHLY_CAP,
    compute_next_reset,
    get_monthly_cap,
)


def _mock_openai_response(
    text: str, *, prompt_tokens: int = 0, completion_tokens: int = 0
) -> LLMResponse:
    """Build an :class:`LLMResponse` shaped like an OpenAI call for provider mocks."""
    return LLMResponse(
        text=text,
        provider="openai",
        model="gpt-4o-mini",
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )


async def _signup(client: AsyncClient, username: str = "alice") -> dict[str, str]:
    """Create a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


async def _add_balance(client: AsyncClient, headers: dict[str, str], amount: int = 10) -> None:
    """Add offering credits to the authenticated user."""
    resp = await client.post("/user/balance/add", json={"amount": amount}, headers=headers)
    assert resp.status_code == HTTPStatus.OK


# ── Authentication ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chat_unauthenticated_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.post("/journal/chat", json={"message": "Hello"})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_balance_unauthenticated_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/user/balance")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_add_balance_unauthenticated_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.post("/user/balance/add", json={"amount": 5})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── Offering balance ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_balance_default_zero(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/user/balance", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["balance"] == 0


@pytest.mark.asyncio
async def test_add_balance(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post("/user/balance/add", json={"amount": 5}, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["balance"] == 5  # noqa: PLR2004
    assert data["added"] == 5  # noqa: PLR2004


@pytest.mark.asyncio
async def test_add_balance_accumulates(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=3)
    await _add_balance(async_client, headers, amount=7)

    resp = await async_client.get("/user/balance", headers=headers)
    assert resp.json()["balance"] == 10  # noqa: PLR2004


@pytest.mark.asyncio
async def test_add_balance_rejects_zero_amount(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post("/user/balance/add", json={"amount": 0}, headers=headers)
    assert resp.status_code == HTTPStatus.BAD_REQUEST


@pytest.mark.asyncio
async def test_add_balance_rejects_negative_amount(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post("/user/balance/add", json={"amount": -5}, headers=headers)
    assert resp.status_code == HTTPStatus.BAD_REQUEST


# ── Chat with BotMason ─────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_chat_with_zero_balance_returns_402(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/journal/chat", json={"message": "Hello BotMason"}, headers=headers
    )
    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert resp.json()["detail"] == "insufficient_offerings"


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_chat_success(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=5)

    resp = await async_client.post(
        "/journal/chat", json={"message": "Hello BotMason"}, headers=headers
    )
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert "response" in data
    assert len(data["response"]) > 0
    assert data["remaining_balance"] == 4  # noqa: PLR2004
    assert data["bot_entry_id"] is not None


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_chat_deducts_balance(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=3)

    await async_client.post("/journal/chat", json={"message": "First message"}, headers=headers)
    await async_client.post("/journal/chat", json={"message": "Second message"}, headers=headers)

    resp = await async_client.get("/user/balance", headers=headers)
    assert resp.json()["balance"] == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_chat_stores_user_and_bot_messages(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)

    await async_client.post(
        "/journal/chat", json={"message": "Tell me about meditation"}, headers=headers
    )

    # Verify both messages appear in journal
    resp = await async_client.get("/journal/", headers=headers)
    data = resp.json()
    assert data["total"] == 2  # noqa: PLR2004
    senders = {item["sender"] for item in data["items"]}
    assert senders == {"user", "bot"}

    # Verify user message content
    user_msgs = [m for m in data["items"] if m["sender"] == "user"]
    assert user_msgs[0]["message"] == "Tell me about meditation"


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_chat_bot_response_in_journal_history(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)

    chat_resp = await async_client.post(
        "/journal/chat", json={"message": "Guide me"}, headers=headers
    )
    bot_entry_id = chat_resp.json()["bot_entry_id"]

    # Fetch the bot entry directly
    entry_resp = await async_client.get(f"/journal/{bot_entry_id}", headers=headers)
    assert entry_resp.status_code == HTTPStatus.OK
    assert entry_resp.json()["sender"] == "bot"


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_chat_exhausts_balance_then_402(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)

    # First chat succeeds
    resp1 = await async_client.post("/journal/chat", json={"message": "First"}, headers=headers)
    assert resp1.status_code == HTTPStatus.CREATED
    assert resp1.json()["remaining_balance"] == 0

    # Second chat fails — balance exhausted
    resp2 = await async_client.post("/journal/chat", json={"message": "Second"}, headers=headers)
    assert resp2.status_code == HTTPStatus.PAYMENT_REQUIRED


@pytest.mark.asyncio
async def test_freeform_journal_works_at_zero_balance(async_client: AsyncClient) -> None:
    """Freeform journaling (POST /journal/) still works without offerings."""
    headers = await _signup(async_client)
    # Balance is 0 by default — freeform journaling should still work
    resp = await async_client.post(
        "/journal/",
        json={"message": "A thought without AI"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["sender"] == "user"


# ── BotMason service unit tests ────────────────────────────────────────


@pytest.mark.asyncio
async def test_stub_response_contains_user_message() -> None:
    result = await generate_response("What is the Archetypal Wavelength?", [])
    assert "What is the Archetypal Wavelength?" in result.text
    # Stub responses are token-free so the usage log never distorts real cost totals.
    assert result.provider == "stub"
    assert result.prompt_tokens == 0
    assert result.completion_tokens == 0


@pytest.mark.asyncio
async def test_system_prompt_default() -> None:
    prompt = get_system_prompt()
    assert "BotMason" in prompt
    assert "APTITUDE" in prompt


@pytest.mark.asyncio
async def test_system_prompt_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOTMASON_SYSTEM_PROMPT", "Custom prompt text")
    prompt = get_system_prompt()
    assert prompt == "Custom prompt text"


@pytest.mark.asyncio
async def test_system_prompt_from_file(monkeypatch: pytest.MonkeyPatch, tmp_path: object) -> None:
    """Valid prompt file inside the allowed directory is loaded."""
    allowed_dir = pathlib.Path(str(tmp_path)) / "prompts"
    allowed_dir.mkdir()
    prompt_file = allowed_dir / "prompt.txt"
    prompt_file.write_text("File-based system prompt")

    monkeypatch.setattr(botmason_mod, "_ALLOWED_PROMPT_DIR", allowed_dir)
    monkeypatch.setenv("BOTMASON_SYSTEM_PROMPT", str(prompt_file))
    prompt = get_system_prompt()
    assert prompt == "File-based system prompt"


# ── Path traversal security tests ─────────────────────────────────────


@pytest.mark.asyncio
async def test_system_prompt_rejects_path_outside_allowed_dir(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: object,
) -> None:
    """File path outside the allowed directory raises RuntimeError."""
    allowed_dir = pathlib.Path(str(tmp_path)) / "prompts"
    allowed_dir.mkdir()

    # Create a file outside the allowed dir
    outside_file = pathlib.Path(str(tmp_path)) / "evil.txt"
    outside_file.write_text("stolen secrets")

    monkeypatch.setattr(botmason_mod, "_ALLOWED_PROMPT_DIR", allowed_dir)
    monkeypatch.setenv("BOTMASON_SYSTEM_PROMPT", str(outside_file))
    with pytest.raises(RuntimeError, match="must be within"):
        get_system_prompt()


@pytest.mark.asyncio
async def test_system_prompt_rejects_path_traversal(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: object,
) -> None:
    """Relative traversal paths (../../etc/passwd) are rejected."""
    allowed_dir = pathlib.Path(str(tmp_path)) / "prompts"
    allowed_dir.mkdir()

    # Create a file via path traversal that resolves outside allowed dir
    outside_file = pathlib.Path(str(tmp_path)) / "secret.txt"
    outside_file.write_text("password data")
    traversal_path = str(allowed_dir / ".." / "secret.txt")

    monkeypatch.setattr(botmason_mod, "_ALLOWED_PROMPT_DIR", allowed_dir)
    monkeypatch.setenv("BOTMASON_SYSTEM_PROMPT", traversal_path)
    with pytest.raises(RuntimeError, match="must be within"):
        get_system_prompt()


@pytest.mark.asyncio
async def test_system_prompt_rejects_etc_passwd(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: object,
) -> None:
    """Absolute paths to sensitive system files are rejected."""
    allowed_dir = pathlib.Path(str(tmp_path)) / "prompts"
    allowed_dir.mkdir()

    monkeypatch.setattr(botmason_mod, "_ALLOWED_PROMPT_DIR", allowed_dir)
    monkeypatch.setenv("BOTMASON_SYSTEM_PROMPT", "/etc/passwd")
    with pytest.raises(RuntimeError, match="must be within"):
        get_system_prompt()


@pytest.mark.asyncio
async def test_system_prompt_rejects_oversized_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: object,
) -> None:
    """Prompt files larger than the max size limit are rejected."""
    allowed_dir = pathlib.Path(str(tmp_path)) / "prompts"
    allowed_dir.mkdir()
    large_file = allowed_dir / "huge.txt"
    # Write a file just over the 50KB limit
    large_file.write_text("x" * (50 * 1024 + 1))

    monkeypatch.setattr(botmason_mod, "_ALLOWED_PROMPT_DIR", allowed_dir)
    monkeypatch.setenv("BOTMASON_SYSTEM_PROMPT", str(large_file))
    with pytest.raises(RuntimeError, match="exceeds maximum"):
        get_system_prompt()


@pytest.mark.asyncio
async def test_system_prompt_allows_file_at_size_limit(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: object,
) -> None:
    """Prompt file exactly at the max size limit is accepted."""
    allowed_dir = pathlib.Path(str(tmp_path)) / "prompts"
    allowed_dir.mkdir()
    max_file = allowed_dir / "max.txt"
    max_file.write_text("x" * (50 * 1024))

    monkeypatch.setattr(botmason_mod, "_ALLOWED_PROMPT_DIR", allowed_dir)
    monkeypatch.setenv("BOTMASON_SYSTEM_PROMPT", str(max_file))
    prompt = get_system_prompt()
    assert len(prompt) == 50 * 1024


# ── LLM API key validation tests ─────────────────────────────────────


@pytest.mark.asyncio
async def test_openai_provider_raises_without_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """OpenAI provider raises RuntimeError when LLM_API_KEY is not set."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="LLM_API_KEY"):
        await generate_response("Hello", [])


@pytest.mark.asyncio
async def test_anthropic_provider_raises_without_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Anthropic provider raises RuntimeError when LLM_API_KEY is not set."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "anthropic")
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="LLM_API_KEY"):
        await generate_response("Hello", [])


@pytest.mark.asyncio
async def test_openai_provider_raises_with_empty_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """OpenAI provider raises RuntimeError when LLM_API_KEY is empty string."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", "")
    with pytest.raises(RuntimeError, match="LLM_API_KEY"):
        await generate_response("Hello", [])


@pytest.mark.asyncio
async def test_anthropic_provider_raises_with_empty_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Anthropic provider raises RuntimeError when LLM_API_KEY is empty string."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_API_KEY", "")
    with pytest.raises(RuntimeError, match="LLM_API_KEY"):
        await generate_response("Hello", [])


@pytest.mark.asyncio
async def test_stub_provider_works_without_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stub provider continues to work without LLM_API_KEY."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    result = await generate_response("Hello", [])
    assert "Hello" in result.text


# ── Race condition prevention tests (sec-17) ──────────────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit", "zero_monthly_cap")
async def test_concurrent_chat_with_balance_one_allows_exactly_one(
    concurrent_async_client: AsyncClient,
) -> None:
    """Concurrent chat requests with balance=1 must yield exactly 1 success (sec-17)."""
    headers = await _signup(concurrent_async_client)
    await _add_balance(concurrent_async_client, headers, amount=1)

    # Fire 5 concurrent requests — only 1 should succeed
    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(
                "/journal/chat", json={"message": f"msg-{i}"}, headers=headers
            )
            for i in range(5)
        ]
    )

    status_codes = [r.status_code for r in responses]
    successes = status_codes.count(HTTPStatus.CREATED)
    failures = status_codes.count(HTTPStatus.PAYMENT_REQUIRED)

    assert successes == 1, f"Expected exactly 1 success, got {successes}"
    assert failures == 4, f"Expected 4 failures, got {failures}"  # noqa: PLR2004

    # Balance must be exactly 0, never negative
    balance_resp = await concurrent_async_client.get("/user/balance", headers=headers)
    assert balance_resp.json()["balance"] == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit", "zero_monthly_cap")
async def test_balance_never_negative_after_concurrent_chat(
    concurrent_async_client: AsyncClient,
) -> None:
    """Balance must never go negative, even under concurrent load (sec-17)."""
    headers = await _signup(concurrent_async_client)
    await _add_balance(concurrent_async_client, headers, amount=3)

    # Fire 10 concurrent requests with only 3 credits
    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(
                "/journal/chat", json={"message": f"msg-{i}"}, headers=headers
            )
            for i in range(10)
        ]
    )

    status_codes = [r.status_code for r in responses]
    successes = status_codes.count(HTTPStatus.CREATED)
    failures = status_codes.count(HTTPStatus.PAYMENT_REQUIRED)

    assert successes == 3, f"Expected 3 successes, got {successes}"  # noqa: PLR2004
    assert failures == 7, f"Expected 7 failures, got {failures}"  # noqa: PLR2004

    # Balance must be exactly 0, never negative
    balance_resp = await concurrent_async_client.get("/user/balance", headers=headers)
    assert balance_resp.json()["balance"] == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_balance_additions_are_atomic(
    concurrent_async_client: AsyncClient,
) -> None:
    """Concurrent balance additions must not lose updates (sec-17)."""
    headers = await _signup(concurrent_async_client)

    # Fire 5 concurrent add-balance requests, each adding 2
    add_amount = 2
    num_requests = 5
    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(
                "/user/balance/add", json={"amount": add_amount}, headers=headers
            )
            for _ in range(num_requests)
        ]
    )

    # All should succeed
    for resp in responses:
        assert resp.status_code == HTTPStatus.OK

    # Final balance should be exactly 10 (5 * 2), no lost updates
    expected_balance = add_amount * num_requests
    balance_resp = await concurrent_async_client.get("/user/balance", headers=headers)
    assert balance_resp.json()["balance"] == expected_balance


# ── BYOK (user-supplied LLM API key) ───────────────────────────────────
# Covers issue #185 — users bring their own API key via ``X-LLM-API-Key``.
# The key must be validated, forwarded to the provider for a single request,
# and never logged, stored, or echoed back.


_VALID_OPENAI_KEY = "sk-abcdef1234567890abcdef1234567890"  # pragma: allowlist secret
_VALID_ANTHROPIC_KEY = "sk-ant-api03-" + "x" * 64  # pragma: allowlist secret


def _forwarded_key(mock_call: AsyncMock) -> object:
    """Return the ``api_key`` argument forwarded to a provider call mock.

    ``_call_openai`` / ``_call_anthropic`` accept the key as the 4th positional
    argument or as the ``api_key`` keyword — this helper hides that detail and
    narrows the mypy types around ``await_args`` being optional.
    """
    call = mock_call.await_args
    assert call is not None, "expected provider mock to have been awaited"
    args, kwargs = call
    if "api_key" in kwargs:
        return kwargs["api_key"]
    if len(args) >= 4:  # noqa: PLR2004 - positional index for api_key
        return args[3]
    return None


def test_validate_format_accepts_openai_key() -> None:
    assert validate_llm_api_key_format(_VALID_OPENAI_KEY, "openai") is True


def test_validate_format_accepts_anthropic_key() -> None:
    assert validate_llm_api_key_format(_VALID_ANTHROPIC_KEY, "anthropic") is True


def test_validate_format_rejects_cross_provider_keys() -> None:
    # An Anthropic key sent to the OpenAI provider is a misconfiguration, not
    # a valid OpenAI key — the ``sk-ant-`` prefix must be rejected there.
    assert validate_llm_api_key_format(_VALID_ANTHROPIC_KEY, "openai") is False
    # An OpenAI key lacks the ``sk-ant-`` prefix the Anthropic SDK expects.
    assert validate_llm_api_key_format(_VALID_OPENAI_KEY, "anthropic") is False


def test_validate_format_rejects_missing_prefix() -> None:
    assert validate_llm_api_key_format("not-a-real-key", "openai") is False
    assert validate_llm_api_key_format("not-a-real-key", "anthropic") is False


def test_validate_format_rejects_empty_or_oversized_key() -> None:
    assert validate_llm_api_key_format("", "openai") is False
    oversized = "sk-" + "x" * LLM_API_KEY_MAX_LENGTH
    assert validate_llm_api_key_format(oversized, "openai") is False


def test_validate_format_skips_check_for_stub_provider() -> None:
    # Stub provider accepts anything — it never makes a real call.
    assert validate_llm_api_key_format("anything", "stub") is True


@pytest.mark.asyncio
async def test_chat_returns_402_when_provider_needs_key_and_none_available(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With provider=openai and no env/header key, chat responds 402."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.delenv("LLM_API_KEY", raising=False)

    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)

    resp = await async_client.post(
        "/journal/chat",
        json={"message": "Hello"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert resp.json()["detail"] == "llm_key_required"

    # Balance must not have been decremented — the key check happens first.
    balance_resp = await async_client.get("/user/balance", headers=headers)
    assert balance_resp.json()["balance"] == 1


@pytest.mark.asyncio
async def test_chat_falls_back_to_env_key_when_header_absent(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no header but LLM_API_KEY set, the env key is used for the call."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", _VALID_OPENAI_KEY)

    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)

    mock_call = AsyncMock(return_value=_mock_openai_response("env-fallback-response"))
    with patch.object(botmason_mod, "_call_openai", mock_call):
        resp = await async_client.post(
            "/journal/chat",
            json={"message": "Hello"},
            headers=headers,
        )

    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["response"] == "env-fallback-response"
    # The key forwarded to the provider should be ``None`` — the service layer
    # resolves env-var fallback internally so the router never touches the env.
    assert _forwarded_key(mock_call) is None


@pytest.mark.asyncio
async def test_chat_uses_user_supplied_key_from_header(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A valid ``X-LLM-API-Key`` header is forwarded to the provider."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.delenv("LLM_API_KEY", raising=False)

    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)
    headers[LLM_API_KEY_HEADER] = _VALID_OPENAI_KEY

    mock_call = AsyncMock(return_value=_mock_openai_response("byok-response"))
    with patch.object(botmason_mod, "_call_openai", mock_call):
        resp = await async_client.post(
            "/journal/chat",
            json={"message": "Hello"},
            headers=headers,
        )

    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["response"] == "byok-response"
    assert _forwarded_key(mock_call) == _VALID_OPENAI_KEY


@pytest.mark.asyncio
async def test_chat_header_key_overrides_env_key(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When both header and env are set, the header key wins (BYOK priority)."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", "sk-server-fallback-key")

    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)
    headers[LLM_API_KEY_HEADER] = _VALID_OPENAI_KEY

    mock_call = AsyncMock(return_value=_mock_openai_response("byok-response"))
    with patch.object(botmason_mod, "_call_openai", mock_call):
        await async_client.post(
            "/journal/chat",
            json={"message": "Hello"},
            headers=headers,
        )

    assert _forwarded_key(mock_call) == _VALID_OPENAI_KEY


@pytest.mark.asyncio
async def test_chat_rejects_malformed_header_key_with_400(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A malformed ``X-LLM-API-Key`` yields 400 without spending balance."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", _VALID_OPENAI_KEY)

    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)
    headers[LLM_API_KEY_HEADER] = "not-a-real-key"  # pragma: allowlist secret

    resp = await async_client.post(
        "/journal/chat",
        json={"message": "Hello"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert resp.json()["detail"] == "invalid_llm_api_key_format"

    # Balance must not have been decremented.
    balance_resp = await async_client.get("/user/balance", headers=headers)
    assert balance_resp.json()["balance"] == 1


@pytest.mark.asyncio
async def test_chat_rejects_oversized_header_key_with_400(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", _VALID_OPENAI_KEY)

    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)
    headers[LLM_API_KEY_HEADER] = "sk-" + "x" * LLM_API_KEY_MAX_LENGTH  # pragma: allowlist secret

    resp = await async_client.post(
        "/journal/chat",
        json={"message": "Hello"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST


@pytest.mark.asyncio
async def test_chat_ignores_empty_header_and_uses_env(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty header value behaves like a missing header (env fallback)."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", _VALID_OPENAI_KEY)

    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)
    headers[LLM_API_KEY_HEADER] = "   "

    mock_call = AsyncMock(return_value=_mock_openai_response("env-response"))
    with patch.object(botmason_mod, "_call_openai", mock_call):
        resp = await async_client.post(
            "/journal/chat",
            json={"message": "Hello"},
            headers=headers,
        )

    assert resp.status_code == HTTPStatus.CREATED
    assert _forwarded_key(mock_call) is None


@pytest.mark.asyncio
async def test_chat_does_not_log_header_key_value(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The raw key value must never appear in log output."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.delenv("LLM_API_KEY", raising=False)

    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)
    headers[LLM_API_KEY_HEADER] = _VALID_OPENAI_KEY

    mock_call = AsyncMock(return_value=_mock_openai_response("ok"))
    with caplog.at_level(logging.DEBUG), patch.object(botmason_mod, "_call_openai", mock_call):
        await async_client.post(
            "/journal/chat",
            json={"message": "Hello"},
            headers=headers,
        )

    for record in caplog.records:
        assert _VALID_OPENAI_KEY not in record.getMessage()


@pytest.mark.asyncio
async def test_chat_response_body_does_not_echo_key(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.delenv("LLM_API_KEY", raising=False)

    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)
    headers[LLM_API_KEY_HEADER] = _VALID_OPENAI_KEY

    mock_call = AsyncMock(return_value=_mock_openai_response("a response"))
    with patch.object(botmason_mod, "_call_openai", mock_call):
        resp = await async_client.post(
            "/journal/chat",
            json={"message": "Hello"},
            headers=headers,
        )

    assert _VALID_OPENAI_KEY not in resp.text


@pytest.mark.asyncio
async def test_stub_provider_ignores_header_key(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stub provider never needs a key and must not 402 when one is absent."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.delenv("LLM_API_KEY", raising=False)

    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)

    resp = await async_client.post(
        "/journal/chat",
        json={"message": "Hello"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED


@pytest.mark.asyncio
async def test_generate_response_uses_override_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``generate_response(api_key=...)`` forwards the override to the provider."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.delenv("LLM_API_KEY", raising=False)

    mock_call = AsyncMock(return_value=_mock_openai_response("overridden"))
    with patch.object(botmason_mod, "_call_openai", mock_call):
        result = await generate_response("hi", [], api_key=_VALID_OPENAI_KEY)

    assert result.text == "overridden"
    assert _forwarded_key(mock_call) == _VALID_OPENAI_KEY


# ── Monthly message cap / token wallet (issue #186) ───────────────────
# Every user receives ``BOTMASON_MONTHLY_CAP`` free messages per calendar
# month.  Once spent, requests fall through to ``offering_balance``; when
# both buckets are empty the router returns 402.  The counter resets
# automatically on the first of every month (UTC).


@pytest.mark.asyncio
async def test_usage_endpoint_reports_defaults_for_new_user(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A fresh account reports zero usage and the full cap remaining."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "50")
    headers = await _signup(async_client)

    resp = await async_client.get("/user/usage", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["monthly_messages_used"] == 0
    assert data["monthly_messages_remaining"] == 50  # noqa: PLR2004
    assert data["monthly_cap"] == 50  # noqa: PLR2004
    assert data["offering_balance"] == 0
    # Reset date is first-of-next-month UTC — sanity check format only so
    # the test does not drift with the wall clock.
    assert data["monthly_reset_date"].endswith(("Z", "+00:00")) or "T" in data["monthly_reset_date"]


@pytest.mark.asyncio
async def test_usage_endpoint_unauthenticated_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/user/usage")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_chat_consumes_free_monthly_tier_first(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With a positive cap, offering_balance is untouched until free tier is spent."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "3")
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=10)

    resp = await async_client.post("/journal/chat", json={"message": "first"}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    # Purchased credits are preserved; the free allocation absorbed the cost.
    assert data["remaining_balance"] == 10  # noqa: PLR2004
    assert data["remaining_messages"] == 2  # noqa: PLR2004


@pytest.mark.asyncio
async def test_chat_falls_back_to_offering_balance_after_cap(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Once the free tier is exhausted, subsequent chats draw from offering_balance."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "1")
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=2)

    # Spend the single free message.
    resp1 = await async_client.post("/journal/chat", json={"message": "a"}, headers=headers)
    assert resp1.status_code == HTTPStatus.CREATED
    assert resp1.json()["remaining_balance"] == 2  # noqa: PLR2004
    assert resp1.json()["remaining_messages"] == 0

    # Next chat must come out of offering_balance.
    resp2 = await async_client.post("/journal/chat", json={"message": "b"}, headers=headers)
    assert resp2.status_code == HTTPStatus.CREATED
    assert resp2.json()["remaining_balance"] == 1
    assert resp2.json()["remaining_messages"] == 0


@pytest.mark.asyncio
async def test_chat_402_when_cap_reached_and_no_offering_balance(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With the cap spent and zero offering_balance, chat returns 402."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "1")
    headers = await _signup(async_client)

    # Spend the free message.
    ok_resp = await async_client.post("/journal/chat", json={"message": "a"}, headers=headers)
    assert ok_resp.status_code == HTTPStatus.CREATED

    # Second attempt: cap reached and no purchased credits.
    failed = await async_client.post("/journal/chat", json={"message": "b"}, headers=headers)
    assert failed.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert failed.json()["detail"] == "insufficient_offerings"


@pytest.mark.asyncio
async def test_usage_tracks_monthly_messages(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Each chat advances ``monthly_messages_used`` and decreases the remaining."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "5")
    headers = await _signup(async_client)

    await async_client.post("/journal/chat", json={"message": "1"}, headers=headers)
    await async_client.post("/journal/chat", json={"message": "2"}, headers=headers)

    usage = await async_client.get("/user/usage", headers=headers)
    data = usage.json()
    assert data["monthly_messages_used"] == 2  # noqa: PLR2004
    assert data["monthly_messages_remaining"] == 3  # noqa: PLR2004
    assert data["monthly_cap"] == 5  # noqa: PLR2004


@pytest.mark.asyncio
async def test_cap_reset_on_new_month(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Crossing ``monthly_reset_date`` resets the counter on the next chat request."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "2")
    headers = await _signup(async_client)

    # Spend the full allocation.
    for msg in ("a", "b"):
        resp = await async_client.post("/journal/chat", json={"message": msg}, headers=headers)
        assert resp.status_code == HTTPStatus.CREATED

    # Third message is over cap.
    blocked = await async_client.post("/journal/chat", json={"message": "c"}, headers=headers)
    assert blocked.status_code == HTTPStatus.PAYMENT_REQUIRED

    # Fast-forward the stored reset date into the past — simulates a new month.
    await db_session.execute(
        update(User).values(monthly_reset_date=datetime(2000, 1, 1, tzinfo=UTC))
    )
    await db_session.commit()

    # Next chat rolls the counter over and succeeds.
    resp_after = await async_client.post("/journal/chat", json={"message": "d"}, headers=headers)
    assert resp_after.status_code == HTTPStatus.CREATED
    assert resp_after.json()["remaining_messages"] == 1

    usage = await async_client.get("/user/usage", headers=headers)
    assert usage.json()["monthly_messages_used"] == 1


@pytest.mark.asyncio
async def test_usage_endpoint_rolls_counter_on_new_month(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``/user/usage`` itself resets stale counters so the UI never shows stale data."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "3")
    headers = await _signup(async_client)

    # Spend one message, then shift the reset date into the past.
    await async_client.post("/journal/chat", json={"message": "x"}, headers=headers)
    await db_session.execute(
        update(User).values(monthly_reset_date=datetime(2000, 1, 1, tzinfo=UTC))
    )
    await db_session.commit()

    resp = await async_client.get("/user/usage", headers=headers)
    data = resp.json()
    assert data["monthly_messages_used"] == 0
    assert data["monthly_messages_remaining"] == 3  # noqa: PLR2004


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_cap_honoured_under_concurrent_load(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Concurrent requests must not allow overspending the free allocation."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "3")
    headers = await _signup(concurrent_async_client)

    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(
                "/journal/chat", json={"message": f"msg-{i}"}, headers=headers
            )
            for i in range(10)
        ]
    )
    successes = sum(1 for r in responses if r.status_code == HTTPStatus.CREATED)
    failures = sum(1 for r in responses if r.status_code == HTTPStatus.PAYMENT_REQUIRED)
    assert successes == 3, f"cap was 3 but {successes} requests succeeded"  # noqa: PLR2004
    assert failures == 7, f"expected 7 rejections, got {failures}"  # noqa: PLR2004

    usage = await concurrent_async_client.get("/user/usage", headers=headers)
    data = usage.json()
    assert data["monthly_messages_used"] == 3  # noqa: PLR2004
    assert data["monthly_messages_remaining"] == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_free_and_paid_wallets_combine_under_concurrent_load(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Free allocation + offering_balance determines total capacity, no more, no less."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "2")
    headers = await _signup(concurrent_async_client)
    await _add_balance(concurrent_async_client, headers, amount=3)

    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(
                "/journal/chat", json={"message": f"msg-{i}"}, headers=headers
            )
            for i in range(10)
        ]
    )
    successes = sum(1 for r in responses if r.status_code == HTTPStatus.CREATED)
    # 2 free + 3 paid = 5 total capacity.
    assert successes == 5, f"expected 5 successes, got {successes}"  # noqa: PLR2004

    usage = await concurrent_async_client.get("/user/usage", headers=headers)
    data = usage.json()
    assert data["monthly_messages_used"] == 2  # noqa: PLR2004
    assert data["offering_balance"] == 0


# ── Usage service unit tests ─────────────────────────────────────────


def test_get_monthly_cap_default_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BOTMASON_MONTHLY_CAP", raising=False)
    assert get_monthly_cap() == DEFAULT_MONTHLY_CAP


def test_get_monthly_cap_parses_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "17")
    assert get_monthly_cap() == 17  # noqa: PLR2004


def test_get_monthly_cap_rejects_malformed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "not-a-number")
    assert get_monthly_cap() == DEFAULT_MONTHLY_CAP


def test_get_monthly_cap_rejects_negative(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "-5")
    assert get_monthly_cap() == DEFAULT_MONTHLY_CAP


def test_get_monthly_cap_allows_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "0")
    assert get_monthly_cap() == 0


def test_compute_next_reset_mid_month() -> None:
    result = compute_next_reset(datetime(2026, 4, 15, 12, 34, 56, tzinfo=UTC))
    assert result == datetime(2026, 5, 1, tzinfo=UTC)


def test_compute_next_reset_december_rollover() -> None:
    result = compute_next_reset(datetime(2026, 12, 31, 23, 59, 59, tzinfo=UTC))
    assert result == datetime(2027, 1, 1, tzinfo=UTC)


def test_compute_next_reset_normalises_naive_input() -> None:
    # A naive datetime is interpreted as UTC rather than silently crashing on
    # mismatched comparisons later.
    result = compute_next_reset(datetime(2026, 6, 15, 12, 0, 0))
    assert result == datetime(2026, 7, 1, tzinfo=UTC)


# ── SSE streaming chat (issue #188) ──────────────────────────────────────


def _parse_sse_events(body: str) -> list[tuple[str, dict[str, object]]]:
    """Parse a UTF-8 SSE stream into ``[(event_name, data_dict), ...]`` pairs.

    The standard frames each event with a blank line so we split on the double
    newline separator, then pick out the ``event:`` and ``data:`` fields.
    Fields without an ``event:`` header default to the generic ``message`` name
    but our endpoint always supplies one, so we assert on it.
    """
    events: list[tuple[str, dict[str, object]]] = []
    for raw_frame in body.strip().split("\n\n"):
        if not raw_frame:
            continue
        name = ""
        payload: dict[str, object] = {}
        for line in raw_frame.split("\n"):
            if line.startswith("event: "):
                name = line.removeprefix("event: ").strip()
            elif line.startswith("data: "):
                import json as _json  # noqa: PLC0415 - local import keeps helper self-contained

                payload = _json.loads(line.removeprefix("data: "))
        events.append((name, payload))
    return events


@pytest.mark.asyncio
async def test_stream_unauthenticated_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.post("/journal/chat/stream", json={"message": "Hi"})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_stream_with_zero_balance_returns_402(async_client: AsyncClient) -> None:
    """Pre-flight wallet check must 402 *before* any SSE bytes go out."""
    headers = await _signup(async_client)
    resp = await async_client.post("/journal/chat/stream", json={"message": "Hi"}, headers=headers)
    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert resp.json()["detail"] == "insufficient_offerings"


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_stream_emits_chunks_then_complete(async_client: AsyncClient) -> None:
    """Happy path: one or more ``chunk`` events followed by a single ``complete``."""
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=2)

    resp = await async_client.post(
        "/journal/chat/stream", json={"message": "Guide me"}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.headers["content-type"].startswith("text/event-stream")

    events = _parse_sse_events(resp.text)
    event_names = [name for name, _ in events]
    assert event_names[-1] == "complete"
    assert "chunk" in event_names

    # Reassembling the chunk texts must equal the final response.
    chunk_text = "".join(str(data["text"]) for name, data in events if name == "chunk")
    complete_payload = next(data for name, data in events if name == "complete")
    assert chunk_text == complete_payload["response"]
    assert complete_payload["remaining_balance"] == 1
    assert complete_payload["bot_entry_id"] is not None


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_stream_persists_user_and_bot_messages(async_client: AsyncClient) -> None:
    """After a successful stream both the user and bot entries are in the journal."""
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)

    await async_client.post(
        "/journal/chat/stream", json={"message": "Tell me a secret"}, headers=headers
    )

    listing = await async_client.get("/journal/", headers=headers)
    items = listing.json()["items"]
    senders = {item["sender"] for item in items}
    assert senders == {"user", "bot"}
    user_msgs = [item for item in items if item["sender"] == "user"]
    assert user_msgs[0]["message"] == "Tell me a secret"


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_stream_deducts_balance_once(async_client: AsyncClient) -> None:
    """One stream costs exactly one wallet unit — same as the non-streaming path."""
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=3)

    await async_client.post("/journal/chat/stream", json={"message": "Hello"}, headers=headers)
    balance = await async_client.get("/user/balance", headers=headers)
    assert balance.json()["balance"] == 2  # noqa: PLR2004


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_stream_provider_error_emits_error_event_and_rolls_back(
    async_client: AsyncClient,
) -> None:
    """A mid-stream provider failure must not charge the user or persist a bot entry."""
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)

    async def _boom(
        *_args: object, **_kwargs: object
    ) -> AsyncIterator[tuple[str, LLMResponse | None]]:
        """Raise on first iteration to mimic a provider network error."""
        # A yield anywhere in the body makes this an async generator; the raise
        # fires on the first ``__anext__`` call so the router sees the error
        # before any chunks land.
        if False:  # pragma: no cover - unreachable, marks this as an async generator
            yield "", None
        msg = "upstream_boom"
        raise RuntimeError(msg)

    with patch.object(botmason_router_mod, "generate_response_stream", _boom):
        resp = await async_client.post(
            "/journal/chat/stream", json={"message": "Hi"}, headers=headers
        )

    assert resp.status_code == HTTPStatus.OK
    events = _parse_sse_events(resp.text)
    assert len(events) == 1
    name, payload = events[0]
    assert name == "error"
    assert payload["status"] == 502  # noqa: PLR2004
    assert payload["detail"] == "llm_provider_error"

    # Rollback: wallet untouched, no journal entries created.
    balance = await async_client.get("/user/balance", headers=headers)
    assert balance.json()["balance"] == 1

    listing = await async_client.get("/journal/", headers=headers)
    assert listing.json()["total"] == 0


@pytest.mark.asyncio
async def test_stream_falls_back_to_env_key_when_header_absent(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Streaming endpoint honours the same BYOK precedence as the non-stream one."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", _VALID_OPENAI_KEY)

    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)

    async def _fake_stream(
        _user_message: str,
        _history: list[dict[str, str]],
        *,
        system_prompt: str | None = None,  # noqa: ARG001 - signature-compat with service
        api_key: str | None = None,
    ) -> AsyncIterator[tuple[str, LLMResponse | None]]:
        yield "Hello ", None
        final = _mock_openai_response("Hello world", prompt_tokens=3, completion_tokens=2)
        # Assert the env key fallback by inspecting what was forwarded.
        _fake_stream.captured_key = api_key  # type: ignore[attr-defined]
        yield "world", final

    with patch.object(botmason_router_mod, "generate_response_stream", _fake_stream):
        resp = await async_client.post(
            "/journal/chat/stream", json={"message": "Hi"}, headers=headers
        )
    assert resp.status_code == HTTPStatus.OK

    # When the header is absent the router forwards ``None`` and the service
    # layer resolves the env var on the provider side.
    assert _fake_stream.captured_key is None  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_stream_rejects_malformed_header_key_with_400(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Malformed BYOK keys 400 *before* the stream opens (no SSE body)."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", _VALID_OPENAI_KEY)

    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)
    headers[LLM_API_KEY_HEADER] = "not-a-real-key"  # pragma: allowlist secret

    resp = await async_client.post("/journal/chat/stream", json={"message": "Hi"}, headers=headers)
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    # Wallet must be untouched on pre-flight rejection.
    balance = await async_client.get("/user/balance", headers=headers)
    assert balance.json()["balance"] == 1


# ── generate_response_stream service unit tests ──────────────────────────


@pytest.mark.asyncio
async def test_stub_stream_yields_words_then_final() -> None:
    """The stub chunker emits the canned response word-by-word and a final payload."""
    chunks: list[tuple[str, LLMResponse | None]] = []
    async for item in botmason_mod.generate_response_stream("ping", []):
        chunks.append(item)

    # At least two chunks (non-final plus final) so clients get progressive UI.
    assert len(chunks) >= 2  # noqa: PLR2004
    # Non-final chunks have ``final=None``; only the last one carries metadata.
    assert all(final is None for _, final in chunks[:-1])
    _, last_final = chunks[-1]
    assert last_final is not None
    assert last_final.provider == "stub"
    # Concatenation must round-trip to the canned stub text.
    reassembled = "".join(chunk for chunk, _ in chunks)
    assert reassembled == last_final.text
    assert "ping" in last_final.text


@pytest.mark.asyncio
async def test_stream_dispatch_routes_to_configured_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``generate_response_stream`` must fan out by ``BOTMASON_PROVIDER``.

    We don't exercise the real provider SDKs in tests (they require network /
    keys), so we patch the private streamers and assert the dispatcher picks
    the right one and forwards the api_key override intact.
    """

    async def _fake(
        _msg: str,
        _history: list[dict[str, str]],
        _prompt: str,
        api_key: str | None,
    ) -> AsyncIterator[tuple[str, LLMResponse | None]]:
        # Echo the api_key back through the final LLMResponse so the caller
        # can prove the override propagated without leaking it in logs.
        final = LLMResponse(
            text=api_key or "",
            provider="fake",
            model="fake",
            prompt_tokens=0,
            completion_tokens=0,
        )
        yield "", final

    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setattr(botmason_mod, "_stream_openai", _fake)
    openai_chunks = [
        item
        async for item in botmason_mod.generate_response_stream(
            "hi",
            [],
            api_key="sk-override",  # pragma: allowlist secret
        )
    ]
    assert openai_chunks[-1][1] is not None
    assert openai_chunks[-1][1].text == "sk-override"

    monkeypatch.setenv("BOTMASON_PROVIDER", "anthropic")
    monkeypatch.setattr(botmason_mod, "_stream_anthropic", _fake)
    anthropic_chunks = [
        item
        async for item in botmason_mod.generate_response_stream(
            "hi",
            [],
            api_key="sk-ant-override",  # pragma: allowlist secret
        )
    ]
    assert anthropic_chunks[-1][1] is not None
    assert anthropic_chunks[-1][1].text == "sk-ant-override"
