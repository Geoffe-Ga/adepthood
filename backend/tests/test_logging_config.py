"""Tests for the application logging configuration (observability gap).

The production image starts uvicorn with no ``--log-config``, and uvicorn
only configures its own ``uvicorn.*`` loggers — the root logger has NO
handler.  Every application record below WARNING (``seed_complete``,
``content_loaded``, ``request_completed`` access lines, …) was therefore
silently dropped: deploys could not verify seeding from the boot log at
all, which is exactly how the course-content seeder race went undiagnosed.

``observability.configure_logging`` must give the root logger a real
stream handler (idempotently), honour ``LOG_LEVEL``, and stamp every
record with a ``trace_id`` so the formatter never KeyErrors.
"""

from __future__ import annotations

import io
import logging

import pytest

from observability import configure_logging, remove_app_log_handlers_for_tests


@pytest.fixture(autouse=True)
def _clean_root_handlers() -> object:
    """Remove any app-configured handler before and after each test."""
    remove_app_log_handlers_for_tests()
    yield
    remove_app_log_handlers_for_tests()


def _app_handlers() -> list[logging.Handler]:
    return [h for h in logging.getLogger().handlers if getattr(h, "_adepthood_app_handler", False)]


def test_configure_logging_installs_one_root_handler() -> None:
    """A single call attaches exactly one app handler to the root logger."""
    configure_logging()
    assert len(_app_handlers()) == 1


def test_configure_logging_is_idempotent() -> None:
    """Repeated calls (multi-worker boots, test re-imports) never stack handlers."""
    configure_logging()
    configure_logging()
    assert len(_app_handlers()) == 1


def test_info_records_are_emitted_with_trace_id_placeholder() -> None:
    """INFO from any app logger reaches the stream — with the no-trace sentinel."""
    stream = io.StringIO()
    configure_logging(stream=stream)
    logging.getLogger("seed_smoke_test").info("seed_complete seeder=%s inserted=%d", "stages", 10)
    output = stream.getvalue()
    assert "seed_complete seeder=stages inserted=10" in output
    assert "[-]" in output, "records outside a request must carry the no-trace sentinel"


def test_log_level_env_is_honoured(monkeypatch: pytest.MonkeyPatch) -> None:
    """``LOG_LEVEL=WARNING`` suppresses INFO without touching WARNING."""
    monkeypatch.setenv("LOG_LEVEL", "WARNING")
    stream = io.StringIO()
    configure_logging(stream=stream)
    logging.getLogger("level_smoke_test").info("invisible_info")
    logging.getLogger("level_smoke_test").warning("visible_warning")
    output = stream.getvalue()
    assert "invisible_info" not in output
    assert "visible_warning" in output


def test_invalid_log_level_falls_back_to_info(monkeypatch: pytest.MonkeyPatch) -> None:
    """A typo'd LOG_LEVEL must not crash boot — INFO is the safe default."""
    monkeypatch.setenv("LOG_LEVEL", "SHOUTING")
    stream = io.StringIO()
    configure_logging(stream=stream)
    logging.getLogger("fallback_smoke_test").info("still_visible")
    assert "still_visible" in stream.getvalue()
