"""Tests for the correlation-ID middleware and trace-id log filter.

BUG-INFRA-025: every request must have a trace ID that:

* propagates through ``contextvars`` for the duration of the request,
* is injected into log records via :class:`TraceIdLogFilter`, and
* is echoed back on the response as ``X-Request-ID``.
"""

from __future__ import annotations

import io
import logging
import re

import pytest
from fastapi.testclient import TestClient

from main import app
from observability import (
    NO_TRACE,
    TRACE_ID_HEADER,
    TraceIdLogFilter,
    _normalise_trace_id,
    configure_stdout_logging,
    get_trace_id,
    trace_id_var,
)

client = TestClient(app)


def test_get_trace_id_outside_request_returns_sentinel() -> None:
    """Outside the middleware the contextvar yields :data:`NO_TRACE`."""
    assert get_trace_id() == NO_TRACE


def test_trace_id_contextvar_holds_value_inside_block() -> None:
    """``trace_id_var.set`` is visible to :func:`get_trace_id` in scope."""
    token = trace_id_var.set("req-42")
    try:
        assert get_trace_id() == "req-42"
    finally:
        trace_id_var.reset(token)
    assert get_trace_id() == NO_TRACE


def test_log_filter_injects_trace_id() -> None:
    """The filter attaches ``trace_id`` to log records."""
    record = logging.LogRecord(
        name="t",
        level=logging.INFO,
        pathname="",
        lineno=0,
        msg="hello",
        args=(),
        exc_info=None,
    )
    token = trace_id_var.set("trace-xyz")
    try:
        TraceIdLogFilter().filter(record)
    finally:
        trace_id_var.reset(token)
    assert record.trace_id == "trace-xyz"  # type: ignore[attr-defined]


def test_configure_stdout_logging_installs_trace_aware_handler() -> None:
    """One call installs the handler, its trace-id filter, and INFO level."""
    target = logging.getLogger("test-stdout-install")
    target.handlers.clear()
    try:
        assert configure_stdout_logging(root=target, stream=io.StringIO()) is True
        assert len(target.handlers) == 1
        assert any(isinstance(f, TraceIdLogFilter) for f in target.handlers[0].filters)
        assert target.level == logging.INFO
    finally:
        target.handlers.clear()
        target.setLevel(logging.NOTSET)


def test_configure_stdout_logging_leaves_preconfigured_loggers_untouched() -> None:
    """A logger that already has handlers is not modified (returns ``False``).

    This is both the idempotency guarantee (a second call sees the first
    call's handler) and the pytest/deployment escape hatch: environments
    that configure logging themselves are respected.
    """
    target = logging.getLogger("test-stdout-preconfigured")
    target.handlers.clear()
    sentinel = logging.NullHandler()
    target.addHandler(sentinel)
    try:
        assert configure_stdout_logging(root=target, stream=io.StringIO()) is False
        assert target.handlers == [sentinel]
    finally:
        target.handlers.clear()


def test_configure_stdout_logging_defaults_to_process_root_logger() -> None:
    """With no explicit target the *process* root logger is inspected.

    Under pytest the root logger carries the capture plugin's handlers, so
    the default-argument call must refuse to touch it.  A ``NullHandler``
    is added first so the assertion stays deterministic even if the plugin
    ever attaches its handlers lazily.
    """
    root = logging.getLogger()
    placeholder: logging.Handler | None = None
    if not root.handlers:
        placeholder = logging.NullHandler()
        root.addHandler(placeholder)
    try:
        assert configure_stdout_logging() is False
    finally:
        if placeholder is not None:
            root.removeHandler(placeholder)


