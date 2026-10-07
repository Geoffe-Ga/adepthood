"""Shared fakes for the resonance-family LLM seam (``services.marginalia.generate_response``).

A fake that labels itself ``provider="stub"`` is no longer a neutral stand-in:
the server treats a stub answer as a demo (#3062) -- an uncharged pass with a
"demo" receipt -- exactly as it treats the real stub. A test that means "some
real provider answered and the charge stands" must therefore answer as one,
and :func:`real_provider_response` is the one place that shape is spelled.
"""

from __future__ import annotations

from services.botmason import ANTHROPIC_PROVIDER_NAME, LLMResponse

#: The model a fake real provider reports. Deliberately not a priced model, so
#: a test that meters cost has to say so rather than inherit a price by accident.
FAKE_REAL_MODEL = "fake-model"


def real_provider_response(
    text: str,
    *,
    provider: str = ANTHROPIC_PROVIDER_NAME,
    model: str = FAKE_REAL_MODEL,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
) -> LLMResponse:
    """Return an ``LLMResponse`` as a real (non-stub) provider would label it."""
    return LLMResponse(
        text=text,
        provider=provider,
        model=model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )
