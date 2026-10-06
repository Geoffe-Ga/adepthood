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

import contextlib
import contextvars
import copy
import logging
import os
import re
import traceback
import uuid
from collections.abc import Mapping
from typing import IO

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from telemetry_safety import exception_label

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

# Record attribute a caller sets (via ``extra=``) to keep one record out of trace
# correlation: :class:`TraceIdLogFilter` stamps :data:`NO_TRACE` on it instead of
# the live trace ID.
#
# The narrow case it exists for is an event whose *occurrence* is itself an
# inference about a person, where the fields are content-free but the fact that
# the line was written is not. Correlation is what makes that fact personal: the
# other records of the same request carry a ``user_id``, so a shared trace ID
# joins the sensitive event straight to a named user. Withholding the value
# rather than deleting the attribute keeps every ``%(trace_id)s`` formatter
# working, and :data:`NO_TRACE` is already the value records outside a request
# carry, so no downstream consumer needs to learn a new one.
#
# Deliberately opt-in and deliberately rare: a record that suppresses correlation
# is a record an operator cannot follow, which is a real cost to pay only where
# the alternative is building a log-joinable dossier of something private.
SUPPRESS_TRACE_CORRELATION = "suppress_trace_correlation"


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

    Attach it to a *handler* — never to a logger. A logger-level filter
    runs only for records emitted directly on that logger, so one sitting
    on the root logger would stamp nothing at all: application code logs
    through ``logging.getLogger(__name__)`` and those records merely
    propagate upward. :func:`configure_logging` makes the one attachment
    that works, on the app stream handler. Use ``%(trace_id)s`` in the
    formatter to emit the value, or read it directly from a
    structured-log handler.

    A record carrying :data:`SUPPRESS_TRACE_CORRELATION` is stamped
    :data:`NO_TRACE` instead — the one honoured exception, for events whose
    mere occurrence must not be joinable to the request that produced it.
    Enforced here rather than at each call site because this filter runs on the
    *handler*, after any logger-level filter, and would otherwise overwrite
    whatever an emitter had set.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        suppressed = bool(getattr(record, SUPPRESS_TRACE_CORRELATION, False))
        record.trace_id = NO_TRACE if suppressed else get_trace_id()
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


# Marker attribute stamped on the handler ``configure_logging`` installs, so
# repeated calls (multi-worker boots, lifespan re-entry in tests) can find
# the existing handler instead of stacking a duplicate.
_APP_HANDLER_MARKER = "_adepthood_app_handler"

#: Boot log format. ``trace_id`` is stamped by the handler-level
#: :class:`TraceIdLogFilter` (records outside a request carry
#: :data:`NO_TRACE`), so the format never KeyErrors.
_APP_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s [%(trace_id)s] %(message)s"

#: Level applied when ``LOG_LEVEL`` is unset or not a recognised level name.
_DEFAULT_LOG_LEVEL = logging.INFO


def _resolve_log_level() -> int:
    """Map the ``LOG_LEVEL`` env var to a logging level, defaulting to INFO.

    A typo'd value must not crash boot — logging is the tool for seeing
    problems, so it fails soft to the INFO default.
    """
    name = os.getenv("LOG_LEVEL", "").upper()
    level = logging.getLevelNamesMapping().get(name)
    return level if level is not None else _DEFAULT_LOG_LEVEL


#: The rate limiter's logger and the template of its per-request warning,
#: ``ratelimit <limit> (<throttle key>) exceeded at endpoint: <raw path>``. The
#: key is the caller's address and the path can hold a share token, so the
#: record is rewritten to name only the limit (#3064). The app's own access
#: record already carries the 429, the route template and the trace id.
_RATE_LIMITER_LOGGER = "slowapi"
_RATE_LIMIT_EXCEEDED_TEMPLATE = "ratelimit %s (%s) exceeded at endpoint: %s"
_RATE_LIMIT_EXCEEDED_SAFE = "ratelimit %s exceeded"


