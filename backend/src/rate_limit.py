"""Shared rate limiter instances for the application."""

import os
import time
from collections.abc import Callable

from limits import RateLimitItemPerHour, parse
from limits.storage import MemoryStorage
from limits.strategies import MovingWindowRateLimiter
from slowapi import Limiter

from client_ip import client_throttle_key

# Default rate limit applied to all endpoints that don't declare their own.
# Auth endpoints override this with stricter per-route limits (3/min signup,
# 5/min login). The global default protects against scraping and general abuse.
FALLBACK_RATE_LIMIT = "60/minute"

# Set only by the DAST contract-fuzz job, which sends thousands of requests from
# one loopback address and would otherwise spend its whole budget collecting
# 429s -- a uniform denial the fuzzer's response checks cannot distinguish from
# a healthy API. This is NOT a production default; no deployment sets it, and
# ``FALLBACK_RATE_LIMIT`` above is what every deployment gets.
DEFAULT_RATE_LIMIT_ENV_VAR = "DEFAULT_RATE_LIMIT"


def resolve_default_rate_limit(raw: str | None) -> str:
    """Decide the global default limit from an optionally-overridden environment.

    Args:
        raw: The override variable's value, or ``None`` when it is unset.

    Returns:
        The limit string to apply to every endpoint that declares no limit of
        its own. A missing or blank value yields the production default.

    Raises:
        ValueError: When a value was supplied that ``limits`` cannot parse. Fail
            closed: falling back on a typo would hand an unlimited default to a
            deployment whose operator believed they had tightened one, and the
            mistake would only be visible under the load it stopped shaping.
    """
    if raw is None or not raw.strip():
        return FALLBACK_RATE_LIMIT
    candidate = raw.strip()
    try:
        parse(candidate)
    except ValueError as error:
        message = f"{DEFAULT_RATE_LIMIT_ENV_VAR}={candidate!r} is not a rate limit: {error}"
        raise ValueError(message) from error
    return candidate


DEFAULT_RATE_LIMIT = resolve_default_rate_limit(os.getenv(DEFAULT_RATE_LIMIT_ENV_VAR))

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

# How many tracked keys it takes before the throttle first scans for keys to
# evict. A deployment quiet enough to stay under this floor never scans at all,
# and the floor is also where the mark resets once the store empties out.
_SWEEP_MIN_TRACKED = 64

# The next scan is scheduled at this multiple of the population that survived
# the last one, which amortises sweeping: a store holding many genuinely active
# clients does not pay a full scan on every recorded attempt. Must stay strictly
# greater than one -- at one, a store of live keys would rescan on every attempt.
_SWEEP_GROWTH_FACTOR = 2


