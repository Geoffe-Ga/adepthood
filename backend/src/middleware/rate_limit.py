"""The ambient rate-limit floor: one limit, charged before anything resolves.

Closes #2909. What was here before was ``slowapi.middleware.SlowAPIMiddleware``,
which applies a limiter's ``default_limits`` to any route that declares none of
its own. It does that by resolving the request to a handler -- walking
``app.routes`` for a route whose ``.endpoint`` matches -- and under FastAPI
0.141 ``app.routes`` holds ``_IncludedRouter`` wrappers that expose no
``.endpoint`` at all. Every route mounted through ``include_router`` therefore
resolved to ``None``, and slowapi treats a handler-less request as *exempt*: the
mechanism failed open for 141 of the 144 mounted routes. The suite stayed green
throughout, because its one test of the default limit drove ``/health``, an
app-level route that still resolved.

The 27 routes carrying ``@limiter.limit`` had no floor either, and that is the
larger half of the hole. The decorator wraps the *endpoint*, so it runs after
routing, body parsing and dependency resolution: an unauthenticated flood at a
login route answers 401 without charging anything, and a malformed-body flood
answers 422 the same way. Enforcement that lives at or below the endpoint cannot
see the traffic that never reaches one, which is also why an app-level
``dependencies=[Depends(...)]`` was measured and rejected as the seam: it does
not run for ``/openapi.json``, for ``/docs``, or for a 404.

So this layer resolves nothing. The invariant, and the entire point of the fix:

    **this layer must never consult route identity.**

No ``app.routes``, no ``scope["route"]`` (``add_middleware`` wraps the router,
so no user middleware ever sees one populated), no ``.endpoint``, no
``_route_limits``, no ``_IncludedRouter``. It reads a client key and a request
path and charges a bucket. ``backend/tests/middleware/test_ambient_rate_limit.py``
mounts it on a Starlette application with zero routes and requires it to refuse
anyway, which is that invariant made executable.

Position in the stack is load-bearing and unchanged from what it replaced:
innermost, so a 429 still passes back out through CORS and the security headers,
and below ``UnhandledExceptionMiddleware``, so a panic here still becomes a 500
envelope a browser can read. ``BaseHTTPMiddleware`` for the same reason slowapi
used it -- and the refusal is *built and returned*, never raised: an exception
raised in a user middleware is served by Starlette's ``ServerErrorMiddleware``,
above every layer here, and would reach the client as a 500.

The limit itself is the application's ambient default, except for the handful
of paths whose legitimate interaction is burstier than it -- those declare their
own floor in ``rate_limit._PATH_BURST_FLOORS``, which may only ever widen. It
has to be declared there rather than as a ``@limiter.limit`` on the route,
because this layer is charged before routing: a declared route limit can only
tighten what the floor already allowed.

Three residuals, recorded here rather than left to be rediscovered:

* The bucket is keyed on the raw path, so enumerating a ``{param}`` route buys a
  fresh 60/minute per id (measured: 70 requests across ``/journal/id-0..69``
  draw no 429). Keying on the route *template* would fix it and is exactly the
  route identity this layer must not consult, so the answer is a coarse
  per-client ceiling sized against real traffic -- deliberately not in the same
  change as this one, because moving bucket granularity and enforcement reach
  together makes a regression in either indistinguishable.
* ``MemoryStorage`` is per process, so the effective budget multiplies by
  replica count. Pre-existing and unchanged by this layer; the fix is shared
  storage, which needs its own answer for what happens when the store is
  unreachable.
* CORS preflight is answered by ``CORSMiddleware`` above this layer and stays
  unthrottled (measured: 70 preflights never arrive here, before or after).
  Moving this layer above CORS would strip the CORS headers off every 429, so
  preflight needs a control of its own rather than a reordering.

Version pins this was measured against (``backend/requirements.txt``): fastapi
0.141.1, starlette 1.6.0, slowapi 0.1.10. Nothing below depends on any of the
three -- it needs a request and a clock. What does depend on them is the claim
that slowapi's middleware cannot do this job, so a later upgrade may well make
that middleware work again. That would not be a reason to hand this invariant
back to it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from starlette.middleware.base import BaseHTTPMiddleware

from client_ip import client_throttle_key
from rate_limit import charge_ambient_limit, rate_limit_exceeded_response, rate_limiting_enabled

if TYPE_CHECKING:
    from starlette.middleware.base import RequestResponseEndpoint
    from starlette.requests import Request
    from starlette.responses import Response


class AmbientRateLimitMiddleware(BaseHTTPMiddleware):
    """Charge every request against the ambient floor, whatever it is for."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        """Refuse the request when its client has spent this path's budget.

        Args:
            request: The inbound request, read only for its client key and its
                raw path. Deliberately not for anything that would name a route.
            call_next: The rest of the stack.

        Returns:
            The downstream response, or the shared 429 envelope.
        """
        if not rate_limiting_enabled():
            return await call_next(request)
        retry_after = charge_ambient_limit(client_throttle_key(request), request.url.path)
        if retry_after is not None:
            return rate_limit_exceeded_response(retry_after)
        return await call_next(request)
