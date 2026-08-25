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


def payload_too_large(reason: str) -> HTTPException:
    """Return a 413 HTTPException for a request body past a declared ceiling.

    Distinct from :func:`unprocessable` because size is the one rejection the
    client can act on without changing anything else about the request: the
    status alone tells them to send something smaller, and a proxy in front of
    the app answers an oversized body with this same code.
    """
    return HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail=reason)


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


def unhandled_exception_response(request: Request, exc: Exception) -> JSONResponse:
    """Build the sanitised 500 for ``exc``, logging and Sentry-reporting it on the way.

    The synchronous twin of :func:`_unhandled_exception_handler`, for callers
    that are not Starlette exception handlers — specifically
    :class:`middleware.unhandled_exception.UnhandledExceptionMiddleware`, which
    exists so this envelope is produced *inside* the user middleware stack and
    therefore travels back out through ``CORSMiddleware``.  Both entry points
    build the identical body, header, log event, and Sentry report; they differ
    only in where in the stack they run.
    """
    return _sanitized_500(request, exc, log_event="unhandled_exception", error_code=INTERNAL_ERROR)


async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch-all handler — log, report to Sentry, return a sanitised envelope.

    BUG-OBS-002 / -003: every unhandled exception used to leak its
    message (and sometimes its stack frame paths) to the client through
    Starlette's default 500 page.  Replacing the page with this handler
    means the client sees only ``{"error": "internal_error",
    "request_id": "..."}`` while the server-side log carries the full
    traceback for support to look up by request ID.

    BUG-OBS-002: every entry is also forwarded to :func:`sentry.capture_exception`
    so the operator inbox gets the same alert signal.  That call ships the
    exception and the allow-listed request metadata below -- never the request
    body -- and is a no-op on a deployment with no DSN configured, which is a
    supported way to run: the ERROR record above is emitted either way.

    The trace ID is echoed in the response header (in addition to the body)
    so clients that opaquely surface failure to a user can ask them to copy
    a header value rather than parse JSON for support escalation.

    Reads the request ID from ``request.state.request_id`` (set by
    :class:`observability.CorrelationIdMiddleware`) because the
    contextvar copy has already been reset by the middleware's
    ``finally`` block by the time Starlette dispatches this handler —
    the contextvar is only a fallback for the bare-app test fixtures
    that do not install the middleware.

    On the deployed app this is a *backstop*: ``UnhandledExceptionMiddleware``
    sits below CORS and catches route- and rate-limit-layer exceptions first, so
    only a panic in one of the outermost layers (forwarded-proto, access
    logging, correlation id, security headers, CORS itself) still arrives here —
    and such a response, being written above CORS, is the one case a browser
    still cannot read.  Registering it remains strictly better than Starlette's
    default traceback page.
    """
    return unhandled_exception_response(request, exc)


def _sanitized_500(
    request: Request, exc: Exception, *, log_event: str, error_code: str
) -> JSONResponse:
    """Log + Sentry-report ``exc`` and return the sanitised 500 envelope.

    Shared by the catch-all and the journal-decryption handlers so both emit the
    same ``{error, request_id}`` body + trace header while logging a distinct
    event name (``log_event``) and returning a distinct ``error_code``.

    Logs at ERROR with an explicit ``exc_info=exc`` rather than calling
    ``logger.exception()``: this helper runs one frame below the Starlette
    handler and outside any ``except`` block, so a bare ``logger.exception()``
    would depend on ``sys.exc_info()`` still being populated by an enclosing
    frame.  Naming the exception we were handed keeps the traceback attached
    without that ambient coupling.
    """
    request_id = getattr(request.state, "request_id", None) or get_trace_id() or NO_TRACE
    truncated_path = truncate_log_path(request.url.path)
    logger.error(
        log_event,
        exc_info=exc,
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
