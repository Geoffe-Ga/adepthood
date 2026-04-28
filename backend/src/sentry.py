"""Sentry integration shim — stubbed until ops provisions a real DSN.

The real ``sentry-sdk`` package is intentionally NOT imported here so the
backend builds cleanly without an extra dependency.  Once the DSN lands
(tracked in ``prompts/2026-04-18-bug-remediation/remediation-plan/10-observability-e2e.md``),
swap the body of :func:`capture_exception` for
``sentry_sdk.capture_exception(exc, contexts=context)`` and the body of
:func:`capture_message` for ``sentry_sdk.capture_message(message,
contexts=context)``; the call sites elsewhere in the codebase do not
need to change.

The shim is a **silent no-op** today, on purpose:

* Every call site already logs through the standard ``logging`` module
  before invoking us (e.g. :func:`errors._unhandled_exception_handler`
  emits a structured ``unhandled_exception`` record with the request
  id, path, and method).  Re-logging here would double-publish every
  traceback to log aggregators and confuse deduplication.
* The real Sentry SDK does not log to Python's ``logging`` either —
  it ships events to the DSN over HTTP — so a shim that logged would
  drift from production behaviour the moment the DSN was wired in.

Operators that want a temporary "log everything until Sentry is up"
mode should set ``LOG_LEVEL=DEBUG`` and rely on the call-site logger
records instead of changing this file.
"""

from __future__ import annotations


# ``object`` (not ``Any``) for the kwargs so callers can drop arbitrary
# context (request_id, user_id, sql query, ...) without us having to
# enumerate every shape — and so the ``ALL`` ruff config does not reject
# the signature on ANN401.  Each call site already documents what it
# passes in its own surrounding code.
#
# Security note: callers are responsible for not passing secrets in
# ``context``.  Today the shim is a no-op so a leaked credential goes
# nowhere, but the moment the real SDK lands the same call would ship
# the value to Sentry.  The unhandled-exception handler in
# :mod:`errors` only forwards request id, path, and method — none of
# which are sensitive.
def capture_exception(exc: BaseException, **context: object) -> None:
    """Record an unhandled exception (no-op until the real SDK ships).

    Intentionally does nothing today; the call-site logger has already
    emitted the structured record an operator needs to find this
    exception in production logs.  Once the DSN is wired in, replace
    the body with ``sentry_sdk.capture_exception(exc, contexts=context)``.
    """


def capture_message(message: str, **context: object) -> None:
    """Record a soft warning that did not produce an exception (no-op).

    See :func:`capture_exception` — the call site is responsible for
    its own logger record; this function is a placeholder for the
    Sentry SDK swap.
    """
