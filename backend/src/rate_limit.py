"""Shared rate limiter instances for the application."""

import os
import time
from collections.abc import Callable, Sequence
from http import HTTPStatus
from math import ceil

from limits import RateLimitItem, RateLimitItemPerHour, parse
from limits.storage import MemoryStorage
from limits.strategies import MovingWindowRateLimiter
from slowapi import Limiter
from starlette.requests import Request
from starlette.responses import JSONResponse

from client_ip import client_throttle_key

# A 429 is a request to come back later, so the smallest honest answer is one
# second. A computed wait can round to zero at the very end of a window, and
# ``Retry-After: 0`` reads as "retry immediately" -- an invitation to the tight
# loop the refusal exists to break.
_MIN_RETRY_AFTER_SECONDS = 1

# Default rate limit applied to all endpoints that don't declare their own.
# Auth endpoints override this with stricter per-route limits (3/min signup,
# 5/min login). The global default protects against scraping and general abuse.
FALLBACK_RATE_LIMIT = "60/minute"

# Set only by the DAST contract-fuzz job, which sends thousands of requests from
# one loopback address and would otherwise spend its whole budget collecting
# 429s -- a uniform denial the fuzzer's response checks cannot distinguish from
# a healthy API. This is NOT a production default; no deployment sets it, and
# ``FALLBACK_RATE_LIMIT`` above is what every deployment gets.
#
# Namespaced deliberately. A bare ``DEFAULT_RATE_LIMIT`` is a name another tool
# in the same environment may already own, and this knob both loosens a global
# limit and refuses to boot on a value it cannot parse -- so reading somebody
# else's variable would be either a silent weakening or a crash whose cause is
# nowhere near its symptom.
RATE_LIMIT_OVERRIDE_ENV_VAR = "ADEPTHOOD_DEFAULT_RATE_LIMIT"


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
        message = f"{RATE_LIMIT_OVERRIDE_ENV_VAR}={candidate!r} is not a rate limit: {error}"
        raise ValueError(message) from error
    return candidate


DEFAULT_RATE_LIMIT = resolve_default_rate_limit(os.getenv(RATE_LIMIT_OVERRIDE_ENV_VAR))


# Rate limiter keyed by the trusted-proxy-resolved *throttle* key rather than a
# forgeable header or a proxy every user shares: one customer, one budget. That
# key groups an IPv6 client onto its delegated prefix, so rotating inside it
# cannot buy fresh buckets, while the audit trail keeps the exact address.
# Shared across routers so all endpoints use a single limiter with consistent
# state; slowapi captures this key function into each per-route limit at
# decoration time, which happens on import, after this line. Building the
# limiter at import time is safe: both the trusted-proxy allowlist and the
# prefix length are read per request.
class _AppLimiter(Limiter):
    """The application's limiter, publishing read access to what it registered.

    ``slowapi`` keeps its route table, its exemption set and its request filters
    in instance state and exposes no accessor for any of them, so a test that
    wants to pin the declared limits has no honest way to read them. Subclassing
    is that way: these three readers are ordinary protected access from inside
    the class that owns the state, not a reach through a private name from
    outside. They return copies, so nothing a caller does can disturb the
    registrations they describe.

    The exemption readers exist because of a coupling that is easy to miss.
    ``@limiter.exempt`` and ``request_filter`` govern the *decorator* path only;
    the ambient floor in this module deliberately consults neither, because
    consulting them would mean resolving a request to a route -- the exact
    coupling that made the floor unreachable for 141 of 144 routes (#2909). Both
    registries are empty today and a test asserts it, so the day one fills is
    the day someone has to decide what an exemption means for the floor.
    """

    def declared_route_limits(self) -> dict[str, tuple[str, ...]]:
        """Return each decorated endpoint's declared limits, sorted, by name.

        Returns:
            Fully-qualified endpoint name to its declared limit strings, sorted
            so a route declaring two axes compares independently of the
            registration order those two are evaluated in.
        """
        return {
            name: tuple(sorted(str(limit.limit) for limit in declared))
            for name, declared in self._route_limits.items()
        }

    def exempt_route_names(self) -> frozenset[str]:
        """Return the endpoint names registered with ``@limiter.exempt``."""
        return frozenset(self._exempt_routes)

    def request_filter_count(self) -> int:
        """Return how many ``request_filter`` predicates are registered."""
        return len(self._request_filters)

    def seconds_until_reset(self, item: RateLimitItem, identifiers: Sequence[str]) -> int:
        """Return whole seconds until one declared bucket admits again.

        Args:
            item: The cap that refused, as ``slowapi`` recorded it.
            identifiers: The bucket's namespaced components, as ``slowapi``
                assembled them -- the client key and the limit's scope.

        Returns:
            The wait to advertise, floored at one second. ``slowapi``'s own
            strategy object is the only thing that knows when this bucket rolls
            over, and it is instance state with no accessor, which is why this
            reader lives inside the class that owns it rather than reaching in
            from the exception handler.
        """
        stats = self.limiter.get_window_stats(item, *identifiers)
        return max(_MIN_RETRY_AFTER_SECONDS, ceil(stats.reset_time - time.time()))


limiter = _AppLimiter(key_func=client_throttle_key, default_limits=[DEFAULT_RATE_LIMIT])

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


