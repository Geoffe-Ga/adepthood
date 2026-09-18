"""The ambient rate-limit floor, tested without a route to point at (#2909).

This suite exists in this shape on purpose. The defect it closes was that
enforcement needed to resolve a request to a *handler* before it would act:
``SlowAPIMiddleware`` walked ``app.routes`` reading ``.endpoint``, FastAPI
0.141 puts ``_IncludedRouter`` wrappers there that expose none, and a
handler-less request was treated as exempt. The mechanism failed open for 141
of 144 mounted routes while every test in the suite stayed green, because the
only test that exercised the default limit used ``/health`` -- an app-level
route, the one shape that still resolved.

So the structural claim is made executable here: the layer is mounted on a
Starlette application with **zero routes** and must still refuse. A test that
can only be written against a route cannot distinguish "enforced everywhere"
from "enforced where a handler happens to resolve".
"""

from __future__ import annotations

import time

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient

from middleware import AmbientRateLimitMiddleware
from rate_limit import (
    _MAX_PATHS_PER_CLIENT,
    _MIN_RETRY_AFTER_SECONDS,
    _OVERFLOW_PATH_MARKER,
    _PATH_BURST_FLOORS,
    _PATH_COMPONENT,
    AMBIENT_LIMIT_ITEM,
    DEFAULT_RATE_LIMIT,
    AmbientThrottle,
    _requests_per_second,
    ambient_tracked_paths,
    charge_ambient_limit,
    floor_for_path,
    limiter,
    rate_limit_exceeded_response,
    reset_ambient_limit,
)

_AMBIENT_ALLOWANCE = 60
_OK = 200
_TOO_MANY_REQUESTS = 429
# Small enough that the saturation tests reach the ceiling in a few charges
# instead of driving the production one. The production value is driven for
# real by the cross-client test below, which is the property that matters.
_CEILING_PROBE = 8

# An ordinary client's shape while an attacker is saturating: a handful of
# screens, several requests each, all comfortably inside one client's own
# budget. 12 x 10 is deliberately twice the ambient allowance in total, so a
# client wrongly collapsed onto a single bucket is refused half of it.
_ORDINARY_PATHS = 12
_ORDINARY_REQUESTS_PER_PATH = 10

# Far enough past a 60-second window that its reset time is already behind us.
_WELL_PAST_THE_WINDOW = 3600.0

_CLIENT = "198.51.100.7"
_OTHER_CLIENT = "203.0.113.9"
_PATH = "/anything"
_OTHER_PATH = "/anything-else"


@pytest.fixture
def route_less_client() -> TestClient:
    """A Starlette app carrying the floor and nothing else -- no routes at all."""
    app = Starlette()
    app.add_middleware(AmbientRateLimitMiddleware)
    return TestClient(app)


def test_the_ambient_limit_admits_exactly_sixty() -> None:
    """The floor is the 60/minute the application advertises, pinned at the boundary."""
    assert DEFAULT_RATE_LIMIT == "60/minute"

    admitted = [charge_ambient_limit(_CLIENT, _PATH) for _ in range(_AMBIENT_ALLOWANCE)]
    assert admitted == [None] * _AMBIENT_ALLOWANCE

    refused = charge_ambient_limit(_CLIENT, _PATH)
    assert refused is not None
    assert refused > 0


def test_buckets_are_separate_per_path_and_per_client_key() -> None:
    """Spending one bucket leaves every other client's and every other path's intact."""
    for _ in range(_AMBIENT_ALLOWANCE + 1):
        charge_ambient_limit(_CLIENT, _PATH)
    assert charge_ambient_limit(_CLIENT, _PATH) is not None

    assert charge_ambient_limit(_CLIENT, _OTHER_PATH) is None
    assert charge_ambient_limit(_OTHER_CLIENT, _PATH) is None


def test_a_route_less_app_is_still_throttled(route_less_client: TestClient) -> None:
    """The structural claim, executable: no routes, no handler, still a floor.

    Nothing in the enforcement path may consult ``app.routes``,
    ``scope["route"]``, ``.endpoint`` or slowapi's ``_route_limits``. On this
    application every one of those is empty or absent, so a layer that read any
    of them would answer 404 sixty-one times over instead of refusing.
    """
    statuses = [route_less_client.get(_PATH).status_code for _ in range(_AMBIENT_ALLOWANCE)]
    assert _TOO_MANY_REQUESTS not in statuses

    throttled = route_less_client.get(_PATH)
    assert throttled.status_code == _TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == "rate_limit_exceeded"
    assert "retry-after" in throttled.headers


