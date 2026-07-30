"""Retention bounds for the invalid-license hourly throttle.

The throttle counts failed licence verifications per client so a brute-forcer
cannot drive unbounded outbound Gumroad calls. Its backing ``MemoryStorage``
empties an expired key's event list but never drops the key itself, so a
long-lived process accumulates one dict entry per throttle key it has ever
seen. These tests pin the bounded, self-sweeping store that replaces it: keys
whose last attempt has rolled off the hourly window are evicted, live keys are
never evicted, and the sweep threshold grows with the live population so
sweeping stays amortised.

The eviction rule is only safe because the throttle's recorded reading and the
window entries it is compared against come from one clock. Tests that assert on
that comparison hand the ``limits`` library the same fake clock the throttle
runs on, so the whole inequality is executed rather than assumed.
"""

from __future__ import annotations

from collections.abc import Callable

import limits.storage.memory
import limits.strategies
import pytest

from rate_limit import (
    _SWEEP_GROWTH_FACTOR,
    _SWEEP_MIN_TRACKED,
    INVALID_LICENSE_MAX_PER_HOUR,
    _invalid_license_throttle,
    _InvalidLicenseThrottle,
    invalid_license_cap_exhausted,
    record_invalid_license_attempt,
    reset_invalid_license_attempts,
)

# One second either side of the expiry boundary, so a test can sit just inside
# the window, exactly on it, or just past it without depending on wall-clock
# timing.
_EXPIRY_MARGIN_SECONDS = 1

# How far the ticking clock moves on every read. Any positive step works; the
# point is only that two successive reads return different values.
_TICK_SECONDS = 1.0

# Distinct never-seen keys the peek test asks about. More than the sweep floor,
# so a peek that tracked its keys would trip a sweep as well as leaking them.
_UNSEEN_PEEK_KEYS = _SWEEP_GROWTH_FACTOR * _SWEEP_MIN_TRACKED

# Keys left standing by the sweep in the floor test. One is enough: the growth
# factor applied to it lands far below the floor, so only the floor can explain
# the mark the throttle reschedules at.
_LONE_SURVIVORS = 1

# Number of full key batches churned through the store in the bound test, and
# the multiple of the sweep floor the resident set must stay under.
_CHURN_BATCHES = 16
_BOUND_MULTIPLE = 3

# How many half-expiry rounds of denied attempts the refresh test drives, so
# the key's first attempt ages out while its last attempt stays recent.
_DENIAL_ROUNDS = 3

# Peeks taken mid-budget to prove the non-consuming read really consumes
# nothing.
_PEEK_REPEATS = 20


class FakeClock:
    """Deterministic stand-in for ``time.time`` used as an injected clock."""

    def __init__(self, start: float = 0.0) -> None:
        """Create a clock parked at ``start``.

        Args:
            start: Initial reading, in seconds.
        """
        self.now = start

    def __call__(self) -> float:
        """Read the clock.

        Returns:
            The current reading, in seconds.
        """
        return self.now

    def advance(self, seconds: float) -> None:
        """Move the clock forward.

        Args:
            seconds: How many seconds to add to the current reading.
        """
        self.now += seconds


class TickingClock:
    """Clock that steps forward on every read.

    A clock that returns the same reading twice cannot show which of two calls
    happened first. Stepping on each read records the order of the throttle's
    own reads and the ones ``limits`` takes into the values themselves, which
    is what makes an ordering assertion possible.
    """

    def __init__(self, step: float = _TICK_SECONDS) -> None:
        """Create a clock at zero that steps by ``step`` per read.

        Args:
            step: Seconds added to the reading after each read.
        """
        self.now = 0.0
        self.step = step

    def __call__(self) -> float:
        """Read the clock and advance it.

        Returns:
            The reading as it stood before this call's step was applied.
        """
        reading = self.now
        self.now += self.step
        return reading


class FakeTimeModule:
    """Stand-in for the ``time`` module exposing only what ``limits`` reads."""

    def __init__(self, clock: Callable[[], float]) -> None:
        """Wrap ``clock`` in the module surface ``limits`` calls.

        Args:
            clock: Source of the current time, in seconds.
        """
        self.clock = clock

    def time(self) -> float:
        """Read the wrapped clock.

        Returns:
            The current reading, in seconds.
        """
        return self.clock()