class _MovingWindowThrottle:
    """A moving-window counter over a self-bounding in-memory store.

    The backing ``MemoryStorage`` empties an expired key's event list but never
    drops the key itself, so a long-lived process would keep one dict entry per
    throttle key it had ever seen. This wrapper remembers when each key was last
    charged and periodically evicts the keys whose window has fully rolled off,
    bounding the store by the peak concurrent population instead of letting it
    grow without limit as total traffic accumulates.

    Two things schedule that scan, and the second exists because the first is
    not enough on its own. The mark is a multiple of the population that
    survived the last sweep, so it only ever fires on a *growing* store: a burst
    that plateaus leaves its dead keys resident at the historical peak for the
    life of the worker, since the population never climbs back to the mark. So
    an elapsed window is a trigger too, which costs one scan per window while
    traffic flows and makes the resident set follow the last window's peak
    rather than the whole run's.

    Eviction can never be premature, which matters because both users of this
    class are security controls: an attacker must not be able to clear their own
    counter by provoking a sweep. A key's recorded last-attempt reading comes
    from the same wall clock the ``limits`` moving window stamps its entries
    with, so it is at or after the newest entry's arrival time; an age strictly
    greater than one full expiry therefore proves every entry has already left
    the window. That implication only holds while the clock is the one stamping
    those entries, which is why the default is wall clock rather than a
    monotonic source.

    A bucket key is the tuple of string components ``limits`` namespaces its
    store by, which is what lets one implementation serve both callers: the
    invalid-license cap keys on the client alone, ``(client,)``, while the
    ambient floor (#2909) keys on ``(client, path)``.

    Attributes:
        storage: Event store backing the moving window.
        item: The cap this throttle enforces.
        last_attempt: Bucket key to the clock reading of its most recent
            recorded attempt. Public, along with the rest, so this module's own
            unit tests can inspect the store without reaching through private
            names.
        sweep_at: Tracked-key count at which the next scan runs.
    """

    def __init__(
        self,
        item: RateLimitItem,
        clock: Callable[[], float] = time.time,
    ) -> None:
        """Build an empty throttle.

        Args:
            item: The cap every bucket in this throttle is measured against.
            clock: Source of the current time, in seconds. In production it must
                be the same wall clock the moving window stamps its entries
                with, hence the ``time.time`` default; a deterministic clock
                injected by tests need only be applied consistently, so it is
                free to start at any origin.
        """
        self.storage = MemoryStorage()
        self.item = item
        self.last_attempt: dict[tuple[str, ...], float] = {}
        self.sweep_at: int = _SWEEP_MIN_TRACKED
        self._limiter = MovingWindowRateLimiter(self.storage)
        self._clock = clock
        self._swept_at = clock()

    def record(self, key: tuple[str, ...]) -> bool:
        """Charge one attempt against ``key``.

        Args:
            key: Bucket the attempt is charged to.

        Returns:
            True while the bucket remains under its cap, False once the cap is
            spent.
        """
        allowed = self._limiter.hit(self.item, *key)
        # Refreshed even when the attempt was denied, so retention follows the
        # last attempt rather than the first: a client still hammering after
        # spending its cap keeps its counter alive instead of ageing out of the
        # store while it is actively abusing us.
        self.last_attempt[key] = self._clock()
        self._sweep_if_crowded()
        return allowed

    def exhausted(self, key: tuple[str, ...]) -> bool:
        """Report whether ``key`` has already spent its budget.

        Args:
            key: Bucket to peek at.

        Returns:
            True once the cap is spent. The peek consumes nothing and triggers
            no sweep, so asking costs the client nothing.
        """
        return not self._limiter.test(self.item, *key)

    def retry_after(self, key: tuple[str, ...]) -> int:
        """Return how many seconds ``key`` must wait, never less than one.

        Args:
            key: Bucket whose window is being read.

        Returns:
            Whole seconds until the oldest entry leaves the window, floored at
            one: ``Retry-After: 0`` invites an immediate retry, which is the
            opposite of what a 429 is asking for.
        """
        stats = self._limiter.get_window_stats(self.item, *key)
        return max(_MIN_RETRY_AFTER_SECONDS, ceil(stats.reset_time - self._clock()))

    def reset(self) -> None:
        """Drop every counter and return the sweep mark and schedule to their floor."""
        self.storage.reset()
        self.last_attempt.clear()
        self.sweep_at = _SWEEP_MIN_TRACKED
        self._swept_at = self._clock()

    def _sweep_if_crowded(self) -> None:
        """Evict fully rolled-off keys once the tracked set reaches the mark.

        Or once a full window has passed since the last scan, whichever comes
        first. The mark alone only ever fires on a growing population, which
        leaves a store that plateaus holding its dead keys for ever; the elapsed
        window is what bounds the resident set to the last window's peak. It
        cannot evict prematurely -- :meth:`sweep` still checks every key's own
        age -- and it costs one scan per window, not one per attempt.
        """
        crowded = len(self.last_attempt) >= self.sweep_at
        overdue = self._clock() - self._swept_at > self.item.get_expiry()
        if not (crowded or overdue):
            return
        self.sweep()

    def sweep(self) -> None:
        """Evict every key whose window has fully rolled off, now.

        Public, and separate from :meth:`_sweep_if_crowded`, because a caller
        that knows the store is at a bound -- :class:`AmbientThrottle` at its
        per-client ceiling -- may need the scan before either scheduled trigger
        would reach it.
        """
        now = self._clock()
        self._swept_at = now
        expiry = self.item.get_expiry()
        # Snapshot: the loop mutates the dict it is walking.
        for key, last in list(self.last_attempt.items()):
            # Strictly greater: the library's own membership test is inclusive
            # (an entry still occupies a slot while ``atime >= now - expiry``),
            # so an age of exactly one expiry can still be a live key. Past
            # that, every entry's arrival time falls below the bound, which
            # makes evicting a key the library would still count impossible.
            if now - last > expiry:
                self._forget(key)
        self.sweep_at = max(_SWEEP_MIN_TRACKED, _SWEEP_GROWTH_FACTOR * len(self.last_attempt))

    def _forget(self, key: tuple[str, ...]) -> None:
        """Drop one key from the tracking map and from the event store.

        Args:
            key: Bucket to evict. The store is keyed by the item's namespaced
                form of it, so purging by the raw key would silently leave the
                entry behind.
        """
        del self.last_attempt[key]
        storage_key = self.item.key_for(*key)
        # Serialise against the library's background sweeper, which truncates
        # this key's event list under this same lock after reading it; dropping
        # the key between those two steps would raise on that thread.
        with self.storage.locks[storage_key]:
            self.storage.clear(storage_key)


