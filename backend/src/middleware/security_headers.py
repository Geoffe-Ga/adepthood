"""Security-header middleware applied to every response.

BUG-APP-002: when CORS sat outside this middleware, its preflight short-
circuit returned a 200 without ever invoking the inner stack — so
``OPTIONS`` responses lacked CSP / HSTS / Referrer-Policy.  Reordering in
:mod:`main` puts CORS *inside* this middleware, which means even
preflight responses are wrapped with the security headers below before
they leave the server.
"""

from __future__ import annotations

import os

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

# Content-Security-Policy is conservative: only same-origin scripts/styles,
# block plugins, and disallow framing.  The frontend is a React Native app
# that talks JSON; if a future web build needs richer CSP it should be
# expanded here rather than loosened ad-hoc per route.
_CSP_DIRECTIVES = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self'; "
    "img-src 'self' data:; "
    "connect-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'none'"
)

_PERMISSIONS_POLICY = "geolocation=(), microphone=(), camera=()"

# Environments in which HSTS is meaningful — set in production / staging
# only so local HTTP development still works.
_HSTS_ENVIRONMENTS = {"production", "staging"}

# 1 year HSTS lifetime per OWASP recommendation (in seconds).
_HSTS_MAX_AGE_SECONDS = 31_536_000


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security headers to every response.

    - ``X-Content-Type-Options: nosniff`` — prevents MIME-type sniffing
    - ``X-Frame-Options: DENY`` — prevents clickjacking via iframes
    - ``Strict-Transport-Security`` — enforces HTTPS in production / staging
    - ``Content-Security-Policy`` — restricts loadable assets (BUG-INFRA-001)
    - ``Referrer-Policy: strict-origin-when-cross-origin`` (BUG-INFRA-002)
    - ``Permissions-Policy`` — deny camera/mic/geo by default (BUG-INFRA-003)
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = _CSP_DIRECTIVES
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = _PERMISSIONS_POLICY

        # ENV is read on every request rather than cached at import so
        # tests can ``monkeypatch.setenv("ENV", "production")`` and see
        # the HSTS header without a worker restart.  The cost is one
        # ``os.environ`` lookup per response — well below the noise of
        # the surrounding work, and worth it for the test ergonomics.
        if os.getenv("ENV", "development") in _HSTS_ENVIRONMENTS:
            response.headers["Strict-Transport-Security"] = (
                f"max-age={_HSTS_MAX_AGE_SECONDS}; includeSubDomains"
            )
        return response
