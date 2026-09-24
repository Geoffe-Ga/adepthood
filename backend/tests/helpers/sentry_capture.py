"""A real Sentry client whose transport is a list, for tests that read events back.

Shared by every suite that asserts on what error monitoring would have shipped:
the event is captured *after* the SDK has serialised it into an envelope, so the
assertions see the same bytes a deployment would put on the wire, and the client
is built by the production :func:`sentry.init_error_monitoring`, so its
``before_send``, breadcrumb, frame-local and request-body policies are the real
ones.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import TYPE_CHECKING

import sentry_sdk
from sentry_sdk.transport import Transport

import sentry as error_monitoring

if TYPE_CHECKING:
    from collections.abc import Iterator

    import pytest
    from sentry_sdk.envelope import Envelope

# The event as the vendor would receive it: a dict of JSON-safe values.
# Written as a plain assignment, not PEP 695 ``type`` syntax: the backend's
# compatibility matrix still builds on Python 3.11, which cannot parse it.
CapturedEvent = dict[str, object]

# A syntactically valid DSN pointing at a host no test ever reaches: the
# transport is replaced with a list, so nothing leaves the process.
TEST_DSN = "https://0123456789abcdef@o0.ingest.sentry.io/1"

TEST_ENVIRONMENT = "staging"
TEST_RELEASE = "test-release-abc123"


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


@contextmanager
def capturing_sentry(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[CapturedEvent]]:
    """Initialise the production Sentry client, capturing locally, then disarm it.

    Leaves the process with an inert client on exit so no later test can ship
    an event into this list (or anywhere else).
    """
    monkeypatch.setenv("ENV", TEST_ENVIRONMENT)
    monkeypatch.setenv(error_monitoring.SENTRY_DSN_ENV_VAR, TEST_DSN)
    monkeypatch.setenv(error_monitoring.SENTRY_RELEASE_ENV_VAR, TEST_RELEASE)
    transport = CapturingTransport()
    assert error_monitoring.init_error_monitoring(transport=transport) is True
    try:
        yield transport.events
    finally:
        sentry_sdk.init(dsn=None)
