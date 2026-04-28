"""Middleware-stack ordering and trace-id-at-import regression tests.

Closes:

- BUG-APP-001 — middleware add order LIFO: the last ``add_middleware`` is
  the outermost layer, so the registration order had to be reversed.
- BUG-APP-002 — preflight bypassed security headers when CORS sat
  outside SecurityHeaders; CORS short-circuited with a 200 before the
  headers were applied.
- BUG-APP-007 — :func:`install_trace_id_logging` ran in the lifespan
  startup hook, after router-registration log records had already been
  emitted without a trace-id field.
"""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

from main import app
from observability import TRACE_ID_HEADER, TraceIdLogFilter

client = TestClient(app)


# Expected outermost → innermost order.  ``app.user_middleware`` is stored
# outermost-first so this list compares directly against ``[m.cls.__name__
# for m in app.user_middleware]``.
EXPECTED_ORDER: list[str] = [
    "RequestLoggingMiddleware",
    "CorrelationIdMiddleware",
    "SecurityHeadersMiddleware",
    "CORSMiddleware",
    "SlowAPIMiddleware",
]


def test_middleware_registered_outer_to_inner() -> None:
    """BUG-APP-001: stack order is logging -> trace-id -> security -> CORS -> rate-limit."""
    assert [getattr(m.cls, "__name__", repr(m.cls)) for m in app.user_middleware] == EXPECTED_ORDER


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


def test_install_trace_id_logging_runs_at_import() -> None:
    """BUG-APP-007: importing ``main`` must already have installed the filter.

    A lifespan-only install left router-mount log records without a
    ``trace_id`` attribute and crashed any formatter that referenced
    ``%(trace_id)s``.  The check below asserts the filter is present on
    the root logger after merely importing ``main`` (which the test
    module already did).
    """
    root = logging.getLogger()
    assert any(isinstance(f, TraceIdLogFilter) for f in root.filters)


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