def _share_clock_with_limits(monkeypatch: pytest.MonkeyPatch, clock: Callable[[], float]) -> None:
    """Make the ``limits`` library read ``clock`` instead of the wall clock.

    The throttle's safety argument compares readings it took itself against the
    arrival times ``limits`` stamps on its window entries, so the two must come
    from one clock for a test to observe the comparison at all. The module
    attribute is replaced wholesale rather than patched onto the real ``time``
    module, which would hand a fake clock to every other importer in the
    process.

    Args:
        monkeypatch: Patcher whose undo restores the real module on teardown.
        clock: Source of the current time, in seconds, to install.
    """
    fake_time = FakeTimeModule(clock)
    # The moving window reads the clock through the storage today; patching the
    # strategy module too, which also binds ``time`` at import, keeps the shared
    # clock honest if that ever changes.
    monkeypatch.setattr(limits.storage.memory, "time", fake_time, raising=True)
    monkeypatch.setattr(limits.strategies, "time", fake_time, raising=True)


def _record_batch(throttle: _InvalidLicenseThrottle, prefix: str, count: int) -> list[str]:
    """Record one attempt against ``count`` distinct keys sharing ``prefix``.

    Args:
        throttle: The throttle under test.
        prefix: Namespace for the generated keys, unique per batch.
        count: How many distinct keys to record.

    Returns:
        The keys that were recorded, in order.
    """
    keys = [f"{prefix}-{index}" for index in range(count)]
    for key in keys:
        throttle.record(key)
    return keys


def _force_sweep(throttle: _InvalidLicenseThrottle, prefix: str) -> list[str]:
    """Record just enough fresh keys to push the throttle over its sweep mark.

    Args:
        throttle: The throttle under test.
        prefix: Namespace for the generated keys, unique per call.

    Returns:
        The fresh keys recorded to trigger the sweep.

    Raises:
        AssertionError: If the throttle has already reached its mark, in which
            case this call would record nothing and the caller's "and then it
            sweeps" would be a silent no-op.
    """
    needed = throttle.sweep_at - len(throttle.last_attempt)
    assert needed > 0
    return _record_batch(throttle, prefix, needed)


