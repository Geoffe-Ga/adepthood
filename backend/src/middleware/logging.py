"""Request-logging middleware — outermost layer of the ASGI stack.

Sits *outside* :class:`middleware.trace_id.CorrelationIdMiddleware` so the
log line emitted for every request always carries a ``trace_id`` field
(the trace-id middleware sets the contextvar before this middleware's
``call_next`` returns).  Keeping it outermost means even a panic from
the security-headers / CORS / rate-limit layers below is captured in the
access log with its status code and elapsed time.
"""

from __future__ import annotations

import logging
import time

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("adepthood.access")

# Status threshold above which we log at ``warning``.  Server errors (>=500)
# bump to ``error`` so they show up in the same alerting bucket as panics
# from inner middleware layers.
_WARNING_STATUS = 400
_ERROR_STATUS = 500

# Width that keeps SQLite/Postgres-friendly logging stable — paths longer
# than this are truncated with an ellipsis so a malicious caller cannot
# inflate log volume by hammering ``/foo/AAAAA…`` URLs.
_PATH_TRUNCATE = 256


def _level_for_status(status: int) -> int:
    """Map an HTTP status code to a log level (info / warning / error)."""
    if status >= _ERROR_STATUS:
        return logging.ERROR
    if status >= _WARNING_STATUS:
        return logging.WARNING
    return logging.INFO


def _truncate(value: str) -> str:
    """Trim ``value`` to :data:`_PATH_TRUNCATE` characters with an ellipsis suffix."""
    if len(value) <= _PATH_TRUNCATE:
        return value
    return value[: _PATH_TRUNCATE - 1] + "…"


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """Emit one structured log line per request, even on inner-middleware errors.

    The line carries the request method, truncated path, response status,
    and elapsed milliseconds.  ``trace_id`` is injected automatically by
    the log filter installed in :func:`observability.install_trace_id_logging`,
    so every line is correlatable end-to-end without explicit threading.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        start = time.perf_counter()
        method = request.method
        path = _truncate(request.url.path)
        try:
            response = await call_next(request)
        except Exception:
            elapsed_ms = (time.perf_counter() - start) * 1000
            # The global exception handler will translate this to a 500
            # JSON envelope, but we still need a log line for the access
            # trail because the handler emits its own structured event,
            # not an access record.
            logger.exception(
                "request_failed",
                extra={
                    "http_method": method,
                    "http_path": path,
                    "elapsed_ms": round(elapsed_ms, 2),
                },
            )
            raise
        elapsed_ms = (time.perf_counter() - start) * 1000
        logger.log(
            _level_for_status(response.status_code),
            "request_completed",
            extra={
                "http_method": method,
                "http_path": path,
                "http_status": response.status_code,
                "elapsed_ms": round(elapsed_ms, 2),
            },
        )
        return response