def test_disabling_the_limiter_passes_everything_through(route_less_client: TestClient) -> None:
    """``limiter.enabled`` stays the single kill switch for both layers.

    ``conftest``'s ``disable_rate_limit`` fixture and ``tests/e2e/server.py``
    both turn rate limiting off by flipping exactly this flag. If the ambient
    floor read its own switch instead, those two would silently stop working
    and the failures would land in unrelated suites.
    """
    limiter.enabled = False
    try:
        statuses = [route_less_client.get(_PATH).status_code for _ in range(_AMBIENT_ALLOWANCE + 1)]
    finally:
        limiter.enabled = True

    assert _TOO_MANY_REQUESTS not in statuses


def test_the_middleware_envelope_matches_the_decorator_envelope(
    route_less_client: TestClient,
) -> None:
    """One 429 definition, used by both layers -- byte-identical body and headers."""
    for _ in range(_AMBIENT_ALLOWANCE):
        route_less_client.get(_PATH)
    throttled = route_less_client.get(_PATH)

    reference = rate_limit_exceeded_response(int(throttled.headers["retry-after"]))
    assert throttled.status_code == reference.status_code
    assert throttled.content == reference.body
    assert throttled.headers["content-type"] == reference.headers["content-type"]
    assert throttled.headers["retry-after"] == reference.headers["Retry-After"]


def _fill_to_the_sweep_mark(throttle: AmbientThrottle, prefix: str) -> None:
    """Charge exactly as many fresh buckets as it takes to trigger one sweep."""
    for index in range(throttle.sweep_at - len(throttle.last_attempt)):
        throttle.charge(_OTHER_CLIENT, f"{prefix}{index}")


def test_one_clients_fan_out_cannot_narrow_another_clients_budget() -> None:
    """Saturation by one address must not downgrade everyone else to one bucket.

    Driven against the production ceiling with the production constants, no
    injection, because the thing being ruled out is a property of the shipped
    numbers. What this replaces asserted ``ceiling > sweep floor`` -- two module
    constants, no object under test -- and certified a behaviour it never
    exercised. The behaviour it certified was false: the ceiling counted keys
    across *all* clients, so one address opening enough buckets pinned the store
    at the ceiling and every other client's first request to any path it had not
    already touched was diverted to a single per-client overflow bucket. Its
    60/minute *per path* silently became 60/minute across the whole API, health
    probes included.
    """
    throttle = AmbientThrottle()
    for index in range(_MAX_PATHS_PER_CLIENT + _CEILING_PROBE):
        throttle.charge(_CLIENT, f"/flood-{index}")

    ordinary = [
        throttle.charge(_OTHER_CLIENT, f"/screen-{screen}")
        for screen in range(_ORDINARY_PATHS)
        for _ in range(_ORDINARY_REQUESTS_PER_PATH)
    ]

    assert ordinary == [None] * (_ORDINARY_PATHS * _ORDINARY_REQUESTS_PER_PATH)
    assert (_OTHER_CLIENT, _OVERFLOW_PATH_MARKER) not in throttle.last_attempt
    assert throttle.charge(_OTHER_CLIENT, "/health/live") is None


def test_a_saturated_client_reclaims_its_buckets_after_a_full_window() -> None:
    """Reaching the ceiling must be a phase, not a one-way door.

    The ceiling stops an unseen path minting a key, and sweeping is what gives
    the keys back once their windows roll off. Those two have to compose: a
    client that saturated and then waited out a full window must find its own
    per-path budgets again, and the buckets it abandoned must actually leave the
    store. The sweep only ever ran on a *growing* population, so a store held at
    its ceiling stopped sweeping altogether and the diversion became permanent.
    """
    now = [0.0]
    throttle = AmbientThrottle(clock=lambda: now[0], max_paths_per_client=_CEILING_PROBE)
    for index in range(_CEILING_PROBE):
        throttle.charge(_CLIENT, f"/flood-{index}")
    throttle.charge(_CLIENT, "/diverted")
    assert (_CLIENT, _OVERFLOW_PATH_MARKER) in throttle.last_attempt

    now[0] = throttle.item.get_expiry() * 2 + 1
    assert throttle.charge(_CLIENT, "/after-the-window") is None

    assert (_CLIENT, "/after-the-window") in throttle.last_attempt
    assert not [key for key in throttle.last_attempt if key[_PATH_COMPONENT].startswith("/flood-")]


def test_the_burst_floor_can_only_widen_the_ambient_one() -> None:
    """A path floor is an allowance for a known interaction, never a tightening.

    The ambient item is what the ``ADEPTHOOD_DEFAULT_RATE_LIMIT`` override
    moves, and the DAST contract-fuzz job widens it enormously. A per-path
    allowance that simply replaced the ambient item would quietly *undo* that
    override on exactly the paths it names, so the wider of the two wins.
    """
    for path, floor in _PATH_BURST_FLOORS.items():
        assert floor_for_path(path) is floor
        assert _requests_per_second(floor) > _requests_per_second(AMBIENT_LIMIT_ITEM)

    assert floor_for_path(_PATH) is AMBIENT_LIMIT_ITEM