def test_rolled_off_keys_are_dropped_from_the_event_store() -> None:
    """Keys whose last attempt predates the window leave both stores."""
    clock = FakeClock()
    throttle = _InvalidLicenseThrottle(clock=clock)
    expiry = throttle.item.get_expiry()

    old_keys = _record_batch(throttle, "old", _SWEEP_MIN_TRACKED // 2)
    clock.advance(expiry + _EXPIRY_MARGIN_SECONDS)
    fresh_keys = _force_sweep(throttle, "fresh")

    for key in old_keys:
        assert key not in throttle.last_attempt
        assert throttle.item.key_for(key) not in throttle.storage.events
    for key in fresh_keys:
        assert key in throttle.last_attempt
        assert throttle.item.key_for(key) in throttle.storage.events


def test_store_size_stays_bounded_under_key_churn() -> None:
    """The resident key set stays bounded however many keys pass through.

    This is the leak itself: today every distinct throttle key ever seen keeps
    a permanent entry in the storage's event dict, so the store grows with
    total traffic rather than with the number of currently rate-limited
    clients.
    """
    clock = FakeClock()
    throttle = _InvalidLicenseThrottle(clock=clock)
    expiry = throttle.item.get_expiry()

    for batch in range(_CHURN_BATCHES):
        _record_batch(throttle, f"batch-{batch}", _SWEEP_MIN_TRACKED)
        clock.advance(expiry + _EXPIRY_MARGIN_SECONDS)

    distinct_keys_seen = _CHURN_BATCHES * _SWEEP_MIN_TRACKED
    bound = _BOUND_MULTIPLE * _SWEEP_MIN_TRACKED
    assert len(throttle.storage.events) <= bound
    # The storage keeps a second per-key dict of locks, which grows just as
    # unboundedly as the events if eviction empties one without dropping the
    # other. Only the library's own clear covers both.
    assert len(throttle.storage.locks) <= bound
    assert len(throttle.last_attempt) <= bound
    assert distinct_keys_seen > _BOUND_MULTIPLE * bound


def test_live_key_keeps_its_spent_cap_across_a_sweep() -> None:
    """A sweep must never hand an exhausted client a fresh hourly budget.

    An attacker who has spent their cap must not be able to clear their own
    counter by spraying unrelated keys until the store sweeps. The throttle
    runs on the real clock here, so no key has aged out and eviction of the
    exhausted key would be a security regression rather than housekeeping.
    """
    throttle = _InvalidLicenseThrottle()
    victim = "victim-client"

    for _ in range(INVALID_LICENSE_MAX_PER_HOUR):
        assert throttle.record(victim) is True
    assert throttle.record(victim) is False

    _record_batch(throttle, "spray", _SWEEP_GROWTH_FACTOR * _SWEEP_MIN_TRACKED)

    assert throttle.sweep_at > _SWEEP_MIN_TRACKED
    assert throttle.exhausted(victim) is True
    assert throttle.record(victim) is False
    assert victim in throttle.last_attempt
    assert throttle.item.key_for(victim) in throttle.storage.events


def test_key_inside_the_window_is_not_evicted_at_the_boundary() -> None:
    """Eviction waits for the age to pass a full expiry, not merely reach it.

    The boundary is exclusive because the library's own membership test is
    inclusive: ``MemoryStorage`` still treats an entry as occupying a slot
    while its arrival time is no older than exactly one expiry. A key whose
    last attempt sits precisely on that bound can therefore still be holding
    its spent cap, and evicting it there would refill an attacker's budget one
    tick early. Only a strictly greater age proves every entry has left the
    window, so the throttle must be the stricter of the two.
    """
    clock = FakeClock()
    throttle = _InvalidLicenseThrottle(clock=clock)
    expiry = throttle.item.get_expiry()
    survivor = "boundary-client"

    throttle.record(survivor)
    clock.advance(expiry)
    _force_sweep(throttle, "on-boundary")

    assert survivor in throttle.last_attempt
    assert throttle.item.key_for(survivor) in throttle.storage.events

    clock.advance(_EXPIRY_MARGIN_SECONDS)
    _force_sweep(throttle, "past-boundary")

    assert survivor not in throttle.last_attempt
    assert throttle.item.key_for(survivor) not in throttle.storage.events


def test_last_attempt_is_stamped_after_the_hit_it_records(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The recorded reading lands at or after the newest window entry.

    This inequality is the whole eviction proof. The stamp is taken from the
    window's own clock *after* the hit that adds the entry, so it is never
    older than that entry's arrival time; an age past a full expiry therefore
    proves every entry has already rolled off. Stamping before the hit would
    invert the inequality and let a sweep evict a key the library still counts,
    which is an attacker clearing their own counter. The clock steps on every
    read, so the two orderings yield different readings and this assertion can
    tell them apart -- and because the library reads that same clock, the
    comparison is between two genuinely comparable numbers rather than two
    unrelated timelines.
    """
    clock = TickingClock()
    _share_clock_with_limits(monkeypatch, clock)
    throttle = _InvalidLicenseThrottle(clock=clock)
    key = "stamp-order-client"

    assert throttle.record(key) is True

    entries = throttle.storage.events[throttle.item.key_for(key)]
    assert len(entries) == 1
    assert throttle.last_attempt[key] >= max(entry.atime for entry in entries)


def test_the_window_itself_counts_a_key_until_the_expiry_passes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A spent client is still refused for the whole window, per the library.

    "Still live" has to mean what ``limits`` means by it, not merely what the
    throttle's own bookkeeping claims. Sharing one clock puts that to the test:
    a client that has spent its cap is still exhausted a second short of a full
    expiry, and is refilled only once the window has genuinely rolled past. The
    retention rule is calibrated against this, so if the two ever disagreed the
    store would be evicting keys the library would still charge.
    """
    clock = FakeClock()
    _share_clock_with_limits(monkeypatch, clock)
    throttle = _InvalidLicenseThrottle(clock=clock)
    expiry = throttle.item.get_expiry()
    spender = "window-client"

    for _ in range(INVALID_LICENSE_MAX_PER_HOUR):
        assert throttle.record(spender) is True
    assert throttle.record(spender) is False

    clock.advance(expiry - _EXPIRY_MARGIN_SECONDS)
    assert throttle.exhausted(spender) is True

    # One further second carries the clock past the boundary itself.
    clock.advance(_EXPIRY_MARGIN_SECONDS + _EXPIRY_MARGIN_SECONDS)
    assert throttle.exhausted(spender) is False


def test_peeking_at_unseen_keys_allocates_nothing() -> None:
    """The exhaustion peek is free: it tracks no key and schedules no sweep.

    Every signup attempt peeks before any outbound call is made, so a peek that
    stamped its key would reintroduce exactly the unbounded growth this store
    exists to close -- on the hottest path in the flow, keyed by whatever
    arrives. Nothing may be allocated for a key that has never failed a
    verification.
    """
    throttle = _InvalidLicenseThrottle()

    for index in range(_UNSEEN_PEEK_KEYS):
        assert throttle.exhausted(f"unseen-{index}") is False

    assert throttle.last_attempt == {}
    assert len(throttle.storage.events) == 0
    assert len(throttle.storage.locks) == 0
    assert throttle.sweep_at == _SWEEP_MIN_TRACKED


def test_denied_attempts_keep_the_key_tracked() -> None:
    """Retention follows the last attempt, not the first.

    A client that keeps hammering after exhausting its cap has a first attempt
    far outside the window but a very recent last attempt. Refreshing on a
    denied attempt only ever delays eviction, which is the safe direction: it
    keeps the counter alive for an actively abusive client.
    """
    clock = FakeClock()
    throttle = _InvalidLicenseThrottle(clock=clock)
    expiry = throttle.item.get_expiry()
    half_expiry = expiry // 2
    persistent = "persistent-client"

    for _ in range(INVALID_LICENSE_MAX_PER_HOUR):
        assert throttle.record(persistent) is True
    for _ in range(_DENIAL_ROUNDS):
        clock.advance(half_expiry)
        assert throttle.record(persistent) is False

    assert _DENIAL_ROUNDS * half_expiry > expiry
    _force_sweep(throttle, "churn")

    assert persistent in throttle.last_attempt
    assert throttle.item.key_for(persistent) in throttle.storage.events


def test_sweep_threshold_grows_with_the_live_population() -> None:
    """The next sweep is scheduled off the surviving population, not a constant.

    Rescheduling at a multiple of the live count amortises sweeping: a store
    holding many genuinely active clients does not pay a full scan on every
    recorded attempt.
    """
    clock = FakeClock()
    throttle = _InvalidLicenseThrottle(clock=clock)
    expiry = throttle.item.get_expiry()

    _record_batch(throttle, "doomed", _SWEEP_MIN_TRACKED)
    clock.advance(expiry + _EXPIRY_MARGIN_SECONDS)
    survivors = _force_sweep(throttle, "live")

    assert set(throttle.last_attempt) == set(survivors)
    assert throttle.sweep_at == max(_SWEEP_MIN_TRACKED, _SWEEP_GROWTH_FACTOR * len(survivors))
    assert throttle.sweep_at > _SWEEP_MIN_TRACKED


def test_the_sweep_mark_never_falls_below_its_floor() -> None:
    """A sweep that leaves almost nobody behind reschedules at the floor.

    The growth factor alone would collapse the mark toward zero as a burst
    drained away, and a near-empty store would then rescan itself on every
    single recorded attempt. The floor is what keeps a quiet deployment from
    sweeping constantly, so it has to be the thing setting the mark here rather
    than a multiple that happens to be large enough.
    """
    clock = FakeClock()
    throttle = _InvalidLicenseThrottle(clock=clock)
    expiry = throttle.item.get_expiry()

    doomed = _record_batch(throttle, "doomed", _SWEEP_MIN_TRACKED - _LONE_SURVIVORS)
    clock.advance(expiry + _EXPIRY_MARGIN_SECONDS)
    survivors = _record_batch(throttle, "survivor", _LONE_SURVIVORS)

    assert len(doomed) + len(survivors) == _SWEEP_MIN_TRACKED
    assert set(throttle.last_attempt) == set(survivors)
    assert _SWEEP_GROWTH_FACTOR * len(survivors) < _SWEEP_MIN_TRACKED
    assert throttle.sweep_at == _SWEEP_MIN_TRACKED


def test_reset_clears_the_store_the_tracking_and_the_threshold() -> None:
    """Reset restores a pristine throttle, which test isolation depends on."""
    for index in range(_SWEEP_MIN_TRACKED):
        record_invalid_license_attempt(f"reset-{index}")
    exhausted_key = "reset-0"
    for _ in range(INVALID_LICENSE_MAX_PER_HOUR):
        record_invalid_license_attempt(exhausted_key)

    assert invalid_license_cap_exhausted(exhausted_key) is True
    assert _invalid_license_throttle.sweep_at > _SWEEP_MIN_TRACKED

    reset_invalid_license_attempts()

    assert _invalid_license_throttle.last_attempt == {}
    assert len(_invalid_license_throttle.storage.events) == 0
    assert _invalid_license_throttle.sweep_at == _SWEEP_MIN_TRACKED
    assert invalid_license_cap_exhausted(exhausted_key) is False
    assert record_invalid_license_attempt(exhausted_key) is True


def test_facade_cap_contract_is_unchanged() -> None:
    """The public hourly cap behaves exactly as before the store was bounded."""
    client = "facade-client"
    assert invalid_license_cap_exhausted(client) is False
    for _ in range(INVALID_LICENSE_MAX_PER_HOUR):
        assert record_invalid_license_attempt(client) is True
    assert record_invalid_license_attempt(client) is False
    assert invalid_license_cap_exhausted(client) is True

    peeker = "facade-peeker"
    spent = INVALID_LICENSE_MAX_PER_HOUR // 2
    for _ in range(spent):
        assert record_invalid_license_attempt(peeker) is True
    for _ in range(_PEEK_REPEATS):
        assert invalid_license_cap_exhausted(peeker) is False
    for _ in range(INVALID_LICENSE_MAX_PER_HOUR - spent):
        assert record_invalid_license_attempt(peeker) is True
    assert record_invalid_license_attempt(peeker) is False