class RateLimitRecordFilter(logging.Filter):
    """Rewrite slowapi's "limit exceeded" record to drop the throttle key and raw path."""

    def filter(self, record: logging.LogRecord) -> bool:
        """Keep the record, reduced to the limit that was exceeded."""
        if record.msg == _RATE_LIMIT_EXCEEDED_TEMPLATE and isinstance(record.args, tuple):
            record.msg = _RATE_LIMIT_EXCEEDED_SAFE
            record.args = record.args[:1]
        return True


#: Format for the uvicorn server's own handlers, which carry no trace filter.
_SERVER_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"

#: Loggers uvicorn installs its own handlers on. ``uvicorn.error`` propagates
#: only as far as ``uvicorn``, never to the root handler, and it is where the
#: server prints "Exception in ASGI application" with the traceback of anything
#: Starlette's ``ServerErrorMiddleware`` re-raised.
_SERVER_LOGGERS = ("uvicorn", "uvicorn.error")

#: uvicorn's per-request line: the request line *with* its query string, so a
#: journal ``?search=`` term (#3064). The app's own ``adepthood.access`` record
#: replaces it. Off in code as well as by ``--no-access-log`` in the Dockerfile,
#: so a host that starts uvicorn some other way is covered too.
_SERVER_ACCESS_LOGGER = "uvicorn.access"

#: HTTP client libraries that log every outbound request line at INFO, URL
#: included -- a user's self-hosted vault address and the entry id in its path.
#: Raised to WARNING so only their failures reach the host's logs; the app's own
#: records already name each outbound call by capability.
_OUTBOUND_CLIENT_LOGGERS = ("httpx", "httpx2")

_TRACEBACK_HEADER = "Traceback (most recent call last):\n"
_CAUSE_SEPARATOR = "\nThe above exception was the direct cause of the following exception:\n\n"
_CONTEXT_SEPARATOR = "\nDuring handling of the above exception, another exception occurred:\n\n"
_GROUP_MEMBER_HEADER = "+---- exception group member {index} ----\n"

_SEPARATORS = frozenset({_CAUSE_SEPARATOR, _CONTEXT_SEPARATOR})

#: What a record that cannot be formatted is reduced to: level and logger only.
_UNFORMATTABLE_RECORD = "<unformattable log record: {level} {logger}>"


def _neutralised(value: object) -> object:
    """Return an exception as its content-free label; anything else unchanged."""
    return exception_label(value) if isinstance(value, BaseException) else value


def _neutralised_args(
    args: tuple[object, ...] | Mapping[str, object] | None,
) -> tuple[object, ...] | Mapping[str, object] | None:
    """Replace every exception among a record's ``%``-arguments with its label."""
    if args is None:
        return None
    if isinstance(args, Mapping):
        return {key: _neutralised(value) for key, value in args.items()}
    return tuple(_neutralised(arg) for arg in args)


def _render_one(exc: BaseException) -> str:
    """Render one exception's frames and its ``Type: reason`` line."""
    frames = "".join(traceback.format_list(traceback.extract_tb(exc.__traceback__)))
    return f"{_TRACEBACK_HEADER}{frames}{exception_label(exc)}\n"


def _predecessor(exc: BaseException) -> tuple[BaseException, str] | None:
    """Return the cause (or unsuppressed context) ``exc`` was raised from, with its separator."""
    if exc.__cause__ is not None:
        return exc.__cause__, _CAUSE_SEPARATOR
    if exc.__context__ is not None and not exc.__suppress_context__:
        return exc.__context__, _CONTEXT_SEPARATOR
    return None


def _render_work(exc: BaseException) -> list[str | BaseException]:
    """Return what rendering ``exc`` expands to, in output order, links left unexpanded."""
    work: list[str | BaseException] = []
    predecessor = _predecessor(exc)
    if predecessor is not None:
        work.extend(predecessor)
    work.append(_render_one(exc))
    for index, member in enumerate(getattr(exc, "exceptions", ()), start=1):
        work.extend((_GROUP_MEMBER_HEADER.format(index=index), member))
    return work


