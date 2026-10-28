"""The deep-scan evidence gate reads what the app *actually* writes now (#3064).

``scan_evidence`` used to read uvicorn's own access lines. Those carried the raw
request line -- query string included -- so they are switched off in every
deployment, and the gate would then read nothing and fail every nightly run as
"never reached a handler". The gate now reads the app's own content-free access
record, which names the method, the route *template* and the status.

These tests drive the real app through the real ``configure_logging`` handler,
then feed exactly that output to the gate. That way a change to either side --
the record's shape or the parser -- fails here, not in a cron run nobody watches.
They also prove the gate still fails on a real violation: a scan whose every
request to the probe route was answered at the door.
"""

from __future__ import annotations

import io
from collections.abc import Iterator
from http import HTTPStatus
from pathlib import Path

import pytest
from httpx import AsyncClient

from observability import configure_logging, remove_app_log_handlers_for_tests
from scripts.dast.report import EXIT_CLEAN, EXIT_HARNESS_ERROR
from scripts.dast.runner import DEFAULT_AUTH_PROBE_PATH
from scripts.dast.scan_evidence import main, reached_handlers, requests_in
from tests.helpers.telemetry_canaries import SHORT_CANARY, assert_no_canary


@pytest.fixture
def app_log() -> Iterator[io.StringIO]:
    """The deployed root handler, writing into a buffer the gate can read."""
    remove_app_log_handlers_for_tests()
    stream = io.StringIO()
    configure_logging(stream=stream)
    try:
        yield stream
    finally:
        remove_app_log_handlers_for_tests()


async def _bearer(client: AsyncClient) -> dict[str, str]:
    """Sign a scan identity up and return its credential header."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": "dast-evidence@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _gate(tmp_path: Path, log_text: str) -> int:
    """Run the evidence gate exactly as the workflow does, on ``log_text``."""
    log = tmp_path / "uvicorn.log"
    log.write_text(log_text, encoding="utf-8")
    return main(["--log", str(log), "--probe-path", DEFAULT_AUTH_PROBE_PATH])


@pytest.mark.asyncio
async def test_the_gate_passes_on_a_scan_that_reached_authenticated_code(
    async_client: AsyncClient, app_log: io.StringIO, tmp_path: Path
) -> None:
    """One authenticated answer on the probe route, read off the app's own log."""
    headers = await _bearer(async_client)
    await async_client.get(DEFAULT_AUTH_PROBE_PATH)
    reached = await async_client.get(DEFAULT_AUTH_PROBE_PATH, headers=headers)
    assert reached.status_code == HTTPStatus.OK

    output = app_log.getvalue()

    assert ("GET", DEFAULT_AUTH_PROBE_PATH, HTTPStatus.OK) in requests_in(output)
    assert reached_handlers(requests_in(output), DEFAULT_AUTH_PROBE_PATH)
    assert _gate(tmp_path, output) == EXIT_CLEAN


@pytest.mark.asyncio
async def test_the_gate_still_fails_a_scan_answered_at_the_door(
    async_client: AsyncClient, app_log: io.StringIO, tmp_path: Path
) -> None:
    """The violation the gate exists for: every probe-route request denied."""
    await async_client.get(DEFAULT_AUTH_PROBE_PATH)
    await async_client.get("/openapi.json")

    output = app_log.getvalue()

    assert ("GET", DEFAULT_AUTH_PROBE_PATH, HTTPStatus.UNAUTHORIZED) in requests_in(output)
    assert _gate(tmp_path, output) == EXIT_HARNESS_ERROR


@pytest.mark.asyncio
async def test_the_evidence_line_names_the_route_never_what_the_caller_typed(
    async_client: AsyncClient, app_log: io.StringIO
) -> None:
    """The record the gate reads is the same one production writes: templates only."""
    await async_client.get(f"/practices/share/{SHORT_CANARY}", params={"search": SHORT_CANARY})

    output = app_log.getvalue()

    assert_no_canary(output, SHORT_CANARY)
    assert ("GET", "/practices/share/{token}", HTTPStatus.UNAUTHORIZED) in requests_in(output)
