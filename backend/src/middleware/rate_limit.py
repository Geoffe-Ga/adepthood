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

Every request is charged against two budgets in one call: its path's floor,
and its client's overall ceiling (``rate_limit.ClientCeiling``, #2913), which
is keyed on the client alone and so consults no route identity either.

Residuals, recorded here rather than left to be rediscovered:

* Closed by #2913. The path bucket is keyed on the raw path, so enumerating a
  ``{param}`` route bought a fresh 60/minute per id. The 512-path fan-out
  ceiling already refused one-shot enumeration from the 573rd distinct path,
  but repeat hits across fewer ids than that were admitted up to some 30,780 a
  minute. Keying on the route *template* is the route identity this layer must
  not consult, so the answer is the per-client ceiling: ``CLIENT_CEILING_LIMIT``
  (600/minute), sized from the worst legitimate fan-out in the code because no
  production percentiles were available.
* Open. All limiter state -- this floor's ``MemoryStorage``, the ceiling and
  slowapi's declared route limits alike -- is per worker process, so the
  effective per-deployment budget is ``WEB_CONCURRENCY`` x each limit
  (``DEPLOYMENT.md``). The fix is a shared store, and it is not built here:
  whoever adds one must make an asserted decision for an unreachable store --
  fail closed, or fall back to this in-memory state -- and must never fail
  open, which would loosen every limit exactly when the store is down.
* Open, split out of #2913. CORS preflight is answered by ``CORSMiddleware``
  above this layer and stays unthrottled (measured: 70 preflights never arrive
  here, before or after). Moving this layer above CORS would strip the CORS
  headers off every 429, so preflight needs a control of its own -- a new layer
  inserted above CORS -- rather than a reordering.

Version pins this was measured against (``backend/requirements-lock.txt``,
where starlette's adopted version lives): fastapi 0.141.1, starlette 1.7.0,
slowapi 0.1.10. First measured on starlette 1.6.0 and re-measured on 1.7.0
(#2923) by ``test_slowapi_middleware_still_cannot_see_included_router_routes``
in ``tests/middleware/test_ambient_rate_limit.py``, which re-takes the
measurement on every run. Nothing below depends on any of the three -- it needs
a request and a clock. What does depend on them is the claim that slowapi's
middleware cannot do this job, so a later upgrade may well make that middleware
work again, and that test is where it would show. That would not be a reason to
hand this invariant back to it.
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
    """Charge every request against its path floor and its client's ceiling, whatever it is for."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        """Refuse the request when its client has spent this path's budget or its ceiling.

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
