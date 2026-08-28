"""Behavioural tests for the Sentry error-monitoring seam.

Two properties are under test, and both need a *proven* noisy side and a
*proven* quiet side or they prove nothing:

* **It reports.** With a DSN configured, an unhandled exception reaches the
  transport as a real Sentry event carrying the exception type, the request
  tags, the environment, and the release.
* **It reports nothing private.** No journal body, no transcription text, and
  no credential survives into that event.

The quiet side is asserted end to end, by driving a real FastAPI app through
the real global exception handler into a real ``sentry_sdk`` client built by
the *production* :func:`sentry.init_error_monitoring`, with only the transport
swapped for a list. The noisy side is asserted against
:func:`sentry.scrub_event` directly, fed the event a *default-configured* SDK
would have produced — request body captured, frame locals captured — so the
scrubber is proven to fire on exactly the payload the default configuration
would have shipped.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from typing import cast
from unittest.mock import patch

import pytest
import sentry_sdk
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sentry_sdk.envelope import Envelope
from sentry_sdk.transport import Transport
from sentry_sdk.types import Breadcrumb
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import sentry as error_monitoring
from conftest import test_engine
from errors import ERROR_KEY, INTERNAL_ERROR, install_exception_handlers
from main import app, lifespan
from middleware import CorrelationIdMiddleware
from observability import TRACE_ID_HEADER

# The event as the vendor would receive it: a dict of JSON-safe values.
# Written as a plain assignment, not PEP 695 ``type`` syntax: the backend's
# compatibility matrix still builds on Python 3.11, which cannot parse it.
CapturedEvent = dict[str, object]

# A syntactically valid DSN pointing at a host no test ever reaches: the
# transport is replaced with a list, so nothing leaves the process.
TEST_DSN = "https://0123456789abcdef@o0.ingest.sentry.io/1"

# Sentinels stand in for the three content classes the acceptance bar names.
# They are defined here, far from any ``raise``, because Sentry's stack frames
# carry ``pre_context``/``post_context`` source lines — a sentinel written as a
# literal beside a raise would show up as *source code* and fail the assertions
# for a reason that has nothing to do with the scrubber.
JOURNAL_SENTINEL = "sat with the grief about my father and did not look away"
TRANSCRIPTION_SENTINEL = "and then she said the thing I have never written down"
CREDENTIAL_SENTINEL = "creek-vault-live-2f9c41d7b6e84a15"  # pragma: allowlist secret
SMTP_PASSWORD_SENTINEL = (
    "SG.7Qb2mVfN4tRwXcYd.h3LpZ0AeGiJoNqUvW9BdFhKmPrTxZ2"  # pragma: allowlist secret
)

BOOM_PATH = "/__boom__"


class CapturingTransport(Transport):
    """A real ``Transport`` that keeps envelopes instead of sending them.

    Subclassing the vendor's own transport (rather than passing a function)
    means the assertions run against the event *after* the client has
    serialised it into an envelope — the same bytes a live deployment would
    put on the wire.
    """

    def __init__(self) -> None:
        """Start with an empty capture log."""
        super().__init__()
        self.events: list[CapturedEvent] = []

    def capture_envelope(self, envelope: Envelope) -> None:
        """Record the envelope's event item."""
        event = envelope.get_event()
        if event is not None:
            self.events.append(dict(event))


@pytest.fixture
def monitored_app() -> FastAPI:
    """A minimal app wired exactly like production: correlation id + handlers."""
    app = FastAPI()
    app.add_middleware(CorrelationIdMiddleware)
    install_exception_handlers(app)

    @app.post(BOOM_PATH)
    async def boom(payload: dict[str, str]) -> None:
        # The private text lands in a local variable — the classic vector for a
        # monitoring SDK that captures frame locals by default.
        entry_text = payload["text"]
        # Keep the local alive across the raise so it reaches the stack frame.
        assert entry_text
        raise RuntimeError("journal_save_failed")

    return app


@pytest.fixture
def captured_events(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[CapturedEvent]]:
    """Initialise a real Sentry client on the production options, capturing locally.

    Only the transport differs from a deployed client: the client is built by
    the production :func:`sentry.init_error_monitoring`, so everything the
    acceptance bar cares about — ``before_send``, breadcrumb policy, local
    variable policy, request-body policy — is the production configuration, and
    a regression in any of it fails these tests.
    """
    monkeypatch.setenv("ENV", "staging")
    monkeypatch.setenv(error_monitoring.SENTRY_DSN_ENV_VAR, TEST_DSN)
    monkeypatch.setenv(error_monitoring.SENTRY_RELEASE_ENV_VAR, "test-release-abc123")
    transport = CapturingTransport()
    assert error_monitoring.init_error_monitoring(transport=transport) is True
    try:
        yield transport.events
    finally:
        # Leave the process with an inert client so no later test can ship an
        # event into this list (or anywhere else).
        sentry_sdk.init(dsn=None)


