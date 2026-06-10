"""Sentry integration shim — stubbed until ops provisions a real DSN.

The real ``sentry-sdk`` package is intentionally NOT imported here so the
backend builds cleanly without an extra dependency.  Once the DSN lands,
swap the body of :func:`capture_exception` for
``sentry_sdk.capture_exception(exc, contexts=context)``; the call sites
elsewhere in the codebase do not need to change.

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

from typing import TypedDict, Unpack


class SentryContext(TypedDict, total=False):
    """Closed allow-list of context fields a capture may attach (issue #272).

    The shim used to take ``**context: object``, which type-checked a
    future call like ``capture_exception(exc, token=bearer)`` — a
    credential that would ship to Sentry the moment the real DSN lands.
    Narrowing the kwargs to this TypedDict makes any new field an
    explicit, reviewed decision: add it here (with a sensitivity check)
    before a call site can pass it.
    """

    request_id: str
    request_path: str
    request_method: str


# Security note: the allow-list above is the guard rail — none of the
# permitted fields are sensitive, and mypy rejects anything outside it.
def capture_exception(exc: BaseException, **context: Unpack[SentryContext]) -> None:
    """Record an unhandled exception (no-op until the real SDK ships).

    Intentionally does nothing today; the call-site logger has already
    emitted the structured record an operator needs to find this
    exception in production logs.  Once the DSN is wired in, replace
    the body with ``sentry_sdk.capture_exception(exc, contexts=context)``.

    A ``capture_message`` companion is intentionally NOT defined here —
    no current code path needs it, and CLAUDE.md forbids speculative
    scaffolding.  Add it alongside the first call site that warrants
    a soft warning being shipped to Sentry.
    """
