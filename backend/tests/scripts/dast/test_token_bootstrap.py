"""The token-bootstrap CLI the contract-fuzz job mints its credential with.

The contract-fuzz job's whole value rests on one thing this module has to prove:
the token it hands Schemathesis actually opens the application. A fuzz run whose
credential is broken answers 401 to every request, violates none of the enabled
checks, and reports a clean gate having exercised no handler at all -- the exact
false pass ``backend/scripts/dast/README.md`` treats as louder than a finding.

So the assertions here are the ones a merely-returned-something helper cannot
satisfy: the token has to work on a genuinely authenticated route of the *real*
application, a token that does not work has to exit non-zero, and stdout has to
carry the bare token and nothing else, because CI captures it with ``$(...)``
and a stray line of chatter would be spliced into an ``Authorization`` header.

The real application is driven in-process over ``ASGITransport`` against a
throwaway file-backed SQLite database, which is what lets the ORM insert be
handed a database URL of its own -- the same shape the production run passes.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from httpx import AsyncClient, Response

from scripts.dast import tokens
from scripts.dast.report import EXIT_CLEAN, EXIT_HARNESS_ERROR
from scripts.dast.runner import Identity
from tests.scripts.dast.conftest import (
    REAL_APP_BASE_URL,
    REAL_APP_PROBE_PATH,
    STUB_AUTH_PROBE_PATH,
    STUB_BASE_URL,
    StubDeployment,
    close_client,
    serve_real_app,
    stub_client,
)

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

BLIND_IDENTITY_LABEL = "blind"
LOGIN_PATH = "/auth/login"

# Nothing listens here, which is what makes the connection attempt immediate and
# local: the production path has to build its own client to fail at all.
UNREACHABLE_BASE_URL = "http://127.0.0.1:55498"


def _run(
    *,
    base_url: str,
    database_url: str,
    probe_path: str,
    overrides: tokens.TokenOverrides,
) -> int:
    """Drive the CLI end to end with one set of injected seams.

    ``main`` owns the event loop, so this is deliberately synchronous: an async
    test could not call it without nesting ``asyncio.run`` inside a running loop.

    Args:
        base_url: The target the CLI is told to dial.
        database_url: The identity database the CLI is told to insert into.
        probe_path: The authenticated route the minted token is verified against.
        overrides: The seams to inject.

    Returns:
        The CLI's exit code.
    """
    return tokens.main(
        [
            "--base-url",
            base_url,
            "--database-url",
            database_url,
            "--probe-path",
            probe_path,
        ],
        overrides=overrides,
    )


def _get_with(client: AsyncClient, path: str, token: str) -> Response:
    """Send one bearer-authenticated GET from synchronous test code."""
    return asyncio.run(client.get(path, headers={"Authorization": f"Bearer {token}"}))


def _blind_minter(deployment: StubDeployment) -> tokens.Minter:
    """Build a minter that logs in to a stub which will never honour the token.

    Args:
        deployment: The stub whose pre-registered owner should be logged in.

    Returns:
        A minter the CLI can be handed in place of the ORM insert plus real login.
    """

    async def _mint(client: AsyncClient) -> Identity:
        response = await client.post(
            LOGIN_PATH,
            json={
                "email": deployment.owner.email,
                "password": deployment.owner.password,
            },
        )
        return Identity(
            label=BLIND_IDENTITY_LABEL,
            email=deployment.owner.email,
            token=str(response.json()["token"]),
        )

    return _mint


def test_the_cli_prints_a_token_that_opens_the_real_application(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The one assertion no stub can make: the credential works on this app.

    The row is inserted through the application's own ORM and the token is
    minted over its real ``POST /auth/login``, so a break anywhere in the
    hasher, the login route, or the bearer dependency turns this red.
    """
    with serve_real_app(tmp_path) as target:
        exit_code = _run(
            base_url=REAL_APP_BASE_URL,
            database_url=target.database_url,
            probe_path=REAL_APP_PROBE_PATH,
            overrides=tokens.TokenOverrides(client=target.client),
        )
        captured = capsys.readouterr()
        assert exit_code == EXIT_CLEAN, f"stdout={captured.out!r} stderr={captured.err!r}"

        token = captured.out.strip()
        assert token, "the CLI printed no token"
        probe = _get_with(target.client, REAL_APP_PROBE_PATH, token)

    assert probe.is_success, f"the printed token did not authenticate: {probe.text}"


