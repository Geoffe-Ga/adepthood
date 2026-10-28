"""No model is server-paid any more, so the Opus/Turbo carve-out is subsumed (#623, #3067).

#623 refused Opus/Turbo "on the server-paid path" because one offering could
not pay for their worst case. ADR 0009 phase (a) removed that path outright: a
request carrying no key of the writer's own never reaches a cloud provider, on
any model. These tests pin that the old refusal set is now a subset of a
stricter rule -- every configured model, cost-bounded or not, is undialled
without the writer's key -- while the writer's own key still reaches all of
them, the stub is unaffected, and the vision capability check that shares
``_get_model`` does not raise.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from services import botmason
from services.botmason import (
    KEY_REQUIRED_DETAIL,
    PROVIDER_REGISTRY,
    LLMResponse,
    NoGenerationSourceError,
    generate_response,
    supports_vision,
)
from services.llm_pricing import MODEL_PRICING
from tests.provider_transport import ANTHROPIC_KEY, OPENAI_KEY

_KEY_FOR_PROVIDER = {"anthropic": ANTHROPIC_KEY, "openai": OPENAI_KEY}
_CALLER_FOR_PROVIDER = {"anthropic": "_call_anthropic", "openai": "_call_openai"}

#: The models #623 refused server-paid: still on the allowlists, BYOK-only.
_UNCAPPED_CASES = [
    ("anthropic", "claude-opus-5"),
    ("anthropic", "claude-opus-4-7"),
    ("openai", "gpt-4-turbo"),
]
#: The cost-bounded defaults and the two left as an open question: no longer
#: server-paid either.
_BOUNDED_CASES = [
    ("anthropic", "claude-sonnet-5"),
    ("openai", "gpt-4o-mini"),
    ("anthropic", "claude-sonnet-4-6"),
    ("openai", "gpt-4o"),
]

_CANNED = LLMResponse(
    text="ok", provider="test", model="test", prompt_tokens=1, completion_tokens=1
)


def _configure(monkeypatch: pytest.MonkeyPatch, provider: str, model: str) -> None:
    """Point the server at a real provider with its own server-side key, seam disarmed."""
    monkeypatch.setenv("BOTMASON_PROVIDER", provider)
    monkeypatch.setenv("LLM_API_KEY", _KEY_FOR_PROVIDER[provider])
    monkeypatch.setenv("LLM_MODEL", model)
    monkeypatch.delenv(botmason.STUB_SEAM_ENV_VAR, raising=False)


@pytest.mark.asyncio
@pytest.mark.parametrize(("provider", "model"), _UNCAPPED_CASES + _BOUNDED_CASES)
async def test_no_configured_model_is_dialled_without_the_writers_key(
    monkeypatch: pytest.MonkeyPatch, provider: str, model: str
) -> None:
    """Keyless: refused ``llm_key_required`` before the provider function is reached."""
    _configure(monkeypatch, provider, model)
    caller = AsyncMock(return_value=_CANNED)
    with (
        patch.object(botmason, _CALLER_FOR_PROVIDER[provider], caller),
        pytest.raises(NoGenerationSourceError) as exc,
    ):
        await generate_response("hello", [], api_key=None)
    assert str(exc.value) == KEY_REQUIRED_DETAIL
    caller.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(("provider", "model"), _UNCAPPED_CASES + _BOUNDED_CASES)
async def test_the_writers_own_key_still_dials_every_allowlisted_model(
    monkeypatch: pytest.MonkeyPatch, provider: str, model: str
) -> None:
    """The writer's own key pays, so the same model dials exactly once."""
    _configure(monkeypatch, provider, model)
    caller = AsyncMock(return_value=_CANNED)
    with patch.object(botmason, _CALLER_FOR_PROVIDER[provider], caller):
        result = await generate_response("hello", [], api_key=_KEY_FOR_PROVIDER[provider])
    assert result is _CANNED
    caller.assert_awaited_once()


@pytest.mark.asyncio
async def test_stub_provider_is_unaffected_under_an_opus_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The armed stub never dials, so an Opus LLM_MODEL changes nothing for it."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.setenv("LLM_MODEL", "claude-opus-5")
    result = await generate_response("hello", [], api_key=None)
    assert result.provider == botmason.STUB_PROVIDER_NAME


@pytest.mark.parametrize(("provider", "model"), _UNCAPPED_CASES)
def test_vision_capability_check_does_not_raise_under_opus(
    monkeypatch: pytest.MonkeyPatch, provider: str, model: str
) -> None:
    """Each uncapped model stays vision-capable for a writer's own key under its own config."""
    _configure(monkeypatch, provider, model)
    assert supports_vision(provider, model) is True


def test_the_uncapped_models_stay_allowlisted_and_priced_for_byok() -> None:
    """No allowlist or pricing edit: the writer's own key can still choose them."""
    for _provider, model in _UNCAPPED_CASES:
        assert model in MODEL_PRICING
        assert any(model in spec.allowed_models for spec in PROVIDER_REGISTRY.values())
