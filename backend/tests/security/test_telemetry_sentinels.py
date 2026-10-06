"""Content-free telemetry as a tested invariant (#3064, #3079).

Synthetic canaries stand in for what a user wrote. Each test plants them where
user content could ride out -- an exception message, a chained cause, a frame,
an SDK-added key nobody reviewed, a request path, a query string -- and asserts
that no telemetry sink carries any of them:

* the Sentry envelope, captured through the production client and a fake
  transport (``helpers.sentry_capture``; nothing leaves the process),
* the root log stream that hosting log collection reads, and
* the access log.

Each sink is also asserted positively, so an "absent" pass cannot come from a
sink that went silent: the operator still gets the request id, the release,
the exception type, the frames and the route.
"""

from __future__ import annotations

import io
import json
import logging
from collections.abc import Callable, Iterator
from typing import ClassVar, NoReturn

import pytest
import sentry_sdk
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import AsyncClient
from pydantic import BaseModel

import sentry as error_monitoring
import telemetry_safety
from errors import install_exception_handlers
from middleware import CorrelationIdMiddleware
from observability import (
    TRACE_ID_HEADER,
    UNMATCHED_ROUTE,
    ContentFreeFormatter,
    configure_logging,
    remove_app_log_handlers_for_tests,
)
from services.journal_encryption import JournalEncryptionError
from tests.helpers.dockerfile_cmd import runtime_cmd_flag_names, runtime_cmd_tokens
from tests.helpers.sentry_capture import (
    TEST_ENVIRONMENT,
    TEST_RELEASE,
    CapturedEvent,
    CapturingTransport,
    capturing_sentry,
    disarm_sentry,
)
from tests.helpers.telemetry_canaries import (
    SENTINEL_IDS,
    SENTINELS,
    SHORT_CANARY,
    assert_no_canary,
)

# The keys an outgoing event may carry at each level. Asserted as a subset, so
# a field the SDK (or a future integration) adds is dropped by default rather
# than shipped until somebody notices it.
_TOP_LEVEL_KEYS = frozenset(
    {
        "event_id",
        "timestamp",
        "platform",
        "level",
        "environment",
        "release",
        "sdk",
        "tags",
        "contexts",
        "exception",
    }
)
_ENTRY_KEYS = frozenset({"type", "module", "value", "mechanism", "stacktrace"})
_FRAME_KEYS = frozenset({"filename", "module", "function", "lineno", "in_app"})

_SENTINEL_ROUTE = "/__sentinel__/{item_id}"
_REQUEST_ID = "sentinel-trace-1"


def _dump(event: object) -> str:
    """Serialise an event both ways a vendor could store it."""
    return json.dumps(event, ensure_ascii=False, default=str) + json.dumps(event, default=str)


def _event_carrying(canary: str) -> dict[str, object]:
    """An event with ``canary`` in every channel a scrubber has to close.

    Shaped like a real chained capture (two ``values`` entries with frames),
    then salted with every SDK-shaped key that has ever carried text plus one
    nobody has invented yet.
    """
    frame = {
        "filename": "routers/journal.py",
        "abs_path": f"/app/{canary}.py",
        "module": "routers.journal",
        "function": "create_entry",
        "lineno": 42,
        "in_app": True,
        "pre_context": [canary],
        "context_line": canary,
        "post_context": [canary],
        "vars": {"body": canary},
        "unknown_frame_key": canary,
    }
    return {
        "event_id": "0" * 32,
        "level": "error",
        "platform": "python",
        "environment": "production",
        "release": "abc123",
        "server_name": canary,
        "message": canary,
        "logentry": {"message": canary, "formatted": canary, "params": [canary]},
        "threads": {"values": [{"stacktrace": {"frames": [dict(frame)]}}]},
        "request": {"data": canary, "query_string": f"search={canary}"},
        "extra": {"body": canary},
        "breadcrumbs": {"values": [{"message": canary}]},
        "user": {"email": canary},
        "fingerprint": [canary],
        "transaction": canary,
        "tags": {"request_id": "trace-1", "other": canary},
        "contexts": {
            error_monitoring.REQUEST_CONTEXT_KEY: {
                "request_id": "trace-1",
                "request_path": "/journal/{entry_id}",
                "request_method": "POST",
                "unknown_context_key": canary,
            },
            "other_context": {"value": canary},
        },
        "sdk": {"name": "sentry.python", "version": "2", "packages": [{"name": canary}]},
        "exception": {
            "values": [
                {"type": "KeyError", "value": canary, "unknown_entry_key": canary},
                {
                    "type": "ValueError",
                    "module": None,
                    "value": canary,
                    "mechanism": {
                        "type": "generic",
                        "handled": True,
                        "data": {"body": canary},
                        "description": canary,
                    },
                    "stacktrace": {"frames": [frame], "registers": {"x": canary}},
                },
            ]
        },
        "unknown_future_key": canary,
    }