def test_stdout_carries_the_bare_token_and_nothing_else(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """CI splices stdout straight into an ``Authorization`` header.

    One stray word of progress reporting on stdout would travel into that header
    and turn every fuzzed request into a 401, which no enabled check would fail.
    """
    with serve_real_app(tmp_path) as target:
        exit_code = _run(
            base_url=REAL_APP_BASE_URL,
            database_url=target.database_url,
            probe_path=REAL_APP_PROBE_PATH,
            overrides=tokens.TokenOverrides(client=target.client),
        )

    captured = capsys.readouterr()
    assert exit_code == EXIT_CLEAN, captured.err
    assert captured.out.endswith("\n"), "the token must be a complete line"
    assert captured.out.count("\n") == 1, f"stdout is more than one line: {captured.out!r}"
    assert " " not in captured.out.strip(), f"stdout is not a bare token: {captured.out!r}"


def test_a_token_that_does_not_authenticate_is_a_harness_error(
    blind_deployment: StubDeployment,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The vacuity guard: a minted-but-useless token must never report success.

    The blind stub logs anybody in and then answers 401 to everything, which is
    the exact shape of a fuzz run that exercises no handler while looking green.
    """
    client = stub_client(blind_deployment)
    try:
        exit_code = _run(
            base_url=STUB_BASE_URL,
            database_url=UNLOADABLE_DATABASE_URL,
            probe_path=STUB_AUTH_PROBE_PATH,
            overrides=tokens.TokenOverrides(
                client=client,
                minter=_blind_minter(blind_deployment),
            ),
        )
    finally:
        close_client(client)

    captured = capsys.readouterr()
    assert exit_code == EXIT_HARNESS_ERROR, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert captured.out == "", f"a harness error must not print a token: {captured.out!r}"
    assert STUB_AUTH_PROBE_PATH in captured.err, captured.err


def test_an_unusable_identity_database_is_named_without_its_credential(
    blind_deployment: StubDeployment,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A CI log is pasted into issues, so the DSN travels without its password.

    The minter is left in place here on purpose: this is the production ORM
    insert, driven against a database URL no driver can load.
    """
    client = stub_client(blind_deployment)
    try:
        exit_code = _run(
            base_url=STUB_BASE_URL,
            database_url=UNLOADABLE_DATABASE_URL,
            probe_path=STUB_AUTH_PROBE_PATH,
            overrides=tokens.TokenOverrides(client=client),
        )
    finally:
        close_client(client)

    captured = capsys.readouterr()
    assert exit_code == EXIT_HARNESS_ERROR, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert captured.out == "", f"a harness error must not print a token: {captured.out!r}"
    assert REDACTED_DATABASE_URL in captured.err, captured.err
    assert DSN_USERINFO not in captured.err, "the DSN credential reached the report"


def test_an_unreachable_instance_is_a_harness_error_not_a_crash(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The production path builds its own client; a dead target must still exit 3.

    Nothing is injected here, so this is the wiring CI actually runs. An
    unhandled ``ConnectError`` would leave a traceback and exit 1, which the rest
    of this package reserves for a finding -- a consumer keying off the exit code
    could not tell "the instance is down" from "we found something".
    """
    exit_code = _run(
        base_url=UNREACHABLE_BASE_URL,
        database_url=UNLOADABLE_DATABASE_URL,
        probe_path=REAL_APP_PROBE_PATH,
        overrides=tokens.TokenOverrides(),
    )

    captured = capsys.readouterr()
    assert exit_code == EXIT_HARNESS_ERROR, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert captured.out == "", f"a harness error must not print a token: {captured.out!r}"
