"""Sentry integration shim — stubbed until ops provisions a real DSN.

The real ``sentry-sdk`` package is intentionally NOT imported here so the
backend builds cleanly without an extra dependency.  Once the DSN lands
(tracked in ``prompts/2026-04-18-bug-remediation/remediation-plan/10-observability-e2e.md``),
swap :func:`capture_exception` to delegate to ``sentry_sdk.capture_exception``
and :func:`capture_message` to ``sentry_sdk.capture_message``; the call
sites elsewhere in the codebase do not need to change.

Until then every call is logged at ``error`` level with whatever extra
context was supplied so a grep on production logs is the temporary
substitute for a Sentry inbox.  This keeps observability honest — a
silent stub that did nothing would let real exceptions disappear.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("adepthood.sentry")


# ``object`` (not ``Any``) for the kwargs so callers can drop arbitrary
# context (request_id, user_id, sql query, ...) without us having to
# enumerate every shape — and so the ``ALL`` ruff config does not reject
# the signature on ANN401.  Each call site already documents what it
# passes in its own surrounding code.
def capture_exception(exc: BaseException, **context: object) -> None:
    """Record an unhandled exception.

    The exception's traceback is attached via ``exc_info=(type, value,
    tb)`` so the log record carries the full stack even when called from
    outside an ``except`` block — without this an operator would see only
    the message.  ``context`` is flattened into ``extra`` so structured
    log handlers can index against ``request_id`` / ``user_id`` etc.
    """
    logger.error(
        "sentry_capture_exception",
        exc_info=(type(exc), exc, exc.__traceback__),
        extra={"sentry_context": context} if context else None,
    )


def capture_message(message: str, **context: object) -> None:
    """Record a soft warning that did not produce an exception."""
    logger.warning(
        "sentry_capture_message",
        extra={"sentry_message": message, "sentry_context": context},
    )