def _exception_entries(event: CapturedEvent) -> list[dict[str, object]]:
    """Return an event's exception entries, asserting the shape on the way."""
    exception = event["exception"]
    assert isinstance(exception, dict)
    values = exception["values"]
    assert isinstance(values, list)
    assert all(isinstance(entry, dict) for entry in values)
    return values


def _frames(entry: dict[str, object]) -> list[dict[str, object]]:
    """Return one exception entry's frames."""
    stacktrace = entry["stacktrace"]
    assert isinstance(stacktrace, dict)
    frames = stacktrace["frames"]
    assert isinstance(frames, list)
    return frames


# ── Backend Sentry: the allowlist rebuild ──────────────────────────────────


@pytest.mark.parametrize("canary", SENTINELS, ids=SENTINEL_IDS)
def test_scrub_event_ships_no_canary_from_any_channel(canary: str) -> None:
    """AC1/AC3/AC4: nothing planted anywhere survives, however it is spelled."""
    scrubbed = error_monitoring.scrub_event(_event_carrying(canary), {})

    assert_no_canary(_dump(scrubbed), canary)


def test_scrub_event_keeps_what_an_operator_diagnoses_with() -> None:
    """AC6/AC12: the type, the frames and the request identity survive the rebuild."""
    scrubbed = error_monitoring.scrub_event(_event_carrying(SHORT_CANARY), {})

    entries = _exception_entries(scrubbed)
    assert [entry["type"] for entry in entries] == ["KeyError", "ValueError"]
    assert all(entry["value"] == telemetry_safety.MESSAGE_WITHHELD for entry in entries)
    assert _frames(entries[-1]) == [
        {
            "filename": "routers/journal.py",
            "module": "routers.journal",
            "function": "create_entry",
            "lineno": 42,
            "in_app": True,
        }
    ]
    assert entries[-1]["mechanism"] == {"type": "generic", "handled": True}
    assert scrubbed["tags"] == {"request_id": "trace-1"}
    assert scrubbed["contexts"] == {
        error_monitoring.REQUEST_CONTEXT_KEY: {
            "request_id": "trace-1",
            "request_path": "/journal/{entry_id}",
            "request_method": "POST",
        }
    }
    assert scrubbed["environment"] == "production"
    assert scrubbed["release"] == "abc123"
    assert scrubbed["sdk"] == {"name": "sentry.python", "version": "2"}


def test_scrub_event_output_is_within_the_allowlist() -> None:
    """AC3: the event is rebuilt from named keys, so an unknown key cannot pass."""
    scrubbed = error_monitoring.scrub_event(_event_carrying(SHORT_CANARY), {})

    assert set(scrubbed) <= _TOP_LEVEL_KEYS
    for entry in _exception_entries(scrubbed):
        assert set(entry) <= _ENTRY_KEYS
        for frame in _frames(entry) if "stacktrace" in entry else []:
            assert set(frame) <= _FRAME_KEYS


def test_scrub_event_returns_a_new_object() -> None:
    """The input is never handed back: a rebuild, not an in-place edit."""
    event = _event_carrying(SHORT_CANARY)

    scrubbed = error_monitoring.scrub_event(event, {})
    event["message"] = "mutated after the scrub"

    assert scrubbed is not event
    assert "message" not in scrubbed


class _DeclaredFailureError(Exception):
    """An app exception that names its own content-free code."""

    safe_code: ClassVar[str] = "journal_save_failed"


