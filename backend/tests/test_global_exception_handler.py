"""Tests for the catch-all exception handler installed in :func:`install_exception_handlers`.

Closes BUG-OBS-002 / BUG-OBS-003: every unhandled exception must

* return a stable ``{"error": "internal_error", "request_id": "..."}`` body,
* echo the trace ID in the ``X-Request-ID`` response header,
* never leak the raw exception message to the client,
* be reported to Sentry (via the local stub until a DSN ships), and
* be logged with the request id, path, and method for support lookup.
"""

from __future__ import annotations

import logging
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from errors import ERROR_KEY, INTERNAL_ERROR, REQUEST_ID_KEY, install_exception_handlers
from middleware import CorrelationIdMiddleware
from observability import TRACE_ID_HEADER


@pytest.fixture
def app_with_failing_route() -> FastAPI:
    """Build a tiny FastAPI app with the global handler + one always-failing route.

    Done in a fixture (not at module level) so we can install the handler
    on a fresh app instance without side-effecting the production
    ``main.app`` test client used elsewhere in the suite.
    """
    app = FastAPI()
    app.add_middleware(CorrelationIdMiddleware)
    install_exception_handlers(app)

    @app.get("/__boom__")
    async def boom() -> None:
        # The exception message intentionally contains a "secret" so the
        # response-body assertion below can prove we don't leak it.
        msg = "DATABASE_PASSWORD=hunter2"  # pragma: allowlist secret
        raise RuntimeError(msg)

    return app


def test_unhandled_exception_returns_envelope(app_with_failing_route: FastAPI) -> None:
    """Body is ``{"error": "internal_error", "request_id": "..."}``."""
    client = TestClient(app_with_failing_route, raise_server_exceptions=False)
    response = client.get("/__boom__")
    assert response.status_code == 500
    body = response.json()
    assert body[ERROR_KEY] == INTERNAL_ERROR
    assert body[REQUEST_ID_KEY]
    # Only the two stable keys are present on the success branch — no
    # ``detail`` / ``traceback`` / ``message`` slipping in.
    assert set(body.keys()) == {ERROR_KEY, REQUEST_ID_KEY}


def test_unhandled_exception_echoes_request_id_header(app_with_failing_route: FastAPI) -> None:
    """The trace ID echoed in the body must match ``X-Request-ID``."""
    client = TestClient(app_with_failing_route, raise_server_exceptions=False)
    inbound = "boom-trace-1234567890ab"
    response = client.get("/__boom__", headers={TRACE_ID_HEADER: inbound})
    assert response.status_code == 500
    assert response.headers[TRACE_ID_HEADER] == inbound
    assert response.json()[REQUEST_ID_KEY] == inbound


def test_unhandled_exception_does_not_leak_message(app_with_failing_route: FastAPI) -> None:
    """The raw exception message (including secrets) must never appear in the body."""
    client = TestClient(app_with_failing_route, raise_server_exceptions=False)
    response = client.get("/__boom__")
    assert "DATABASE_PASSWORD" not in response.text
    assert "hunter2" not in response.text
    assert "RuntimeError" not in response.text


def test_unhandled_exception_logs_with_request_id(
    app_with_failing_route: FastAPI,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The server-side log carries the request id, path, and method."""
    client = TestClient(app_with_failing_route, raise_server_exceptions=False)
    inbound = "log-trace-abc"
    with caplog.at_level(logging.ERROR, logger="errors"):
        client.get("/__boom__", headers={TRACE_ID_HEADER: inbound})
    matching = [r for r in caplog.records if r.message == "unhandled_exception"]
    assert matching, "expected one unhandled_exception log record"
    record = matching[-1]
    # ``LogRecord`` does not statically know about ``extra`` keys, so we
    # read them through ``getattr`` rather than suppressing mypy with
    # a ``# type: ignore`` (CLAUDE.md forbids the suppression).
    assert getattr(record, "request_id", None) == inbound
    assert getattr(record, "request_path", None) == "/__boom__"
    assert getattr(record, "request_method", None) == "GET"


def test_unhandled_exception_calls_sentry_capture(app_with_failing_route: FastAPI) -> None:
    """The handler forwards to ``sentry.capture_exception`` (today a stub)."""
    captured: list[tuple[BaseException, dict[str, object]]] = []

    def fake_capture(exc: BaseException, **ctx: object) -> None:
        captured.append((exc, ctx))

    with patch("errors.capture_exception", side_effect=fake_capture):
        client = TestClient(app_with_failing_route, raise_server_exceptions=False)
        client.get("/__boom__", headers={TRACE_ID_HEADER: "sentry-trace-1"})
    assert len(captured) == 1
    exc, ctx = captured[0]
    assert isinstance(exc, RuntimeError)
    assert ctx["request_id"] == "sentry-trace-1"
    assert ctx["request_path"] == "/__boom__"
    assert ctx["request_method"] == "GET"


def test_existing_http_exception_keeps_detail_shape() -> None:
    """Per-route ``HTTPException`` responses still emit ``{"detail": ...}``.

    Sanity check: the global handler only catches genuine unhandled
    exceptions, leaving the legacy 4xx envelope shape untouched so
    existing clients (and the ~50 tests that assert on ``detail``)
    continue to work.
    """
    from main import app  # noqa: PLC0415 — import inside the test so the fixture above runs first

    client = TestClient(app, raise_server_exceptions=False)
    response = client.post("/auth/login", json={"email": "no@one.test", "password": "wrong-pw"})
    body = response.json()
    assert "detail" in body
    assert ERROR_KEY not in body
