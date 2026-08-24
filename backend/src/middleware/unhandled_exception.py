"""Turn an unhandled exception into a 500 *inside* the stack, so CORS can see it.

Starlette pops a handler registered against the base ``Exception`` out of the
handler map and hands it to ``ServerErrorMiddleware``, which it installs above
every user middleware.  A response built there is written straight to the
transport: it never travels back down through
:class:`~fastapi.middleware.cors.CORSMiddleware`, so it carries no
``Access-Control-Allow-Origin``.  A browser then refuses to expose it to
JavaScript, ``fetch`` rejects with a bare ``TypeError``, and a web client — with
no status to read — cannot tell a broken server from a broken network.  That is
the whole distance between "something went wrong on our end" and the app
telling a user to go check their wifi while the server is up and answering.

Handled errors never had the problem: an ``HTTPException`` (and any exception
with its own registered handler, such as ``JournalEncryptionError``) is turned
into a response by ``ExceptionMiddleware`` *inside* the user stack, and so
passes back out through CORS like any other.  That asymmetry is exactly what
makes the gap hard to notice — every ordinary error path looks fine.

This layer closes it by catching what escapes ``ExceptionMiddleware`` and
answering from a slot below CORS.  Three decisions are worth pinning:

*Pure ASGI, not ``BaseHTTPMiddleware``.*  ``BaseHTTPMiddleware`` re-raises an
inner exception only after it has finished streaming a body, which is the
opposite of the ordering this layer needs, and it runs the inner app in an
anyio task group whose cancellation semantics would be one more thing standing
between an exception and its 500.

*Directly inside CORS, outside rate limiting.*  Being below CORS is the point.
Being above ``SlowAPIMiddleware`` means a panic in the rate limiter is covered
too — and costs nothing, because slowapi answers its own ``RateLimitExceeded``
with a 429 response rather than raising it upward, so a rate-limited request
never reaches the ``except`` below.

*No re-raise.*  ``ServerErrorMiddleware`` re-raises so the ASGI server can log
what it swallowed; here the exception is already logged with its traceback and
reported to Sentry by :func:`errors.unhandled_exception_response`, so re-raising
would duplicate the report and, worse, hand a second party a response to send
after this one has gone out.  The one case that *must* re-raise is an exception
raised after the response has already started: those bytes are committed, no
second ``http.response.start`` is legal, and the connection has to fail.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from starlette.requests import Request

from errors import unhandled_exception_response

if TYPE_CHECKING:
    from starlette.types import ASGIApp, Message, Receive, Scope, Send

_HTTP_SCOPE_TYPE = "http"
_SCOPE_TYPE_KEY = "type"
_RESPONSE_START = "http.response.start"


class UnhandledExceptionMiddleware:
    """Answer an escaped exception with the sanitised 500 envelope, in-stack."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap ``app``; every exception it lets escape becomes a 500 response."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Delegate to the wrapped app, converting an escaped exception to a 500.

        Lifespan and websocket scopes are passed straight through: there is no
        HTTP response to build for them, and a lifespan failure has to keep
        propagating so boot fails loudly rather than being answered with JSON.
        """
        if scope[_SCOPE_TYPE_KEY] != _HTTP_SCOPE_TYPE:
            await self.app(scope, receive, send)
            return
        await self._call_http(scope, receive, send)

    async def _call_http(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Run the wrapped app for an HTTP scope, guarding the response start.

        ``started`` is tracked by wrapping ``send`` rather than inferred later:
        by the time an exception arrives there is no other way to know whether
        the status line has already gone out.
        """
        started = False

        async def _tracking_send(message: Message) -> None:
            nonlocal started
            if message[_SCOPE_TYPE_KEY] == _RESPONSE_START:
                started = True
            await send(message)

        try:
            await self.app(scope, receive, _tracking_send)
        except Exception as exc:
            if started:
                raise
            response = unhandled_exception_response(Request(scope, receive), exc)
            await response(scope, receive, send)