def test_scrub_event_reports_a_declared_safe_code_from_the_hint() -> None:
    """AC6: the code comes from the exception class, never from the message."""
    exc = _DeclaredFailureError(SHORT_CANARY)
    event: dict[str, object] = {
        "exception": {"values": [{"type": "_DeclaredFailureError", "value": SHORT_CANARY}]}
    }

    scrubbed = error_monitoring.scrub_event(event, {"exc_info": (type(exc), exc, None)})

    assert _exception_entries(scrubbed)[0]["value"] == "journal_save_failed"


def test_scrub_event_withholds_a_code_two_same_named_classes_disagree_on() -> None:
    """An ambiguous name falls back to the marker rather than guess a code."""

    class ClashError(Exception):
        safe_code: ClassVar[str] = "first_code"

    first = ClashError()
    second_type = type("ClashError", (Exception,), {"safe_code": "second_code"})
    first.__context__ = second_type()
    event: dict[str, object] = {"exception": {"values": [{"type": "ClashError", "value": "x"}]}}

    scrubbed = error_monitoring.scrub_event(event, {"exc_info": (ClashError, first, None)})

    assert _exception_entries(scrubbed)[0]["value"] == telemetry_safety.MESSAGE_WITHHELD


_DEEP_NESTING = 1000


def _nested(leaf: object, depth: int) -> object:
    """Return ``leaf`` wrapped in ``depth`` levels of single-key mappings."""
    node = leaf
    for _ in range(depth):
        node = {"adepthood_request": node}
    return node


_MALFORMED_SHAPES: list[tuple[str, object]] = [
    ("exception_is_text", {"exception": SHORT_CANARY}),
    ("values_is_a_mapping", {"exception": {"values": {"value": SHORT_CANARY}}}),
    ("values_holds_text", {"exception": {"values": [SHORT_CANARY]}}),
    ("value_is_not_text", {"exception": {"values": [{"type": "E", "value": 123}]}}),
    ("type_is_not_text", {"exception": {"values": [{"type": [SHORT_CANARY]}]}}),
    ("frames_is_text", {"exception": {"values": [{"stacktrace": {"frames": SHORT_CANARY}}]}}),
    ("frame_is_text", {"exception": {"values": [{"stacktrace": {"frames": [SHORT_CANARY]}}]}}),
    ("stacktrace_is_text", {"exception": {"values": [{"stacktrace": SHORT_CANARY}]}}),
    ("mechanism_is_text", {"exception": {"values": [{"mechanism": SHORT_CANARY}]}}),
    ("contexts_is_text", {"contexts": SHORT_CANARY}),
    ("request_context_is_text", {"contexts": {"adepthood_request": SHORT_CANARY}}),
    ("tags_is_a_list", {"tags": [SHORT_CANARY]}),
    ("sdk_is_text", {"sdk": SHORT_CANARY}),
    ("level_is_a_mapping", {"level": {"x": SHORT_CANARY}}),
    ("non_text_key", {1: SHORT_CANARY, "exception": {"values": []}}),
    ("event_is_a_list", [SHORT_CANARY]),
    ("event_is_text", SHORT_CANARY),
    ("deeply_nested_contexts", {"contexts": _nested(SHORT_CANARY, _DEEP_NESTING)}),
]


@pytest.mark.parametrize(
    "event", [shape for _, shape in _MALFORMED_SHAPES], ids=[name for name, _ in _MALFORMED_SHAPES]
)
def test_scrub_event_fails_safe_on_a_malformed_event(event: object) -> None:
    """AC5: a shape nobody expected yields a minimal event, never the original."""
    scrubbed = error_monitoring.scrub_event(event, {})

    assert scrubbed is not event
    assert isinstance(scrubbed, dict)
    assert set(scrubbed) <= _TOP_LEVEL_KEYS
    assert_no_canary(_dump(scrubbed), SHORT_CANARY)
    entries = _exception_entries(scrubbed)
    assert entries, "a minimal event still says that something failed"
    assert all(isinstance(entry["type"], str) for entry in entries)


