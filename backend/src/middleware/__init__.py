"""ASGI middleware classes registered against the FastAPI app.

The classes live in dedicated modules so :mod:`main` can wire them in the
exact outer-to-inner order the security model requires (BUG-APP-001):

    logging → trace-id → security-headers → CORS → rate-limit

Starlette adds middleware in LIFO order (the last ``add_middleware`` call
becomes the outermost layer), so :mod:`main` registers them bottom-up.  The
explicit imports below let test suites pull individual classes by name
without reaching into nested modules.
"""

from __future__ import annotations

from middleware.logging import RequestLoggingMiddleware
from middleware.security_headers import SecurityHeadersMiddleware
from middleware.trace_id import CorrelationIdMiddleware

__all__ = [
    "CorrelationIdMiddleware",
    "RequestLoggingMiddleware",
    "SecurityHeadersMiddleware",
]
