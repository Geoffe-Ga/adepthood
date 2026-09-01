"""The Host header must not author the authority of any URL this app mints.

Starlette builds the trailing-slash 307's ``Location`` from ``scope["scheme"]``
and the ``Host`` header, at routing time, before any dependency or auth check
runs -- so a caller sending ``Host: evil.example`` gets an unauthenticated
``Location`` pointing wherever it likes.  The scheme half of that URL is already
settled from operator config by ``ForwardedProtoMiddleware``; these tests pin the
authority half to the same rule.

The control settles rather than rejects, and most of these cases exist to pin
what that buys.  Nothing is ever refused, so the health probes stay reachable
from a prober whose ``Host`` this repository cannot know, no response is minted
above the CORS layer for a browser to fail to read, and the loopback DAST
harness -- which configures no allowlist -- keeps seeing exactly today's
behaviour.

Cases that need a configured allowlist drive the real ``main.app`` and the real
router, which is possible only because the allowlist is read from the
environment per request: the middleware stack itself is built once at import,
long before any test runs, so nothing a test does could reconfigure it.
"""

from __future__ import annotations

import logging
from http import HTTPStatus
from typing import TYPE_CHECKING

import pytest
from httpx import ASGITransport, AsyncClient

from main import app
from middleware import CanonicalHostMiddleware
from observability import TRACE_ID_HEADER

if TYPE_CHECKING:
    from starlette.types import Message, Scope

# The variable is named by its bare literal on purpose: importing the constant
# would make a missing implementation an ImportError, and an ImportError is not
# a behavioural red.
_ALLOWED_HOSTS_ENV_VAR = "ALLOWED_HOSTS"
_ENV_VAR = "ENV"

# A collection path whose canonical form carries a trailing slash, so the
# router answers 307 at routing time -- before any auth dependency runs,
# which is what makes the primitive unauthenticated.  Same path
# tests/middleware/test_forwarded_proto.py reads a Location from.
_COLLECTION_PATH = "/practices"
_REDIRECT_TARGET = "/practices/"
_LOCATION_HEADER = "location"
_HOST_HEADER = "Host"

# A liveness probe that touches no database, so it answers on its own merits
# rather than on the test environment's.  ``backend/railway.toml`` checks this
# service with ``restartPolicyMaxRetries = 3``, which is why a control that
# could refuse a probe would fail the deploy rather than merely annoy it.
_LIVENESS_PATH = "/health/live"

_POISONED_HOST = "evil.example"
_CANONICAL_HOST = "api.aptitude.guru"
_SECOND_HOST = "aptitude.guru"
_ACCESS_LOGGER = "adepthood.access"
_COMPLETED_RECORD = "request_completed"
_ORIGINAL_HOST_FIELD = "original_host"

# ``base_url`` decides the socket scheme the transport writes into the scope, so
# every case starts from plaintext and reads an ``http://`` Location.
_BASE_URL = "http://test"

_HTTP_SCOPE_TYPE = "http"
_HEADERS_SCOPE_KEY = "headers"
_ORIGINAL_HOST_SCOPE_KEY = "adepthood.original_host"

# A scope type no arm of this middleware may examine, carrying a spoofed Host so
# an assertion on it can only pass if the mapping was left alone.
_LIFESPAN_SCOPE_TYPE = "lifespan"
_SCOPE_TYPE_KEY = "type"
_SPOOFED_HOST_HEADERS = [(b"host", _POISONED_HOST.encode())]


async def _get(
    path: str,
    host: str | None,
    *,
    trace_id: str | None = None,
) -> tuple[int, dict[str, str]]:
    """Drive the real app once and return the response status and headers."""
    headers = {}
    if host is not None:
        headers[_HOST_HEADER] = host
    if trace_id is not None:
        headers[TRACE_ID_HEADER] = trace_id
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=_BASE_URL) as client:
        response = await client.get(path, headers=headers, follow_redirects=False)
    return response.status_code, dict(response.headers)


class _ScopeRecorder:
    """An inner app that records the scope the middleware handed it."""

    def __init__(self) -> None:
        """Start with no observation, so a scope that never arrived is visible."""
        self.scope: Scope | None = None

    async def __call__(self, scope: Scope, receive: object, send: object) -> None:
        """Record the scope and return without producing any response."""
        del receive, send
        self.scope = scope


async def _receive() -> Message:
    """Stand in for an ASGI receive channel the recorder never reads."""
    return {"type": "http.request"}


async def _send(message: Message) -> None:
    """Stand in for an ASGI send channel the recorder never writes."""
    del message


async def _observed_scope(scope: Scope) -> Scope:
    """Run one scope through the middleware and return what the inner app saw."""
    recorder = _ScopeRecorder()
    await CanonicalHostMiddleware(recorder)(scope, _receive, _send)
    assert recorder.scope is not None
    return recorder.scope


def _host_lines(scope: Scope) -> list[str]:
    """Return every Host field line the scope carries, decoded."""
    return [value.decode("latin-1") for name, value in scope[_HEADERS_SCOPE_KEY] if name == b"host"]