def test_a_key_is_evicted_only_after_a_full_window() -> None:
    """An attacker must not be able to clear their own counter by provoking a sweep.

    The sweep is what bounds the store, and the only dangerous way to get that
    wrong is to evict early: a bucket whose window has not fully rolled off
    still holds live entries, so dropping it hands its owner a fresh budget.
    Asserted on *premature* eviction with an injected clock -- a test that only
    checked "the store shrinks" would pass a threshold mutated to half a window.
    """
    now = [0.0]
    throttle = AmbientThrottle(clock=lambda: now[0])
    expiry = throttle.item.get_expiry()

    victim = (_CLIENT, _PATH)
    throttle.charge(*victim)

    # Exactly one expiry old: the library still counts an entry at the boundary,
    # so evicting here would be evicting a live bucket.
    now[0] = expiry
    _fill_to_the_sweep_mark(throttle, "/churn-")
    assert victim in throttle.last_attempt

    now[0] = expiry * 2 + 1
    _fill_to_the_sweep_mark(throttle, "/later-")
    assert victim not in throttle.last_attempt


def test_saturation_charges_the_per_client_overflow_bucket() -> None:
    """Past the ceiling an unseen path mints no key; it is billed to its own client.

    The bucket is keyed on the raw request path, which an attacker controls, so
    an unbounded store would let a 404 flood of random paths grow it without
    limit inside a single window -- nothing has rolled off yet for the sweep to
    reclaim. Degradation has to be fail-closed (the flood pins its own sender at
    the floor) and strictly per client: one tenant reaching its ceiling must
    neither move another tenant's counter nor divert another tenant's traffic --
    the second client here goes on minting its own per-path buckets until it
    reaches a ceiling of its own, and gets an overflow bucket of its own when it
    does.
    """
    throttle = AmbientThrottle(max_paths_per_client=_CEILING_PROBE)

    for index in range(_CEILING_PROBE):
        throttle.charge(_CLIENT, f"/flood-{index}")
    assert len(throttle.last_attempt) == _CEILING_PROBE

    throttle.charge(_CLIENT, "/one-more")
    assert (_CLIENT, "/one-more") not in throttle.last_attempt
    assert (_CLIENT, _OVERFLOW_PATH_MARKER) in throttle.last_attempt

    mine = throttle.last_attempt[_CLIENT, _OVERFLOW_PATH_MARKER]
    throttle.charge(_OTHER_CLIENT, "/one-more")
    assert (_OTHER_CLIENT, "/one-more") in throttle.last_attempt
    assert (_OTHER_CLIENT, _OVERFLOW_PATH_MARKER) not in throttle.last_attempt
    assert throttle.last_attempt[_CLIENT, _OVERFLOW_PATH_MARKER] == mine

    for index in range(_CEILING_PROBE):
        throttle.charge(_OTHER_CLIENT, f"/theirs-{index}")
    throttle.charge(_OTHER_CLIENT, "/and-one-more")
    assert (_OTHER_CLIENT, _OVERFLOW_PATH_MARKER) in throttle.last_attempt
    assert throttle.last_attempt[_CLIENT, _OVERFLOW_PATH_MARKER] == mine


def test_an_existing_bucket_survives_saturation() -> None:
    """The ceiling diverts only *unseen* paths; a bucket already tracked keeps its own.

    Saturation is driven by the same client here, because the ceiling bounds one
    client's fan-out: another client's flood is none of this client's business
    and is the subject of its own test above.
    """
    throttle = AmbientThrottle(max_paths_per_client=_CEILING_PROBE)
    throttle.charge(_CLIENT, _PATH)
    for index in range(_CEILING_PROBE):
        throttle.charge(_CLIENT, f"/flood-{index}")

    throttle.charge(_CLIENT, _PATH)
    assert (_CLIENT, _PATH) in throttle.last_attempt
    assert throttle.charge(_CLIENT, _PATH) is None


def test_reset_clears_every_ambient_bucket() -> None:
    """Isolation seam: ``conftest``'s autouse reset has to empty this store too."""
    charge_ambient_limit(_CLIENT, _PATH)
    assert ambient_tracked_paths() == frozenset({_PATH})

    reset_ambient_limit()
    assert ambient_tracked_paths() == frozenset()


def test_the_retry_after_never_falls_below_one_second() -> None:
    """A ``Retry-After: 0`` invites an immediate retry, which is not what a 429 means.

    Reached by reading the window through a clock already past its reset, the
    shape a real request meets at the very end of a window.
    """
    throttle = AmbientThrottle(clock=lambda: time.time() + _WELL_PAST_THE_WINDOW)
    for _ in range(_AMBIENT_ALLOWANCE):
        throttle.charge(_CLIENT, _PATH)

    retry_after = throttle.charge(_CLIENT, _PATH)
    assert retry_after == _MIN_RETRY_AFTER_SECONDS
