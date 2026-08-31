"""A permanently exhausted provider balance is classified, and never retried.

Two providers express the same permanent, billing-level refusal differently:

* **OpenAI** answers ``429`` with a machine-readable ``code`` of
  ``insufficient_quota`` -- indistinguishable, by status alone, from a genuine
  rate limit that *is* worth retrying.
* **Anthropic** answers ``400`` with an ``invalid_request_error`` whose only
  signal is prose about the credit balance.

Both currently flatten into a plain :class:`LLMProviderError`, which every
caller maps to a transient ``502``. These tests pin the distinction.

Every provider here is stubbed at the **HTTP transport**, not at the SDK
call. The existing suites patch ``_call_openai`` / ``generate_response``
wholesale, so URL building, header assembly, status handling and -- decisively
-- the SDK's own construction of a typed error from a real response body never
run. A suite that hands the code a hand-built exception can never observe how
the provider actually expresses this condition, which is how it shipped. Here
the SDK builds its own ``RateLimitError`` / ``BadRequestError`` from the real
captured bodies, and every request that leaves the client is counted.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, TypeVar

import anthropic
import httpx
import httpx2
import openai
import pytest

from services import botmason
from services.botmason import _MAX_RETRIES, _RETRY_BASE_DELAY, LLMProviderError, generate_response
from tests.provider_transport import OPENAI_KEY, use_anthropic, use_openai

# --- Provider fixtures, captured from real accounts (see the issue bodies) ---

#: OpenAI's answer for an account whose quota is spent. The ``code`` is the
#: machine-readable signal that separates this from congestion.
_OPENAI_QUOTA_BODY: dict[str, Any] = {
    "error": {
        "message": "You exceeded your current quota, please check your plan and billing details.",
        "type": "insufficient_quota",
        "param": None,
        "code": "insufficient_quota",
    }
}

#: OpenAI's answer for a genuine rate limit -- the common case, same status,
#: different ``code``. Retrying this one is correct and must keep working.
_OPENAI_RATE_LIMIT_BODY: dict[str, Any] = {
    "error": {
        "message": "Rate limit reached for gpt-4o-mini in organization on requests per min.",
        "type": "requests",
        "param": None,
        "code": "rate_limit_exceeded",
    }
}

#: Anthropic's answer for a zero credit balance, captured verbatim. Anthropic
#: publishes no machine-readable code for this, so prose is the only signal.
_ANTHROPIC_CREDIT_BODY: dict[str, Any] = {
    "type": "error",
    "error": {
        "type": "invalid_request_error",
        "message": (
            "Your credit balance is too low to access the Anthropic API. "
            "Please go to Plans & Billing to upgrade or purchase credits."
        ),
    },
    "request_id": "req_011CeRey6WW3GcfU1D4hjUXs",
}

#: An ordinary Anthropic 400 that has nothing to do with billing. Without a
#: case like this the classifier is free to reclassify every 400 as a billing
#: refusal, which would be a worse bug than the one being fixed.
_ANTHROPIC_ORDINARY_400_BODY: dict[str, Any] = {
    "type": "error",
    "error": {
        "type": "invalid_request_error",
        "message": "max_tokens: 999999 > 8192, which is the maximum allowed for this model",
    },
    "request_id": "req_011CeRey6WW3GcfU1D4hjUXt",
}

#: Anthropic's genuine rate limit. The OpenAI carve-out must not reach it.
_ANTHROPIC_RATE_LIMIT_BODY: dict[str, Any] = {
    "type": "error",
    "error": {"type": "rate_limit_error", "message": "Number of requests has exceeded your limit."},
    "request_id": "req_011CeRey6WW3GcfU1D4hjUXu",
}

#: OpenAI's answer when a configured spend cap is hit rather than a quota
#: spent. A different reason for the same permanent, caller-settleable refusal.
_OPENAI_HARD_LIMIT_BODY: dict[str, Any] = {
    "error": {
        "message": "Billing hard limit has been reached",
        "type": "invalid_request_error",
        "param": None,
        "code": "billing_hard_limit_reached",
    }
}

#: Anthropic's overload answer -- a 529 that belongs to no RFC registry and is
#: its most common transient failure.
_ANTHROPIC_OVERLOADED_BODY: dict[str, Any] = {
    "type": "error",
    "error": {"type": "overloaded_error", "message": "Overloaded"},
}

#: A contrived Anthropic 429 whose prose happens to mention a credit balance.
#: The carve-out is narrowed by status as well as by SDK precisely so this stays
#: a retryable rate limit rather than being reclassified as permanent.
_ANTHROPIC_RATE_LIMIT_MENTIONING_CREDIT_BODY: dict[str, Any] = {
    "type": "error",
    "error": {
        "type": "rate_limit_error",
        "message": "Slow down; your credit balance is too low for this burst rate.",
    },
}

_HTTP_TOO_MANY_REQUESTS = 429
_HTTP_BAD_REQUEST = 400
#: Anthropic's own overload status. In no RFC registry, and its single most
#: common transient failure -- the reason the retryable range is a floor.
_HTTP_ANTHROPIC_OVERLOADED = 529

#: One provider call and no backoff: what a permanent refusal must cost.
_SINGLE_ATTEMPT = 1
#: What a genuinely transient failure is allowed to cost -- this layer's own
#: budget, and only this layer's.
_FULL_ATTEMPT_BUDGET = _MAX_RETRIES + 1
_EXPECTED_BACKOFF = [_RETRY_BASE_DELAY * (2**attempt) for attempt in range(_MAX_RETRIES)]


@pytest.fixture
def backoff_delays(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Record every backoff delay slept, without spending real time.

    Patches the module-global ``asyncio.sleep``, which silences the provider
    SDKs' own internal backoff as well as this layer's -- so a test asserting
    on attempts never quietly becomes a test of wall-clock patience.
    """
    delays: list[float] = []
    original_sleep = asyncio.sleep

    async def _record(delay: float, *args: object, **kwargs: object) -> None:
        del args, kwargs
        delays.append(delay)
        await original_sleep(0)

    monkeypatch.setattr(botmason.asyncio, "sleep", _record)
    return delays


