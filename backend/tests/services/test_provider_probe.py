"""One marked prompt leaves a stub-configured server for a real provider.

A deployment whose ``BOTMASON_PROVIDER`` is the stub answers every prompt
itself. That is what makes it deterministic, and it is also what leaves the
provider wiring behind it — key resolution, the SDK, the transport, the retry
budget, and the classification of whatever comes back — never exercised. The
probe token is the seam that closes that gap: armed by configuration, it sends
exactly the prompts that carry it to a named real provider and leaves every
other prompt with the stub.

These tests pin both halves. The routing (a marked prompt dials, an unmarked one
does not, and neither an unarmed server nor a real-provider server is affected)
and the consequence that makes the seam worth having: the error a caller gets
back is one the SDK built out of the provider's own response body, so what is
under test is the real classification rather than a hand-built exception. That
distinction is the whole reason the billing-refusal bug shipped (#2479), and the
end-to-end lane reaches this condition through this seam.
"""

from __future__ import annotations

from typing import Any

import anthropic
import openai
import pytest

from services import botmason
from services.botmason import (
    STUB_PROSE_PREFIX,
    STUB_PROVIDER_NAME,
    LLMCreditExhaustedError,
    generate_response,
)
from services.provider_probe import MIN_PROBE_TOKEN_LENGTH, PROVIDER_PROBE_ENV_VAR, probed_provider
from tests.provider_transport import (
    ANTHROPIC_KEY,
    OPENAI_KEY,
    TransportStub,
    use_anthropic,
    use_openai,
)

#: A token of the shape the lane mints: random, and long enough to arm.
TOKEN = "b7Qm2xL9pT4vRc8ZaHnE6sWd"  # pragma: allowlist secret

#: OpenAI's answer for an account whose quota is spent, as
#: ``tests/services/test_botmason_credit_exhausted.py`` captured it. Repeated
#: rather than imported: that module owns the classifier's fixtures, this one
#: owns the routing, and a shared import would make an edit there silently
#: change what this file believes it is sending.
_OPENAI_QUOTA_BODY: dict[str, Any] = {
    "error": {
        "message": "You exceeded your current quota, please check your plan and billing details.",
        "type": "insufficient_quota",
        "param": None,
        "code": "insufficient_quota",
    }
}

_ANTHROPIC_CREDIT_BODY: dict[str, Any] = {
    "type": "error",
    "error": {
        "type": "invalid_request_error",
        "message": (
            "Your credit balance is too low to access the Anthropic API. "
            "Please go to Plans & Billing to upgrade or purchase credits."
        ),
    },
}

_HTTP_TOO_MANY_REQUESTS = 429
_HTTP_BAD_REQUEST = 400


#: An entry the writer might actually have written, with the marker sitting in
#: it the way the lane puts it there.
def _marked(provider: str, token: str = TOKEN) -> str:
    """Return a prompt carrying the probe marker for ``provider``."""
    return f"The willow bent all night. {token}:{provider}"


UNMARKED = "The willow bent all night and did not break."


def _arm(monkeypatch: pytest.MonkeyPatch, token: str = TOKEN) -> None:
    """Arm the probe with ``token`` on a stub-configured server."""
    monkeypatch.setenv(PROVIDER_PROBE_ENV_VAR, token)
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")


