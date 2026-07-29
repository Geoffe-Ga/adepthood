"""Shared rate limiter instances for the application."""

from limits import RateLimitItemPerHour
from limits.storage import MemoryStorage
from limits.strategies import MovingWindowRateLimiter
from slowapi import Limiter

from client_ip import resolve_client_ip

# Default rate limit applied to all endpoints that don't declare their own.
# Auth endpoints override this with stricter per-route limits (3/min signup,
# 5/min login). The global default protects against scraping and general abuse.
DEFAULT_RATE_LIMIT = "60/minute"

# Rate limiter keyed by the trusted-proxy-resolved client address, so it agrees
# with the invalid-license throttle and the audit trail instead of keying on a
# forgeable header or on a proxy every user shares. Shared across routers so all
# endpoints use a single limiter with consistent state. Building the limiter at
# import time is safe: the trusted-proxy config is read per request.
limiter = Limiter(key_func=resolve_client_ip, default_limits=[DEFAULT_RATE_LIMIT])

# Second-layer throttle for signup attempts that fail license verification:
# distinct from the 3/minute signup limit above so a license brute-forcer is
# capped per hour even if they pace themselves under the per-minute limit.
INVALID_LICENSE_MAX_PER_HOUR = 10

_invalid_license_storage = MemoryStorage()
_invalid_license_limiter = MovingWindowRateLimiter(_invalid_license_storage)
_INVALID_LICENSE_ITEM = RateLimitItemPerHour(INVALID_LICENSE_MAX_PER_HOUR)


def record_invalid_license_attempt(client_ip: str) -> bool:
    """Count one invalid-license signup attempt for ``client_ip``.

    Returns True while the client remains under the hourly cap (the attempt
    is recorded against the moving window); returns False once the cap is
    exceeded, at which point the caller should answer 429.
    """
    return _invalid_license_limiter.hit(_INVALID_LICENSE_ITEM, client_ip)


def reset_invalid_license_attempts() -> None:
    """Clear every invalid-license counter (test isolation between cases)."""
    _invalid_license_storage.reset()