@pytest.mark.asyncio
async def test_poisoned_host_cannot_author_the_trailing_slash_redirect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A Host outside the declared allowlist is replaced by the canonical one.

    The reported vulnerability, and the reason this layer exists: before it,
    this request answered ``307 Location: http://evil.example/practices/`` to an
    unauthenticated caller.
    """
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, _CANONICAL_HOST)

    status, headers = await _get(_COLLECTION_PATH, _POISONED_HOST)

    assert status == HTTPStatus.TEMPORARY_REDIRECT
    assert headers[_LOCATION_HEADER] == f"http://{_CANONICAL_HOST}{_REDIRECT_TARGET}"
    assert _POISONED_HOST not in headers[_LOCATION_HEADER]


@pytest.mark.asyncio
async def test_an_allowlisted_host_keeps_its_own_authority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A host the operator declared is answered as itself, not folded onto entry one.

    Two entries, requesting the second, because a one-entry allowlist cannot
    tell a selective control from one that rewrites every request to a single
    canonical value.
    """
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, f"{_CANONICAL_HOST},{_SECOND_HOST}")

    status, headers = await _get(_COLLECTION_PATH, _SECOND_HOST)

    assert status == HTTPStatus.TEMPORARY_REDIRECT
    assert headers[_LOCATION_HEADER] == f"http://{_SECOND_HOST}{_REDIRECT_TARGET}"


@pytest.mark.asyncio
async def test_an_unconfigured_development_boot_keeps_todays_behaviour(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no allowlist the Host is untouched -- fail-open, pinned rather than incidental.

    This is what lets local development, Expo, LAN addresses and the loopback
    DAST harness keep working with no configuration, and it is why every
    existing test that reaches the app over ``http://test`` stays green.
    """
    monkeypatch.delenv(_ALLOWED_HOSTS_ENV_VAR, raising=False)
    monkeypatch.setenv(_ENV_VAR, "development")

    status, headers = await _get(_COLLECTION_PATH, _POISONED_HOST)

    assert status == HTTPStatus.TEMPORARY_REDIRECT
    assert headers[_LOCATION_HEADER] == f"http://{_POISONED_HOST}{_REDIRECT_TARGET}"


@pytest.mark.parametrize("blank", ["", "   ", ",", " , "])
@pytest.mark.asyncio
async def test_a_blank_allowlist_names_nobody_and_settles_nothing(
    monkeypatch: pytest.MonkeyPatch,
    blank: str,
) -> None:
    """Padding and separators name no host, so a blank value fails open like an unset one."""
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, blank)

    _, headers = await _get(_COLLECTION_PATH, _POISONED_HOST)

    assert headers[_LOCATION_HEADER] == f"http://{_POISONED_HOST}{_REDIRECT_TARGET}"


@pytest.mark.asyncio
async def test_blank_entries_between_real_ones_are_padding_not_hosts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A doubled separator is list padding: the real entries either side still count."""
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, f" {_CANONICAL_HOST} ,, {_SECOND_HOST} ")

    _, headers = await _get(_COLLECTION_PATH, _SECOND_HOST)

    assert headers[_LOCATION_HEADER] == f"http://{_SECOND_HOST}{_REDIRECT_TARGET}"


@pytest.mark.asyncio
async def test_a_shouting_host_is_the_same_host(monkeypatch: pytest.MonkeyPatch) -> None:
    """Case is not part of a hostname's identity, so an allowlisted host in caps matches.

    Starlette's own ``TrustedHostMiddleware`` compares the raw header against
    the raw entry and would treat this as hostile, which is one of the reasons
    the matcher here is ours rather than its.
    """
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, _CANONICAL_HOST)

    _, headers = await _get(_COLLECTION_PATH, "API.Aptitude.Guru")

    assert headers[_LOCATION_HEADER] == f"http://API.Aptitude.Guru{_REDIRECT_TARGET}"


@pytest.mark.asyncio
async def test_an_entry_without_a_port_covers_that_host_on_any_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Matching ignores the port, so an operator need not enumerate them."""
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, _CANONICAL_HOST)

    _, headers = await _get(_COLLECTION_PATH, f"{_CANONICAL_HOST}:8443")

    assert headers[_LOCATION_HEADER] == f"http://{_CANONICAL_HOST}:8443{_REDIRECT_TARGET}"


@pytest.mark.asyncio
async def test_an_entry_with_a_port_is_substituted_verbatim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An operator who wrote a port meant it to appear in the URLs the app mints.

    Dropping it -- which is what Starlette's ``split(":")[0]`` would do -- would
    mint a ``Location`` naming a port nothing is listening on.
    """
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, "localhost:8000")

    _, headers = await _get(_COLLECTION_PATH, _POISONED_HOST)

    assert headers[_LOCATION_HEADER] == f"http://localhost:8000{_REDIRECT_TARGET}"