@pytest.mark.parametrize(
    "exc_info",
    [SHORT_CANARY, (None, SHORT_CANARY, None), (ValueError,), None],
    ids=["text", "value_is_text", "short_tuple", "none"],
)
def test_scrub_event_fails_safe_on_a_malformed_hint(exc_info: object) -> None:
    """A hint that is not a real ``exc_info`` triple cannot inject a code or a message."""
    event: dict[str, object] = {"exception": {"values": [{"type": "ValueError", "value": "x"}]}}

    scrubbed = error_monitoring.scrub_event(event, {"exc_info": exc_info})

    assert_no_canary(_dump(scrubbed), SHORT_CANARY)
    assert _exception_entries(scrubbed)[0]["value"] == telemetry_safety.MESSAGE_WITHHELD


def test_scrub_event_ships_a_minimal_event_when_the_rebuild_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AC5: an error inside the rebuild yields the minimal event, never the input."""

    def explode(_exc: BaseException) -> list[BaseException]:
        raise RuntimeError(SHORT_CANARY)

    monkeypatch.setattr(error_monitoring, "exception_chain", explode)
    monkeypatch.setenv(error_monitoring.ENVIRONMENT_ENV_VAR, "production")
    monkeypatch.setenv(error_monitoring.SENTRY_RELEASE_ENV_VAR, "rel-minimal")
    exc = ValueError(SHORT_CANARY)
    event = _event_carrying(SHORT_CANARY)

    scrubbed = error_monitoring.scrub_event(event, {"exc_info": (ValueError, exc, None)})

    assert scrubbed == {
        "level": "error",
        "platform": "python",
        "environment": "production",
        "release": "rel-minimal",
        "exception": {
            "values": [
                {
                    "type": error_monitoring.UNREPORTABLE_EXCEPTION_TYPE,
                    "value": telemetry_safety.MESSAGE_WITHHELD,
                }
            ]
        },
    }


def test_no_sdk_integration_is_installed() -> None:
    """AC13: an SDK upgrade cannot quietly turn automatic capture back on."""
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setenv(error_monitoring.SENTRY_DSN_ENV_VAR, "https://k@o0.ingest.sentry.io/1")
        try:
            assert error_monitoring.init_error_monitoring(transport=CapturingTransport())
            installed = frozenset(sentry_sdk.get_client().integrations)
        finally:
            disarm_sentry()

    assert installed == error_monitoring.APPROVED_INTEGRATIONS == frozenset()


def test_a_journal_encryption_failure_reports_its_declared_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A real app exception opts in to a code, so a key misconfiguration still groups."""
    with capturing_sentry(monkeypatch) as events:
        error_monitoring.capture_exception(JournalEncryptionError(SHORT_CANARY))

    assert_no_canary(_dump(events), SHORT_CANARY)
    assert _exception_entries(events[0])[0]["value"] == "journal_encryption_failed"


# ── Backend Sentry: end to end through the real client ─────────────────────


def _raise(exc: BaseException) -> NoReturn:
    """Raise ``exc``; called inside a ``try`` so the chain gets a real traceback."""
    raise exc


def _raise_from(canary: str) -> None:
    """Raise a ValueError explicitly chained from a KeyError."""
    try:
        _raise(KeyError(canary))
    except KeyError as cause:
        raise ValueError(canary) from cause


def _raise_in_handler(canary: str) -> None:
    """Raise a ValueError implicitly chained (``__context__``) to a RuntimeError."""
    try:
        _raise(RuntimeError(canary))
    except RuntimeError:
        _raise(ValueError(canary))


def _raise_group(canary: str) -> None:
    """Raise an ExceptionGroup whose message and members all carry the canary."""
    raise ExceptionGroup(canary, [RuntimeError(canary), KeyError(canary)])


class _ServiceInput(BaseModel):
    """A service-layer model, validated from text a user supplied."""

    count: int


def _raise_validation_error(canary: str) -> None:
    """Raise pydantic's ValidationError, whose ``str()`` quotes ``input_value``."""
    _ServiceInput.model_validate({"count": canary})


_RAISERS = {
    "raise_from": _raise_from,
    "implicit_context": _raise_in_handler,
    "exception_group": _raise_group,
    "pydantic_validation_error": _raise_validation_error,
}