class _InvalidLicenseThrottle:
    """Hourly invalid-license counter over a self-bounding in-memory store.

    The backing ``MemoryStorage`` empties an expired key's event list but never
    drops the key itself, so a long-lived process would keep one dict entry per
    throttle key it had ever seen. This wrapper remembers when each key was last
    charged and periodically evicts the keys whose window has fully rolled off,
    bounding the store by the peak concurrent population instead of letting it
    grow without limit as total traffic accumulates. The mark only ratchets up
    on a completed sweep and never shrinks, so a burst's dead keys stay resident
    until traffic climbs back to that peak: the store is bounded, not minimal.

    Eviction can never be premature, which matters because this throttle is a
    security control: an attacker must not be able to clear their own counter by
    provoking a sweep. A key's recorded last-attempt reading comes from the same
    wall clock the ``limits`` moving window stamps its entries with, so it is at
    or after the newest entry's arrival time; an age strictly greater than one
    full expiry therefore proves every entry has already left the window. That
    implication only holds while the clock is the one stamping those entries,
    which is why the default is wall clock rather than a monotonic source.

    Attributes:
        storage: Event store backing the moving window.
        item: The hourly cap this throttle enforces.
        last_attempt: Raw throttle key to the clock reading of its most recent
            recorded attempt. Public, along with the rest, so this module's own
            unit tests can inspect the store without reaching through private
            names.
        sweep_at: Tracked-key count at which the next scan runs.
    """

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        """Build an empty throttle.

        Args:
            clock: Source of the current time, in seconds. In production it must
                be the same wall clock the moving window stamps its entries
                with, hence the ``time.time`` default; a deterministic clock
                injected by tests need only be applied consistently, so it is
                free to start at any origin.
        """
        self.storage = MemoryStorage()
        self.item = RateLimitItemPerHour(INVALID_LICENSE_MAX_PER_HOUR)
        self.last_attempt: dict[str, float] = {}
        self.sweep_at: int = _SWEEP_MIN_TRACKED
        self._limiter = MovingWindowRateLimiter(self.storage)
        self._clock = clock

    def record(self, throttle_key: str) -> bool:
        """Charge one attempt against ``throttle_key``.

        Args:
            throttle_key: Grouped client key the attempt is charged to.

        Returns:
            True while the client remains under the hourly cap, False once the
            cap is spent.
        """
        allowed = self._limiter.hit(self.item, throttle_key)
        # Refreshed even when the attempt was denied, so retention follows the
        # last attempt rather than the first: a client still hammering after
        # spending its cap keeps its counter alive instead of ageing out of the
        # store while it is actively abusing us.
        self.last_attempt[throttle_key] = self._clock()
        self._sweep_if_crowded()
        return allowed

    def exhausted(self, throttle_key: str) -> bool:
        """Report whether ``throttle_key`` has already spent its hourly budget.

        Args:
            throttle_key: Grouped client key to peek at.

        Returns:
            True once the cap is spent. The peek consumes nothing and triggers
            no sweep, so asking costs the client nothing.
        """
        return not self._limiter.test(self.item, throttle_key)

    def reset(self) -> None:
        """Drop every counter and return the sweep mark to its floor."""
        self.storage.reset()
        self.last_attempt.clear()
        self.sweep_at = _SWEEP_MIN_TRACKED

    def _sweep_if_crowded(self) -> None:
        """Evict fully rolled-off keys once the tracked set reaches the mark."""
        if len(self.last_attempt) < self.sweep_at:
            return
        now = self._clock()
        expiry = self.item.get_expiry()
        # Snapshot: the loop mutates the dict it is walking.
        for throttle_key, last in list(self.last_attempt.items()):
            # Strictly greater: the library's own membership test is inclusive
            # (an entry still occupies a slot while ``atime >= now - expiry``),
            # so an age of exactly one expiry can still be a live key. Past
            # that, every entry's arrival time falls below the bound, which
            # makes evicting a key the library would still count impossible.
            if now - last > expiry:
                self._forget(throttle_key)
        self.sweep_at = max(_SWEEP_MIN_TRACKED, _SWEEP_GROWTH_FACTOR * len(self.last_attempt))

    def _forget(self, throttle_key: str) -> None:
        """Drop one key from the tracking map and from the event store.

        Args:
            throttle_key: Raw client key to evict. The store is keyed by the
                item's namespaced form of it, so purging by the raw key would
                silently leave the entry behind.
        """
        del self.last_attempt[throttle_key]
        storage_key = self.item.key_for(throttle_key)
        # Serialise against the library's background sweeper, which truncates
        # this key's event list under this same lock after reading it; dropping
        # the key between those two steps would raise on that thread.
        with self.storage.locks[storage_key]:
            self.storage.clear(storage_key)


_invalid_license_throttle = _InvalidLicenseThrottle()


def record_invalid_license_attempt(throttle_key: str) -> bool:
    """Count one invalid-license signup attempt against ``throttle_key``.

    Takes a throttle key rather than an exact address so an IPv6 subscriber
    cannot refill the cap by presenting a new address from their own delegated
    prefix on every guess.

    Returns True while the client remains under the hourly cap (the attempt
    is recorded against the moving window); returns False once the cap is
    exceeded, at which point the caller should answer 429.
    """
    return _invalid_license_throttle.record(throttle_key)


def invalid_license_cap_exhausted(throttle_key: str) -> bool:
    """Report whether ``throttle_key`` has already spent its hourly budget.

    A non-consuming peek at the moving window: it reads the counter without
    acquiring an entry, so asking costs the client nothing. True means the
    caller must refuse *before* making any outbound Gumroad call, which is the
    whole point of the cap -- a throttle that only shapes the response still
    lets a spent client drive one verify request per allowlisted product on
    every guess. The consuming charge remains
    ``record_invalid_license_attempt``, which the caller applies after a
    verify actually fails.
    """
    return _invalid_license_throttle.exhausted(throttle_key)


def reset_invalid_license_attempts() -> None:
    """Clear every invalid-license counter (test isolation between cases)."""
    _invalid_license_throttle.reset()
