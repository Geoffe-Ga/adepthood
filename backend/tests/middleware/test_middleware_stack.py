"""Middleware-stack ordering and trace-id-at-import regression tests.

Closes:

- BUG-APP-001 — middleware add order LIFO: the last ``add_middleware`` is
  the outermost layer, so the registration order had to be reversed.
- BUG-APP-002 — preflight bypassed security headers when CORS sat
  outside SecurityHeaders; CORS short-circuited with a 200 before the
  headers were applied.
- BUG-APP-007 — trace-id log configuration ran in the lifespan startup
  hook, after router-registration log records had already been emitted
  without a trace-id field.
"""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

import main as main_module
from main import app
from observability import TRACE_ID_HEADER

client = TestClient(app)


def test_every_middleware_side_effect_fires_on_one_request(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """BUG-APP-001 behaviour pin: every layer's observable effect on one request.

    Replaces the old ``app.user_middleware`` introspection (issue #272),
    which coupled the test to a Starlette-internal attribute.  A single
    ordinary request must simultaneously show each layer did its job —
    access log (logging, outermost), trace-id echo (correlation),
    security headers (security), and the CORS expose header (CORS) —
    which is only possible when every layer wrapped the response.  The
    preflight tests below pin the relative ordering edge cases.
    """
    with caplog.at_level(logging.INFO, logger="adepthood.access"):
        response = client.get(
            "/auth/login",
            headers={TRACE_ID_HEADER: "stack-probe-1", "Origin": "http://localhost:3000"},
        )
    # SecurityHeadersMiddleware wrapped the response.
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert "Content-Security-Policy" in response.headers
    # CorrelationIdMiddleware echoed the inbound trace id.
    assert response.headers[TRACE_ID_HEADER] == "stack-probe-1"
    # CORSMiddleware exposed the trace id to cross-origin readers.
    exposed = response.headers.get("access-control-expose-headers", "")
    assert TRACE_ID_HEADER.lower() in exposed.lower()
    # RequestLoggingMiddleware (outermost) emitted the access record.
    assert any(r.message == "request_completed" for r in caplog.records)


def test_preflight_response_carries_security_headers() -> None:
    """BUG-APP-002: OPTIONS preflight inherits CSP / Referrer-Policy / etc.

    Before the reorder, CORSMiddleware sat outside SecurityHeadersMiddleware
    and short-circuited on preflight without ever calling the inner stack —
    so OPTIONS responses lacked the security-header set.  With CORS now
    inside SecurityHeaders, every preflight must carry the same headers
    a regular response would.
    """
    response = client.options(
        "/auth/login",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert response.status_code == 200
    assert "X-Content-Type-Options" in response.headers
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert "Content-Security-Policy" in response.headers
    assert "Referrer-Policy" in response.headers
    assert "Permissions-Policy" in response.headers


def test_preflight_response_carries_trace_id() -> None:
    """Trace-ID middleware now wraps CORS, so even preflight responses echo it."""
    response = client.options(
        "/auth/login",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            TRACE_ID_HEADER: "preflight-trace-1234",
        },
    )
    assert response.headers[TRACE_ID_HEADER] == "preflight-trace-1234"


def test_cors_allows_x_request_id_header() -> None:
    """Browsers must be allowed to *send* ``X-Request-ID`` on cross-origin requests.

    Without ``X-Request-ID`` in ``ALLOWED_HEADERS``, a preflight that
    advertises the header in ``Access-Control-Request-Headers`` is
    rejected by the CORSMiddleware and the browser strips the header
    from the actual request.  The end-to-end correlation contract
    needs both the inbound allow and the outbound expose.
    """
    response = client.options(
        "/auth/login",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": TRACE_ID_HEADER,
        },
    )
    assert response.status_code == 200
    allowed = response.headers.get("access-control-allow-headers", "")
    assert TRACE_ID_HEADER.lower() in allowed.lower()


