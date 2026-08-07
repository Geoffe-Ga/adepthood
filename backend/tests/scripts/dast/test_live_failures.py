"""An instance that never answered must not be reported as an authorization finding.

Python exits ``1`` on an uncaught exception, and ``1`` is bit-for-bit
``EXIT_AUTHZ_FINDING``. So a bootstrap whose database refuses it, or an
``/openapi.json`` fetch that cannot connect, would tell a CI consumer "we found a
BOLA" when what actually happened is "the harness never authenticated at all" --
the exact ambiguity this harness exists to eliminate.

Every live-I/O boundary is therefore driven into failure here and asserted to
produce ``EXIT_HARNESS_ERROR`` with a line naming the stage, the target, and the
error: the identity bootstrap, the discovery fetch, and a document that arrives
but is not one. The precedence assertion at the bottom is the point of the
exercise -- a failed bootstrap reports no findings and no uncovered routes, and
must still outrank both of them.
"""

from __future__ import annotations

from collections.abc import Callable
from http import HTTPStatus

import pytest
from httpx import ASGITransport, AsyncBaseTransport, AsyncClient, ConnectError, Request, Response

from scripts.dast.report import EXIT_AUTHZ_FINDING, EXIT_CLEAN, EXIT_HARNESS_ERROR
from scripts.dast.runner import Identity, run_matrix
from tests.scripts.dast.conftest import (
    STUB_BASE_URL,
    STUB_OBJECT_SCOPED_ROUTES,
    StubDeployment,
    close_client,
    drive_main,
    drive_main_with,
    stub_client,
    stub_config,
    stub_overrides,
)

LIVE_GUARD = "require_live_stages_completed"

REFUSED_CONNECTION = "All connection attempts failed"
DATABASE_HOST = "127.0.0.1"
DATABASE_PORT = 55499

OPENAPI_PATH = "/openapi.json"

# A driver this deployment does not have: ``create_async_engine`` rejects the URL
# before any socket is opened, which makes the identity database unusable without
# the test needing one to be up in the first place.
UNLOADABLE_DRIVER = "nosuchdb+nodriver"
# Stands in for the deployment credential a real DSN carries. Both URLs below are
# composed rather than written out, so neither line is a literal userinfo string.
DSN_USERINFO = "opaque-userinfo-value"
REDACTION = "***"
UNLOADABLE_DATABASE_URL = f"{UNLOADABLE_DRIVER}://dast:{DSN_USERINFO}@127.0.0.1:5432/aptitude"
REDACTED_DATABASE_URL = f"{UNLOADABLE_DRIVER}://dast:{REDACTION}@127.0.0.1:5432/aptitude"

UNPARSEABLE_DATABASE_URL = "this is not a database url"
UNPARSEABLE_MARKER = "<unparseable database URL>"


async def refusing_bootstrap(_client: AsyncClient) -> tuple[Identity, Identity]:
    """Fail the way the bootstrap fails when the identity database is down.

    Raises:
        ConnectionRefusedError: Always -- this is what the driver raises through
            the ORM when nothing is listening on the database's port.
    """
    raise ConnectionRefusedError(f"Connect call failed ('{DATABASE_HOST}', {DATABASE_PORT})")


class InterceptingTransport(AsyncBaseTransport):
    """Delegate to a stub app, except for one path handled by a callback.

    The harness talks to its target through exactly one client, so making a
    single path unreachable -- while login and the probe route keep working --
    is the only way to drive one live stage into failure without first breaking
    the stages that run before it.
    """

    def __init__(
        self,
        inner: AsyncBaseTransport,
        path: str,
        respond: Callable[[Request], Response],
    ) -> None:
        """Wrap ``inner``, routing requests for ``path`` to ``respond`` instead."""
        self._inner = inner
        self._path = path
        self._respond = respond

    async def handle_async_request(self, request: Request) -> Response:
        """Answer one request: from the callback for ``path``, from the app otherwise."""
        if request.url.path == self._path:
            return self._respond(request)
        return await self._inner.handle_async_request(request)


def refuse(request: Request) -> Response:
    """Fail a request the way an unreachable instance does.

    Raises:
        ConnectError: Always.
    """
    raise ConnectError(REFUSED_CONNECTION, request=request)


def serve_a_list(_request: Request) -> Response:
    """Answer with valid JSON that is not an OpenAPI document."""
    return Response(HTTPStatus.OK, json=[])


def client_with_broken_discovery(
    deployment: StubDeployment,
    respond: Callable[[Request], Response],
) -> AsyncClient:
    """Return a client onto ``deployment`` whose ``/openapi.json`` is broken."""
    transport = InterceptingTransport(
        ASGITransport(app=deployment.app),
        OPENAPI_PATH,
        respond,
    )
    return AsyncClient(transport=transport, base_url=STUB_BASE_URL)