# Per shape: how many exception entries the chain yields, and the type of the
# outermost one -- asserted so a pass cannot come from an event that lost links.
_CHAIN_LINKS = {
    "raise_from": 2,
    "implicit_context": 2,
    "exception_group": 3,
    "pydantic_validation_error": 1,
}
_OUTER_TYPE = {
    "raise_from": "ValueError",
    "implicit_context": "ValueError",
    "exception_group": "ExceptionGroup",
    "pydantic_validation_error": "ValidationError",
}


@pytest.mark.parametrize("shape", list(_RAISERS))
@pytest.mark.parametrize("canary", SENTINELS, ids=SENTINEL_IDS)
def test_captured_chain_ships_no_message(
    monkeypatch: pytest.MonkeyPatch, shape: str, canary: str
) -> None:
    """AC2: every link of a chain, captured by the real client, is message-free."""
    with capturing_sentry(monkeypatch) as events:
        try:
            _RAISERS[shape](canary)
        except (ValueError, ExceptionGroup) as exc:
            error_monitoring.capture_exception(exc, request_id=_REQUEST_ID)

    assert len(events) == 1
    assert_no_canary(_dump(events[0]), canary)
    entries = _exception_entries(events[0])
    assert len(entries) == _CHAIN_LINKS[shape], "every chain link is still reported, by type"
    assert entries[-1]["type"] == _OUTER_TYPE[shape]
    assert {entry["value"] for entry in entries} == {telemetry_safety.MESSAGE_WITHHELD}


@pytest.fixture
def sentinel_app() -> FastAPI:
    """An app with the production handlers and one route that raises the canary."""
    app = FastAPI()
    app.add_middleware(CorrelationIdMiddleware)
    install_exception_handlers(app)

    @app.get(_SENTINEL_ROUTE)
    async def explode(item_id: str) -> None:
        _raise_from(f"{SHORT_CANARY} {item_id}")

    return app


