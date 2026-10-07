"""A provider base-URL override cannot quietly redirect journal content in production (#3065).

Both provider SDKs read their own environment variable -- ``OPENAI_BASE_URL``
and ``ANTHROPIC_BASE_URL`` -- whenever the client is built without an explicit
``base_url``. Nothing else in the app reads those variables, so before this
check a single deployment setting could send every journal body, every prior
letter and every transcription photograph to whichever host it named, with no
code change and nothing in the running system saying so.

Two layers close it, and each is tested here:

* the boot refuses a production deploy whose override names any host other
  than the one the recipient register lists for that provider, and
* in production the dial passes the registered base URL explicitly, so a
  variable set or changed after boot is never read at all.

Outside production both layers stand aside: the end-to-end lane points the
real SDK clients at a loopback fake through exactly these variables
(``frontend/e2e/globalSetup.ts``), and that has to keep working byte for byte.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, Callable, Generator
from contextlib import asynccontextmanager
from typing import Any, cast
from unittest.mock import AsyncMock, patch

import anthropic
import httpx
import httpx2
import openai
import pytest
from cryptography.fernet import Fernet
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from conftest import test_engine
from main import app, lifespan, validate_llm_base_url_config
from privacy.recipients import PROVIDER_BASE_URL_ENV_VARS, REGISTERED_PROVIDER_BASE_URLS
from services import botmason, email, journal_encryption
from tests.helpers.resend_env import RESEND_ENV_VALUES

ENV_VAR = "ENV"

#: Arms one provider over a mock transport and returns the hosts it is asked for.
HostRecorder = Callable[[pytest.MonkeyPatch], list[str]]
OPENAI_VAR = "OPENAI_BASE_URL"
ANTHROPIC_VAR = "ANTHROPIC_BASE_URL"
OPENAI_HOST = "api.openai.com"
ANTHROPIC_HOST = "api.anthropic.com"

# A host nobody registered, and the shape an attacker would hide one in.
COLLECTOR_URL = "https://collector.example/v1"
COLLECTOR_HOST = "collector.example"
USERINFO_SECRET = "s3cret-userinfo-never-echoed"  # pragma: allowlist secret
USERINFO_URL = f"https://user:{USERINFO_SECRET}@collector.example/v1"
USERINFO_HOST_TRICK = "https://api.openai.com@evil.example/v1"
SUFFIX_HOST_TRICK = "https://api.openai.com.evil.example/v1"
USERINFO_ON_REGISTERED = "https://user:pw@api.openai.com/v1"  # pragma: allowlist secret
PLAIN_HTTP_REGISTERED = "http://api.openai.com/v1"
WRONG_PORT_REGISTERED = "https://api.openai.com:8443/v1"
UNPARSEABLE_PORT = "https://api.openai.com:notaport/v1"

# The two values the end-to-end lane sets, verbatim in shape.
LANE_OPENAI = "http://127.0.0.1:43123/v1"
LANE_ANTHROPIC = "http://127.0.0.1:43123"

OPENAI_KEY = "sk-abcdef1234567890abcdef1234567890"  # pragma: allowlist secret
ANTHROPIC_KEY = "sk-ant-abcdef1234567890abcdef1234567890"  # pragma: allowlist secret
OPENAI_OK_BODY: dict[str, object] = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "created": 0,
    "model": "gpt-4o-mini",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "ok"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}
ANTHROPIC_OK_BODY: dict[str, object] = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": "claude-sonnet-5",
    "content": [{"type": "text", "text": "ok"}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 1, "output_tokens": 1},
}


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    """Start every case from no override and no production signal.

    The platform variables are cleared because a developer running the suite
    from a ``railway run`` shell would otherwise turn every non-production case
    into a production one.
    """
    for name in journal_encryption.PRODUCTION_SIGNAL_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    for name in PROVIDER_BASE_URL_ENV_VARS.values():
        monkeypatch.delenv(name, raising=False)
    journal_encryption.reset_cache()
    yield
    journal_encryption.reset_cache()


def _refusal(monkeypatch: pytest.MonkeyPatch, name: str, value: str) -> str:
    """Set ``name`` in a production environment and return the refusal message."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(name, value)
    with pytest.raises(RuntimeError) as excinfo:
        validate_llm_base_url_config()
    return str(excinfo.value)


