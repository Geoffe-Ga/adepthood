"""Standardized HTTP error helpers for consistent API responses."""

from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse

from observability import NO_TRACE, TRACE_ID_HEADER, get_trace_id, truncate_log_path
from sentry import capture_exception

logger = logging.getLogger(__name__)

# Stable error-envelope keys for the catch-all 500 handler.  The
# per-route ``HTTPException(detail="...")`` responses keep the
# legacy ``{"detail": ...}`` shape so existing clients are not broken;
# the envelope below only applies to genuine unhandled exceptions
# (BUG-OBS-002 / -003) where the alternative was a full traceback page.
ERROR_KEY = "error"
REQUEST_ID_KEY = "request_id"

# Generic detail strings — never include the raw exception message in the
# HTTP body (BUG-OBS-003 / security).  The full traceback goes to logs and
# Sentry; the client only sees a stable token they can show the user.
INTERNAL_ERROR = "internal_error"


def not_found(resource: str) -> HTTPException:
    """Return a 404 HTTPException with a snake_case detail."""
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{resource}_not_found")


def forbidden(reason: str = "forbidden") -> HTTPException:
    """Return a 403 HTTPException."""
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=reason)


def bad_request(reason: str) -> HTTPException:
    """Return a 400 HTTPException."""
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=reason)


def conflict(reason: str) -> HTTPException:
    """Return a 409 HTTPException for state conflicts."""
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=reason)


def payment_required(reason: str = "payment_required") -> HTTPException:
    """Return a 402 HTTPException for insufficient credits."""
    return HTTPException(status_code=status.HTTP_402_PAYMENT_REQUIRED, detail=reason)


def unprocessable(reason: str) -> HTTPException:
    """Return a 422 HTTPException for post-Pydantic validation failures.

    Use this when a value passes the request schema but fails a domain or
    security check applied afterwards (for example,
    :class:`security.TextTooLongError` from sanitization expanding NFC
    combining sequences past the cap).  Mirrors FastAPI's own status code
    for length-cap violations so clients see a uniform shape.
    """
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=reason)


async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch-all handler — log, report to Sentry, return a sanitised envelope.

    BUG-OBS-002 / -003: every unhandled exception used to leak its
    message (and sometimes its stack frame paths) to the client through
    Starlette's default 500 page.  Replacing the page with this handler
    means the client sees only ``{"error": "internal_error",
    "request_id": "..."}`` while the server-side log carries the full
    traceback for support to look up by request ID.

    BUG-OBS-002: every entry is also forwarded to :func:`sentry.capture_exception`
    so the operator inbox gets the same alert signal.  ``capture_exception``
    is the no-op stub today; once the DSN lands the call site already
    works without modification.

    The trace ID is echoed in the response header (in addition to the body)
    so clients that opaquely surface failure to a user can ask them to copy
    a header value rather than parse JSON for support escalation.

    Reads the request ID from ``request.state.request_id`` (set by
    :class:`middleware.trace_id.CorrelationIdMiddleware`) because the
    contextvar copy has already been reset by the middleware's
    ``finally`` block by the time Starlette dispatches this handler —
    the contextvar is only a fallback for the bare-app test fixtures
    that do not install the middleware.
    """
    request_id = getattr(request.state, "request_id", None) or get_trace_id() or NO_TRACE
    truncated_path = truncate_log_path(request.url.path)
    logger.exception(
        "unhandled_exception",
        extra={
            "request_id": request_id,
            "request_path": truncated_path,
            "request_method": request.method,
        },
    )
    capture_exception(
        exc,
        request_id=request_id,
        request_path=truncated_path,
        request_method=request.method,
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={ERROR_KEY: INTERNAL_ERROR, REQUEST_ID_KEY: request_id},
        headers={TRACE_ID_HEADER: request_id},
    )


def install_exception_handlers(app: FastAPI) -> None:
    """Wire the global catch-all exception handler onto a FastAPI app.

    Per-route ``HTTPException`` responses keep their existing
    ``{"detail": ...}`` shape so legacy clients are not broken; only
    genuine unhandled exceptions (where Starlette would otherwise emit a
    full traceback page) flow through :func:`_unhandled_exception_handler`
    and get the sanitised ``{error, request_id}`` envelope.

    Kept as a function so tests can spin up a bare app and opt in
    selectively rather than inheriting the global handler from import.
    """
    app.add_exception_handler(Exception, _unhandled_exception_handler)
