"""Tests for the BotMason wallet API and LLM provider service.

The conversational chat endpoints were retired in favour of journal
resonance; what remains here exercises the wallet surface
(``/user/balance``, ``/user/usage``, ``/user/balance/add``) and the
``services.botmason`` provider layer (system-prompt loading, BYOK key
resolution, and provider routing).
"""

from __future__ import annotations

import asyncio
import importlib
import pathlib
from http import HTTPStatus
from typing import ClassVar
from unittest.mock import AsyncMock, patch

import anthropic
import openai
import pytest
from httpx import AsyncClient
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col

import services.botmason as botmason_mod
from models.user import User
from services.botmason import (
    LLM_API_KEY_MAX_LENGTH,
    LLMResponse,
    generate_response,
    get_system_prompt,
    provider_for_api_key,
    validate_llm_api_key_format,
)
from services.usage import (
    DEFAULT_MONTHLY_CAP,
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


async def _promote_admin(db_session: AsyncSession, username: str = "alice") -> None:
    """Flip ``is_admin`` for the user created by :func:`_signup`."""
    email = f"{username}@example.com"
    await db_session.execute(update(User).where(col(User.email) == email).values(is_admin=True))
    await db_session.commit()


async def _signup_admin(
    client: AsyncClient, db_session: AsyncSession, username: str = "alice"
) -> dict[str, str]:
    """Sign up a user and promote them to admin — returns their auth headers.

    Chat / balance tests use this because :http:post:`/user/balance/add` is
    admin-gated; tests that only exercise the non-admin surface should keep
    using :func:`_signup`.
    """
    headers = await _signup(client, username)
    await _promote_admin(db_session, username)
    return headers


async def _concurrent_promote_admin(
    factory: async_sessionmaker[AsyncSession], username: str = "alice"
) -> None:
    """Promote a signed-up user via the concurrent-fixture engine."""
    email = f"{username}@example.com"
    async with factory() as session:
        await session.execute(update(User).where(col(User.email) == email).values(is_admin=True))
        await session.commit()


async def _concurrent_signup_admin(
    client: AsyncClient,
    factory: async_sessionmaker[AsyncSession],
    username: str = "alice",
) -> dict[str, str]:
    """Concurrent-fixture counterpart of :func:`_signup_admin`."""
    headers = await _signup(client, username)
    await _concurrent_promote_admin(factory, username)
    return headers


# ── Authentication ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_balance_unauthenticated_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/user/balance")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_add_balance_unauthenticated_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.post("/user/balance/add", json={"amount": 5})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_add_balance_non_admin_returns_403(async_client: AsyncClient) -> None:
    """A signed-in non-admin must not be able to mint credits."""
    headers = await _signup(async_client)
    resp = await async_client.post("/user/balance/add", json={"amount": 5}, headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "admin_required"


@pytest.mark.asyncio
async def test_add_balance_deleted_admin_returns_401(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A valid JWT whose admin row was deleted now 401s at the auth gate.

    BUG-MODEL-001: ``get_current_user`` queries ``is_active`` /
    ``deleted_at`` so a missing-user lookup short-circuits with 401
    ``unauthorized`` (the correct OWASP A07 response for a JWT that
    cannot be resolved to a user) before reaching the admin check.
    """
    headers = await _signup_admin(async_client, db_session)
    await db_session.execute(delete(User).where(col(User.email) == "alice@example.com"))
    await db_session.commit()

    resp = await async_client.post("/user/balance/add", json={"amount": 5}, headers=headers)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED
    assert resp.json()["detail"] == "unauthorized"


# ── Offering balance ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_balance_default_zero(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/user/balance", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["balance"] == 0


@pytest.mark.asyncio
async def test_add_balance(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await _signup_admin(async_client, db_session)
    resp = await async_client.post("/user/balance/add", json={"amount": 5}, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["balance"] == 5
    assert data["added"] == 5


@pytest.mark.asyncio
async def test_add_balance_accumulates(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await _signup_admin(async_client, db_session)
    resp1 = await async_client.post("/user/balance/add", json={"amount": 3}, headers=headers)
    assert resp1.status_code == HTTPStatus.OK
    resp2 = await async_client.post("/user/balance/add", json={"amount": 7}, headers=headers)
    assert resp2.status_code == HTTPStatus.OK

    resp = await async_client.get("/user/balance", headers=headers)
    assert resp.json()["balance"] == 10


@pytest.mark.asyncio
async def test_add_balance_rejects_zero_amount(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``amount=0`` fails Pydantic ``ge=1`` → 422, not 400."""
    headers = await _signup_admin(async_client, db_session)
    resp = await async_client.post("/user/balance/add", json={"amount": 0}, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_add_balance_rejects_negative_amount(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Negative amounts short-circuit at the schema, never reaching the wallet."""
    headers = await _signup_admin(async_client, db_session)
    resp = await async_client.post("/user/balance/add", json={"amount": -5}, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_add_balance_rejects_amount_over_one_million(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``amount > 1_000_000`` is rejected before wallet code runs."""
    headers = await _signup_admin(async_client, db_session)
    resp = await async_client.post("/user/balance/add", json={"amount": 1_000_001}, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_add_balance_accepts_upper_bound(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The upper bound (1_000_000) itself is valid — only *over* it is rejected."""
    headers = await _signup_admin(async_client, db_session)
    resp = await async_client.post("/user/balance/add", json={"amount": 1_000_000}, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["balance"] == 1_000_000


@pytest.mark.asyncio
async def test_add_balance_rejects_non_integer_amount(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A floating-point amount (e.g. 1.5) is not a valid credit grant."""
    headers = await _signup_admin(async_client, db_session)
    resp = await async_client.post("/user/balance/add", json={"amount": 1.5}, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


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
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_balance_additions_are_atomic(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Concurrent balance additions must not lose updates (sec-17)."""
    headers = await _concurrent_signup_admin(concurrent_async_client, concurrent_session_factory)

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
    if len(args) >= 4:
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


def test_provider_for_api_key_derives_provider_from_prefix() -> None:
    """A BYOK key resolves to the provider its prefix identifies."""
    assert provider_for_api_key(_VALID_OPENAI_KEY) == "openai"
    assert provider_for_api_key(_VALID_ANTHROPIC_KEY) == "anthropic"
    assert provider_for_api_key("not-a-real-key") is None
    assert provider_for_api_key("") is None


@pytest.mark.asyncio
async def test_generate_response_byok_key_overrides_stub_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``generate_response`` dispatches on the BYOK key's provider, not the env."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.delenv("LLM_API_KEY", raising=False)

    mock_call = AsyncMock(return_value=_mock_openai_response("byok-on-stub"))
    with patch.object(botmason_mod, "_call_openai", mock_call):
        result = await generate_response("hi", [], api_key=_VALID_OPENAI_KEY)

    assert result.text == "byok-on-stub"
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
    assert data["monthly_messages_remaining"] == 50
    assert data["monthly_cap"] == 50
    assert data["offering_balance"] == 0
    # Reset date is first-of-next-month UTC — sanity check format only so
    # the test does not drift with the wall clock.
    assert data["monthly_reset_date"].endswith(("Z", "+00:00")) or "T" in data["monthly_reset_date"]


@pytest.mark.asyncio
async def test_usage_endpoint_unauthenticated_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/user/usage")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── Usage service unit tests ─────────────────────────────────────────


def test_get_monthly_cap_default_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BOTMASON_MONTHLY_CAP", raising=False)
    assert get_monthly_cap() == DEFAULT_MONTHLY_CAP


def test_get_monthly_cap_parses_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "17")
    assert get_monthly_cap() == 17


def test_get_monthly_cap_rejects_malformed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "not-a-number")
    assert get_monthly_cap() == DEFAULT_MONTHLY_CAP


def test_get_monthly_cap_rejects_negative(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "-5")
    assert get_monthly_cap() == DEFAULT_MONTHLY_CAP


def test_get_monthly_cap_allows_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "0")
    assert get_monthly_cap() == 0


# ── Issue #402: live-provider activation ────────────────────────────────


class _FakeOpenAIClient:
    """Stands in for ``openai.AsyncOpenAI`` — records ctor args, returns a completion."""

    last_kwargs: ClassVar[dict[str, object]] = {}

    def __init__(self, **kwargs: object) -> None:
        type(self).last_kwargs = kwargs

        class _Completions:
            @staticmethod
            async def create(**_call: object) -> object:
                message = type("Msg", (), {"content": "A real OpenAI completion."})()
                choice = type("Choice", (), {"message": message})()
                usage = type("Usage", (), {"prompt_tokens": 42, "completion_tokens": 17})()
                return type("Completion", (), {"choices": [choice], "usage": usage})()

        self.chat = type("Chat", (), {"completions": _Completions()})()


class _FakeAnthropicClient:
    """Stands in for ``anthropic.AsyncAnthropic`` — records ctor args, returns a message."""

    last_kwargs: ClassVar[dict[str, object]] = {}

    def __init__(self, **kwargs: object) -> None:
        type(self).last_kwargs = kwargs

        class _Messages:
            @staticmethod
            async def create(**_call: object) -> object:
                block = type("Block", (), {"text": "A real Anthropic completion."})()
                usage = type("Usage", (), {"input_tokens": 33, "output_tokens": 9})()
                return type("Message", (), {"content": [block], "usage": usage})()

        self.messages = _Messages()


@pytest.mark.asyncio
async def test_generate_response_routes_to_openai_sdk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The openai provider routes through the real SDK import path.

    Model text and non-zero token counts come back (issue #402).
    """
    monkeypatch.setattr(openai, "AsyncOpenAI", _FakeOpenAIClient)
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", "sk-server-key")  # pragma: allowlist secret
    monkeypatch.delenv("LLM_MODEL", raising=False)

    result = await generate_response("Hello", [])

    assert result.text == "A real OpenAI completion."
    assert result.provider == "openai"
    assert result.prompt_tokens == 42
    assert result.completion_tokens == 17
    assert _FakeOpenAIClient.last_kwargs["api_key"] == "sk-server-key"  # pragma: allowlist secret


@pytest.mark.asyncio
async def test_generate_response_routes_to_anthropic_sdk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same end-to-end proof for the anthropic provider."""
    monkeypatch.setattr(anthropic, "AsyncAnthropic", _FakeAnthropicClient)
    monkeypatch.setenv("BOTMASON_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_API_KEY", "sk-ant-server-key")  # pragma: allowlist secret
    monkeypatch.delenv("LLM_MODEL", raising=False)

    result = await generate_response("Hello", [])

    assert result.text == "A real Anthropic completion."
    assert result.provider == "anthropic"
    assert result.prompt_tokens == 33
    assert result.completion_tokens == 9
    expected_key = "sk-ant-server-key"  # pragma: allowlist secret
    assert _FakeAnthropicClient.last_kwargs["api_key"] == expected_key


def test_provider_sdks_are_installed_dependencies() -> None:
    """The SDKs are declared dependencies that import cleanly."""
    assert importlib.import_module("openai") is not None
    assert importlib.import_module("anthropic") is not None


# ── Issue #404: declarative provider registry ───────────────────────────


def test_registry_specs_are_internally_consistent() -> None:
    """Every provider entry is complete and self-consistent.

    Default model on its own allowlist; entrypoints resolve to real
    module callables; a non-empty key prefix.
    """
    assert set(botmason_mod.PROVIDER_REGISTRY) >= {"openai", "anthropic"}
    for name, spec in botmason_mod.PROVIDER_REGISTRY.items():
        assert spec.default_model in spec.allowed_models, name
        assert callable(getattr(botmason_mod, spec.call_name)), name
        assert spec.key_prefix, name


def test_registry_key_prefixes_are_unambiguous() -> None:
    """A synthetic key built from each provider's prefix routes ONLY to it."""
    for name, spec in botmason_mod.PROVIDER_REGISTRY.items():
        synthetic = f"{spec.key_prefix}{'x' * 40}"
        assert provider_for_api_key(synthetic) == name


@pytest.mark.asyncio
async def test_disallowed_model_rejected_before_any_network_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A model outside the allowlist fails fast — the SDK client is never built."""
    constructed: list[bool] = []

    class _Tripwire:
        def __init__(self, **_kwargs: object) -> None:
            constructed.append(True)

    monkeypatch.setattr(openai, "AsyncOpenAI", _Tripwire)
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", "sk-server-key")  # pragma: allowlist secret
    monkeypatch.setenv("LLM_MODEL", "gpt-4o-most-expensive")

    with pytest.raises(RuntimeError, match="allowlist"):
        await generate_response("Hello", [])
    assert constructed == []


@pytest.mark.asyncio
async def test_allowed_model_passes_the_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(openai, "AsyncOpenAI", _FakeOpenAIClient)
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", "sk-server-key")  # pragma: allowlist secret
    monkeypatch.setenv("LLM_MODEL", "gpt-4o")

    result = await generate_response("Hello", [])
    assert result.provider == "openai"