def _post_boom(app: FastAPI, text: str) -> None:
    client = TestClient(app, raise_server_exceptions=False)
    response = client.post(
        BOOM_PATH, json={"text": text}, headers={TRACE_ID_HEADER: "monitor-trace-1"}
    )
    assert response.status_code == 500
    assert response.json()[ERROR_KEY] == INTERNAL_ERROR


def _mapping(node: object, key: str) -> dict[str, object]:
    """Read ``node[key]`` as a mapping, failing the test if it is not one."""
    assert isinstance(node, dict)
    value = node[key]
    assert isinstance(value, dict)
    return value


def _sequence(node: object, key: str) -> list[object]:
    """Read ``node[key]`` as a list, failing the test if it is not one."""
    assert isinstance(node, dict)
    value = node[key]
    assert isinstance(value, list)
    return value


def _text(node: object, key: str) -> str:
    """Read ``node[key]`` as a string, failing the test if it is not one."""
    assert isinstance(node, dict)
    value = node[key]
    assert isinstance(value, str)
    return value


def _reported_exception(event: CapturedEvent) -> dict[str, object]:
    """Return the innermost exception entry of a captured event."""
    entry = _sequence(_mapping(event, "exception"), "values")[-1]
    assert isinstance(entry, dict)
    return entry


def _reported_frames(event: CapturedEvent) -> list[object]:
    """Return the stack frames of a captured event's innermost exception."""
    return _sequence(_mapping(_reported_exception(event), "stacktrace"), "frames")


def _reported_breadcrumbs(event: CapturedEvent) -> list[object]:
    """Return an event's breadcrumbs under either serialised shape."""
    crumbs = event.get("breadcrumbs")
    if isinstance(crumbs, dict):
        return _sequence(crumbs, "values")
    return crumbs if isinstance(crumbs, list) else []


def test_unhandled_exception_is_reported_when_dsn_is_configured(
    monitored_app: FastAPI, captured_events: list[CapturedEvent]
) -> None:
    """The noisy side: a configured DSN turns a 500 into exactly one event."""
    _post_boom(monitored_app, JOURNAL_SENTINEL)

    assert len(captured_events) == 1
    event = captured_events[0]
    assert _text(_reported_exception(event), "type") == "RuntimeError"
    assert _text(_mapping(event, "tags"), "request_id") == "monitor-trace-1"
    assert _mapping(event, "contexts")[error_monitoring.REQUEST_CONTEXT_KEY] == {
        "request_id": "monitor-trace-1",
        "request_path": BOOM_PATH,
        "request_method": "POST",
    }


def test_reported_event_tags_environment_and_release(
    monitored_app: FastAPI, captured_events: list[CapturedEvent]
) -> None:
    """Production must be distinguishable from staging in the operator inbox."""
    _post_boom(monitored_app, JOURNAL_SENTINEL)

    event = captured_events[0]
    assert event["environment"] == "staging"
    assert event["release"] == "test-release-abc123"


@pytest.mark.parametrize(
    "secret",
    [JOURNAL_SENTINEL, TRANSCRIPTION_SENTINEL, CREDENTIAL_SENTINEL],
    ids=["journal", "transcription", "credential"],
)
def test_reported_event_carries_no_request_content(
    monitored_app: FastAPI, captured_events: list[CapturedEvent], secret: str
) -> None:
    """The quiet side, end to end: nothing the caller sent reaches the vendor."""
    _post_boom(monitored_app, secret)

    payload = json.dumps(captured_events[0], default=str)
    assert secret not in payload


def test_reported_event_has_no_request_section_and_no_frame_locals(
    monitored_app: FastAPI, captured_events: list[CapturedEvent]
) -> None:
    """Name the two structures the default configuration would have populated."""
    _post_boom(monitored_app, JOURNAL_SENTINEL)

    event = captured_events[0]
    assert "request" not in event
    assert "extra" not in event
    frames = _reported_frames(event)
    assert frames, "expected a stacktrace so the report is still actionable"
    assert all(isinstance(frame, dict) and "vars" not in frame for frame in frames)


