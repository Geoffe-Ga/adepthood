"""Canonical-host middleware -- settle the authority before anything routes.

The companion to :mod:`middleware.forwarded_proto`, and deliberately the same
shape.  That layer settles ``scope["scheme"]`` from operator config so a caller
cannot author the scheme half of every absolute URL the app mints; this one
settles the ``Host`` header so a caller cannot author the authority half.  The
rule for what may be believed lives in :mod:`request_host`; this module is only
the point in the request path where it is applied.

Four decisions here are the ones a future reader will otherwise re-litigate:

*Above the router, below forwarded-proto.*  Starlette's ``Router`` builds the
trailing-slash 307's ``Location`` from ``URL(scope=scope)``, which reads the
``Host`` header directly out of the scope, so the header has to be settled
before anything routes -- there is no per-route fix, because every router in the
tree uses the default ``redirect_slashes=True`` and the redirect is minted
before any dependency runs.  It sits immediately *inside*
:class:`~middleware.forwarded_proto.ForwardedProtoMiddleware` rather than above
it because that layer's own position is a stated invariant with a test pinning
it, and nothing here needs to be outside it: both settle scope on the way in,
neither reads the other's value, so their relative order has no observable
consequence and the existing claim is left standing rather than rewritten.

*Pure ASGI, not ``BaseHTTPMiddleware``.*  Scope in, nothing out: there is no
response to inspect or rewrite, so the anyio task group ``BaseHTTPMiddleware``
would wrap the inner app in buys nothing and changes how an inner panic reaches
the access log.

*The header list is replaced, not mutated.*  The list in the scope belongs to
the server, and some servers reuse their buffers across requests; rebinding
``scope["headers"]`` to a new list leaves the server's own object alone.  Every
``Host`` line is dropped and exactly one is appended, so a request that arrived
carrying two cannot leave carrying either.

*The original authority is preserved, not destroyed.*  Silently rewriting the
one field that says where a caller thought it was talking to would delete the
only evidence that anyone probed for this.  The inbound value is recorded on the
scope for :class:`~middleware.logging.RequestLoggingMiddleware` to attach to the
access record it already emits, so an operator gets one field on the anomalous
requests and no new line on any of the ordinary ones.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from request_host import ORIGINAL_HOST_SCOPE_KEY, settled_host

if TYPE_CHECKING:
    from collections.abc import Iterable

    from starlette.types import ASGIApp, Receive, Scope, Send

_HTTP_SCOPE_TYPE = "http"
_SCOPE_TYPE_KEY = "type"
_HEADERS_SCOPE_KEY = "headers"

_HOST_HEADER = b"host"

# ASGI carries header values as opaque bytes, and RFC 9110 restricts field
# values to this encoding, so it round-trips whatever a client actually sent
# without a decode error on the way in or an encode error on the way out.
_HEADER_ENCODING = "latin-1"


def _inbound_host(headers: Iterable[tuple[bytes, bytes]]) -> str:
    """Return the single authority the request names, or "" when it names none.

    Two ``Host`` lines name no single authority, so they are read as naming
    none.  Whichever line a downstream reader happened to pick would be a coin
    flip an attacker tossed, and the settle below replaces both with one value
    nobody chose.  A request with no ``Host`` line at all reaches the same
    answer by the same reasoning.
    """
    values = [value for name, value in headers if name.lower() == _HOST_HEADER]
    if len(values) != 1:
        return ""
    return values[0].decode(_HEADER_ENCODING)


def _headers_naming(headers: Iterable[tuple[bytes, bytes]], host: str) -> list[tuple[bytes, bytes]]:
    """Return a new header list carrying exactly one ``Host`` line: ``host``."""
    kept = [(name, value) for name, value in headers if name.lower() != _HOST_HEADER]
    kept.append((_HOST_HEADER, host.encode(_HEADER_ENCODING)))
    return kept


def _apply_canonical_host(scope: Scope) -> None:
    """Replace the request's authority with the canonical one when it needs settling.

    Leaves the scope untouched -- no rebound header list, no scope key -- when
    the allowlist names nobody or the request already names an allowlisted
    authority, so the overwhelmingly common request pays nothing and carries no
    evidence of a decision that was never made.
    """
    headers = scope[_HEADERS_SCOPE_KEY]
    inbound = _inbound_host(headers)
    canonical = settled_host(inbound)
    if canonical is None:
        return
    scope[_HEADERS_SCOPE_KEY] = _headers_naming(headers, canonical)
    scope[ORIGINAL_HOST_SCOPE_KEY] = inbound


class CanonicalHostMiddleware:
    """Settle the request authority from ``ALLOWED_HOSTS`` before anything routes."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap ``app``, which sees the scope only after the authority is settled."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Settle the authority for HTTP scopes, then delegate to the wrapped app.

        The scope-type guard comes first so lifespan and websocket scopes are
        passed on as the exact object received, untouched and unexamined.
        """
        if scope[_SCOPE_TYPE_KEY] == _HTTP_SCOPE_TYPE:
            _apply_canonical_host(scope)
        await self.app(scope, receive, send)