class _InvalidLicenseThrottle:
    """Hourly invalid-license counter, keyed on the grouped client alone.

    Distinct from the 3/minute signup limit so a license brute-forcer is capped
    per hour even if they pace themselves under the per-minute limit.

    A forwarding wrapper rather than a subclass, so its whole surface stays
    keyed on the raw client string while the shared window underneath is keyed
    on identifier tuples. Retention, eviction safety and the sweep all live in
    :class:`_MovingWindowThrottle`; nothing about them is restated here.

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
        """Build an empty hourly counter.

        Args:
            clock: Source of the current time, in seconds. See
                :class:`_MovingWindowThrottle`.
        """
        self._window = _MovingWindowThrottle(
            RateLimitItemPerHour(INVALID_LICENSE_MAX_PER_HOUR), clock=clock
        )

    @property
    def storage(self) -> MemoryStorage:
        """Return the event store backing the moving window."""
        return self._window.storage

    @property
    def item(self) -> RateLimitItem:
        """Return the hourly cap this throttle enforces."""
        return self._window.item

    @property
    def last_attempt(self) -> dict[str, float]:
        """Return each tracked client key against its last recorded attempt."""
        return {key: stamp for (key,), stamp in self._window.last_attempt.items()}

    @property
    def sweep_at(self) -> int:
        """Return the tracked-key count at which the next scan runs."""
        return self._window.sweep_at

    def record(self, throttle_key: str) -> bool:
        """Charge one attempt against ``throttle_key``.

        Args:
            throttle_key: Grouped client key the attempt is charged to.

        Returns:
            True while the client remains under the hourly cap, False once the
            cap is spent.
        """
        return self._window.record((throttle_key,))

    def exhausted(self, throttle_key: str) -> bool:
        """Report whether ``throttle_key`` has already spent its hourly budget.

        Args:
            throttle_key: Grouped client key to peek at.

        Returns:
            True once the cap is spent. The peek consumes nothing and triggers
            no sweep, so asking costs the client nothing.
        """
        return self._window.exhausted((throttle_key,))

    def reset(self) -> None:
        """Drop every counter and return the sweep mark to its floor."""
        self._window.reset()


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


# ── The ambient floor: one limit, charged before anything is resolved ────
#
# #2909. The ambient ``default_limits`` above used to be applied by
# ``slowapi.middleware.SlowAPIMiddleware``, which resolves a request to its
# handler by walking ``app.routes`` for ``.endpoint``. Under FastAPI 0.141
# ``app.routes`` holds ``_IncludedRouter`` wrappers that expose no
# ``.endpoint``, so every route mounted through ``include_router`` resolved to
# ``None`` -- and slowapi treats a handler-less request as *exempt*. The
# mechanism failed open for 141 of the 144 mounted routes, and the whole test
# suite stayed green because its one default-limit test used ``/health``, an
# app-level route that still resolved.
#
# The 27 routes carrying ``@limiter.limit`` were no better off. That decorator
# wraps the *endpoint*, so it fires only after routing, body parsing and
# dependency resolution: an unauthenticated flood (401) or a malformed-body
# flood (422) is refused upstream of it and charged to nothing at all.
#
# So the floor below does not resolve anything. It consults no ``app.routes``,
# no ``scope["route"]``, no ``.endpoint``, no ``_route_limits``, and no
# ``_IncludedRouter``. It charges one bucket per ``(client, path)``, and one
# per-client ceiling across every path (#2913, :class:`ClientCeiling`), and
# answers.
# That is the invariant, and it is the whole fix: **this layer must never
# consult route identity.** Route identity is not available to a middleware
# under this stack, and a layer that needs it is a layer that fails open the
# next time the framework changes how routes are stored.
#
# Version pins this was measured against, so the next upgrade knows what has to
# be re-checked and what does not (``backend/requirements-lock.txt``, where
# starlette's adopted version lives): fastapi 0.141.1, starlette 1.7.0, slowapi
# 0.1.10. First measured on starlette 1.6.0; re-measured on 1.7.0 (#2923) by
# ``test_slowapi_middleware_still_cannot_see_included_router_routes`` in
# ``tests/middleware/test_ambient_rate_limit.py``, which re-takes it on every
# run. Nothing here depends on any of the three: the floor needs a request
# object and a clock. What *does* depend on them is the claim that slowapi's own
# middleware cannot do this job -- so an upgrade may make that middleware work
# again, and must not be taken as a reason to hand this invariant back to it.

# Parsed once, from the same constant the decorated limits inherit, so an
# override set for the DAST contract-fuzz job moves the floor with everything
# else. ``resolve_default_rate_limit`` has already proven the string parses, so
# this adds no new way to fail at import.
AMBIENT_LIMIT_ITEM = parse(DEFAULT_RATE_LIMIT)

# The bucket key's path component comes straight off the request line, which an
# attacker controls: a 404 flood of random paths mints a fresh key per request,
# and inside one window nothing has rolled off for the sweep to reclaim. So one
# client's *fan-out* is capped -- past this many distinct paths of its own, an
# unseen path is billed to that client's overflow bucket instead of minting
# another key.
#
# Per client, and emphatically not a count of the whole store. A ceiling on the
# global key count is reached by whoever floods first and then holds there, and
# from that moment every *other* client's first request to any path it has not
# already touched finds the store full and is diverted -- turning its 60/minute
# per path into 60/minute across the entire API, health probes included. That
# is the exact harm per-path keying exists to prevent, handed to an attacker as
# a tool to use on everybody else. The unit a ceiling may bound is the unit the
# attacker already owns.
#
# Sized well above the 124 distinct paths the API actually mounts (pinned as
# ``_DISTINCT_MOUNTED_PATHS`` in ``tests/test_rate_limits.py``), so no
# legitimate client can approach it by using the product, and above the fan-out
# a client can reach by enumerating ids on a handful of ``{param}`` routes
# inside one window before the sweep starts reclaiming.
_MAX_PATHS_PER_CLIENT = 512

# Stands in for the path in an overflow bucket. Begins with a character no URL
# path can start with, so it can never collide with a real request path.
_OVERFLOW_PATH_MARKER = "\x00overflow"

# Indices inside an ambient bucket key, which is ``(client, path)``.
_CLIENT_COMPONENT = 0
_PATH_COMPONENT = 1

# Before a client has forced a reclaim of its own. Any clock reading is past it,
# so a client reaching its ceiling for the first time gets a scan rather than
# waiting out a window it has never spent.
_NEVER_RECLAIMED = float("-inf")

# The quick-log tile on the habits screen posts one check-in per tap, on this
# one static path, with no batching or coalescing (``HabitsScreen.tsx`` ->
# ``logUnit``). Counting reps or ounces at about a tap a second spends the
# ambient allowance inside a minute and the user is refused for using the
# feature exactly as designed, so this path declares a floor sized to its own
# interaction: roughly three taps a second sustained for a full minute.
#
# It has to live here rather than in a ``@limiter.limit`` on the route. The
# floor is charged in middleware, before routing, so a declared route limit can
# only ever tighten what the floor already allowed -- it can never widen it.
_QUICK_LOG_PATH = "/goal_completions/"
_QUICK_LOG_BURST_LIMIT = "180/minute"

# Paths whose legitimate interaction is burstier than the ambient default, with
# the floor each is measured against instead. Exact paths only, no patterns: a
# pattern is a place for a mistake to fail open, and this table exists to be
# read and argued with. Every entry widens the floor for one path and nothing
# else; see ``_throttle_for`` for what happens when the ambient floor is already
# wider than an entry.
_PATH_BURST_FLOORS: dict[str, RateLimitItem] = {
    _QUICK_LOG_PATH: parse(_QUICK_LOG_BURST_LIMIT),
}


def _requests_per_second(item: RateLimitItem) -> float:
    """Return ``item``'s allowance as a rate, so two windows can be compared.

    Args:
        item: Any parsed rate limit.

    Returns:
        Requests per second. The only honest way to ask which of ``60/minute``
        and ``180/minute`` -- or ``6000/minute`` -- admits more.
    """
    return item.amount / item.get_expiry()


class AmbientThrottle(_MovingWindowThrottle):
    """The floor every request meets, keyed on ``(client key, request path)``.

    Per path rather than per client, which preserves exactly the scope the
    limiter already applied (``slowapi``'s default ``key_style="url"``) and
    keeps one runaway screen from taking the whole API away from the client
    running it -- including the health probes an operator would read to find out
    why. The cost of that choice is recorded in the residuals: enumerating a
    ``{param}`` route buys a fresh budget per id, which is why the fan-out
    ceiling below exists and why :class:`ClientCeiling` (#2913) bounds each
    client's *overall* rate on top of it -- charged in the same call, keyed on
    the client alone, and so still consulting no route identity.

    The ceiling bounds one client's fan-out and is reached independently by each
    client, so saturating is something a client can only do to itself. Reaching
    it is also a phase rather than a one-way door: a client parked at its
    ceiling stops the population growing, so hitting the ceiling asks for a
    reclaim of its own buckets before it diverts rather than waiting for a
    scheduled scan its own ceiling has made unreachable.

    Everything about that reclaim is per client -- which buckets it visits and
    how often it may be asked for -- because every part of this mechanism that
    is shared is a part one tenant can spend on another's behalf.

    Attributes:
        reclaim_after: Client key to the clock reading before which that client
            may not force another reclaim. Public for the same reason the base
            class's store is: this module's own unit tests assert the scoping,
            which is the property a single shared scalar quietly broke. A client
            is entered here only while it holds at least one bucket, so the map
            is bounded by the store rather than by the key space an attacker
            can spell.
    """

    def __init__(
        self,
        item: RateLimitItem | None = None,
        clock: Callable[[], float] = time.time,
        max_paths_per_client: int = _MAX_PATHS_PER_CLIENT,
    ) -> None:
        """Build an empty ambient floor.

        Args:
            item: The cap every bucket here is measured against. Defaults to the
                ambient floor; a burst path passes its own wider one.
            clock: Source of the current time, in seconds. See the base class.
            max_paths_per_client: Distinct paths one client may hold buckets for
                before an unseen path is diverted to its overflow bucket.
                Injectable so the saturation tests do not have to drive the
                production ceiling to reach it.
        """
        super().__init__(AMBIENT_LIMIT_ITEM if item is None else item, clock=clock)
        self._max_paths_per_client = max_paths_per_client
        self._paths_held: dict[str, set[str]] = {}
        self.reclaim_after: dict[str, float] = {}

    def charge(self, throttle_key: str, path: str) -> int | None:
        """Charge one request against ``throttle_key``'s budget for ``path``.

        Args:
            throttle_key: Grouped client key the request is billed to.
            path: Request path, taken raw rather than as a route template --
                resolving a template would mean consulting route identity.

        Returns:
            None while the bucket is under the floor, or the whole seconds the
            caller should wait once it is spent.
        """
        bucket = self._bucket_for(throttle_key, path)
        if self.record(bucket):
            return None
        return self.retry_after(bucket)

    def wait_for(self, throttle_key: str, path: str) -> int | None:
        """Peek at how long ``path`` would make ``throttle_key`` wait, consuming nothing.

        Answers for the bucket :meth:`charge` would bill, without doing any of
        what choosing it can do: it mints no bucket, records no attempt, runs no
        reclaim and schedules no sweep. A client at its fan-out ceiling is
        answered from its overflow bucket even where a reclaim would have freed
        room, which can only lengthen a wait that is being reported on a request
        refused anyway -- never shorten one.

        Args:
            throttle_key: Grouped client key.
            path: Raw request path.

        Returns:
            The whole seconds the bucket still needs when it is spent, or None
            when it would admit (including when no bucket exists to be spent).
        """
        bucket = (throttle_key, path)
        if bucket not in self.last_attempt:
            if self._has_room(throttle_key):
                return None
            bucket = (throttle_key, _OVERFLOW_PATH_MARKER)
            if bucket not in self.last_attempt:
                return None
        if not self.exhausted(bucket):
            return None
        return self.retry_after(bucket)

    def tracked_paths(self) -> frozenset[str]:
        """Return the paths currently holding a bucket, across all clients."""
        return frozenset(key[_PATH_COMPONENT] for key in self.last_attempt)

    def record(self, key: tuple[str, ...]) -> bool:
        """Charge one attempt against ``key``, keeping its client's set of held paths.

        The set, rather than a count, because the reclaim has to be able to
        visit one client's own buckets without walking the whole store. It is
        bounded by the same ceiling the count was: past
        :attr:`_max_paths_per_client` distinct paths a client mints no more, and
        one overflow marker on top of them.

        Args:
            key: Bucket the attempt is charged to.

        Returns:
            True while the bucket remains under its cap.
        """
        client = key[_CLIENT_COMPONENT]
        self._paths_held.setdefault(client, set()).add(key[_PATH_COMPONENT])
        return super().record(key)

    def reset(self) -> None:
        """Drop every counter, every client's fan-out, and every reclaim booking."""
        super().reset()
        self._paths_held.clear()
        self.reclaim_after.clear()

    def _forget(self, key: tuple[str, ...]) -> None:
        """Evict one bucket and give its client back the fan-out it was holding.

        The client's reclaim booking is dropped with its last bucket, which is
        what bounds :attr:`reclaim_after`: its key space is a subset of
        :attr:`_paths_held`'s, and that one the sweep already bounds. A map
        keyed on an attacker-supplied throttle key that nothing ever pruned
        would be the defect this ceiling exists to prevent, in a new place.

        Args:
            key: Bucket to evict.
        """
        super()._forget(key)
        client = key[_CLIENT_COMPONENT]
        held = self._paths_held[client]
        held.discard(key[_PATH_COMPONENT])
        if not held:
            del self._paths_held[client]
            self.reclaim_after.pop(client, None)

    def _has_room(self, throttle_key: str) -> bool:
        """Report whether ``throttle_key`` may still mint a bucket of its own.

        Args:
            throttle_key: Grouped client key.

        Returns:
            True while this client holds fewer buckets than its ceiling.
        """
        return len(self._paths_held.get(throttle_key, ())) < self._max_paths_per_client

    def _reclaim(self, throttle_key: str) -> None:
        """Sweep one client's own buckets on demand, at most once per window.

        A ceiling stops the population growing, and the scheduled sweep fires on
        growth or on an elapsed window, so without this a client that reached
        its ceiling could wait out most of a window with every unseen path it
        asked for diverted, holding buckets that had already rolled off.

        Both halves of the bound are per client, and they have to be. The
        booking is keyed on the client because a single scalar let the first
        client to saturate refuse every other client a reclaim for a whole
        window -- diverting a tenant that had its own reclaimable buckets onto
        its overflow counter on somebody else's account, which is #2909's shape
        again. And the scan visits only that client's own paths, bounded by its
        own ceiling, because a per-client budget over a whole-store scan is a
        per-client CPU amplifier: every saturating client would buy a full scan
        per window, over a store their own fan-out is what grew.

        Rate-limited to once per window because a sweep can only ever reclaim a
        key older than one full expiry: asking more often scans for nothing, at
        the request rate of whoever is saturating.

        Args:
            throttle_key: Grouped client key whose buckets are being revisited.
        """
        now = self._clock()
        if now < self.reclaim_after.get(throttle_key, _NEVER_RECLAIMED):
            return
        expiry = self.item.get_expiry()
        # Booked before the scan, so that a scan which reclaims this client's
        # *last* bucket leaves no booking behind: _forget drops it along with
        # the fan-out entry, which is what keeps this map's key space a subset
        # of one the sweep already bounds.
        self.reclaim_after[throttle_key] = now + expiry
        # Snapshot: _forget mutates the set this walks, and may drop it outright.
        for path in list(self._paths_held.get(throttle_key, ())):
            if now - self.last_attempt[throttle_key, path] > expiry:
                self._forget((throttle_key, path))

    def _bucket_for(self, throttle_key: str, path: str) -> tuple[str, str]:
        """Pick the bucket to bill, diverting unseen paths once this client saturates.

        Three properties make the diversion safe. A bucket that already exists
        is never diverted, so saturation cannot hand an established client a
        counter somebody else is spending. The ceiling and the overflow bucket
        are both keyed on the client, and so is the reclaim that runs before the
        diversion -- both which buckets it may take back and how often it may be
        asked for -- so one tenant's flood can neither move nor narrow another
        tenant's counters, nor spend the reclaim another tenant was about to
        need. The bound is on the fan-out of the client that caused it, with
        nothing shared left for a flood to reach through. And the degradation is
        fail-closed: an attacker
        enumerating paths under saturation collapses their own traffic onto one
        bucket and is pinned at the floor, rather than buying a fresh budget per
        path.

        Args:
            throttle_key: Grouped client key the request is billed to.
            path: Raw request path.

        Returns:
            The client's bucket for ``path``, or the client's overflow bucket
            when ``path`` is unseen and this client is already at its ceiling
            with nothing of its own left to reclaim.
        """
        bucket = (throttle_key, path)
        if bucket in self.last_attempt or self._has_room(throttle_key):
            return bucket
        self._reclaim(throttle_key)
        if self._has_room(throttle_key):
            return bucket
        return (throttle_key, _OVERFLOW_PATH_MARKER)


# ── The per-client ceiling: every path a client asks for, in one budget ──
#
# #2913. The floor above is keyed on ``(client, raw path)``, so enumerating a
# ``{param}`` route buys a fresh 60/minute per id. The fan-out ceiling already
# caps *one-shot* enumeration: past 512 distinct paths every unseen one is
# billed to the client's overflow bucket, so single hits across distinct ids are
# refused from the 573rd. What it did not cap is *repeat* hits across fewer ids
# than that -- up to 512 x 60 + 60, some 30,780 admitted requests a minute per
# client per worker. This ceiling is the aggregate that closes it: one bucket
# per client key, charged in the same call as the floor, reading nothing but
# the client key. Keyed on the client alone and never on route identity, for
# exactly the reason the floor is.
#
# Sized from code, because no production traffic percentiles were available to
# size it from. The worst legitimate burst one user can produce inside a minute:
#
# * a habit insert or reorder, which ``habitManager.ts`` (insert / reorder /
#   ``syncRevealState``) fans out as one POST plus a PUT to every other
#   server-backed habit under a single ``Promise.all`` -- 1 + up to
#   ``_MAX_HABITS_PER_USER`` - 1 (``routers/habits.py``: 100) distinct paths;
# * a full quick-log burst at ``_QUICK_LOG_BURST_LIMIT`` (180/minute) on its
#   one path;
# * ordinary screen loads on top, of the order of a hundred requests.
#
# That is some 300-400 requests. 600 sits well above it, leaving headroom for
# a shared NAT or an IPv6 prefix grouped onto one key -- and it is ten times the
# ambient floor, which is the multiple an override scales it by. A ceiling at or
# under the worst burst would silently narrow the quick-log burst floor or break
# a reorder; ``tests/middleware/test_ambient_rate_limit.py`` drives that burst
# against the shipped value, and ``_MAX_HABITS_PER_USER`` is tied to it there
# rather than imported here, which would make this module import a router.
#
# Two operator caveats (``DEPLOYMENT.md``). Like every limit in this module it
# is per worker process, so the effective per-deployment ceiling is
# ``WEB_CONCURRENCY`` x 600. And with ``TRUSTED_PROXY_CIDRS`` unset every
# request collapses onto the proxy's key, which makes this a site-wide
# 600/minute across the whole API rather than a per-client one.
CLIENT_CEILING_LIMIT = "600/minute"

# How far above the ambient floor the ceiling always sits.
# ``ADEPTHOOD_DEFAULT_RATE_LIMIT`` widens the floor for the DAST jobs to
# thousands per minute; a fixed ceiling would quietly undercut that override
# on every path at once, so the ceiling scales with it instead.
_CLIENT_CEILING_FLOOR_MULTIPLE = 10


def resolve_client_ceiling(ambient: RateLimitItem | None = None) -> RateLimitItem:
    """Return the per-client ceiling for a given ambient floor.

    Args:
        ambient: The ambient floor to scale against. Defaults to
            ``AMBIENT_LIMIT_ITEM``, read at call time.

    Returns:
        The wider, as a rate, of :data:`CLIENT_CEILING_LIMIT` and
        ``_CLIENT_CEILING_FLOOR_MULTIPLE`` times the ambient floor. Only ever the
        wider: the ceiling exists to bound enumeration and must never become the
        thing that undercuts an override. At the shipped default the two agree
        and the literal is returned.
    """
    floor = AMBIENT_LIMIT_ITEM if ambient is None else ambient
    literal = parse(CLIENT_CEILING_LIMIT)
    scaled = type(floor)(
        floor.amount * _CLIENT_CEILING_FLOOR_MULTIPLE,
        floor.multiples,
        floor.namespace,
    )
    return max((literal, scaled), key=_requests_per_second)


class ClientCeiling(_MovingWindowThrottle):
    """One moving-window budget per client key, whatever paths it spends it on.

    Keyed ``(client,)``, so its key space is the client population and nothing
    an attacker can spell into a request line. It inherits the base class's
    sweep, so rolled-off clients leave the store the same way ambient buckets
    do.
    """

    def charge(self, throttle_key: str) -> int | None:
        """Charge one request against ``throttle_key``'s overall budget.

        Args:
            throttle_key: Grouped client key.

        Returns:
            None while the client is under its ceiling, or the whole seconds it
            must wait once the ceiling is spent.
        """
        bucket = (throttle_key,)
        if self.record(bucket):
            return None
        return self.retry_after(bucket)

    def wait_for(self, throttle_key: str) -> int | None:
        """Peek at the client's wait without charging, minting or sweeping anything.

        Args:
            throttle_key: Grouped client key.

        Returns:
            The whole seconds until the ceiling admits again, or None while it
            still has room.
        """
        bucket = (throttle_key,)
        if not self.exhausted(bucket):
            return None
        return self.retry_after(bucket)

    def tracked_clients(self) -> frozenset[str]:
        """Return the client keys currently holding a ceiling bucket."""
        return frozenset(key[_CLIENT_COMPONENT] for key in self.last_attempt)


def _longest_wait(*waits: int | None) -> int | None:
    """Return the longest of the waits that refuse, or None when none does.

    Args:
        *waits: Each bucket's wait, None where that bucket would admit.

    Returns:
        The longest wait: a client told the shorter one would retry into the
        bucket that is still spent.
    """
    refusing = [wait for wait in waits if wait is not None]
    return max(refusing) if refusing else None


def _charge_floor_and_ceiling(
    floor: AmbientThrottle,
    ceiling: ClientCeiling,
    throttle_key: str,
    path: str,
) -> int | None:
    """Charge one request to its path floor and its client ceiling, in that order.

    The order is what keeps the two budgets from spending each other:

    * A spent ceiling refuses before the floor is touched, so a ceiling refusal
      consumes no path budget. Its answer is the longer of the two waits, both
      read by non-consuming peeks.
    * A request its path floor refuses is never billed to the ceiling. Billing
      it would let one runaway screen retrying one path spend the client's
      whole ceiling and take every other path away from it -- health probes
      included -- which is the property per-path keying exists to protect.
    * Only a request the floor admitted is billed to the ceiling.

    Synchronous, with nothing awaited between the peek and the charges, so no
    other request's charge can interleave with them.

    Args:
        floor: The throttle owning ``path``'s floor.
        ceiling: The per-client ceiling.
        throttle_key: Grouped client key.
        path: Raw request path.

    Returns:
        None when admitted, or the ``Retry-After`` seconds when refused.
    """
    ceiling_wait = ceiling.wait_for(throttle_key)
    if ceiling_wait is not None:
        return _longest_wait(ceiling_wait, floor.wait_for(throttle_key, path))
    path_wait = floor.charge(throttle_key, path)
    if path_wait is not None:
        return path_wait
    return ceiling.charge(throttle_key)


_ambient_throttle = AmbientThrottle()

_client_ceiling = ClientCeiling(resolve_client_ceiling(AMBIENT_LIMIT_ITEM))

# One throttle per burst path, rather than a per-bucket cap inside the ambient
# store. Each holds a single path, so its key space is bounded by the client
# population alone -- there is no attacker-controlled component in it at all --
# and the ambient store keeps one cap for every bucket in it, which is what
# makes its ceiling and its sweep mean one thing.
_burst_throttles: dict[str, AmbientThrottle] = {
    path: AmbientThrottle(item=floor) for path, floor in _PATH_BURST_FLOORS.items()
}


def _throttle_for(path: str) -> AmbientThrottle:
    """Return the throttle that owns ``path``'s floor.

    Args:
        path: Raw request path.

    Returns:
        The burst throttle when ``path`` declares one *and* that declaration is
        the wider of the two. ``ADEPTHOOD_DEFAULT_RATE_LIMIT`` moves the ambient
        floor -- the DAST contract-fuzz job sets it to thousands per minute --
        and a burst entry that simply replaced the ambient item would quietly
        undo that override on exactly the paths it names. A per-path entry may
        only ever widen.
    """
    burst = _burst_throttles.get(path)
    if burst is None:
        return _ambient_throttle
    if _requests_per_second(burst.item) <= _requests_per_second(AMBIENT_LIMIT_ITEM):
        return _ambient_throttle
    return burst


def floor_for_path(path: str) -> RateLimitItem:
    """Return the cap the ambient floor measures ``path`` against.

    Args:
        path: Raw request path.

    Returns:
        ``path``'s declared burst floor, or the ambient one.
    """
    return _throttle_for(path).item


def charge_ambient_limit(throttle_key: str, path: str) -> int | None:
    """Charge one request against the ambient floor and the client's ceiling.

    Args:
        throttle_key: Grouped client key the request is billed to.
        path: Raw request path.

    Returns:
        None when the request is admitted, or the ``Retry-After`` seconds to
        answer with when it is refused.
    """
    return _charge_floor_and_ceiling(_throttle_for(path), _client_ceiling, throttle_key, path)


def reset_ambient_limit() -> None:
    """Clear every ambient bucket and every client ceiling (test isolation)."""
    _ambient_throttle.reset()
    _client_ceiling.reset()
    for throttle in _burst_throttles.values():
        throttle.reset()


def ambient_tracked_paths() -> frozenset[str]:
    """Return the paths currently holding an ambient bucket."""
    tracked = _ambient_throttle.tracked_paths()
    for throttle in _burst_throttles.values():
        tracked |= throttle.tracked_paths()
    return tracked


def ambient_tracked_clients() -> frozenset[str]:
    """Return the client keys currently holding a per-client ceiling bucket."""
    return _client_ceiling.tracked_clients()


def declared_limit_retry_after(request: Request, exc: Exception) -> int:
    """Return the ``Retry-After`` seconds for a refusal from a declared limit.

    Args:
        request: The refused request. ``slowapi`` records the bucket it refused
            on ``request.state.view_rate_limit`` immediately before raising.
        exc: The ``RateLimitExceeded`` that was raised.

    Returns:
        Whole seconds until that exact bucket admits again.

        ``slowapi.errors.RateLimitExceeded`` (0.1.10) defines ``limit`` and
        nothing else -- there is no ``retry_after`` attribute on it at any point
        -- so reading one off the exception took its fallback on *every*
        decorator refusal. ``POST /auth/password-reset/request`` declares
        ``3/hour`` and told a refused client to come back in sixty seconds, so
        an obedient client retried some fifty-six more times before its window
        rolled off: the tight loop the refusal exists to break, driven by the
        refusal itself.
    """
    refused = getattr(request.state, "view_rate_limit", None)
    if refused is None:
        return _one_whole_window(exc)
    item, identifiers = refused
    return limiter.seconds_until_reset(item, identifiers)


def _one_whole_window(exc: Exception) -> int:
    """Return one full window of the cap that refused, as a last resort.

    Args:
        exc: The ``RateLimitExceeded`` that was raised.

    Returns:
        The refused cap's window length, or the ambient floor's if the exception
        carries no cap either. Always safe if never tight: a client that waits a
        whole window is certain to find its bucket open.
    """
    declared = getattr(exc, "limit", None)
    item = getattr(declared, "limit", AMBIENT_LIMIT_ITEM)
    return max(_MIN_RETRY_AFTER_SECONDS, int(item.get_expiry()))


def rate_limiting_enabled() -> bool:
    """Report whether rate limiting is switched on.

    ``limiter.enabled`` is the single kill switch for *both* layers, and this is
    the one seam that reads it. ``backend/conftest.py``'s ``disable_rate_limit``
    fixture and ``backend/tests/e2e/server.py`` both flip that flag and expect
    everything to go quiet; a floor with a switch of its own would leave them
    half-working and put the failures in unrelated suites.
    """
    return limiter.enabled


def rate_limit_exceeded_response(retry_after: int) -> JSONResponse:
    """Build the one 429 envelope this application answers with.

    Args:
        retry_after: Whole seconds to advertise in the ``Retry-After`` header.

    Returns:
        The refusal both layers send: the ambient floor returns it directly,
        and :mod:`main`'s ``RateLimitExceeded`` handler returns it for the
        decorated routes. One definition, because a client that learns to read
        one shape of refusal has to be able to read the other.
    """
    return JSONResponse(
        status_code=HTTPStatus.TOO_MANY_REQUESTS,
        content={"detail": "rate_limit_exceeded"},
        headers={"Retry-After": str(retry_after)},
    )
