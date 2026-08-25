"""A 500 must reach a cross-origin browser *as* a 500, with its CORS headers.

The failure this pins is invisible to every ordinary error path.  Starlette
hands a handler registered against the base ``Exception`` to
``ServerErrorMiddleware``, which it installs *above every user middleware* —
so the sanitised 500 envelope is written straight to the transport without
travelling back down through :class:`~fastapi.middleware.cors.CORSMiddleware`.
The response carries no ``Access-Control-Allow-Origin``, the browser refuses
to expose it to JavaScript, ``fetch`` rejects with a bare ``TypeError``, and
the web app — with nothing else to go on — reports "You appear to be offline"
while the server is running and answering.  Handled 4xx are unaffected, since
those are built by ``ExceptionMiddleware`` *inside* the user stack.

Everything below drives the real production ``main.app``, because the position
of a layer in that app's stack is the entire subject.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.types import Message, Receive, Scope, Send

from database import get_session
from errors import DECRYPTION_FAILURE, ERROR_KEY, INTERNAL_ERROR, REQUEST_ID_KEY
from main import app as main_app
from middleware import UnhandledExceptionMiddleware
from observability import TRACE_ID_HEADER
from services.journal_encryption import JournalEncryptionError

# An allow-listed development origin (``main.DEV_ORIGINS``).  Using a real
# entry matters: the assertion is that an *allowed* origin gets its header
# back, not that CORS was widened.
ALLOWED_ORIGIN = "http://localhost:3000"

# Reproduces the incident verbatim: a pending migration left the ORM selecting
# a column the database does not have, and asyncpg's UndefinedColumnError
# surfaced as a SQLAlchemy ProgrammingError with the SQL text attached.  The
# statement doubles as the leak probe — none of it may reach the client.
FAILING_SQL = "SELECT journalentry.corpus_attempted_at FROM journalentry"
UNDEFINED_COLUMN = "column journalentry.corpus_attempted_at does not exist"

# ``/health/ready`` is the smallest real route that depends on ``get_session``
# and no authentication, so overriding that one dependency reproduces "the ORM
# blew up mid-request" without a token dance obscuring what is being tested.
PROBE_PATH = "/health/ready"

# Message for the direct-drive ASGI cases at the bottom of the file.
MID_STREAM_FAILURE = "mid-stream-failure"

# Message for the handler-backed 500, whose own body must stay sanitised too.
DECRYPT_FAILED = "journal ciphertext could not be read"


@pytest.fixture
def failing_session() -> Iterator[None]:
    """Point ``get_session`` at a dependency that raises the incident's error.

    Overriding the dependency (rather than bolting a synthetic route onto the
    shared app) keeps the route table of ``main.app`` untouched, so nothing
    leaks into the tests that run after this one.
    """

    async def _raise_undefined_column() -> AsyncGenerator[AsyncSession, None]:
        raise ProgrammingError(FAILING_SQL, {}, Exception(UNDEFINED_COLUMN))
        yield  # pragma: no cover — unreachable; declares the generator shape

    main_app.dependency_overrides[get_session] = _raise_undefined_column
    try:
        yield
    finally:
        main_app.dependency_overrides.pop(get_session, None)


@pytest.fixture
def cors_client() -> Iterator[TestClient]:
    """Client that returns the app's 500 rather than re-raising into the test.

    ``raise_server_exceptions=False`` is what a browser sees: the transport
    delivers whatever bytes the app produced.
    """
    with TestClient(main_app, raise_server_exceptions=False) as client:
        yield client


@pytest.mark.usefixtures("failing_session")
def test_unhandled_500_carries_cors_headers(cors_client: TestClient) -> None:
    """The regression itself: a 500 must echo the allowed origin.

    Without the header the browser discards the response before JavaScript
    can see its status, which is the whole distance between "the server is
    broken" and "you appear to be offline".
    """
    response = cors_client.get(PROBE_PATH, headers={"Origin": ALLOWED_ORIGIN})

    assert response.status_code == 500
    assert response.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN


@pytest.mark.usefixtures("failing_session")
def test_unhandled_500_keeps_the_sanitised_envelope(cors_client: TestClient) -> None:
    """Reaching the browser must not cost the body its sanitisation."""
    response = cors_client.get(PROBE_PATH, headers={"Origin": ALLOWED_ORIGIN})

    body = response.json()
    assert body[ERROR_KEY] == INTERNAL_ERROR
    assert body[REQUEST_ID_KEY]
    assert set(body) == {ERROR_KEY, REQUEST_ID_KEY}
    assert "corpus_attempted_at" not in response.text
    assert "ProgrammingError" not in response.text
    assert "SELECT" not in response.text


@pytest.mark.usefixtures("failing_session")
def test_unhandled_500_traverses_the_whole_stack(cors_client: TestClient) -> None:
    """Security headers and the trace id prove the 500 came back down the stack.

    ``X-Request-ID`` is the value a user can be asked to quote, and CORS only
    lets a cross-origin reader see it because it is in ``expose_headers`` —
    both halves have to survive the error path, not just the happy one.
    """
    inbound = "cors-500-trace-1"
    response = cors_client.get(
        PROBE_PATH,
        headers={"Origin": ALLOWED_ORIGIN, TRACE_ID_HEADER: inbound},
    )

    assert response.status_code == 500
    assert response.headers[TRACE_ID_HEADER] == inbound
    assert response.json()[REQUEST_ID_KEY] == inbound
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    exposed = response.headers.get("access-control-expose-headers", "")
    assert TRACE_ID_HEADER.lower() in exposed.lower()


def test_handler_backed_500_also_carries_cors_headers(cors_client: TestClient) -> None:
    """The other 500 in the codebase — a journal decrypt failure — must match.

    ``JournalEncryptionError`` has its own registered handler, so it is answered
    by ``ExceptionMiddleware`` from inside the user stack and was never subject
    to the bug.  Asserting it here says so out loud: the fix did not have to
    move this one, and a later change that promoted it to the catch-all would
    have to keep this passing.
    """

    async def _raise_encryption_error() -> AsyncGenerator[AsyncSession, None]:
        raise JournalEncryptionError(DECRYPT_FAILED)
        yield  # pragma: no cover — unreachable; declares the generator shape

    main_app.dependency_overrides[get_session] = _raise_encryption_error
    try:
        response = cors_client.get(PROBE_PATH, headers={"Origin": ALLOWED_ORIGIN})
    finally:
        main_app.dependency_overrides.pop(get_session, None)

    assert response.status_code == 500
    assert response.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN
    assert response.json()[ERROR_KEY] == DECRYPTION_FAILURE


def test_disallowed_origin_still_gets_no_cors_header(cors_client: TestClient) -> None:
    """The allow-list is unchanged: an unlisted origin is refused on 500 too.

    Guards the obvious wrong fix — reflecting whatever ``Origin`` arrived, or
    widening the list to ``*`` — which would make the assertion above pass for
    the wrong reason.
    """
    main_app.dependency_overrides[get_session] = _never_yields
    try:
        response = cors_client.get(
            PROBE_PATH,
            headers={"Origin": "https://evil.example"},
        )
    finally:
        main_app.dependency_overrides.pop(get_session, None)

    assert response.status_code == 500
    assert "access-control-allow-origin" not in response.headers


async def _never_yields() -> AsyncGenerator[AsyncSession, None]:
    """Session dependency that always raises, for the disallowed-origin case."""
    raise ProgrammingError(FAILING_SQL, {}, Exception(UNDEFINED_COLUMN))
    yield  # pragma: no cover — unreachable; declares the generator shape


async def _empty_receive() -> Message:
    """Minimal ASGI ``receive`` for the direct-drive cases below."""
    return {"type": "http.request", "body": b"", "more_body": False}


@pytest.mark.asyncio
async def test_exception_after_response_started_is_re_raised() -> None:
    """Once the status line is out, the only honest move is to fail the connection.

    A second ``http.response.start`` is not legal ASGI, so the layer must not
    try to answer with a 500 over bytes the client has already begun reading.
    """
    sent: list[Message] = []

    async def _send(message: Message) -> None:
        sent.append(message)

    async def _fail_mid_stream(scope: Scope, receive: Receive, send: Send) -> None:
        del scope, receive
        await send({"type": "http.response.start", "status": 200, "headers": []})
        raise RuntimeError(MID_STREAM_FAILURE)

    middleware = UnhandledExceptionMiddleware(_fail_mid_stream)
    with pytest.raises(RuntimeError, match=MID_STREAM_FAILURE):
        await middleware({"type": "http"}, _empty_receive, _send)

    assert [message["type"] for message in sent] == ["http.response.start"]


@pytest.mark.asyncio
async def test_non_http_scopes_pass_straight_through() -> None:
    """A lifespan failure must keep propagating — boot has to fail loudly.

    Answering it with a JSON 500 would be meaningless (nothing reads a body off
    a lifespan scope) and would turn a refusal to start into a silent,
    half-booted process.
    """
    seen: list[str] = []

    async def _lifespan_app(scope: Scope, receive: Receive, send: Send) -> None:
        del receive, send
        seen.append(str(scope["type"]))
        raise RuntimeError(MID_STREAM_FAILURE)

    async def _unused_send(message: Message) -> None:
        raise AssertionError(message)

    middleware = UnhandledExceptionMiddleware(_lifespan_app)
    with pytest.raises(RuntimeError, match=MID_STREAM_FAILURE):
        await middleware({"type": "lifespan"}, _empty_receive, _unused_send)

    assert seen == ["lifespan"]