def test_vendor_default_options_would_have_captured_the_journal_body(
    monitored_app: FastAPI,
) -> None:
    """Prove the assertions above are not vacuous.

    Same app, same exception, same transport — but the vendor's own defaults
    for local-variable capture instead of ours, and no ``before_send``. The
    journal body appears. That is the leak the configuration under test closes,
    and without this test "the sentinel is absent" could just mean the sentinel
    never had a route into the payload in the first place.
    """
    transport = CapturingTransport()
    sentry_sdk.init(
        dsn=TEST_DSN,
        transport=transport,
        # Off only so this test cannot depend on ambient instrumentation; the
        # capture channel under demonstration (``include_local_variables``)
        # keeps its vendor default of ``True``.
        default_integrations=False,
        auto_enabling_integrations=False,
    )
    try:
        _post_boom(monitored_app, JOURNAL_SENTINEL)
    finally:
        sentry_sdk.init(dsn=None)

    assert JOURNAL_SENTINEL in json.dumps(transport.events[0], default=str)


def test_reported_event_carries_no_breadcrumbs(
    monitored_app: FastAPI, captured_events: list[CapturedEvent]
) -> None:
    """Breadcrumbs are the other default channel for user content."""
    _post_boom(monitored_app, JOURNAL_SENTINEL)

    assert not _reported_breadcrumbs(captured_events[0])


def test_drop_breadcrumb_refuses_a_crumb_carrying_journal_text() -> None:
    """``before_breadcrumb`` returning ``None`` is what drops the crumb.

    The hook may return the crumb to keep it, so "returns None" is a real
    decision about this crumb, not a property of the signature.
    """
    crumb = cast("Breadcrumb", {"category": "console", "message": JOURNAL_SENTINEL})

    assert error_monitoring.drop_breadcrumb(crumb, {}) is None


def _default_configured_event() -> CapturedEvent:
    """Build the event a *default-configured* SDK would have produced.

    Request body captured, frame locals captured, a breadcrumb carrying the
    transcription, and a bearer credential in the headers — every channel the
    issue names, populated. This is the input that must make the scrubber
    noisy; :func:`test_scrub_event_leaves_a_clean_event_untouched` supplies the
    input that must leave it silent.
    """
    return {
        "level": "error",
        "request": {
            "url": "https://api.example.test/journal/entries",
            "data": {"body": JOURNAL_SENTINEL},
            "headers": {"Authorization": f"Bearer {CREDENTIAL_SENTINEL}"},
        },
        "extra": {"payload": TRANSCRIPTION_SENTINEL},
        "breadcrumbs": {"values": [{"message": TRANSCRIPTION_SENTINEL}]},
        "exception": {
            "values": [
                {
                    "type": "RuntimeError",
                    "value": "journal_save_failed",
                    "stacktrace": {
                        "frames": [
                            {
                                "function": "create_entry",
                                "lineno": 42,
                                "vars": {"entry_text": JOURNAL_SENTINEL},
                            }
                        ]
                    },
                }
            ]
        },
    }


@pytest.mark.parametrize(
    "secret",
    [JOURNAL_SENTINEL, TRANSCRIPTION_SENTINEL, CREDENTIAL_SENTINEL],
    ids=["journal", "transcription", "credential"],
)
def test_scrub_event_removes_every_default_capture_channel(secret: str) -> None:
    """The proven noisy side: the scrubber fires on the default payload."""
    scrubbed = error_monitoring.scrub_event(_default_configured_event(), {})

    assert secret not in json.dumps(scrubbed, default=str)
    # The report is still worth receiving: type and frame survive.
    assert _text(_reported_exception(scrubbed), "type") == "RuntimeError"
    assert _text(_reported_frames(scrubbed)[0], "function") == "create_entry"


def test_scrub_event_leaves_a_clean_event_untouched() -> None:
    """The proven quiet side: a report with nothing private is passed through."""
    clean: CapturedEvent = {
        "level": "error",
        "environment": "production",
        "release": "abc123",
        "contexts": {
            error_monitoring.REQUEST_CONTEXT_KEY: {
                "request_id": "trace-1",
                "request_path": "/journal/entries",
                "request_method": "POST",
            }
        },
        "exception": {
            "values": [
                {
                    "type": "IntegrityError",
                    "value": "duplicate key value violates unique constraint",
                    "stacktrace": {"frames": [{"function": "create_entry", "lineno": 42}]},
                }
            ]
        },
    }
    expected = json.loads(json.dumps(clean))

    assert error_monitoring.scrub_event(clean, {}) == expected


