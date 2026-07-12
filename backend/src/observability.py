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
import sys
import uuid
from typing import TYPE_CHECKING

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

if TYPE_CHECKING:
    from typing import TextIO

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

    Attach this to a **handler** (see :func:`configure_stdout_logging`),
    not a logger: logger-level filters are skipped for records that
    propagate up from child loggers, so a root-*logger* filter never
    fires for the ``logging.getLogger(__name__)`` calls this codebase
    uses everywhere.  Use ``%(trace_id)s`` in the formatter to emit the
    value, or read it directly from a structured-log handler.
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


# Format for every application log line.  ``%(trace_id)s`` is safe to
# reference only because :func:`configure_stdout_logging` guarantees a
# :class:`TraceIdLogFilter` sits on the same handler as this formatter,
# so the attribute exists on every record before interpolation.
LOG_FORMAT = "%(asctime)s - %(trace_id)s - %(name)s - %(levelname)s - %(message)s"


def configure_stdout_logging(
    root: logging.Logger | None = None,
    stream: TextIO | None = None,
) -> bool:
    """Install a stdout log handler with trace-ID injection (idempotent).

    Containerized deployments (Docker on Railway) capture stdout/stderr
    only — yet Python's root logger ships with **no** handlers, so every
    ``logger.info(...)`` in the app was silently dropped while Uvicorn's
    separately-configured access logs still appeared.  This installs a
    single :class:`~logging.StreamHandler` on ``root`` writing to
    ``stream`` (default ``sys.stdout``) at ``INFO`` level.

    The :class:`TraceIdLogFilter` is attached to the *handler*, not the
    logger: logger-level filters only run for records logged directly
    through that logger instance, while handler-level filters apply to
    every record that reaches the handler — including records propagated
    from the named child loggers (``logging.getLogger(__name__)``) that
    this codebase uses everywhere.  A logger-level filter would leave
    propagated records without ``trace_id`` and make the
    ``%(trace_id)s`` interpolation in :data:`LOG_FORMAT` raise
    ``KeyError``, which :meth:`logging.Handler.emit` swallows into a
    ``--- Logging error ---`` stderr dump instead of the real log line.

    Returns ``True`` when the handler was installed, ``False`` when
    ``root`` already had handlers (e.g. under pytest, or a deployment
    that configures logging itself) — pre-configured environments are
    always left untouched, which also makes repeat calls no-ops.
    """
    target = root if root is not None else logging.getLogger()
    if target.handlers:
        return False
    handler = logging.StreamHandler(stream if stream is not None else sys.stdout)
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    handler.addFilter(TraceIdLogFilter())
    target.addHandler(handler)
    target.setLevel(logging.INFO)
    return True


# Width that keeps log records small enough to flow through SQLite/
# Postgres-friendly logging stable.  Paths longer than this are
# truncated with an ellipsis so a malicious caller cannot inflate log
# volume by hammering ``/foo/AAAAA…`` URLs.  Shared by the
# ``RequestLoggingMiddleware`` access-log emit and the unhandled-
# exception handler in :mod:`errors` so the cap stays in lock-step.
LOG_PATH_TRUNCATE_CHARS = 256


def truncate_log_path(path: str) -> str:
    """Trim ``path`` to :data:`LOG_PATH_TRUNCATE_CHARS` characters.

    Adds a single-character ellipsis suffix when truncation actually
    happens, keeping the original length signal visible.  ``path`` is
    returned unchanged when it already fits within the cap so the
    common case is a no-op.
    """
    if len(path) <= LOG_PATH_TRUNCATE_CHARS:
        return path
    return path[: LOG_PATH_TRUNCATE_CHARS - 1] + "…"