def test_child_logger_record_renders_trace_id_through_configured_handler(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Regression (PR #1547): child-logger records must render, with trace id.

    The original implementation attached :class:`TraceIdLogFilter` to the
    root *logger*, which is skipped for records propagating up from named
    child loggers — so ``%(trace_id)s`` in the formatter raised
    ``KeyError`` and every real log line was swallowed into a
    ``--- Logging error ---`` stderr dump.  This exercises the full
    pipeline the presence-only assertions missed: child logger →
    propagation → handler-level filter → formatter → stream.
    """
    parent = logging.getLogger("test-stdout-e2e")
    parent.handlers.clear()
    child = logging.getLogger("test-stdout-e2e.chapters.seed")
    token = trace_id_var.set("trace-e2e-123")
    try:
        # No explicit stream: the handler must bind sys.stdout (capsys's
        # replacement), pinning the "stdout by default" contract too.
        assert configure_stdout_logging(root=parent) is True
        child.info("seed probe message")
    finally:
        trace_id_var.reset(token)
        parent.handlers.clear()
        parent.setLevel(logging.NOTSET)
    captured = capsys.readouterr()
    assert "seed probe message" in captured.out
    assert "trace-e2e-123" in captured.out
    assert "Logging error" not in captured.err


def test_caller_provided_id_is_echoed() -> None:
    """An inbound ``X-Request-ID`` is copied verbatim onto the response."""
    response = client.get(
        "/auth/login",
        headers={TRACE_ID_HEADER: "caller-supplied-trace"},
    )
    assert response.headers[TRACE_ID_HEADER] == "caller-supplied-trace"


def test_missing_id_is_minted() -> None:
    """A response without an inbound ``X-Request-ID`` still has one set."""
    response = client.get("/auth/login")
    minted = response.headers[TRACE_ID_HEADER]
    assert minted
    assert minted != NO_TRACE


_SANITY_MAX_TRACE_ID = 100

# A 32-char UUID4 hex is the shape minted by ``_normalise_trace_id`` when the
# inbound value is rejected.  Tests assert against this so a regression that
# accidentally lets a hostile value through still trips the length check.
_MINTED_LEN = 32


def test_pathologically_long_id_is_rejected_and_replaced() -> None:
    """Values longer than the cap are silently replaced by a fresh UUID."""
    long_id = "x" * 10_000
    response = client.get("/auth/login", headers={TRACE_ID_HEADER: long_id})
    assert response.headers[TRACE_ID_HEADER] != long_id
    assert len(response.headers[TRACE_ID_HEADER]) < _SANITY_MAX_TRACE_ID


# ── Strict allow-list (BUG-APP-008 / BUG-OBS-001) ──────────────────────────
#
# The header is interpolated directly into log records, so anything that
# could break log-line framing or smuggle ANSI escapes / non-ASCII visual
# spoofs must be rejected and replaced with a server-minted UUID4.


def _assert_replaced(response_id: str, original: str) -> None:
    """Assert that ``original`` was rejected and ``response_id`` is a fresh hex UUID.

    Uses a strict regex (rather than character-set membership) so a future
    regression that minted uppercase hex would also fail this check.
    """
    assert response_id != original
    assert re.fullmatch(r"[0-9a-f]{32}", response_id), response_id


def test_crlf_in_trace_id_rejected() -> None:
    r"""``\r\n`` would split a log line; reject it."""
    response = client.get("/auth/login", headers={TRACE_ID_HEADER: "abc\r\nFAKE-LOG"})
    _assert_replaced(response.headers[TRACE_ID_HEADER], "abc\r\nFAKE-LOG")


def test_null_byte_in_trace_id_rejected() -> None:
    """Null bytes truncate downstream C string parsers; reject."""
    response = client.get("/auth/login", headers={TRACE_ID_HEADER: "abc\x00def"})
    _assert_replaced(response.headers[TRACE_ID_HEADER], "abc\x00def")


def test_non_ascii_trace_id_rejected_at_normaliser() -> None:
    """Allow-list is ASCII alphanumerics only; non-ASCII gets replaced.

    httpx's TestClient pre-encodes header values as ASCII so a non-ASCII
    string never reaches the middleware via that path; instead we exercise
    the normaliser directly and assert it rejects the input.
    """
    minted = _normalise_trace_id("café-trace")
    _assert_replaced(minted, "café-trace")


def test_script_tag_trace_id_rejected() -> None:
    """``<script>`` punctuation is outside the allow-list."""
    response = client.get("/auth/login", headers={TRACE_ID_HEADER: "<script>"})
    _assert_replaced(response.headers[TRACE_ID_HEADER], "<script>")


def test_whitespace_only_trace_id_rejected() -> None:
    """Pure whitespace fails ``[A-Za-z0-9_-]+`` and is minted fresh."""
    response = client.get("/auth/login", headers={TRACE_ID_HEADER: "   "})
    _assert_replaced(response.headers[TRACE_ID_HEADER], "   ")


def test_leading_whitespace_trace_id_rejected() -> None:
    """The strict regex demands no surrounding whitespace at all."""
    response = client.get("/auth/login", headers={TRACE_ID_HEADER: " ok-trace"})
    _assert_replaced(response.headers[TRACE_ID_HEADER], " ok-trace")


def test_over_64_char_trace_id_rejected() -> None:
    """65+ chars (still ASCII alnum) is rejected by the length cap."""
    long_id = "a" * 65
    response = client.get("/auth/login", headers={TRACE_ID_HEADER: long_id})
    _assert_replaced(response.headers[TRACE_ID_HEADER], long_id)


def test_uuid_hex_trace_id_accepted() -> None:
    """Standard 32-char UUID hex (the most common shape) passes through."""
    uuid_hex = "0123456789abcdef0123456789abcdef"  # pragma: allowlist secret
    response = client.get("/auth/login", headers={TRACE_ID_HEADER: uuid_hex})
    assert response.headers[TRACE_ID_HEADER] == uuid_hex


def test_dashed_uuid_trace_id_accepted() -> None:
    """36-char dashed UUID also fits the allow-list."""
    dashed = "01234567-89ab-cdef-0123-456789abcdef"
    response = client.get("/auth/login", headers={TRACE_ID_HEADER: dashed})
    assert response.headers[TRACE_ID_HEADER] == dashed


def test_underscore_trace_id_accepted() -> None:
    """Underscore is in the allow-list for tools that emit ``req_<id>``."""
    val = "req_abc_123"
    response = client.get("/auth/login", headers={TRACE_ID_HEADER: val})
    assert response.headers[TRACE_ID_HEADER] == val
