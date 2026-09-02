"""ASGI middleware classes registered against the FastAPI app.

The classes live in dedicated modules so :mod:`main` can wire them in the
exact outer-to-inner order the security model requires (BUG-APP-001):

    forwarded-proto → canonical-host → logging → trace-id →
    security-headers → CORS → unhandled-exception → rate-limit

Starlette adds middleware in LIFO order (the last ``add_middleware`` call
becomes the outermost layer), so :mod:`main` registers them bottom-up.  The
explicit imports below let test suites pull individual classes by name
without reaching into nested modules.
"""

from __future__ import annotations

from middleware.canonical_host import CanonicalHostMiddleware
from middleware.forwarded_proto import ForwardedProtoMiddleware
from middleware.logging import RequestLoggingMiddleware
from middleware.security_headers import SecurityHeadersMiddleware
from middleware.unhandled_exception import UnhandledExceptionMiddleware

# ``CorrelationIdMiddleware`` lives in :mod:`observability` next to the
# contextvar and log filter it depends on (issue #272 dropped the
# logic-free ``middleware/trace_id.py`` re-export module; this package
# import is the single composition point :mod:`main` and tests use).
from observability import CorrelationIdMiddleware

__all__ = [
    "CanonicalHostMiddleware",
    "CorrelationIdMiddleware",
    "ForwardedProtoMiddleware",
    "RequestLoggingMiddleware",
    "SecurityHeadersMiddleware",
    "UnhandledExceptionMiddleware",
]