def test_route_raising_a_canary_ships_a_clean_but_diagnosable_event(
    sentinel_app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC7/AC12: one 500 through the real handler and client, zero canaries."""
    with capturing_sentry(monkeypatch) as events:
        client = TestClient(sentinel_app, raise_server_exceptions=False)
        response = client.get("/__sentinel__/item-1", headers={TRACE_ID_HEADER: _REQUEST_ID})

    assert response.status_code == 500
    assert len(events) == 1
    event = events[0]
    assert_no_canary(_dump(event), SHORT_CANARY)
    assert event["tags"] == {"request_id": _REQUEST_ID}
    assert event["environment"] == TEST_ENVIRONMENT
    assert event["release"] == TEST_RELEASE
    entries = _exception_entries(event)
    assert [entry["type"] for entry in entries] == ["KeyError", "ValueError"]
    assert any(frame["function"] == "_raise_from" for frame in _frames(entries[-1]))
    contexts = event["contexts"]
    assert isinstance(contexts, dict)
    request_context = contexts[error_monitoring.REQUEST_CONTEXT_KEY]
    assert isinstance(request_context, dict)
    assert request_context["request_id"] == _REQUEST_ID
    assert request_context["request_method"] == "GET"


# ── Paths: the route template, never the raw path ──────────────────────────

_SHARE_ROUTE = "/practices/share/{token}"
_ACCESS_LOGGER = "adepthood.access"


def _access_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Return the access-log records the request produced."""
    return [record for record in caplog.records if record.name == _ACCESS_LOGGER]


@pytest.mark.asyncio
async def test_share_token_never_reaches_the_access_log(
    async_client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    """AC9: a share token is a credential in the path; the access log keeps the template."""
    with caplog.at_level(logging.INFO, logger=_ACCESS_LOGGER):
        await async_client.get(f"/practices/share/{SHORT_CANARY}")

    records = _access_records(caplog)
    assert records, "the request still produced its access record"
    assert getattr(records[-1], "http_path", None) == _SHARE_ROUTE
    assert_no_canary(_emitted(records), SHORT_CANARY)


@pytest.mark.asyncio
async def test_an_unmatched_path_logs_the_marker(
    async_client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    """A path no route matched is logged as a fixed marker, not as typed."""
    with caplog.at_level(logging.INFO, logger=_ACCESS_LOGGER):
        await async_client.get(f"/no-such-route/{SHORT_CANARY}")

    records = _access_records(caplog)
    assert getattr(records[-1], "http_path", None) == UNMATCHED_ROUTE
    assert_no_canary(_emitted(records), SHORT_CANARY)


def test_sentry_and_the_error_log_report_the_route_template(
    sentinel_app: FastAPI, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """AC9/AC12: the unhandled-exception record and event name the route, not the path."""
    with capturing_sentry(monkeypatch) as events, caplog.at_level(logging.ERROR, logger="errors"):
        client = TestClient(sentinel_app, raise_server_exceptions=False)
        client.get(f"/__sentinel__/{SHORT_CANARY}", headers={TRACE_ID_HEADER: _REQUEST_ID})

    assert len(events) == 1
    assert_no_canary(_dump(events[0]), SHORT_CANARY)
    contexts = events[0]["contexts"]
    assert isinstance(contexts, dict)
    assert contexts[error_monitoring.REQUEST_CONTEXT_KEY] == {
        "request_id": _REQUEST_ID,
        "request_path": _SENTINEL_ROUTE,
        "request_method": "GET",
    }
    record = next(r for r in caplog.records if r.getMessage() == "unhandled_exception")
    assert getattr(record, "request_path", None) == _SENTINEL_ROUTE


def _emitted(records: list[logging.LogRecord]) -> str:
    """Every record's message and attributes, as one searchable string."""
    return "\n".join(f"{record.getMessage()} {record.__dict__}" for record in records)


# ── The root log stream: exception types and frames, never messages ────────

_LOGGER = logging.getLogger("tests.telemetry_sentinels")
_THIS_FILE = "test_telemetry_sentinels.py"


@pytest.fixture
def app_stream() -> Iterator[io.StringIO]:
    """The deployed root handler, writing into a buffer instead of stderr."""
    remove_app_log_handlers_for_tests()
    stream = io.StringIO()
    configure_logging(stream=stream)
    try:
        yield stream
    finally:
        remove_app_log_handlers_for_tests()


def _app_handlers() -> list[logging.Handler]:
    """Return the root handlers ``configure_logging`` installed."""
    return [
        h for h in logging.getLogger().handlers if isinstance(h.formatter, ContentFreeFormatter)
    ]


def _caught(raiser: Callable[[str], None], canary: str) -> BaseException:
    """Return the exception ``raiser`` raises, with its real traceback attached."""
    try:
        raiser(canary)
    except (ValueError, ExceptionGroup) as exc:
        return exc
    raise AssertionError("the raiser did not raise")


@pytest.mark.parametrize("shape", list(_RAISERS))
@pytest.mark.parametrize("canary", SENTINELS, ids=SENTINEL_IDS)
def test_an_exc_info_record_prints_types_and_frames_but_no_message(
    app_stream: io.StringIO, shape: str, canary: str
) -> None:
    """AC11: the traceback an operator reads keeps its shape and loses its text."""
    exc = _caught(_RAISERS[shape], canary)

    _LOGGER.error("request_failed", exc_info=exc)

    output = app_stream.getvalue()
    assert_no_canary(output, canary)
    assert "request_failed" in output
    assert "[-]" in output, "the trace-id bracket is still stamped"
    assert "Traceback (most recent call last):" in output
    assert f'{_THIS_FILE}", line ' in output
    assert f"{_OUTER_TYPE[shape]}: {telemetry_safety.MESSAGE_WITHHELD}" in output


def test_a_chain_keeps_its_cause_separator_and_every_type(app_stream: io.StringIO) -> None:
    """The cause, the separator, and the outer exception all still read in order."""
    _LOGGER.error("boom", exc_info=_caught(_raise_from, SHORT_CANARY))

    output = app_stream.getvalue()
    cause = output.index(f"KeyError: {telemetry_safety.MESSAGE_WITHHELD}")
    separator = output.index("The above exception was the direct cause")
    outer = output.index(f"ValueError: {telemetry_safety.MESSAGE_WITHHELD}")
    assert cause < separator < outer


def test_a_group_prints_every_member_type(app_stream: io.StringIO) -> None:
    """An exception group's members are listed by type, without their messages."""
    _LOGGER.error("boom", exc_info=_caught(_raise_group, SHORT_CANARY))

    output = app_stream.getvalue()
    assert_no_canary(output, SHORT_CANARY)
    assert f"ExceptionGroup: {telemetry_safety.MESSAGE_WITHHELD}" in output
    assert f"RuntimeError: {telemetry_safety.MESSAGE_WITHHELD}" in output
    assert f"KeyError: {telemetry_safety.MESSAGE_WITHHELD}" in output


def test_a_declared_safe_code_is_printed(app_stream: io.StringIO) -> None:
    """An exception class that declares a code keeps it in the log, too."""
    _LOGGER.error("boom", exc_info=_DeclaredFailureError(SHORT_CANARY))

    output = app_stream.getvalue()
    assert_no_canary(output, SHORT_CANARY)
    assert "_DeclaredFailureError: journal_save_failed" in output


@pytest.mark.parametrize("canary", SENTINELS, ids=SENTINEL_IDS)
def test_an_exception_interpolated_as_an_argument_is_neutralised(
    app_stream: io.StringIO, canary: str
) -> None:
    """``logger.warning("...: %s", exc)`` prints the type, not the message."""
    _LOGGER.warning("content_manifest_unusable: %s", ValueError(canary))
    _LOGGER.warning("keyed: %(error)s", {"error": KeyError(canary)})
    _LOGGER.error(RuntimeError(canary))

    output = app_stream.getvalue()
    assert_no_canary(output, canary)
    assert f"content_manifest_unusable: ValueError: {telemetry_safety.MESSAGE_WITHHELD}" in output
    assert f"keyed: KeyError: {telemetry_safety.MESSAGE_WITHHELD}" in output
    assert f"RuntimeError: {telemetry_safety.MESSAGE_WITHHELD}" in output


def test_a_traceback_cached_by_another_handler_is_not_reused(app_stream: io.StringIO) -> None:
    """A plain formatter elsewhere caches the full text on the record; it must not leak here.

    ``logging.Formatter.format`` stores ``exc_text`` on the shared record and
    every later handler reuses it. A second handler with the standard
    formatter, attached first, would otherwise decide what the app stream says.
    """
    root = logging.getLogger()
    plain = logging.StreamHandler(io.StringIO())
    root.handlers.insert(0, plain)
    try:
        _LOGGER.error("boom", exc_info=_caught(_raise_from, SHORT_CANARY))
    finally:
        root.removeHandler(plain)

    assert_no_canary(app_stream.getvalue(), SHORT_CANARY)


def test_the_unhandled_exception_line_is_content_free(
    sentinel_app: FastAPI, app_stream: io.StringIO
) -> None:
    """AC11 end to end: ``errors._sanitized_500``'s record, as the host would read it."""
    client = TestClient(sentinel_app, raise_server_exceptions=False)
    client.get(f"/__sentinel__/{SHORT_CANARY}", headers={TRACE_ID_HEADER: _REQUEST_ID})

    output = app_stream.getvalue()
    assert_no_canary(output, SHORT_CANARY)
    assert "unhandled_exception" in output
    assert f"ValueError: {telemetry_safety.MESSAGE_WITHHELD}" in output
    assert f'{_THIS_FILE}", line ' in output


@pytest.fixture
def uvicorn_stream() -> Iterator[io.StringIO]:
    """A handler on the ``uvicorn`` logger, as uvicorn's own dictConfig installs one.

    Starlette's ``ServerErrorMiddleware`` re-raises after answering, and uvicorn
    then logs "Exception in ASGI application" with the traceback on
    ``uvicorn.error``, which propagates only as far as ``uvicorn``'s handler --
    never to the root handler. Restores the loggers afterwards.
    """
    server = logging.getLogger("uvicorn")
    access = logging.getLogger("uvicorn.access")
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    server.addHandler(handler)
    access_disabled = access.disabled
    remove_app_log_handlers_for_tests()
    configure_logging(stream=io.StringIO())
    try:
        yield stream
    finally:
        server.removeHandler(handler)
        access.disabled = access_disabled
        remove_app_log_handlers_for_tests()


def test_uvicorns_own_traceback_is_content_free(
    uvicorn_stream: io.StringIO, capsys: pytest.CaptureFixture[str]
) -> None:
    """The server's "Exception in ASGI application" line keeps types, loses messages."""
    exc = _caught(_raise_from, SHORT_CANARY)

    logging.getLogger("uvicorn.error").error("Exception in ASGI application\n", exc_info=exc)

    output = uvicorn_stream.getvalue()
    assert_no_canary(output, SHORT_CANARY)
    assert "Exception in ASGI application" in output
    assert f"ValueError: {telemetry_safety.MESSAGE_WITHHELD}" in output
    # uvicorn's handlers carry no trace filter; a format needing one would fail
    # into ``handleError``, which prints the raw record to stderr.
    assert "Logging error" not in capsys.readouterr().err


@pytest.mark.parametrize("canary", SENTINELS, ids=SENTINEL_IDS)
def test_an_unformattable_record_prints_a_fixed_line_and_nothing_else(
    app_stream: io.StringIO, capsys: pytest.CaptureFixture[str], canary: str
) -> None:
    """A ``%`` mismatch must not fall through to ``handleError``'s raw-record dump."""
    record = _LOGGER.makeRecord(
        _LOGGER.name, logging.ERROR, __file__, 0, "two placeholders %s %s", (canary,), None
    )
    # Handed to the app's own handlers only: pytest's capture handler would
    # (rightly) raise on the malformed record before the app handler saw it.
    for handler in _app_handlers():
        handler.handle(record)

    output = app_stream.getvalue()
    assert_no_canary(output, canary)
    assert f"<unformattable log record: ERROR {_LOGGER.name}>" in output
    stderr = capsys.readouterr().err
    assert "Logging error" not in stderr
    assert_no_canary(stderr, canary)


def test_uvicorns_access_logger_is_switched_off(uvicorn_stream: io.StringIO) -> None:
    """In code, behind the CMD flag: uvicorn's request line carries the query string."""
    assert uvicorn_stream is not None
    assert logging.getLogger("uvicorn.access").disabled is True


@pytest.mark.parametrize("client_logger", ["httpx", "httpx2"])
def test_outbound_request_urls_stay_out_of_the_info_stream(
    app_stream: io.StringIO, client_logger: str
) -> None:
    """An HTTP client's per-request INFO line carries the URL; it no longer prints."""
    logger = logging.getLogger(client_logger)

    logger.info("HTTP Request: GET https://vault.example/v1/journal-entries/%s", SHORT_CANARY)
    logger.warning("client_failure_still_visible")

    output = app_stream.getvalue()
    assert_no_canary(output, SHORT_CANARY)
    assert "client_failure_still_visible" in output


# ── Query strings: only uvicorn's access line ever carried them ────────────

_NO_ACCESS_LOG_FLAG = "--no-access-log"


def test_the_runtime_cmd_disables_uvicorns_access_log() -> None:
    """AC10: uvicorn's access line is the request line *with* its query string.

    ``?search=`` is a journal search term -- the user's own words -- and the
    app's own ``adepthood.access`` record already covers method, route,
    status and latency without it.
    """
    tokens = runtime_cmd_tokens()

    assert _NO_ACCESS_LOG_FLAG in tokens
    assert "--access-log" not in tokens
    # A log config would replace uvicorn's loggers wholesale, out from under
    # the content-free formatter configure_logging installs on them.
    assert "--log-config" not in runtime_cmd_flag_names()


_TEST_CLIENT_LOGGER = "httpx"


@pytest.mark.asyncio
async def test_a_search_query_string_reaches_no_log(
    async_client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    """AC10, in process: no record the app emits for a search request carries the term.

    The uvicorn leg is the CMD flag and the disabled logger above; this pins
    the app's own records (which name the route template, not the URL).
    """
    with caplog.at_level(logging.DEBUG):
        await async_client.get("/journal/", params={"search": SHORT_CANARY})

    # The test's own HTTP client logs the URL it sent, on the ``httpx`` logger;
    # that line is the caller's, not the server's, so it is set aside here.
    server_records = [r for r in caplog.records if not r.name.startswith(_TEST_CLIENT_LOGGER)]
    assert _access_records(caplog), "the request was logged at all"
    assert_no_canary(_emitted(server_records), SHORT_CANARY)
