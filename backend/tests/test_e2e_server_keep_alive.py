"""The e2e server keeps idle connections open longer than a test leaves them idle.

Playwright's request context reuses an idle keep-alive connection. With
uvicorn's 5 s default, a request sent on a connection that had sat idle for
about that long raced the server closing it, and failed as ``socket hang up``
or ``ECONNRESET`` -- a different browser journey each time, on PRs that never
touched it.
"""

from __future__ import annotations

from tests.e2e.server import IDLE_KEEP_ALIVE_SECONDS, _server_config

#: uvicorn's own default, which the browser lane outlived between requests.
_UVICORN_DEFAULT_KEEP_ALIVE_SECONDS = 5

#: Longest quiet stretch a browser journey leaves between two API requests
#: (reloads, navigation and UI waits) with margin to spare.
_LONGEST_JOURNEY_IDLE_SECONDS = 60


def test_idle_connections_outlive_the_longest_quiet_stretch_in_a_journey() -> None:
    """A reused connection is never one the server is about to close."""
    config = _server_config(0)

    assert config.timeout_keep_alive == IDLE_KEEP_ALIVE_SECONDS
    assert config.timeout_keep_alive > _LONGEST_JOURNEY_IDLE_SECONDS
    assert config.timeout_keep_alive > _UVICORN_DEFAULT_KEEP_ALIVE_SECONDS


def test_the_server_still_listens_only_on_loopback() -> None:
    """Raising the keep-alive does not widen where the server can be reached."""
    port = 43_210

    config = _server_config(port)

    assert config.host == "127.0.0.1"
    assert config.port == port
