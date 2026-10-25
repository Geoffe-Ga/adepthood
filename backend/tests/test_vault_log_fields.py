"""The vault seam's structured fields reach the log line (#3502).

``services.creek_vault_telemetry``, ``services.creek_vault_read`` and
``services.creek_vault_write`` emit one static message each and put everything an
operator acts on -- the capability, the outcome, the degrade reason, the vault's
own code -- in ``extra``. The app formatter printed only the message, so in
production ``creek vault read degraded`` arrived with nothing to act on: the
2026-10-21 reflection failure (ref ``e9b76872...``) took a code read across two
repositories to diagnose.

What is pinned here is deliberately narrower than "render extras". Two hundred
and fifty ``extra=`` sites exist and some carry identifiers, so the formatter
renders fields only from the vault loggers, only under the names those modules
use, and only when the value has the shape of a closed-vocabulary token. A
future ``extra={"reason": entry.body}`` on one of these loggers is dropped, not
printed.
"""

from __future__ import annotations

import io
import logging

import pytest

from domain.creek_vault import (
    CreekCapability,
    CreekVaultUnavailableError,
    VaultErrorCode,
)
from observability import (
    configure_logging,
    remove_app_log_handlers_for_tests,
    trace_id_var,
)
from services.creek_vault_read import log_read_degraded
from services.creek_vault_telemetry import VaultTelemetryOutcome, record_vault_outcome

_FREE_TEXT = "I walked to the creek and cried about my father"


@pytest.fixture(autouse=True)
def _clean_root_handlers() -> object:
    """Remove any app-configured handler before and after each test."""
    remove_app_log_handlers_for_tests()
    yield
    remove_app_log_handlers_for_tests()


@pytest.fixture
def stream() -> io.StringIO:
    """Install the production app handler over an in-memory stream."""
    sink = io.StringIO()
    configure_logging(stream=sink)
    return sink


def _line(stream: io.StringIO, event: str) -> str:
    """Return the one formatted line carrying *event*."""
    lines = [line for line in stream.getvalue().splitlines() if event in line]
    assert len(lines) == 1, stream.getvalue()
    return lines[0]


def test_a_degraded_read_names_its_capability_reason_and_code(stream: io.StringIO) -> None:
    """The exact line that was unactionable on 2026-10-21 now says why."""
    error = CreekVaultUnavailableError(
        "creek vault reflect call failed", code=VaultErrorCode.TEMPORARILY_UNAVAILABLE
    )

    log_read_degraded(CreekCapability.REFLECT, error)

    line = _line(stream, "creek vault read degraded")
    assert line.endswith(
        "creek vault read degraded capability=creek.reflect reason=unavailable"
        " code=temporarily_unavailable"
    ), line


def test_a_vault_outcome_names_its_outcome_and_capability(stream: io.StringIO) -> None:
    """Fields render in a fixed order, so two lines for one event diff cleanly."""
    token = trace_id_var.set("TRACE1")
    try:
        record_vault_outcome(
            VaultTelemetryOutcome.UNAVAILABLE,
            CreekCapability.REFLECT,
            code=VaultErrorCode.TEMPORARILY_UNAVAILABLE,
        )
    finally:
        trace_id_var.reset(token)

    line = _line(stream, "creek vault outcome")
    assert "[TRACE1] creek vault outcome capability=creek.reflect" in line, line
    assert line.endswith("outcome=vault_unavailable code=temporarily_unavailable"), line


def test_free_text_under_an_allowed_name_is_dropped(stream: io.StringIO) -> None:
    """The value must look like a token; prose under ``reason`` never prints."""
    logging.getLogger("services.creek_vault_read").warning(
        "creek vault read degraded",
        extra={"capability": "creek.reflect", "reason": _FREE_TEXT},
    )

    line = _line(stream, "creek vault read degraded")
    assert "capability=creek.reflect" in line, line
    assert "reason=" not in line, line
    assert "creek and cried" not in stream.getvalue()


def test_a_field_outside_the_allowlist_is_dropped(stream: io.StringIO) -> None:
    """``entry_id`` and anything else the vault loggers attach stay off the line."""
    logging.getLogger("services.creek_vault_write").warning(
        "creek vault write degraded",
        extra={"entry_id": 4242, "reason": "not_stored", "body": "secret"},
    )

    line = _line(stream, "creek vault write degraded")
    assert line.endswith("creek vault write degraded reason=not_stored"), line
    assert "4242" not in line
    assert "secret" not in line


def test_another_logger_s_extras_are_never_rendered(stream: io.StringIO) -> None:
    """The rendering is scoped to the vault seam, not to a field name."""
    logging.getLogger("routers.auth").info("token_rejected", extra={"reason": "revoked"})

    line = _line(stream, "token_rejected")
    assert line.endswith("token_rejected"), line


def test_a_care_escalation_stays_uncorrelated(stream: io.StringIO) -> None:
    """Rendering fields must not undo #3064's suppression of the trace id."""
    logging.getLogger().setLevel(logging.DEBUG)
    for handler in logging.getLogger().handlers:
        handler.setLevel(logging.DEBUG)
    token = trace_id_var.set("CARETRACE")
    try:
        record_vault_outcome(VaultTelemetryOutcome.ESCALATED, CreekCapability.REFLECT)
    finally:
        trace_id_var.reset(token)

    line = _line(stream, "creek vault outcome")
    assert "CARETRACE" not in line, line
    assert "suppress_trace_correlation" not in line, line
    assert line.endswith("outcome=vault_escalated"), line
