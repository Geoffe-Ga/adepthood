"""Server-paid generations refuse the models one offering cannot pay for (#623).

The owner's 2026-09-06 economics validation (decision record §2) found that
"Opus/Turbo models are not safely covered by a flat one-offering charge at
their worst case" and ruled: "treat Opus/Turbo as BYOK/admin-only or charge a
model-specific multiplier". Record §4 picks the option: "refuse non-cost-bounded
models on the server-paid path (no multiplier)".

These tests pin where that refusal lives (``generate_response``, gated on
``api_key is None``), what it refuses (exactly Opus/Turbo), and what it leaves
alone (BYOK, the stub, the cost-bounded defaults, and the vision capability
probe that shares ``_get_model``).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from services import botmason
from services.botmason import (
    PROVIDER_REGISTRY,
    SERVER_PAID_REFUSED_MODELS,
    LLMProviderError,
    LLMResponse,
    LLMVisionUnsupportedError,
    generate_response,
    vision_provider_available,
)
from services.llm_pricing import MODEL_PRICING
from tests.provider_transport import ANTHROPIC_KEY, OPENAI_KEY

_KEY_FOR_PROVIDER = {"anthropic": ANTHROPIC_KEY, "openai": OPENAI_KEY}
_CALLER_FOR_PROVIDER = {"anthropic": "_call_anthropic", "openai": "_call_openai"}

_REFUSED_CASES = [
    ("anthropic", "claude-opus-5"),
    ("anthropic", "claude-opus-4-7"),
    ("openai", "gpt-4-turbo"),
]

_CANNED = LLMResponse(
    text="ok", provider="test", model="test", prompt_tokens=1, completion_tokens=1
)


def _configure(monkeypatch: pytest.MonkeyPatch, provider: str, model: str) -> None:
    """Point the server at a real provider with its own server-side key."""
    monkeypatch.setenv("BOTMASON_PROVIDER", provider)
    monkeypatch.setenv("LLM_API_KEY", _KEY_FOR_PROVIDER[provider])
    monkeypatch.setenv("LLM_MODEL", model)


@pytest.mark.asyncio
@pytest.mark.parametrize(("provider", "model"), _REFUSED_CASES)
async def test_server_paid_generate_response_refuses_opus_before_dialing(
    monkeypatch: pytest.MonkeyPatch, provider: str, model: str
) -> None:
    """A server-paid Opus/Turbo request raises before any provider dial."""
    _configure(monkeypatch, provider, model)
    caller = AsyncMock(return_value=_CANNED)
    with (
        patch.object(botmason, _CALLER_FOR_PROVIDER[provider], caller),
        pytest.raises(LLMProviderError) as exc,
    ):
        await generate_response("hello", [], api_key=None)
    assert not isinstance(exc.value, LLMVisionUnsupportedError)
    assert str(exc.value) == "server_paid_model_not_allowed"
    caller.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(("provider", "model"), _REFUSED_CASES)
async def test_server_paid_refusal_logs_provider_and_model_not_the_key(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    provider: str,
    model: str,
) -> None:
    """The refusal is visible to operators, and the server key never reaches a log."""
    _configure(monkeypatch, provider, model)
    with (
        patch.object(botmason, _CALLER_FOR_PROVIDER[provider], AsyncMock()),
        caplog.at_level("WARNING", logger=botmason.__name__),
        pytest.raises(LLMProviderError),
    ):
        await generate_response("hello", [], api_key=None)
    refusals = [r for r in caplog.records if r.getMessage() == "server_paid_model_refused"]
    assert len(refusals) == 1
    assert refusals[0].__dict__["provider"] == provider
    assert refusals[0].__dict__["model"] == model
    assert _KEY_FOR_PROVIDER[provider] not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(("provider", "model"), _REFUSED_CASES)
async def test_byok_opus_still_dials(
    monkeypatch: pytest.MonkeyPatch, provider: str, model: str
) -> None:
    """The user's own key pays, so the same model dials exactly once."""
    _configure(monkeypatch, provider, model)
    caller = AsyncMock(return_value=_CANNED)
    with patch.object(botmason, _CALLER_FOR_PROVIDER[provider], caller):
        result = await generate_response("hello", [], api_key=_KEY_FOR_PROVIDER[provider])
    assert result is _CANNED
    caller.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "model"),
    [("anthropic", "claude-sonnet-5"), ("openai", "gpt-4o-mini")],
)
async def test_default_models_dial_when_server_paid(
    monkeypatch: pytest.MonkeyPatch, provider: str, model: str
) -> None:
    """The cost-bounded defaults are what server-paid traffic runs on."""
    _configure(monkeypatch, provider, model)
    caller = AsyncMock(return_value=_CANNED)
    with patch.object(botmason, _CALLER_FOR_PROVIDER[provider], caller):
        result = await generate_response("hello", [], api_key=None)
    assert result is _CANNED
    caller.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "model"),
    [("anthropic", "claude-sonnet-4-6"), ("openai", "gpt-4o")],
)
async def test_unratified_models_stay_allowed_when_server_paid(
    monkeypatch: pytest.MonkeyPatch, provider: str, model: str
) -> None:
    """Sonnet 4.6 and gpt-4o are an open question, not a ratified refusal."""
    _configure(monkeypatch, provider, model)
    caller = AsyncMock(return_value=_CANNED)
    with patch.object(botmason, _CALLER_FOR_PROVIDER[provider], caller):
        await generate_response("hello", [], api_key=None)
    caller.assert_awaited_once()


@pytest.mark.asyncio
async def test_stub_provider_is_unaffected_under_an_opus_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The stub never dials, so an Opus LLM_MODEL changes nothing for it."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.setenv("LLM_MODEL", "claude-opus-5")
    result = await generate_response("hello", [], api_key=None)
    assert result.text


@pytest.mark.parametrize(("provider", "model"), _REFUSED_CASES)
def test_vision_provider_available_does_not_raise_under_opus(
    monkeypatch: pytest.MonkeyPatch, provider: str, model: str
) -> None:
    """The capability probe shares ``_get_model``; the guard is not in there."""
    _configure(monkeypatch, provider, model)
    assert vision_provider_available() is True


def test_refused_set_is_exactly_opus_and_turbo_and_allowlists_are_unchanged() -> None:
    """No multiplier, no allowlist or pricing edit: only the refusal set is new."""
    assert frozenset({"claude-opus-5", "claude-opus-4-7", "gpt-4-turbo"}) == (
        SERVER_PAID_REFUSED_MODELS
    )
    for model in SERVER_PAID_REFUSED_MODELS:
        assert model in MODEL_PRICING
        assert any(model in spec.allowed_models for spec in PROVIDER_REGISTRY.values())