def drive_production_bootstrap(
    deployment: StubDeployment,
    *,
    database_url: str,
) -> int:
    """Run the CLI with its own identity bootstrap against a broken database URL."""
    client = stub_client(deployment)
    try:
        return drive_main_with(
            stub_overrides(client, bootstrap=None),
            min_routes=STUB_OBJECT_SCOPED_ROUTES,
            database_url=database_url,
        )
    finally:
        close_client(client)


def test_a_bootstrap_that_cannot_reach_its_database_exits_three_not_one(
    leaky_deployment: StubDeployment,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Exit 1 here would read as a genuine BOLA in the CI log."""
    exit_code = drive_main(
        leaky_deployment,
        min_routes=STUB_OBJECT_SCOPED_ROUTES,
        bootstrap=refusing_bootstrap,
    )

    captured = capsys.readouterr()
    assert exit_code == EXIT_HARNESS_ERROR, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert exit_code != EXIT_AUTHZ_FINDING
    assert captured.out == "", f"a harness error must not report on stdout: {captured.out!r}"
    assert f"HARNESS ERROR  {LIVE_GUARD}" in captured.err, captured.err
    assert "the identity bootstrap" in captured.err, captured.err
    assert str(DATABASE_PORT) in captured.err, captured.err


def test_an_openapi_fetch_that_cannot_connect_exits_three_not_one(
    leaky_deployment: StubDeployment,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Discovery is live I/O too, and it fails before a single cell has run."""
    exit_code = drive_main(
        leaky_deployment,
        min_routes=STUB_OBJECT_SCOPED_ROUTES,
        client=client_with_broken_discovery(leaky_deployment, refuse),
    )

    captured = capsys.readouterr()
    assert exit_code == EXIT_HARNESS_ERROR, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert exit_code != EXIT_AUTHZ_FINDING
    assert f"HARNESS ERROR  {LIVE_GUARD}" in captured.err, captured.err
    assert OPENAPI_PATH in captured.err, captured.err
    assert REFUSED_CONNECTION in captured.err, captured.err


def test_a_document_that_is_not_a_document_is_a_harness_error_not_a_crash(
    leaky_deployment: StubDeployment,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A proxy answering 200 with something else must not take the run down."""
    exit_code = drive_main(
        leaky_deployment,
        min_routes=STUB_OBJECT_SCOPED_ROUTES,
        client=client_with_broken_discovery(leaky_deployment, serve_a_list),
    )

    captured = capsys.readouterr()
    assert exit_code == EXIT_HARNESS_ERROR, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert exit_code != EXIT_AUTHZ_FINDING
    assert "HARNESS ERROR  require_minimum_coverage" in captured.err, captured.err


def test_an_unusable_identity_database_is_named_without_its_credential(
    leaky_deployment: StubDeployment,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The production bootstrap names the DSN it could not use, credential removed.

    A report is pasted into issues and CI logs, so the URL has to be actionable
    and the credential in it must not survive the trip.
    """
    exit_code = drive_production_bootstrap(
        leaky_deployment,
        database_url=UNLOADABLE_DATABASE_URL,
    )

    captured = capsys.readouterr()
    assert exit_code == EXIT_HARNESS_ERROR, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert "the identity bootstrap" in captured.err, captured.err
    assert REDACTED_DATABASE_URL in captured.err, captured.err
    assert DSN_USERINFO not in captured.err, "the DSN credential reached the report"


def test_an_unparseable_database_url_is_still_a_harness_error(
    leaky_deployment: StubDeployment,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A DSN that cannot even be parsed must not be echoed back verbatim either."""
    exit_code = drive_production_bootstrap(
        leaky_deployment,
        database_url=UNPARSEABLE_DATABASE_URL,
    )

    captured = capsys.readouterr()
    assert exit_code == EXIT_HARNESS_ERROR, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert UNPARSEABLE_MARKER in captured.err, captured.err
    assert UNPARSEABLE_DATABASE_URL not in captured.err, captured.err


@pytest.mark.asyncio
async def test_a_failed_bootstrap_outranks_a_clean_run_with_no_findings(
    leaky_client: AsyncClient,
) -> None:
    """Precedence, at the one point where "nothing was found" would be a lie.

    The run produced no findings and no uncovered routes precisely because it
    never probed anything, so the guard has to be what decides the exit code.
    """
    report = await run_matrix(
        leaky_client,
        bootstrap=refusing_bootstrap,
        config=stub_config(),
    )

    assert report.findings == ()
    assert report.uncovered == ()
    assert [failure.guard for failure in report.guard_failures] == [LIVE_GUARD]
    assert report.exit_code == EXIT_HARNESS_ERROR
    assert report.exit_code not in {EXIT_CLEAN, EXIT_AUTHZ_FINDING}
