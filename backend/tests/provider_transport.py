"""Point a provider SDK at a canned HTTP transport, and count what reaches it.

Stubbing at the transport rather than at ``generate_response`` is the whole
point: URL building, header assembly, status handling and -- decisively -- the
SDK's own construction of a typed error from a real response body all still run.
A suite that hands the code a hand-built exception cannot observe how a provider
actually expresses a condition, which is how the billing-refusal bug shipped.

Counting requests here rather than at the client factory matters too: this
module's retry loop is nested inside each SDK's own ``max_retries``, so an
assertion made one level up cannot see the multiplication.

``openai`` 3.x is typed against ``httpx2`` -- a separate distribution from the
``httpx`` that Starlette and ``anthropic`` still use, sharing no base classes --
so the two providers need their own transports and their own request types.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

import anthropic
import httpx
import httpx2
import openai

from services import botmason

if TYPE_CHECKING:
    import pytest

OPENAI_KEY = "sk-abcdef1234567890abcdef1234567890"  # pragma: allowlist secret
ANTHROPIC_KEY = "sk-ant-abcdef1234567890abcdef1234567890"  # pragma: allowlist secret
OPENAI_MODEL = "gpt-4o-mini"
ANTHROPIC_MODEL = "claude-sonnet-5"


class TransportStub:
    """A canned provider outcome, plus a count of the requests that reached it.

    Either serves ``body`` at ``status_code``, or -- when ``raises`` is set --
    raises that transport exception instead, which is how a dropped socket or a
    timed-out request arrives in real life.
    """

    def __init__(
        self,
        status_code: int,
        body: dict[str, Any] | None = None,
        *,
        raises: Exception | None = None,
    ) -> None:
        """Arm the stub with the outcome every request to it will produce."""
        self.status_code = status_code
        self.body = body if body is not None else {}
        self.raises = raises
        self.request_count = 0

    def record(self) -> None:
        """Count one request, and raise the canned transport failure if there is one."""
        self.request_count += 1
        if self.raises is not None:
            raise self.raises


def use_openai(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    body: dict[str, Any] | None = None,
    *,
    raises: Exception | None = None,
) -> TransportStub:
    """Point the OpenAI client at a mock transport serving ``body`` (or raising)."""
    stub = TransportStub(status_code, body, raises=raises)
    real_client = openai.AsyncOpenAI

    def _handle(request: httpx2.Request) -> httpx2.Response:
        stub.record()
        return httpx2.Response(stub.status_code, json=stub.body, request=request)

    def _factory(**kwargs: object) -> openai.AsyncOpenAI:
        kwargs["http_client"] = httpx2.AsyncClient(transport=httpx2.MockTransport(_handle))
        return real_client(**cast("dict[str, Any]", kwargs))

    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", OPENAI_KEY)
    monkeypatch.setenv("LLM_MODEL", OPENAI_MODEL)
    monkeypatch.setattr(botmason.openai, "AsyncOpenAI", _factory)
    return stub


def use_anthropic(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    body: dict[str, Any] | None = None,
    *,
    raises: Exception | None = None,
) -> TransportStub:
    """Point the Anthropic client at a mock transport serving ``body`` (or raising)."""
    stub = TransportStub(status_code, body, raises=raises)
    real_client = anthropic.AsyncAnthropic

    def _handle(request: httpx.Request) -> httpx.Response:
        stub.record()
        return httpx.Response(stub.status_code, json=stub.body, request=request)

    def _factory(**kwargs: object) -> anthropic.AsyncAnthropic:
        kwargs["http_client"] = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        return real_client(**cast("dict[str, Any]", kwargs))

    monkeypatch.setenv("BOTMASON_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_API_KEY", ANTHROPIC_KEY)
    monkeypatch.setenv("LLM_MODEL", ANTHROPIC_MODEL)
    monkeypatch.setattr(botmason.anthropic, "AsyncAnthropic", _factory)
    return stub
