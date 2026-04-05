"""Shared rate limiter instance for the application."""

from slowapi import Limiter
from slowapi.util import get_remote_address

# Rate limiter keyed by client IP address. Shared across routers so all
# endpoints use a single limiter with consistent state.
limiter = Limiter(key_func=get_remote_address)