#: Bound so a caller that asks for ``LLMCreditExhaustedError`` gets one back,
#: rather than a bare ``Exception`` whose ``provider`` no type checker can see.
_ExcT = TypeVar("_ExcT", bound=Exception)


async def _call_and_capture(exc_type: type[_ExcT]) -> _ExcT:  # noqa: UP047
    """Drive ``generate_response`` and return the raised ``exc_type``."""
    with pytest.raises(exc_type) as excinfo:
        await generate_response("hi", [])
    return excinfo.value


def _extra(record: logging.LogRecord, key: str) -> object:
    """Read one ``extra=`` field off a log record.

    Fields passed through ``extra=`` land in the record's ``__dict__`` rather
    than on the ``LogRecord`` type, so this is the honest way to reach them.
    """
    return record.__dict__[key]


class TestCreditExhaustionIsClassifiedApart:
    """A permanent billing refusal gets its own type; nothing else does."""

    @pytest.mark.asyncio
    async def test_openai_insufficient_quota_is_credit_exhausted(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """OpenAI's ``insufficient_quota`` 429 is a billing refusal, not congestion."""
        del backoff_delays
        use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_QUOTA_BODY)
        exc = await _call_and_capture(botmason.LLMCreditExhaustedError)
        assert exc.provider == "openai"

    @pytest.mark.asyncio
    async def test_anthropic_credit_balance_is_credit_exhausted(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """Anthropic's credit-balance 400 is the same condition in different clothes."""
        del backoff_delays
        use_anthropic(monkeypatch, _HTTP_BAD_REQUEST, _ANTHROPIC_CREDIT_BODY)
        exc = await _call_and_capture(botmason.LLMCreditExhaustedError)
        assert exc.provider == "anthropic"

    @pytest.mark.asyncio
    async def test_openai_genuine_rate_limit_stays_a_plain_provider_error(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """A real rate limit is transient and must keep its transient classification.

        Same status, same SDK class, different ``code``. A classifier keyed on
        the status would swallow this one too and tell every rate-limited user
        to go top up an account that is not empty.
        """
        del backoff_delays
        use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_RATE_LIMIT_BODY)
        exc = await _call_and_capture(LLMProviderError)
        assert not isinstance(exc, botmason.LLMCreditExhaustedError)

    @pytest.mark.asyncio
    async def test_anthropic_ordinary_bad_request_stays_a_plain_provider_error(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """A 400 that is not about billing must not be reclassified as one."""
        del backoff_delays
        use_anthropic(monkeypatch, _HTTP_BAD_REQUEST, _ANTHROPIC_ORDINARY_400_BODY)
        exc = await _call_and_capture(LLMProviderError)
        assert not isinstance(exc, botmason.LLMCreditExhaustedError)


class TestPermanentRefusalIsNotRetried:
    """No amount of waiting refills an empty account; genuine congestion clears."""

    @pytest.mark.asyncio
    async def test_openai_quota_costs_exactly_one_provider_call(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """One request leaves the process, and nothing sleeps.

        Counted at the transport rather than at the factory on purpose: this
        layer's retry loop is nested inside the SDK's own ``max_retries``, so
        an assertion made one level up cannot see the multiplication.
        """
        stub = use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_QUOTA_BODY)
        await _call_and_capture(botmason.LLMCreditExhaustedError)
        assert stub.request_count == _SINGLE_ATTEMPT
        assert backoff_delays == []

    @pytest.mark.asyncio
    async def test_openai_genuine_rate_limit_still_retries_with_backoff(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """The common case keeps its retries -- and only this layer's budget of them.

        This is the regression guard the fix is measured against: a change that
        makes every 429 permanent would trade a rare wasted retry for a common
        broken one.
        """
        stub = use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_RATE_LIMIT_BODY)
        await _call_and_capture(LLMProviderError)
        assert stub.request_count == _FULL_ATTEMPT_BUDGET
        assert backoff_delays == _EXPECTED_BACKOFF

    @pytest.mark.asyncio
    async def test_anthropic_credit_costs_exactly_one_provider_call(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """Anthropic's 400 is already unretried; pin it so a status-set edit cannot change that."""
        stub = use_anthropic(monkeypatch, _HTTP_BAD_REQUEST, _ANTHROPIC_CREDIT_BODY)
        await _call_and_capture(botmason.LLMCreditExhaustedError)
        assert stub.request_count == _SINGLE_ATTEMPT
        assert backoff_delays == []

    @pytest.mark.asyncio
    async def test_anthropic_genuine_rate_limit_still_retries(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """The carve-out is keyed on OpenAI's code and must not reach Anthropic's 429."""
        stub = use_anthropic(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _ANTHROPIC_RATE_LIMIT_BODY)
        await _call_and_capture(LLMProviderError)
        assert stub.request_count == _FULL_ATTEMPT_BUDGET
        assert backoff_delays == _EXPECTED_BACKOFF


class TestOperatorKeepsTheRealCause:
    """The user is told something softer; the operator is told the truth."""

    @pytest.mark.asyncio
    async def test_openai_error_carries_the_provider_code(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """The provider's own code survives onto the exception an operator reads."""
        del backoff_delays
        use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_QUOTA_BODY)
        exc = await _call_and_capture(botmason.LLMCreditExhaustedError)
        assert "insufficient_quota" in str(exc)
        assert isinstance(exc.__cause__, openai.RateLimitError)

    @pytest.mark.asyncio
    async def test_anthropic_error_carries_the_provider_prose(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """Anthropic offers no code, so the prose is the operator's only cause."""
        del backoff_delays
        use_anthropic(monkeypatch, _HTTP_BAD_REQUEST, _ANTHROPIC_CREDIT_BODY)
        exc = await _call_and_capture(botmason.LLMCreditExhaustedError)
        assert "credit balance is too low" in str(exc)
        assert isinstance(exc.__cause__, anthropic.BadRequestError)

    @pytest.mark.asyncio
    async def test_error_never_carries_the_api_key(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """Whatever an operator logs from this exception, the key is not in it."""
        del backoff_delays
        use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_QUOTA_BODY)
        exc = await _call_and_capture(botmason.LLMCreditExhaustedError)
        assert OPENAI_KEY not in str(exc)
        assert OPENAI_KEY not in repr(exc)


class TestTransientFailuresKeepTheirRetries:
    """This layer owns the whole retry budget, so it must cover what the SDKs did.

    Setting each SDK's ``max_retries`` to zero stops the nested budgets from
    multiplying, but it also makes this layer the only one retrying anything. A
    transient failure the status set does not name -- a dropped socket, a
    timeout, a 529 -- would then get exactly one attempt where it used to get
    three, and no test that drives only status errors could see it. These count
    at the transport, which is the only place the difference is visible.
    """

    @pytest.mark.asyncio
    async def test_a_dropped_connection_still_gets_the_full_budget(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """A reset socket is the definition of transient, and carries no status.

        ``openai.APIConnectionError`` is an ``APIError``, not an ``OSError``, so
        a network branch testing only ``OSError`` matches nothing a real call
        can raise.
        """
        stub = use_openai(
            monkeypatch,
            _HTTP_TOO_MANY_REQUESTS,
            raises=httpx2.ConnectError("connection reset by peer"),
        )
        exc = await _call_and_capture(LLMProviderError)
        assert isinstance(exc.__cause__, openai.APIConnectionError)
        assert stub.request_count == _FULL_ATTEMPT_BUDGET
        assert backoff_delays == _EXPECTED_BACKOFF

    @pytest.mark.asyncio
    async def test_a_read_timeout_still_gets_the_full_budget(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """A writer on flaky signal gets three shots at a 30s call, not one."""
        stub = use_openai(
            monkeypatch, _HTTP_TOO_MANY_REQUESTS, raises=httpx2.ReadTimeout("timed out")
        )
        await _call_and_capture(LLMProviderError)
        assert stub.request_count == _FULL_ATTEMPT_BUDGET
        assert backoff_delays == _EXPECTED_BACKOFF

    @pytest.mark.asyncio
    async def test_anthropic_dropped_connection_still_gets_the_full_budget(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """The other SDK has its own transport stack, so it needs its own proof."""
        stub = use_anthropic(
            monkeypatch, _HTTP_BAD_REQUEST, raises=httpx.ConnectError("connection reset by peer")
        )
        exc = await _call_and_capture(LLMProviderError)
        assert isinstance(exc.__cause__, anthropic.APIConnectionError)
        assert stub.request_count == _FULL_ATTEMPT_BUDGET
        assert backoff_delays == _EXPECTED_BACKOFF

    @pytest.mark.asyncio
    async def test_anthropic_overloaded_529_still_gets_the_full_budget(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """Anthropic's commonest transient failure is a 5xx no status set named."""
        stub = use_anthropic(monkeypatch, _HTTP_ANTHROPIC_OVERLOADED, _ANTHROPIC_OVERLOADED_BODY)
        await _call_and_capture(LLMProviderError)
        assert stub.request_count == _FULL_ATTEMPT_BUDGET
        assert backoff_delays == _EXPECTED_BACKOFF


class TestTheCarveOutsReachOnlyTheirOwnProvider:
    """Each carve-out is narrowed by SDK and by the shape that SDK actually uses."""

    @pytest.mark.asyncio
    async def test_openai_billing_hard_limit_is_credit_exhausted(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """A configured spend cap is as permanent as a spent quota, and as settleable."""
        stub = use_openai(monkeypatch, _HTTP_BAD_REQUEST, _OPENAI_HARD_LIMIT_BODY)
        exc = await _call_and_capture(botmason.LLMCreditExhaustedError)
        assert exc.provider == "openai"
        assert stub.request_count == _SINGLE_ATTEMPT
        assert backoff_delays == []

    @pytest.mark.asyncio
    async def test_anthropic_rate_limit_mentioning_credit_stays_retryable(
        self, monkeypatch: pytest.MonkeyPatch, backoff_delays: list[float]
    ) -> None:
        """Prose alone must not make a 429 permanent; the status has to agree.

        Without the status narrowing, an Anthropic rate limit whose wording
        happened to mention a credit balance would be reclassified as a
        permanent refusal and lose its retries -- the classifier's own failure
        mode, in the direction that hurts a user who did nothing wrong.
        """
        stub = use_anthropic(
            monkeypatch, _HTTP_TOO_MANY_REQUESTS, _ANTHROPIC_RATE_LIMIT_MENTIONING_CREDIT_BODY
        )
        exc = await _call_and_capture(LLMProviderError)
        assert not isinstance(exc, botmason.LLMCreditExhaustedError)
        assert stub.request_count == _FULL_ATTEMPT_BUDGET
        assert backoff_delays == _EXPECTED_BACKOFF


class TestBothKeyOwnersProduceAnOperatorSignal:
    """Making this condition non-retryable removed the retry loop's own WARNINGs.

    Before the fix an OpenAI exhaustion was retryable, so the retry loop logged
    twice on the way past. It no longer retries, so if ``credit_exhausted_error``
    stays silent on a branch, that branch produces no server-side signal at all.
    """

    @staticmethod
    def _exhausted() -> botmason.LLMCreditExhaustedError:
        """The refusal, as the classifier hands it to a router."""
        return botmason.LLMCreditExhaustedError(
            "Error code: 429 - insufficient_quota", provider="openai"
        )

    def test_a_spent_caller_key_is_logged_at_info(self, caplog: pytest.LogCaptureFixture) -> None:
        """A caller's own bill is ordinary traffic, but it is not invisible."""
        with caplog.at_level(logging.INFO, logger=botmason.logger.name):
            botmason.credit_exhausted_error(self._exhausted(), byok=True)
        records = [r for r in caplog.records if r.message == botmason.CREDIT_EXHAUSTED_DETAIL]
        assert len(records) == 1
        assert records[0].levelno == logging.INFO
        assert _extra(records[0], "provider") == "openai"
        assert _extra(records[0], "byok") is True

    def test_a_spent_server_key_is_logged_at_warning(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A spent server key is an outage, so it gets the level an operator alerts on."""
        with caplog.at_level(logging.INFO, logger=botmason.logger.name):
            botmason.credit_exhausted_error(self._exhausted(), byok=False)
        records = [
            r for r in caplog.records if r.message == botmason.SERVICE_CREDIT_EXHAUSTED_DETAIL
        ]
        assert len(records) == 1
        assert records[0].levelno == logging.WARNING
        assert _extra(records[0], "byok") is False

    def test_neither_log_carries_the_api_key_or_user_text(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Whatever an operator reads, it is ids and the provider's own words only."""
        with caplog.at_level(logging.INFO, logger=botmason.logger.name):
            botmason.credit_exhausted_error(self._exhausted(), byok=True)
            botmason.credit_exhausted_error(self._exhausted(), byok=False)
        blob = "".join(str(record.__dict__) for record in caplog.records)
        assert OPENAI_KEY not in blob