def _drop_dangling_separator(pending: list[str | BaseException]) -> None:
    """Drop the separator queued to introduce a link that will not be rendered."""
    if pending and isinstance(pending[-1], str) and pending[-1] in _SEPARATORS:
        pending.pop()


def render_exception(exc: BaseException) -> str:
    """Render ``exc`` like a standard traceback, with every message withheld.

    Same order and separators as :func:`traceback.format_exception` -- the
    cause or context first, then the exception, then an exception group's
    members -- so an operator reads a familiar traceback. The final line of
    each block is :func:`telemetry_safety.exception_label`, never ``str(exc)``.

    Iterative, with an explicit stack: a chain thousands of links long renders
    in full instead of raising ``RecursionError``. Each exception renders once,
    so a context cycle (which Python permits) terminates; a link already
    rendered also drops the separator that would have introduced it.
    """
    parts: list[str] = []
    seen: set[int] = set()
    pending: list[str | BaseException] = [exc]
    while pending:
        item = pending.pop()
        if isinstance(item, str):
            parts.append(item)
            continue
        if id(item) in seen:
            _drop_dangling_separator(pending)
            continue
        seen.add(id(item))
        pending.extend(reversed(_render_work(item)))
    return "".join(parts)


class ContentFreeFormatter(logging.Formatter):
    """A formatter that prints an exception's type and frames, never its message.

    The standard formatter's traceback ends in ``Type: message``, and the
    message is authored at the raise site: a validation error quoting its
    input, a database error quoting a row, a provider error quoting a prompt.
    Every unhandled exception reaches the host's log collection through this
    formatter, so it withholds the message on all three routes one can take
    into a line (#3064):

    * ``exc_info`` -- rendered by :func:`render_exception`;
    * an exception passed as a ``%``-argument or as the message itself --
      replaced by its label before interpolation;
    * ``record.exc_text`` -- the full text another handler's standard
      formatter may already have cached on the shared record -- ignored.

    Works on a copy, so the record other handlers (and ``caplog``) see is
    untouched.
    """

    def format(self, record: logging.LogRecord) -> str:
        """Format a content-free copy of ``record``; never raise.

        A formatter that raises hands the record to ``Handler.handleError``,
        which prints ``--- Logging error ---``, a traceback chained to the
        exception being logged, and ``Message: %r / Arguments: %s`` with the raw
        values -- the very text this class withholds. So *every* failure is
        absorbed, deliberately not a list of "format errors": an argument's
        ``__str__`` can raise anything (a lazy load on a detached ORM row, a
        RuntimeError), and nothing can be logged from inside a formatter. The
        record is then reduced to a fixed line naming its level and logger.
        """
        line = _UNFORMATTABLE_RECORD.format(level=record.levelname, logger=record.name)
        with contextlib.suppress(Exception):
            line = self._format_content_free(record)
        return line

    def _format_content_free(self, record: logging.LogRecord) -> str:
        """Build and format the content-free copy."""
        safe = copy.copy(record)
        safe.msg = _neutralised(record.msg)
        safe.args = _neutralised_args(record.args)
        exc = record.exc_info[1] if record.exc_info else None
        safe.exc_info = None
        safe.exc_text = render_exception(exc).rstrip("\n") if exc is not None else None
        return super().format(safe)


def _build_app_handler(stream: IO[str] | None, level: int) -> logging.Handler:
    """Construct the marked app stream handler ``configure_logging`` installs.

    The :class:`TraceIdLogFilter` is attached to the *handler* (not the
    logger): logger-level filters never run for records propagated from
    child loggers, so the handler is the only seam that guarantees every
    formatted record carries a ``trace_id`` attribute.
    """
    handler = logging.StreamHandler(stream)
    handler.setLevel(level)
    handler.setFormatter(ContentFreeFormatter(_APP_LOG_FORMAT))
    handler.addFilter(TraceIdLogFilter())
    setattr(handler, _APP_HANDLER_MARKER, True)
    return handler


