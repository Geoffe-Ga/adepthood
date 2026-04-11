"""Shared rate limiter instance for the application."""

from slowapi import Limiter
from slowapi.util import get_remote_address

# Default rate limit applied to all endpoints that don't declare their own.
# Auth endpoints override this with stricter per-route limits (3/min signup,
# 5/min login). The global default protects against scraping and general abuse.
DEFAULT_RATE_LIMIT = "60/minute"

# Rate limiter keyed by client IP address. Shared across routers so all
# endpoints use a single limiter with consistent state.
limiter = Limiter(key_func=get_remote_address, default_limits=[DEFAULT_RATE_LIMIT])
