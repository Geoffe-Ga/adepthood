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

import json
from typing import ClassVar, NoReturn

import pytest
import sentry_sdk
from fastapi import FastAPI
from fastapi.testclient import TestClient

import sentry as error_monitoring
import telemetry_safety
from errors import install_exception_handlers
from middleware import CorrelationIdMiddleware
from observability import TRACE_ID_HEADER
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
    exc = ValueError(SHORT_CANARY)
    event = _event_carrying(SHORT_CANARY)

    scrubbed = error_monitoring.scrub_event(event, {"exc_info": (ValueError, exc, None)})

    assert scrubbed == {
        "level": "error",
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


_RAISERS = {
    "raise_from": _raise_from,
    "implicit_context": _raise_in_handler,
    "exception_group": _raise_group,
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
    assert len(entries) >= 2, "every chain link is still reported, by type"
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
