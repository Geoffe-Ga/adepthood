"""Shared rate limiter instances for the application."""

from limits import RateLimitItemPerHour
from limits.storage import MemoryStorage
from limits.strategies import MovingWindowRateLimiter
from slowapi import Limiter

from client_ip import client_throttle_key

# Default rate limit applied to all endpoints that don't declare their own.
# Auth endpoints override this with stricter per-route limits (3/min signup,
# 5/min login). The global default protects against scraping and general abuse.
DEFAULT_RATE_LIMIT = "60/minute"

# Rate limiter keyed by the trusted-proxy-resolved *throttle* key rather than a
# forgeable header or a proxy every user shares: one customer, one budget. That
# key groups an IPv6 client onto its delegated prefix, so rotating inside it
# cannot buy fresh buckets, while the audit trail keeps the exact address.
# Shared across routers so all endpoints use a single limiter with consistent
# state; slowapi captures this key function into each per-route limit at
# decoration time, which happens on import, after this line. Building the
# limiter at import time is safe: both the trusted-proxy allowlist and the
# prefix length are read per request.
limiter = Limiter(key_func=client_throttle_key, default_limits=[DEFAULT_RATE_LIMIT])

# Second-layer throttle for signup attempts that fail license verification:
# distinct from the 3/minute signup limit above so a license brute-forcer is
# capped per hour even if they pace themselves under the per-minute limit.
INVALID_LICENSE_MAX_PER_HOUR = 10

_invalid_license_storage = MemoryStorage()
_invalid_license_limiter = MovingWindowRateLimiter(_invalid_license_storage)
_INVALID_LICENSE_ITEM = RateLimitItemPerHour(INVALID_LICENSE_MAX_PER_HOUR)


def record_invalid_license_attempt(throttle_key: str) -> bool:
    """Count one invalid-license signup attempt against ``throttle_key``.

    Takes a throttle key rather than an exact address so an IPv6 subscriber
    cannot refill the cap by presenting a new address from their own delegated
    prefix on every guess.

    Returns True while the client remains under the hourly cap (the attempt
    is recorded against the moving window); returns False once the cap is
    exceeded, at which point the caller should answer 429.
    """
    return _invalid_license_limiter.hit(_INVALID_LICENSE_ITEM, throttle_key)


def reset_invalid_license_attempts() -> None:
    """Clear every invalid-license counter (test isolation between cases)."""
    _invalid_license_storage.reset()
