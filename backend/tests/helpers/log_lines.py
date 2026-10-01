"""Render a captured log record the way the deployed app handler prints it.

The production handler installed by :func:`observability.configure_logging`
formats with a plain ``%(message)s`` line, so every ``extra=`` field is dropped
from stdout. A number an operator must read therefore has to be in the
message itself; :func:`production_line` lets a test assert exactly that,
through the real handler rather than a copy of its format string.

:func:`assert_no_text` is the matching privacy check: no record's message, nor
any attribute on it, may carry the writer's text.
"""

from __future__ import annotations

import io
import logging
from collections.abc import Iterable

from observability import configure_logging, remove_app_log_handlers_for_tests


def production_line(record: logging.LogRecord) -> str:
    """Return ``record`` as the app's own stream handler would write it."""
    root = logging.getLogger()
    remove_app_log_handlers_for_tests()
    before = set(root.handlers)
    stream = io.StringIO()
    configure_logging(stream=stream)
    try:
        for handler in set(root.handlers) - before:
            handler.handle(record)
    finally:
        remove_app_log_handlers_for_tests()
    return stream.getvalue()


def assert_no_text(records: Iterable[logging.LogRecord], *texts: str) -> None:
    """Fail when any record's message or attribute contains any of ``texts``."""
    for record in records:
        surfaces = [record.getMessage(), *(str(v) for v in record.__dict__.values())]
        for text in texts:
            assert not any(text in surface for surface in surfaces), record.getMessage()


def records_for(records: Iterable[logging.LogRecord], event: str) -> list[logging.LogRecord]:
    """Every record whose message's first word is ``event``."""
    return [r for r in records if r.getMessage().split(" ", 1)[0] == event]
