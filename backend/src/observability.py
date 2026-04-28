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
import re
import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

# Header used by upstream load balancers / browser clients to propagate a
# trace identifier.  We honour whatever value the caller supplied as long as
# it matches a strict allow-list; otherwise we mint a new UUID4 so every log
# line in every request has a non-empty, log-injection-safe trace_id.
TRACE_ID_HEADER = "X-Request-ID"

# Strict shape for an accepted caller-supplied trace ID.
#
# BUG-APP-008 / BUG-OBS-001: log records use ``%(trace_id)s`` so a value
# containing ``\n`` / ``\r`` would split a log line into two and let an
# attacker forge follow-up records ("CRLF log injection").  Restricting the
# accepted alphabet to ASCII alphanumerics, ``-`` and ``_`` makes that
# impossible without re-implementing escaping at every log handler.  64 chars
# fits both the standard 32-char UUID-hex and the 36-char dashed UUID with
# headroom for short ULID / nanoid prefixes; longer values almost always
# indicate junk data (or a smuggling attempt) and are replaced with a fresh
# server-minted UUID4.  Non-ASCII codepoints would also break terminal log
# viewers and grep-pipeline correlation, so they are rejected as well.
_VALID_TRACE_ID = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


# Sentinel returned by ``get_trace_id`` when no request is in flight.  Using
# a distinct constant (rather than ``""``) means dashboards can filter out
# "no-trace" entries explicitly when needed.
NO_TRACE = "-"

trace_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("trace_id", default=NO_TRACE)


def get_trace_id() -> str:
    """Return the current request's trace ID, or :data:`NO_TRACE` if none is set."""
    return trace_id_var.get()


def _normalise_trace_id(raw: str | None) -> str:
    r"""Validate an inbound ``X-Request-ID`` against the allow-list, else mint a UUID4.

    BUG-APP-008 / BUG-OBS-001: the value is interpolated into log records as
    plain text, so an attacker who can put ``\r\n`` (or any control
    character) in this header could split log lines and forge follow-up
    records.  We therefore require the value to match
    ``^[A-Za-z0-9_-]{1,64}$`` exactly — not strip-then-accept, because a
    leading or trailing whitespace character should itself be evidence of
    tampering.  Anything that fails the check is silently replaced with a
    fresh UUID4 hex; we don't 400 the request because correlation IDs are
    advisory and an upstream proxy that fat-fingers the header should not
    cause a user-visible failure.
    """
    if raw is None or not _VALID_TRACE_ID.fullmatch(raw):
        return uuid.uuid4().hex
    return raw


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

    The same value is mirrored onto ``request.state.request_id`` so a
    FastAPI exception handler — which runs *outside* this middleware in
    Starlette's stack and therefore cannot read the contextvar (the
    ``finally`` block below has already reset it by then) — can still
    recover the trace ID for the unhandled-exception envelope
    (BUG-OBS-002 / -003).
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        trace_id = _normalise_trace_id(request.headers.get(TRACE_ID_HEADER))
        request.state.request_id = trace_id
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