def test_cors_exposes_x_request_id_header() -> None:
    """Browsers must be allowed to *read* ``X-Request-ID`` from the response.

    Without ``expose_headers=["X-Request-ID"]`` on the CORSMiddleware,
    the trace-id echoed by ``CorrelationIdMiddleware`` is silently
    dropped by every cross-origin browser client and the AuthContext /
    logging adapter cannot correlate client telemetry with server logs.
    """
    response = client.get(
        "/auth/login",
        headers={"Origin": "http://localhost:3000"},
    )
    exposed = response.headers.get("access-control-expose-headers", "")
    assert TRACE_ID_HEADER.lower() in exposed.lower()


def test_stdout_logging_configured_at_import() -> None:
    """BUG-APP-007: importing ``main`` must already have configured logging.

    A lifespan-only setup left records emitted during module import
    (router mounts, seed data) without a trace-id-aware handler.  ``main``
    exposes the import-time call's outcome as ``STDOUT_LOGGING_CONFIGURED``;
    reading it here pins that :func:`observability.configure_stdout_logging`
    ran at import (merely importing ``main``, which this module already
    did, produced the attribute).  Its value is environment-dependent —
    ``False`` under pytest, whose capture plugin pre-configures the root
    logger and must be respected — so only the type is asserted; the
    behavioural pipeline is pinned in ``test_observability.py``.
    """
    assert isinstance(main_module.STDOUT_LOGGING_CONFIGURED, bool)


def test_request_logging_middleware_emits_one_record_per_request(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The outermost RequestLoggingMiddleware logs an access record on every call."""
    with caplog.at_level(logging.INFO, logger="adepthood.access"):
        client.get("/auth/login")
    completed = [r for r in caplog.records if r.message == "request_completed"]
    assert completed, "expected at least one request_completed record"
    record = completed[-1]
    # ``LogRecord`` does not statically know about ``extra`` keys, so we
    # read them through ``getattr`` rather than suppressing mypy with
    # a ``# type: ignore`` (CLAUDE.md forbids the suppression).
    assert getattr(record, "http_method", None) == "GET"
    assert getattr(record, "http_path", None) == "/auth/login"
    assert isinstance(getattr(record, "elapsed_ms", None), float)


def test_request_logging_middleware_logs_inner_middleware_panic(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Cover the ``except Exception`` branch where an inner middleware raises.

    Route-handler exceptions are normally caught by Starlette's
    ``ExceptionMiddleware`` and converted to a 500 envelope before
    bubbling out — so the success path logs them.  The defensive
    branch only fires when a *middleware layer below us* itself raises
    (e.g., ``SecurityHeadersMiddleware`` blowing up before
    ``ExceptionMiddleware`` can wrap it).  This test simulates that
    by stacking a deliberately-panicking middleware *inside* the
    outermost ``RequestLoggingMiddleware`` and asserting the access
    log still emits a ``request_failed`` record.
    """
    from fastapi import FastAPI as InnerApp  # noqa: PLC0415 — local helper
    from starlette.middleware.base import (  # noqa: PLC0415
        BaseHTTPMiddleware,
        RequestResponseEndpoint,
    )
    from starlette.requests import Request as StarletteRequest  # noqa: PLC0415
    from starlette.responses import Response as StarletteResponse  # noqa: PLC0415
    from starlette.testclient import TestClient as InnerTestClient  # noqa: PLC0415

    from middleware.logging import RequestLoggingMiddleware  # noqa: PLC0415

    class _PanickingMiddleware(BaseHTTPMiddleware):
        async def dispatch(
            self,
            request: StarletteRequest,  # noqa: ARG002 — required by BaseHTTPMiddleware
            call_next: RequestResponseEndpoint,  # noqa: ARG002 — same; never invoked
        ) -> StarletteResponse:
            msg = "inner-middleware-panic"
            raise RuntimeError(msg)

    inner_app = InnerApp()
    inner_app.add_middleware(_PanickingMiddleware)
    inner_app.add_middleware(RequestLoggingMiddleware)

    inner_client = InnerTestClient(inner_app, raise_server_exceptions=False)
    with caplog.at_level(logging.ERROR, logger="adepthood.access"):
        inner_client.get("/probe")

    failed = [r for r in caplog.records if r.message == "request_failed"]
    assert failed, "expected one request_failed record from the panic branch"
    assert getattr(failed[-1], "http_method", None) == "GET"
    assert getattr(failed[-1], "http_path", None) == "/probe"
