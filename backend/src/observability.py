"""Cross-cutting observability primitives — correlation IDs and log filters.

BUG-INFRA-024 / BUG-INFRA-025: every request gets a trace ID (read from the
``X-Request-ID`` header or minted as a UUID4) that:

* propagates through ``contextvars`` so any code in the call chain can read
  it without explicit threading,
* is automatically injected into log records via :class:`TraceIdLogFilter`
  so structured-logging consumers can stitch entries together, and
* is echoed back to the client in the ``X-Request-ID`` response header so
  client logs can be matched against server logs by support staff.

The module is intentionally framework-agnostic except for the middleware
adapter; the core mechanics (contextvar + log filter) work in background
tasks and Celery / RQ workers without modification.
"""

from __future__ import annotations

import contextvars
import logging
import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

# Header used by upstream load balancers / browser clients to propagate a
# trace identifier.  We honour whatever value the caller supplied as long as
# it looks reasonable; otherwise we mint a new UUID4 so every log line in
# every request has a non-empty trace_id.
TRACE_ID_HEADER = "X-Request-ID"

# Maximum length we'll accept for a caller-supplied trace ID.  256 chars is
# well above the 36-char UUID and any reasonable correlation token while
# capping memory usage if a client sends pathological input.
_MAX_TRACE_ID_LENGTH = 256

# Sentinel returned by ``get_trace_id`` when no request is in flight.  Using
# a distinct constant (rather than ``""``) means dashboards can filter out
# "no-trace" entries explicitly when needed.
NO_TRACE = "-"

trace_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("trace_id", default=NO_TRACE)


def get_trace_id() -> str:
    """Return the current request's trace ID, or :data:`NO_TRACE` if none is set."""
    return trace_id_var.get()


def _normalise_trace_id(raw: str | None) -> str:
    """Sanitise an inbound ``X-Request-ID`` value and fall back to a UUID4.

    Strips surrounding whitespace and rejects values that are empty or
    longer than :data:`_MAX_TRACE_ID_LENGTH`.  We don't try to enforce a
    specific format (UUID, ULID, etc.) because callers in different
    environments use different conventions.
    """
    if raw is None:
        return uuid.uuid4().hex
    candidate = raw.strip()
    if not candidate or len(candidate) > _MAX_TRACE_ID_LENGTH:
        return uuid.uuid4().hex
    return candidate


class TraceIdLogFilter(logging.Filter):
    """Inject the current request's trace ID into every log record.

    Adding the filter at the root logger means every handler picks up the
    ``trace_id`` attribute without having to be reconfigured individually.
    Use ``%(trace_id)s`` in the formatter to emit the value, or read it
    directly from a structured-log handler.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = get_trace_id()
        return True


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    """Set ``trace_id_var`` for the duration of each request and echo it back.

    The middleware reads :data:`TRACE_ID_HEADER` from the inbound request
    (minting a fresh UUID4 when absent), pushes it into the contextvar so
    downstream handlers and log records can see it, and writes the value
    onto the response so clients can correlate their own logs with ours.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        trace_id = _normalise_trace_id(request.headers.get(TRACE_ID_HEADER))
        token = trace_id_var.set(trace_id)
        try:
            response = await call_next(request)
        finally:
            trace_id_var.reset(token)
        response.headers[TRACE_ID_HEADER] = trace_id
        return response


def install_trace_id_logging() -> None:
    """Attach :class:`TraceIdLogFilter` to the root logger (idempotent).

    Safe to call from app startup and from tests; calling it more than
    once is a no-op because we check for an existing instance before
    appending.  This means importing :mod:`main` repeatedly during a test
    run doesn't accumulate filters.
    """
    root = logging.getLogger()
    if not any(isinstance(f, TraceIdLogFilter) for f in root.filters):
        root.addFilter(TraceIdLogFilter())