def test_production_refuses_an_unregistered_openai_base_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The variable and the registered host are named; the collector is not."""
    message = _refusal(monkeypatch, OPENAI_VAR, COLLECTOR_URL)

    assert OPENAI_VAR in message
    assert OPENAI_HOST in message
    assert COLLECTOR_HOST not in message


def test_production_refuses_an_unregistered_anthropic_base_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A loopback override is as much a redirect in production as a remote one."""
    message = _refusal(monkeypatch, ANTHROPIC_VAR, LANE_ANTHROPIC)

    assert ANTHROPIC_VAR in message
    assert ANTHROPIC_HOST in message
    assert "127.0.0.1" not in message


def test_refusal_names_every_offending_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both overrides at once are both reported, so one fix is not a second outage."""
    monkeypatch.setenv(ANTHROPIC_VAR, COLLECTOR_URL)
    message = _refusal(monkeypatch, OPENAI_VAR, COLLECTOR_URL)

    assert OPENAI_VAR in message
    assert ANTHROPIC_VAR in message


def test_refusal_never_echoes_userinfo(monkeypatch: pytest.MonkeyPatch) -> None:
    """A credential embedded in the URL stays out of the boot log."""
    message = _refusal(monkeypatch, OPENAI_VAR, USERINFO_URL)

    assert USERINFO_SECRET not in message
    assert COLLECTOR_HOST not in message


@pytest.mark.parametrize(
    "value",
    [
        USERINFO_HOST_TRICK,
        SUFFIX_HOST_TRICK,
        USERINFO_ON_REGISTERED,
        PLAIN_HTTP_REGISTERED,
        WRONG_PORT_REGISTERED,
        UNPARSEABLE_PORT,
    ],
    ids=[
        "userinfo-host-trick",
        "suffix-host",
        "userinfo-on-registered-host",
        "plain-http",
        "wrong-port",
        "unparseable-port",
    ],
)
def test_lookalikes_of_the_registered_host_are_refused(
    value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The host is parsed, not substring-matched, and the scheme and port count too.

    ``https://api.openai.com@evil.example`` connects to ``evil.example``; a
    plain-``http`` URL to the right host puts the journal on the wire in clear.
    """
    message = _refusal(monkeypatch, OPENAI_VAR, value)

    assert OPENAI_VAR in message
    assert "evil.example" not in message