@pytest.mark.asyncio
async def test_the_liveness_probe_answers_whatever_host_it_is_asked_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A configured allowlist never makes a health probe unreachable.

    Resolved by construction rather than by a path exemption: nothing is ever
    rejected, so there is no exemption list to get wrong.  ``backend/railway.toml``
    health-checks this service with ``restartPolicyMaxRetries = 3`` and the
    prober's Host cannot be known from this repository, so a control that could
    answer 400 here would loop a deploy through three restarts and fail it.
    """
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, _CANONICAL_HOST)

    status, _ = await _get(_LIVENESS_PATH, _POISONED_HOST)

    assert status == HTTPStatus.OK


@pytest.mark.asyncio
async def test_a_settled_request_keeps_every_guarantee_the_stack_makes(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Settling is not rejecting: the response is an ordinary one in every other way.

    The positive form of "nothing is ever refused".  A minted rejection would
    have been produced above the CORS layer and would have skipped the trace-id
    echo, the security-header set and the access record; this asserts all three
    survive a settled request.
    """
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, _CANONICAL_HOST)

    with caplog.at_level(logging.INFO, logger=_ACCESS_LOGGER):
        status, headers = await _get(
            _COLLECTION_PATH,
            _POISONED_HOST,
            trace_id="canonical-host-probe-1",
        )

    assert status == HTTPStatus.TEMPORARY_REDIRECT
    assert headers[TRACE_ID_HEADER.lower()] == "canonical-host-probe-1"
    assert headers["x-content-type-options"] == "nosniff"
    assert "content-security-policy" in headers
    completed = [r for r in caplog.records if r.message == _COMPLETED_RECORD]
    assert len(completed) == 1


@pytest.mark.asyncio
async def test_the_access_record_preserves_the_authority_that_was_replaced(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Rewriting the Host must not destroy the evidence that somebody probed.

    The field rides the ``request_completed`` record the access log already
    emits, so it costs no extra line, and it appears only on the anomalous
    requests -- an ordinary one carries no such field at all.
    """
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, _CANONICAL_HOST)

    with caplog.at_level(logging.INFO, logger=_ACCESS_LOGGER):
        await _get(_COLLECTION_PATH, _POISONED_HOST)
        settled = [r for r in caplog.records if r.message == _COMPLETED_RECORD]
        caplog.clear()
        await _get(_COLLECTION_PATH, _CANONICAL_HOST)
        ordinary = [r for r in caplog.records if r.message == _COMPLETED_RECORD]

    assert getattr(settled[-1], _ORIGINAL_HOST_FIELD, None) == _POISONED_HOST
    assert getattr(ordinary[-1], _ORIGINAL_HOST_FIELD, None) is None


@pytest.mark.asyncio
async def test_a_request_naming_no_authority_is_given_the_canonical_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No Host header must not fall through to the container's own socket address.

    Starlette answers ``URL(scope=scope)`` from ``scope["server"]`` when the
    header is missing, which would leak the internal listen address into the
    Location.  Driven through the middleware directly because no HTTP client
    will omit the header.
    """
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, _CANONICAL_HOST)

    observed = await _observed_scope({_SCOPE_TYPE_KEY: _HTTP_SCOPE_TYPE, _HEADERS_SCOPE_KEY: []})

    assert _host_lines(observed) == [_CANONICAL_HOST]
    assert observed[_ORIGINAL_HOST_SCOPE_KEY] == ""


@pytest.mark.asyncio
async def test_two_host_lines_name_no_single_authority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A request carrying two Host lines leaves carrying one nobody chose.

    Whichever line a downstream reader picked would be a coin flip an attacker
    tossed, so a pair is read as naming no authority at all -- even when one of
    the two is allowlisted.
    """
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, _CANONICAL_HOST)
    headers = [(b"host", _CANONICAL_HOST.encode()), (b"host", _POISONED_HOST.encode())]

    observed = await _observed_scope(
        {_SCOPE_TYPE_KEY: _HTTP_SCOPE_TYPE, _HEADERS_SCOPE_KEY: headers}
    )

    assert _host_lines(observed) == [_CANONICAL_HOST]


@pytest.mark.asyncio
async def test_an_allowlisted_request_leaves_no_trace_of_a_decision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An untouched request keeps the server's own header list object, unrebound."""
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, _CANONICAL_HOST)
    headers = [(b"host", _CANONICAL_HOST.encode())]

    observed = await _observed_scope(
        {_SCOPE_TYPE_KEY: _HTTP_SCOPE_TYPE, _HEADERS_SCOPE_KEY: headers}
    )

    assert observed[_HEADERS_SCOPE_KEY] is headers
    assert _ORIGINAL_HOST_SCOPE_KEY not in observed


@pytest.mark.asyncio
async def test_a_non_http_scope_is_handed_on_unexamined(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Lifespan and websocket scopes are passed on as the exact object received."""
    monkeypatch.setenv(_ALLOWED_HOSTS_ENV_VAR, _CANONICAL_HOST)
    scope = {_SCOPE_TYPE_KEY: _LIFESPAN_SCOPE_TYPE, _HEADERS_SCOPE_KEY: _SPOOFED_HOST_HEADERS}

    observed = await _observed_scope(scope)

    assert observed[_HEADERS_SCOPE_KEY] is _SPOOFED_HOST_HEADERS
    assert _ORIGINAL_HOST_SCOPE_KEY not in observed