def _apply_log_level(root: logging.Logger, handlers: list[logging.Handler], level: int) -> None:
    """Set ``level`` on the app handlers and open the root logger to it.

    The root logger's default WARNING level would drop INFO records
    before any handler sees them; opening it to the configured level
    lets the handler apply its own threshold.
    """
    for handler in handlers:
        handler.setLevel(level)
    if root.level == 0 or root.level > level:
        root.setLevel(level)


def configure_logging(stream: IO[str] | None = None) -> None:
    """Give the root logger a real stream handler (idempotent).

    The production image starts uvicorn with no ``--log-config``, and
    uvicorn only configures its own ``uvicorn.*`` loggers — the root
    logger is left handler-less, so every application record below
    WARNING (``seed_complete``, ``content_loaded``, the per-request
    access lines) is silently dropped by :data:`logging.lastResort`.
    That made a production seeding failure indistinguishable from a
    successful boot.  Called from the lifespan startup hook so every
    worker gets exactly one handler.

    ``stream`` defaults to stderr (the ``StreamHandler`` default); tests
    inject a ``StringIO`` to assert on output.
    """
    root = logging.getLogger()
    level = _resolve_log_level()
    handlers = [h for h in root.handlers if getattr(h, _APP_HANDLER_MARKER, False)]
    if not handlers:
        handlers = [_build_app_handler(stream, level)]
        root.addHandler(handlers[0])
    _apply_log_level(root, handlers, level)
    _harden_library_loggers()


def _harden_library_loggers() -> None:
    """Make the server's and HTTP clients' own log output content-free (idempotent).

    uvicorn's handlers get :class:`ContentFreeFormatter`; its access logger --
    whose line is the raw request line, query string included -- is switched
    off; the HTTP clients' per-request URL lines are raised out of INFO; and
    the rate limiter's "exceeded" record loses its throttle key and raw path.
    Runs after uvicorn configured its loggers (it does so before loading the
    app), and touches nothing else when the app runs under another server.
    """
    for name in _SERVER_LOGGERS:
        for handler in logging.getLogger(name).handlers:
            if not isinstance(handler.formatter, ContentFreeFormatter):
                handler.setFormatter(ContentFreeFormatter(_SERVER_LOG_FORMAT))
    logging.getLogger(_SERVER_ACCESS_LOGGER).disabled = True
    limiter_logger = logging.getLogger(_RATE_LIMITER_LOGGER)
    if not any(isinstance(f, RateLimitRecordFilter) for f in limiter_logger.filters):
        limiter_logger.addFilter(RateLimitRecordFilter())
    for name in _OUTBOUND_CLIENT_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


def remove_app_log_handlers_for_tests() -> None:
    """Detach every handler ``configure_logging`` installed.

    Public on purpose — keeps the test contract on the module's public
    API instead of a private marker attribute, mirroring
    ``reset_content_repository_for_tests``.
    """
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, _APP_HANDLER_MARKER, False):
            root.removeHandler(handler)


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


#: Logged in place of a path no route matched (a 404 probe, a panic in a
#: middleware layer below the router). The raw path is never logged: it is
#: whatever the caller typed.
UNMATCHED_ROUTE = "<unmatched>"


def route_template(request: Request) -> str:
    """Return the matched route's template (``/practices/share/{token}``) for logging.

    The raw path carries the values a route was called with -- a share token is
    a credential, an entry id is a pointer at someone's writing -- so every
    telemetry record names the *template* instead (#3064). Starlette's router
    stores the matched route on the shared ``scope`` while dispatching, so a
    middleware reads it after ``call_next`` and an exception handler reads it
    after the endpoint raised. Anything that never reached a route is
    :data:`UNMATCHED_ROUTE`. Truncated like any other logged path, so a
    mounted sub-application's template stays bounded too.
    """
    template = getattr(request.scope.get("route"), "path_format", None)
    if not isinstance(template, str):
        return UNMATCHED_ROUTE
    return truncate_log_path(template)