@pytest.mark.parametrize(
    ("name", "value"),
    [
        (OPENAI_VAR, None),
        (OPENAI_VAR, ""),
        (OPENAI_VAR, "   "),
        (OPENAI_VAR, REGISTERED_PROVIDER_BASE_URLS["openai"]),
        (ANTHROPIC_VAR, REGISTERED_PROVIDER_BASE_URLS["anthropic"]),
        (ANTHROPIC_VAR, "https://api.anthropic.com/"),
    ],
    ids=["unset", "empty", "blank", "openai-registered", "anthropic-registered", "slash"],
)
def test_registered_unset_and_blank_values_boot(
    name: str, value: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only a redirect is refused: no override, or the registered host itself, boots."""
    monkeypatch.setenv(ENV_VAR, "production")
    if value is not None:
        monkeypatch.setenv(name, value)

    validate_llm_base_url_config()


@pytest.mark.parametrize("environment", ["development", "e2e", None])
def test_non_production_keeps_the_lane_loopback_override(
    environment: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The end-to-end lane's own settings boot, and the dial still defers to them."""
    if environment is None:
        monkeypatch.delenv(ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(ENV_VAR, environment)
    monkeypatch.setenv(OPENAI_VAR, LANE_OPENAI)
    monkeypatch.setenv(ANTHROPIC_VAR, LANE_ANTHROPIC)

    validate_llm_base_url_config()

    assert botmason.sdk_base_url("openai") is None
    assert botmason.sdk_base_url("anthropic") is None


def test_platform_production_refuses_whatever_env_says(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Railway production deploy with ``ENV`` unset is still production (B02's predicate)."""
    monkeypatch.delenv(ENV_VAR, raising=False)
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "production")
    monkeypatch.setenv(OPENAI_VAR, COLLECTOR_URL)

    with pytest.raises(RuntimeError, match=OPENAI_VAR):
        validate_llm_base_url_config()


@asynccontextmanager
async def _isolated_factory_patch() -> AsyncGenerator[None, None]:
    """Point main's session factory at the conftest SQLite engine for lifespan runs."""
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    with (
        patch("main.async_session_factory", new=factory),
        patch("main.require_database_schema_current", new=AsyncMock()),
    ):
        yield


def _production_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    """Satisfy every earlier production refusal, so the one observed is this one."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv("SKIP_STARTUP_SEED", "1")
    monkeypatch.setenv(journal_encryption.KEYS_ENV_VAR, Fernet.generate_key().decode())
    journal_encryption.reset_cache()
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, email.BACKEND_RESEND)
    for name, value in RESEND_ENV_VALUES.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("APP_BASE_URL", "https://app.adepthood.invalid")
    monkeypatch.delenv("GUMROAD_API_TOKEN", raising=False)
    monkeypatch.delenv("GUMROAD_WEBHOOK_SECRET", raising=False)


@pytest.mark.asyncio
async def test_production_lifespan_refuses_boot(monkeypatch: pytest.MonkeyPatch) -> None:
    """Driven through the real ``lifespan``: a validator nobody wired in guards nothing."""
    _production_ready(monkeypatch)
    monkeypatch.setenv(OPENAI_VAR, COLLECTOR_URL)

    with pytest.raises(RuntimeError, match=OPENAI_VAR):
        async with _isolated_factory_patch(), lifespan(app):
            pytest.fail("startup completed with journal content redirected off-register")


@pytest.mark.asyncio
async def test_production_lifespan_boots_without_an_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same production configuration minus the override goes live -- the quiet side."""
    _production_ready(monkeypatch)

    async with _isolated_factory_patch(), lifespan(app):
        pass


def _record_openai_hosts(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Build real OpenAI clients over a mock transport; record each request's host."""
    hosts: list[str] = []
    real_client = openai.AsyncOpenAI

    def _handle(request: httpx2.Request) -> httpx2.Response:
        hosts.append(str(request.url.host))
        return httpx2.Response(200, json=OPENAI_OK_BODY, request=request)

    def _factory(**kwargs: object) -> openai.AsyncOpenAI:
        kwargs["http_client"] = httpx2.AsyncClient(transport=httpx2.MockTransport(_handle))
        return real_client(**cast("dict[str, Any]", kwargs))

    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", OPENAI_KEY)
    monkeypatch.setenv("LLM_MODEL", "gpt-4o-mini")
    monkeypatch.setattr(botmason.openai, "AsyncOpenAI", _factory)
    return hosts


def _record_anthropic_hosts(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Build real Anthropic clients over a mock transport; record each request's host."""
    hosts: list[str] = []
    real_client = anthropic.AsyncAnthropic

    def _handle(request: httpx.Request) -> httpx.Response:
        hosts.append(str(request.url.host))
        return httpx.Response(200, json=ANTHROPIC_OK_BODY, request=request)

    def _factory(**kwargs: object) -> anthropic.AsyncAnthropic:
        kwargs["http_client"] = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        return real_client(**cast("dict[str, Any]", kwargs))

    monkeypatch.setenv("BOTMASON_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_API_KEY", ANTHROPIC_KEY)
    monkeypatch.setenv("LLM_MODEL", "claude-sonnet-5")
    monkeypatch.setattr(botmason.anthropic, "AsyncAnthropic", _factory)
    return hosts


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("record", "name", "registered_host"),
    [
        (_record_openai_hosts, OPENAI_VAR, OPENAI_HOST),
        (_record_anthropic_hosts, ANTHROPIC_VAR, ANTHROPIC_HOST),
    ],
    ids=["openai", "anthropic"],
)
async def test_production_dial_pins_the_registered_base_url(
    record: HostRecorder,
    name: str,
    registered_host: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An override set after boot is never read: the request goes to the registered host.

    The boot check reads the environment once. The SDK would read it again on
    every client it builds, so the dial passes the registered base URL itself.
    """
    hosts = record(monkeypatch)
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(name, COLLECTOR_URL)

    await botmason.generate_response("hello", [])

    assert hosts == [registered_host]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("record", "name"),
    [(_record_openai_hosts, OPENAI_VAR), (_record_anthropic_hosts, ANTHROPIC_VAR)],
    ids=["openai", "anthropic"],
)
async def test_development_dial_still_follows_the_sdk_variable(
    record: HostRecorder, name: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Outside production the SDK's own variable is honoured -- the lane depends on it."""
    hosts = record(monkeypatch)
    monkeypatch.setenv(ENV_VAR, "development")
    monkeypatch.setenv(name, COLLECTOR_URL)

    await botmason.generate_response("hello", [])

    assert hosts == [COLLECTOR_HOST]
