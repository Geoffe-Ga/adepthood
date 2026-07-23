"""Standardized HTTP error helpers for consistent API responses."""

from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse

from observability import NO_TRACE, TRACE_ID_HEADER, get_trace_id, truncate_log_path
from sentry import capture_exception
from services.journal_encryption import JournalEncryptionError

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
# Distinct code for a journal decrypt/encrypt failure (key misconfigured or
# rotated out with un-migrated rows) so logs/clients can tell it apart from a
# generic 500 — the difference between "rotation went wrong" and "unrelated bug".
DECRYPTION_FAILURE = "decryption_failure"


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


def bad_gateway(reason: str) -> HTTPException:
    """Return a 502 HTTPException for an upstream-dependency failure.

    Use this when a downstream provider the request relies on (the LLM
    provider, the content repository) errors out, so the caller sees a
    stable snake_case token rather than the raw upstream error.
    """
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=reason)


def service_unavailable(reason: str) -> HTTPException:
    """Return a 503 HTTPException for a temporarily unusable dependency.

    Use this when a required upstream (e.g. Gumroad license verification)
    cannot answer and the endpoint must fail closed rather than guess, so
    the caller sees a stable snake_case token and knows to retry later.
    """
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=reason)


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
    :class:`observability.CorrelationIdMiddleware`) because the
    contextvar copy has already been reset by the middleware's
    ``finally`` block by the time Starlette dispatches this handler —
    the contextvar is only a fallback for the bare-app test fixtures
    that do not install the middleware.
    """
    return _sanitized_500(request, exc, log_event="unhandled_exception", error_code=INTERNAL_ERROR)


def _sanitized_500(
    request: Request, exc: Exception, *, log_event: str, error_code: str
) -> JSONResponse:
    """Log + Sentry-report ``exc`` and return the sanitised 500 envelope.

    Shared by the catch-all and the journal-decryption handlers so both emit the
    same ``{error, request_id}`` body + trace header while logging a distinct
    event name (``log_event``) and returning a distinct ``error_code``.
    """
    request_id = getattr(request.state, "request_id", None) or get_trace_id() or NO_TRACE
    truncated_path = truncate_log_path(request.url.path)
    logger.exception(
        log_event,
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
        content={ERROR_KEY: error_code, REQUEST_ID_KEY: request_id},
        headers={TRACE_ID_HEADER: request_id},
    )


async def _journal_encryption_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Surface a journal encrypt/decrypt failure as a distinct, logged 500.

    Without this, a key misconfiguration (or a rotation leaving rows encrypted
    under a retired key) raised from inside SQLAlchemy result-loading would be
    indistinguishable from any other 500 — blacking out the journal feature with
    no diagnostic signal. The body stays sanitised; the log/Sentry event names it.
    """
    return _sanitized_500(
        request, exc, log_event="journal_decryption_failure", error_code=DECRYPTION_FAILURE
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
    # Specific handler first so a journal decrypt/encrypt failure logs its own
    # event instead of disappearing into the catch-all.
    app.add_exception_handler(JournalEncryptionError, _journal_encryption_error_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