@pytest.mark.parametrize(
    ("env_var", "sentinel"),
    [
        ("CREEK_VAULT_API_KEY", CREDENTIAL_SENTINEL),
        ("SMTP_PASSWORD", SMTP_PASSWORD_SENTINEL),
    ],
    ids=["vault_api_key", "smtp_password"],
)
def test_scrub_event_redacts_a_configured_credential_value(
    monkeypatch: pytest.MonkeyPatch, env_var: str, sentinel: str
) -> None:
    """A credential that reached a message by its *value* is redacted too.

    Pattern matching alone cannot recognise an opaque vault key or a relay
    password, so the scrubber also redacts the literal values of the
    deployment's own secret environment variables. Every name on that list is
    a separate promise, so each one is exercised here.
    """
    monkeypatch.setenv(env_var, sentinel)
    event: CapturedEvent = {
        "exception": {
            "values": [{"type": "RuntimeError", "value": f"upstream refused the call: {sentinel}"}]
        }
    }

    scrubbed = error_monitoring.scrub_event(event, {})

    message = _text(_reported_exception(scrubbed), "value")
    assert sentinel not in message
    assert error_monitoring.REDACTED in message
    # The non-secret part of the message survives, or the report is useless.
    assert "upstream refused the call" in message


def test_scrub_event_ignores_a_blank_secret_environment_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unset or too-short secret must not turn the scrubber into a shredder."""
    monkeypatch.setenv("CREEK_VAULT_API_KEY", "")
    monkeypatch.setenv("SECRET_KEY", "x")
    event: CapturedEvent = {
        "exception": {"values": [{"type": "RuntimeError", "value": "x marks the spot"}]}
    }

    scrubbed = error_monitoring.scrub_event(event, {})

    assert _text(_reported_exception(scrubbed), "value") == "x marks the spot"


def test_scrub_event_truncates_an_over_long_exception_message() -> None:
    """A message that interpolated something bounded, not shipped whole.

    Exception messages are the one field configuration cannot close: they are
    authored at the raise site. The house rule is that they stay static and
    capability-named; the cap bounds what a message that broke that rule can
    carry.
    """
    overlong = "x" * (error_monitoring.MAX_EXCEPTION_MESSAGE_CHARS + 500)
    event: CapturedEvent = {"exception": {"values": [{"type": "ValueError", "value": overlong}]}}

    message = _text(_reported_exception(error_monitoring.scrub_event(event, {})), "value")

    assert message.endswith(error_monitoring.TRUNCATION_MARKER)
    assert len(message) < len(overlong)


def test_scrub_event_leaves_a_short_exception_message_whole() -> None:
    """The quiet side of the cap: a normal message is not mangled."""
    event: CapturedEvent = {
        "exception": {"values": [{"type": "ValueError", "value": "journal_save_failed"}]}
    }

    message = _text(_reported_exception(error_monitoring.scrub_event(event, {})), "value")

    assert message == "journal_save_failed"


def test_init_without_dsn_disables_monitoring_with_one_line(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """No DSN is a supported way to run: one startup line, nothing else."""
    monkeypatch.delenv(error_monitoring.SENTRY_DSN_ENV_VAR, raising=False)

    with caplog.at_level(logging.DEBUG, logger="sentry"):
        assert error_monitoring.init_error_monitoring() is False

    assert len(caplog.records) == 1
    assert caplog.records[0].levelno == logging.INFO
    assert "error_monitoring_disabled" in caplog.records[0].getMessage()


def test_init_with_unusable_dsn_warns_once_and_keeps_running(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A typo in the DSN degrades the deployment, it does not fail it."""
    monkeypatch.setenv(error_monitoring.SENTRY_DSN_ENV_VAR, "not-a-dsn")

    with caplog.at_level(logging.DEBUG, logger="sentry"):
        assert error_monitoring.init_error_monitoring() is False

    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.levelno == logging.WARNING
    message = record.getMessage()
    assert error_monitoring.SENTRY_DSN_ENV_VAR in message
    # The DSN embeds a public key; name the variable, never echo the value.
    assert "not-a-dsn" not in message


