"""Forwarded-proto middleware -- believe the scheme only from a declared proxy.

``X-Forwarded-Proto`` is the only way an app behind a TLS-terminating ingress
can know it is really being served over https, and getting it wrong is visible:
the router's trailing-slash 307 and every absolute URL the app mints are built
from ``scope["scheme"]``, so an unbelieved header downgrades a browser to
plaintext and a forged one lets any caller declare its own request was
TLS-protected.  This layer resolves the scheme against the same
``TRUSTED_PROXY_CIDRS`` walk :mod:`client_ip` performs for the client address,
so one allowlist and one parser settle both questions.

Five decisions here are the ones a future reader will otherwise re-litigate:

*Pure ASGI, not ``BaseHTTPMiddleware``.*  The whole concern is scope-in,
nothing-out: there is no response to inspect or rewrite.  ``BaseHTTPMiddleware``
would buy nothing for that and would cost something real -- it wraps the inner
app in an anyio task group, and putting one outside ``RequestLoggingMiddleware``
would change how an inner-middleware panic propagates to the access log.

*Outermost.*  Starlette's ``Router`` builds the trailing-slash redirect's
``Location`` from ``scope["scheme"]``, so the scheme has to be settled before
anything routes.  Sitting above every other layer as well is what makes the
answer uniform: no layer in between reads the scheme today, but any that came
to would see the client-facing one rather than the hop the ingress spoke to us
over, which is the reading each of them would want.  Because that second half
has no observable consequence yet, the position is pinned by an explicit
ordering assertion in ``tests/middleware/test_middleware_stack.py`` rather than
by any behaviour a request can show.

*The last field line wins.*  A proxy appends its own line rather than replacing
the caller's, so the last line is the only one it authored -- the same
right-most reading ``client_ip`` applies to the forwarded chain.  A plain
header lookup returns the *first* line, which is precisely the one a caller can
prepend.

*No comma splitting.*  A comma-joined chain is not a scheme, and the caller
controls the left of any chain it can get merged into one field line, so
splitting would hand it authorship of the value.  Refusing the whole line is
uvicorn's own reading and costs a misconfigured deployment its scheme upgrade
while costing an attacker the forgery.  Case folding is the one deliberate
divergence from uvicorn, which only strips: schemes are case-insensitive per
RFC 3986, so this layer accepts ``HTTPS`` where uvicorn rejects it -- a more
permissive reading, and the correct one.

*HTTP scopes only.*  There is deliberately no websocket arm: the backend serves
no websocket routes, so one would be unreachable, untested code.  Every other
scope type is handed on with the mapping untouched.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from starlette.requests import HTTPConnection

from client_ip import peer_is_trusted_proxy

if TYPE_CHECKING:
    from starlette.types import ASGIApp, Receive, Scope, Send

# ASGI scope keys this layer reads, plus the only one whose value it ever
# changes: "scheme".  (Building an HTTPConnection has Starlette's Headers rebind
# scope["headers"] to an equal list, which changes no value.)
_HTTP_SCOPE_TYPE = "http"
_SCOPE_TYPE_KEY = "type"
_SCHEME_SCOPE_KEY = "scheme"

_FORWARDED_PROTO_HEADER = "x-forwarded-proto"

# The schemes a forwarded value may name, matching the set uvicorn's own
# proxy-headers middleware accepts.  Anything outside it -- junk, an absolute
# URL, a comma-joined chain, an empty value -- is not a scheme token and leaves
# the socket scheme standing.  ``ws``/``wss`` are here because uvicorn's set has
# them, not because anything upstream serves websockets: only a vouched proxy
# can put one on an HTTP scope, so it is that proxy's misconfiguration to make
# rather than a caller's to exploit, and narrowing the set would buy nothing.
_ACCEPTED_SCHEMES = frozenset({"http", "https", "ws", "wss"})


def _forwarded_scheme(connection: HTTPConnection) -> str | None:
    """Return the scheme a vouched peer reported, or None when there is none to believe.

    Reads every ``X-Forwarded-Proto`` field line and takes the last, which is
    the proxy-authored one; scheme tokens are case-insensitive, so a shouting
    proxy is still understood.
    """
    lines = connection.headers.getlist(_FORWARDED_PROTO_HEADER)
    if not lines:
        return None
    reported = lines[-1].strip().lower()
    return reported if reported in _ACCEPTED_SCHEMES else None


def _apply_forwarded_scheme(scope: Scope) -> None:
    """Raise ``scope["scheme"]`` to the forwarded one when the peer may say so.

    Fails closed at the first gate: for a peer the allowlist does not name the
    header is never even consulted, so an unvouched caller's value cannot leak
    into any later decision.  ``scope["client"]`` is never touched -- that
    answer belongs to :mod:`client_ip`, at the moment it is asked for.
    """
    connection = HTTPConnection(scope)
    if not peer_is_trusted_proxy(connection):
        return
    scheme = _forwarded_scheme(connection)
    if scheme is not None:
        scope[_SCHEME_SCOPE_KEY] = scheme


class ForwardedProtoMiddleware:
    """Settle the request scheme from ``X-Forwarded-Proto`` before anything routes."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap ``app``, which sees the scope only after the scheme is settled."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Resolve the scheme for HTTP scopes, then delegate to the wrapped app.

        The scope-type guard comes first so lifespan and websocket scopes are
        passed on as the exact object received, untouched and unexamined.
        """
        if scope[_SCOPE_TYPE_KEY] == _HTTP_SCOPE_TYPE:
            _apply_forwarded_scheme(scope)
        await self.app(scope, receive, send)
