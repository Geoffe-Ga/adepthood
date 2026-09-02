"""Request-logging middleware — outermost layer that touches the response.

Only :class:`middleware.forwarded_proto.ForwardedProtoMiddleware` and
:class:`middleware.canonical_host.CanonicalHostMiddleware` sit above it, and
both only settle scope on the way in — neither wraps a response — so the access
record below still describes the whole response path.  The canonical-host layer
also leaves behind the authority it replaced, which this one attaches to the
record it was already emitting.

Sits *outside* :class:`observability.CorrelationIdMiddleware` so the
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

from observability import truncate_log_path
from request_host import ORIGINAL_HOST_SCOPE_KEY

logger = logging.getLogger("adepthood.access")

# Field naming the authority a request arrived with, on the requests whose
# authority ``CanonicalHostMiddleware`` replaced.  Absent from every other
# record, so it costs nothing on ordinary traffic and its presence alone is the
# signal that somebody sent a ``Host`` this deploy does not answer as.
_ORIGINAL_HOST_FIELD = "original_host"

# Status threshold above which we log at ``warning``.  Server errors (>=500)
# bump to ``error`` so they show up in the same alerting bucket as panics
# from inner middleware layers.
_WARNING_STATUS = 400
_ERROR_STATUS = 500


def _level_for_status(status: int) -> int:
    """Map an HTTP status code to a log level (info / warning / error)."""
    if status >= _ERROR_STATUS:
        return logging.ERROR
    if status >= _WARNING_STATUS:
        return logging.WARNING
    return logging.INFO


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """Emit one structured log line per request, even on inner-middleware errors.

    The line carries the request method, truncated path, response status,
    and elapsed milliseconds.  ``trace_id`` is injected automatically by
    the :class:`~observability.TraceIdLogFilter` that
    :func:`observability.configure_logging` attaches to the app log
    handler, so every line is correlatable end-to-end without explicit
    threading.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        start = time.perf_counter()
        method = request.method
        path = truncate_log_path(request.url.path)
        try:
            response = await call_next(request)
        except Exception:
            elapsed_ms = (time.perf_counter() - start) * 1000
            # Defensive catch.  An ``HTTPException`` is converted by
            # Starlette's ``ExceptionMiddleware`` and anything else by
            # ``UnhandledExceptionMiddleware`` — both of which sit
            # *inside* this layer — so in the normal case an error
            # arrives here as a response and takes the success path
            # below, logged at ERROR level by ``_level_for_status``.
            # This branch only fires if a middleware layer between us
            # and those two itself raises (e.g. SecurityHeaders or CORS
            # blowing up), which is a far rarer failure mode that still
            # deserves a single access record.
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
        fields: dict[str, object] = {
            "http_method": method,
            "http_path": path,
            "http_status": response.status_code,
            "elapsed_ms": round(elapsed_ms, 2),
        }
        # ``.get`` answers None only when the key is absent: the layer that sets
        # it always stores a string, using "" for a request that named no
        # authority at all.  So this reads "a settle happened", not "a value
        # was truthy" — a probe sending an empty Host still gets its record.
        original_host = request.scope.get(ORIGINAL_HOST_SCOPE_KEY)
        if original_host is not None:
            fields[_ORIGINAL_HOST_FIELD] = original_host
        logger.log(_level_for_status(response.status_code), "request_completed", extra=fields)
        return response