def test_init_with_dsn_enables_monitoring_with_one_line(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The configured path is equally quiet: one line naming env and release."""
    monkeypatch.setenv(error_monitoring.SENTRY_DSN_ENV_VAR, TEST_DSN)
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv(error_monitoring.SENTRY_RELEASE_ENV_VAR, "rel-9")

    try:
        with caplog.at_level(logging.DEBUG, logger="sentry"):
            assert error_monitoring.init_error_monitoring(transport=CapturingTransport()) is True
    finally:
        sentry_sdk.init(dsn=None)

    assert len(caplog.records) == 1
    message = caplog.records[0].getMessage()
    assert "error_monitoring_enabled" in message
    assert "production" in message
    assert "rel-9" in message
    assert TEST_DSN not in message


# Each entry is a client option that, on its own, keeps a private channel shut.
# Named individually because they overlap: with both the option set below and
# ``scrub_event`` in place, removing either one alone still leaves the other
# holding the door, so an end-to-end "the sentinel is absent" assertion cannot
# tell which lock is doing the work — and cannot notice when one is dropped.
PRIVACY_CRITICAL_OPTIONS = [
    # Frame locals are where the entry body sits at the moment of the raise.
    ("include_local_variables", False),
    # The request body is the entry itself.
    ("max_request_body_size", "never"),
    # PII means the caller's address, cookies, and user identifiers.
    ("send_default_pii", False),
    # A rolling buffer of whatever ran before the failure.
    ("max_breadcrumbs", 0),
    # A stack on a message the SDK invented, from a frame nobody reviewed.
    ("attach_stacktrace", False),
    # Traces carry route parameters, which for this app are entry identifiers.
    ("traces_sample_rate", 0.0),
    # Automatic instrumentation observes requests and log records wholesale.
    ("default_integrations", False),
    ("auto_enabling_integrations", False),
]


@pytest.mark.parametrize(
    ("option", "expected"), PRIVACY_CRITICAL_OPTIONS, ids=[o for o, _ in PRIVACY_CRITICAL_OPTIONS]
)
def test_init_pins_every_privacy_critical_option(
    monkeypatch: pytest.MonkeyPatch, option: str, expected: object
) -> None:
    """Pin the options one by one, so dropping any single one fails a test.

    The end-to-end assertions are deliberately redundant with these — two locks
    on each door is the design. The cost of that redundancy is that no
    end-to-end test can fail when exactly one lock is removed, which is the
    edit most likely to happen ("the scrubber handles it anyway"). This test
    buys the redundancy back: each option is now load-bearing on its own.
    """
    monkeypatch.setenv(error_monitoring.SENTRY_DSN_ENV_VAR, TEST_DSN)
    try:
        assert error_monitoring.init_error_monitoring(transport=CapturingTransport()) is True
        # The SDK types its options as a closed TypedDict, which cannot be
        # indexed by a computed key; the parametrisation needs exactly that.
        options = cast("dict[str, object]", sentry_sdk.get_client().options)
        assert options[option] == expected
    finally:
        sentry_sdk.init(dsn=None)


@pytest.mark.asyncio
async def test_boot_initialises_and_drains_error_monitoring(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Drive the real lifespan: a seam nobody wired in reports nothing.

    The startup half is asserted behaviourally, through the log line an
    unconfigured deployment emits. The shutdown half has no observable effect
    with an in-process transport, so it is asserted as the wiring it is.
    """
    monkeypatch.setenv("SKIP_STARTUP_SEED", "1")
    monkeypatch.delenv(error_monitoring.SENTRY_DSN_ENV_VAR, raising=False)
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    caplog.set_level(logging.INFO, logger="sentry")

    with (
        patch("main.async_session_factory", new=factory),
        patch("main.shutdown_error_monitoring") as drain,
    ):
        async with lifespan(app):
            assert any(
                "error_monitoring_disabled" in record.getMessage() for record in caplog.records
            ), "boot must announce that monitoring is off"
            drain.assert_not_called()

    drain.assert_called_once_with()


def test_capture_failure_never_breaks_the_request(
    monitored_app: FastAPI, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A monitoring outage must cost the caller nothing but a log line."""

    def explode(_exc: BaseException) -> str:
        raise RuntimeError("sentry transport is down")

    monkeypatch.setattr(sentry_sdk, "capture_exception", explode)

    with caplog.at_level(logging.WARNING, logger="sentry"):
        _post_boom(monitored_app, JOURNAL_SENTINEL)

    assert any("error_monitoring_capture_failed" in r.getMessage() for r in caplog.records)


def test_unreported_exception_is_still_logged_when_monitoring_is_off(
    monitored_app: FastAPI, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Degrading must never mean swallowing: the traceback still hits the log."""
    monkeypatch.delenv(error_monitoring.SENTRY_DSN_ENV_VAR, raising=False)
    sentry_sdk.init(dsn=None)

    with caplog.at_level(logging.ERROR, logger="errors"):
        _post_boom(monitored_app, JOURNAL_SENTINEL)

    record = next(r for r in caplog.records if r.message == "unhandled_exception")
    assert record.exc_info is not None
