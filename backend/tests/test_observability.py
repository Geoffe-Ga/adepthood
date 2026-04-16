"""Tests for the correlation-ID middleware and trace-id log filter.

BUG-INFRA-025: every request must have a trace ID that:

* propagates through ``contextvars`` for the duration of the request,
* is injected into log records via :class:`TraceIdLogFilter`, and
* is echoed back on the response as ``X-Request-ID``.
"""

from __future__ import annotations

import logging

from fastapi.testclient import TestClient

from main import app
from observability import (
    NO_TRACE,
    TRACE_ID_HEADER,
    TraceIdLogFilter,
    get_trace_id,
    install_trace_id_logging,
    trace_id_var,
)

client = TestClient(app)


def test_get_trace_id_outside_request_returns_sentinel() -> None:
    """Outside the middleware the contextvar yields :data:`NO_TRACE`."""
    assert get_trace_id() == NO_TRACE


def test_trace_id_contextvar_holds_value_inside_block() -> None:
    """``trace_id_var.set`` is visible to :func:`get_trace_id` in scope."""
    token = trace_id_var.set("req-42")
    try:
        assert get_trace_id() == "req-42"
    finally:
        trace_id_var.reset(token)
    assert get_trace_id() == NO_TRACE


def test_log_filter_injects_trace_id() -> None:
    """The filter attaches ``trace_id`` to log records."""
    record = logging.LogRecord(
        name="t",
        level=logging.INFO,
        pathname="",
        lineno=0,
        msg="hello",
        args=(),
        exc_info=None,
    )
    token = trace_id_var.set("trace-xyz")
    try:
        TraceIdLogFilter().filter(record)
    finally:
        trace_id_var.reset(token)
    assert record.trace_id == "trace-xyz"  # type: ignore[attr-defined]


def test_install_trace_id_logging_is_idempotent() -> None:
    """Calling :func:`install_trace_id_logging` twice adds only one filter."""
    install_trace_id_logging()
    install_trace_id_logging()
    root = logging.getLogger()
    trace_filters = [f for f in root.filters if isinstance(f, TraceIdLogFilter)]
    assert len(trace_filters) == 1


def test_caller_provided_id_is_echoed() -> None:
    """An inbound ``X-Request-ID`` is copied verbatim onto the response."""
    response = client.get(
        "/auth/login",
        headers={TRACE_ID_HEADER: "caller-supplied-trace"},
    )
    assert response.headers[TRACE_ID_HEADER] == "caller-supplied-trace"


def test_missing_id_is_minted() -> None:
    """A response without an inbound ``X-Request-ID`` still has one set."""
    response = client.get("/auth/login")
    minted = response.headers[TRACE_ID_HEADER]
    assert minted
    assert minted != NO_TRACE


_SANITY_MAX_TRACE_ID = 100


def test_pathologically_long_id_is_rejected_and_replaced() -> None:
    """Values longer than the cap are silently replaced by a fresh UUID."""
    long_id = "x" * 10_000
    response = client.get("/auth/login", headers={TRACE_ID_HEADER: long_id})
    assert response.headers[TRACE_ID_HEADER] != long_id
    assert len(response.headers[TRACE_ID_HEADER]) < _SANITY_MAX_TRACE_ID