class TestTheProbeIsOffUntilItIsConfigured:
    """Nothing about a prompt can arm this; only the operator's environment can."""

    @pytest.mark.asyncio
    async def test_an_unarmed_server_answers_a_marked_prompt_from_the_stub(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """With no token set, the marker is just text the writer happened to type."""
        stub = use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_QUOTA_BODY)
        monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
        monkeypatch.delenv(PROVIDER_PROBE_ENV_VAR, raising=False)

        result = await generate_response(_marked("openai"), [])

        assert result.provider == STUB_PROVIDER_NAME
        assert STUB_PROSE_PREFIX in result.text
        assert stub.request_count == 0

    @pytest.mark.asyncio
    async def test_a_token_below_the_length_floor_cannot_arm_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A careless or truncated value must not become a live provider seam.

        A one-character token would make a marker a writer could stumble into,
        and an empty one would make every prompt a marked prompt.
        """
        short = "x" * (MIN_PROBE_TOKEN_LENGTH - 1)
        stub = use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_QUOTA_BODY)
        _arm(monkeypatch, short)

        result = await generate_response(_marked("openai", short), [])

        assert result.provider == STUB_PROVIDER_NAME
        assert stub.request_count == 0

    @pytest.mark.asyncio
    async def test_an_armed_server_still_answers_every_unmarked_prompt_from_the_stub(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Arming the probe must not turn the whole deployment into a provider client."""
        stub = use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_QUOTA_BODY)
        _arm(monkeypatch)

        result = await generate_response(UNMARKED, [])

        assert result.provider == STUB_PROVIDER_NAME
        assert stub.request_count == 0

    @pytest.mark.asyncio
    async def test_a_marker_naming_no_known_provider_dials_nothing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The provider half of the marker is matched against the registry, not trusted."""
        stub = use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_QUOTA_BODY)
        _arm(monkeypatch)

        result = await generate_response(_marked("mystery-provider"), [])

        assert result.provider == STUB_PROVIDER_NAME
        assert stub.request_count == 0


class TestAMarkedPromptReachesTheProviderAndItsOwnError:
    """What comes back is the SDK's error, built from the provider's real body."""

    @pytest.mark.asyncio
    async def test_openai_builds_its_own_rate_limit_error_from_the_quota_body(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The refusal is a response body, never a directly-raised typed error.

        The assertion on ``__cause__`` is the load-bearing one: it says the
        exception this server classified was constructed by the SDK out of a
        ``429`` carrying ``insufficient_quota``, which is how OpenAI actually
        expresses a spent balance.
        """
        stub = use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_QUOTA_BODY)
        _arm(monkeypatch)

        with pytest.raises(LLMCreditExhaustedError) as excinfo:
            await generate_response(_marked("openai"), [])

        assert excinfo.value.provider == "openai"
        assert isinstance(excinfo.value.__cause__, openai.RateLimitError)
        assert stub.request_count == 1

    @pytest.mark.asyncio
    async def test_anthropic_builds_its_own_bad_request_from_the_credit_body(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Anthropic publishes no code for this, so the prose in its ``400`` is the signal."""
        stub = use_anthropic(monkeypatch, _HTTP_BAD_REQUEST, _ANTHROPIC_CREDIT_BODY)
        _arm(monkeypatch)

        with pytest.raises(LLMCreditExhaustedError) as excinfo:
            await generate_response(_marked("anthropic"), [])

        assert excinfo.value.provider == "anthropic"
        assert isinstance(excinfo.value.__cause__, anthropic.BadRequestError)
        assert stub.request_count == 1

    @pytest.mark.asyncio
    async def test_the_probed_call_carries_the_server_key_and_never_echoes_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A probed request is paid for by the server's own key, and says so nowhere."""
        use_anthropic(monkeypatch, _HTTP_BAD_REQUEST, _ANTHROPIC_CREDIT_BODY)
        _arm(monkeypatch)

        with pytest.raises(LLMCreditExhaustedError) as excinfo:
            await generate_response(_marked("anthropic"), [])

        assert ANTHROPIC_KEY not in str(excinfo.value)
        assert ANTHROPIC_KEY not in repr(excinfo.value)


class TestTheProbeCannotReachAConfiguredProvider:
    """A deployment that already dials a real provider is not on this path at all."""

    @pytest.mark.asyncio
    async def test_a_configured_provider_ignores_a_marker_naming_another_one(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The probe is consulted only when the configured provider is not a real one.

        Without this, a marker in a writer's entry could redirect a production
        request from the provider the operator configured to a different one —
        the probe weakening the very path it exists to exercise.
        """
        openai_stub = use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_QUOTA_BODY)
        anthropic_stub = use_anthropic(monkeypatch, _HTTP_BAD_REQUEST, _ANTHROPIC_CREDIT_BODY)
        # ``use_anthropic`` ran last, so the configured provider is Anthropic
        # while the marker below names OpenAI.
        monkeypatch.setenv(PROVIDER_PROBE_ENV_VAR, TOKEN)

        with pytest.raises(LLMCreditExhaustedError) as excinfo:
            await generate_response(_marked("openai"), [])

        assert excinfo.value.provider == "anthropic"
        assert anthropic_stub.request_count == 1
        assert openai_stub.request_count == 0

    @pytest.mark.asyncio
    async def test_a_caller_supplied_key_still_selects_its_own_provider(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """BYOK keeps deciding first: the key's owner pays, whatever the entry says."""
        anthropic_stub: TransportStub = use_anthropic(
            monkeypatch, _HTTP_BAD_REQUEST, _ANTHROPIC_CREDIT_BODY
        )
        # Second, so the model this run resolves is OpenAI's: each helper sets
        # ``LLM_MODEL`` for the provider it arms, and the call below is the one
        # that has to be servable.
        openai_stub = use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_QUOTA_BODY)
        _arm(monkeypatch)

        with pytest.raises(LLMCreditExhaustedError) as excinfo:
            await generate_response(_marked("anthropic"), [], api_key=OPENAI_KEY)

        assert excinfo.value.provider == "openai"
        assert openai_stub.request_count == 1
        assert anthropic_stub.request_count == 0


class TestTheMarkerIsMatchedExactly:
    """The unit beneath the routing, where the string rules are decided."""

    def test_it_reads_the_token_from_the_environment(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A marked message names its provider only when the token matches."""
        monkeypatch.setenv(PROVIDER_PROBE_ENV_VAR, TOKEN)

        assert probed_provider(_marked("openai"), botmason.PROVIDER_REGISTRY) == "openai"

    def test_a_different_token_is_not_this_deployments_marker(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Knowing the shape of the marker is not knowing the token."""
        monkeypatch.setenv(PROVIDER_PROBE_ENV_VAR, TOKEN)
        other = "Z" * MIN_PROBE_TOKEN_LENGTH

        assert probed_provider(_marked("openai", other), botmason.PROVIDER_REGISTRY) is None

    def test_surrounding_whitespace_does_not_change_the_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A value pasted with a trailing newline is the same token, not a dead one."""
        monkeypatch.setenv(PROVIDER_PROBE_ENV_VAR, f"  {TOKEN}\n")

        assert probed_provider(_marked("anthropic"), botmason.PROVIDER_REGISTRY) == "anthropic"

    def test_the_token_alone_names_no_provider(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Both halves are required; a bare token selects nothing."""
        monkeypatch.setenv(PROVIDER_PROBE_ENV_VAR, TOKEN)

        assert (
            probed_provider(f"a page mentioning {TOKEN} only", botmason.PROVIDER_REGISTRY) is None
        )
