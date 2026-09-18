"""Tests for global and per-endpoint rate limiting (sec-11).

Verifies that:
- All endpoints have a global default rate limit (60/minute)
- Expensive endpoints have stricter per-endpoint limits
- 429 responses include a Retry-After header
- Existing auth rate limits remain unchanged

Every limit is pinned at its exact value: each test proves the limit-th
request is admitted *and* the (limit + 1)-th request is rejected, so a
mutation that tightens a limit (e.g. 5/minute -> 2/minute) fails the test
instead of slipping through unnoticed.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from models.user import User
from rate_limit import ambient_tracked_paths, limiter, reset_ambient_limit
from tests.helpers.openapi_errors import route_index

_LIMIT_3 = 3
_LIMIT_5 = 5
_LIMIT_30 = 30
_LIMIT_60 = 60

_PRACTICE_PAYLOAD: dict[str, object] = {
    "stage_number": 1,
    "name": "Test Practice",
    "description": "Test desc",
    "instructions": "Test instructions",
    "default_duration_minutes": 10,
}


async def _signup(client: AsyncClient, username: str = "alice") -> dict[str, str]:
    """Create a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


async def _promote_admin(db_session: AsyncSession, username: str = "alice") -> None:
    """Flip ``is_admin`` for the signed-up user so they can hit admin routes."""
    email = f"{username}@example.com"
    await db_session.execute(update(User).where(col(User.email) == email).values(is_admin=True))
    await db_session.commit()


async def _assert_limit_pinned(send: Callable[[], Awaitable[Response]], limit: int) -> None:
    """Assert a rate limit is pinned at exactly ``limit`` requests per window.

    Fires ``limit - 1`` warm-up requests, asserts the ``limit``-th request is
    admitted (any non-429 status), then asserts request ``limit + 1`` is
    rejected with the standard 429 payload and a Retry-After header.
    """
    for _ in range(limit - 1):
        await send()

    admitted = await send()
    assert admitted.status_code != HTTPStatus.TOO_MANY_REQUESTS

    throttled = await send()
    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == "rate_limit_exceeded"
    assert "retry-after" in throttled.headers


def _post_practice(client: AsyncClient, headers: dict[str, str]) -> Awaitable[Response]:
    return client.post("/practices/", json=_PRACTICE_PAYLOAD, headers=headers)


def _get_journal_list(client: AsyncClient, headers: dict[str, str]) -> Awaitable[Response]:
    return client.get("/journal/", headers=headers)


def _get_content_body(client: AsyncClient, headers: dict[str, str]) -> Awaitable[Response]:
    return client.get("/course/content/1/body", headers=headers)


def _get_site_resource_body(client: AsyncClient, headers: dict[str, str]) -> Awaitable[Response]:
    return client.get("/course/site-resources/about/body", headers=headers)


# ── Default global limit ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    "path",
    [
        pytest.param("/health", id="app-level-APIRoute"),
        pytest.param("/practices/", id="include_router-mounted"),
        pytest.param("/openapi.json", id="starlette-Route"),
        pytest.param("/nope-404", id="no-route-at-all"),
    ],
)
@pytest.mark.asyncio
async def test_default_rate_limit_pinned_at_60_per_minute(
    async_client: AsyncClient, path: str
) -> None:
    """Any request with no ``@limiter.limit()`` of its own meets the 60/minute floor.

    Parametrized over the four shapes a request can have (#2909), because for
    years this test asserted the claim in its own name while exercising only the
    first of them. ``/health`` is mounted on the application object itself, and
    it was the single shape ``SlowAPIMiddleware`` could still resolve to a
    handler: every ``include_router`` route resolved to ``None`` and was treated
    as exempt, and a request matching no route never had a handler to begin
    with. This test was green for all of that. Its green is what made the gap
    invisible, so the fix is not a new test beside it -- it is these four cases
    in the place the claim was already being made.

    The first two are the regression guards that must stay green; ``/health``'s
    case is the original assertion, unchanged.
    """

    async def send() -> Response:
        return await async_client.get(path)

    await _assert_limit_pinned(send, _LIMIT_60)


# The quick-log tile posts one check-in per tap, on one static path, with no
# batching. A user counting reps at about a tap a second spends the ambient
# allowance inside a minute, so that path declares a floor sized to its own
# interaction. Pinned here rather than derived, so widening it is a deliberate
# edit to a test rather than a number nobody looks at.
_QUICK_LOG_PATH = "/goal_completions/"
_QUICK_LOG_LIMIT = 180


@pytest.mark.asyncio
async def test_the_quick_log_path_is_floored_at_its_own_interaction_rate(
    async_client: AsyncClient,
) -> None:
    """Quick Log Mode must survive a minute of tapping, and still have a ceiling.

    ``HabitsScreen``'s quick-log tile calls ``logUnit`` on every tap, which is
    one ``POST /goal_completions/`` per tap: no batching, no coalescing, one
    static path. At roughly a tap a second -- counting reps, counting ounces --
    the ambient 60/minute refuses from tap 61, the optimistic increment is
    rolled back out of the store and the on-disk snapshot, and the user is told
    they are sending a lot of requests for using the feature as designed.

    A declared ``@limiter.limit`` cannot answer this: the floor is charged in
    middleware, before routing, so a per-route limit can only ever tighten what
    the floor already allowed. The allowance therefore belongs to the floor, is
    named for the one path that needs it, and is still a cap -- asserted at both
    boundaries so it can neither shrink back under the tapping rate nor quietly
    become unlimited.
    """

    async def send() -> Response:
        return await async_client.post(_QUICK_LOG_PATH, json={"goal_id": 1})

    await _assert_limit_pinned(send, _QUICK_LOG_LIMIT)


# ── Retry-After header ──────────────────────────────────────────────────


# The two windows the declared limits use, and the two answers a refusal from
# each of them may honestly advertise. Named so the assertions below read as
# "its own window" rather than as two unexplained integers.
_ONE_MINUTE_SECONDS = 60
_ONE_HOUR_SECONDS = 3600

_RESET_REQUEST_PATH = "/auth/password-reset/request"
_RESET_REQUESTS_PER_HOUR = 3


@pytest.mark.asyncio
async def test_a_decorator_refusal_advertises_its_own_window(async_client: AsyncClient) -> None:
    """A 429 must say when the bucket it refused actually admits again.

    ``slowapi.errors.RateLimitExceeded`` carries ``limit`` and nothing else --
    it has no ``retry_after`` attribute at all -- so the handler's
    ``getattr(exc, "retry_after", 60)`` took its fallback on *every* decorator
    refusal. ``POST /auth/password-reset/request`` declares ``3/hour``, and a
    client told to come back in 60 seconds retries roughly 56 more times before
    its window rolls off: precisely the tight loop ``_MIN_RETRY_AFTER_SECONDS``
    exists to break, live on the other half of the system.

    Both windows are asserted, in both directions, so a handler that answers one
    hardcoded number cannot pass: an hourly limit must advertise more than a
    minute, and a per-minute limit must not advertise an hour.
    """
    hourly = [
        await async_client.post(_RESET_REQUEST_PATH, json={"email": "reset@example.com"})
        for _ in range(_RESET_REQUESTS_PER_HOUR + 1)
    ][-1]
    assert hourly.status_code == HTTPStatus.TOO_MANY_REQUESTS
    hourly_wait = int(hourly.headers["retry-after"])
    assert _ONE_MINUTE_SECONDS < hourly_wait <= _ONE_HOUR_SECONDS

    per_minute = [
        await async_client.post(
            "/auth/login",
            json={
                "email": "nobody@example.com",
                "password": "wrongpassword1",  # pragma: allowlist secret
            },
        )
        for _ in range(_LIMIT_5 + 1)
    ][-1]
    assert per_minute.status_code == HTTPStatus.TOO_MANY_REQUESTS
    per_minute_wait = int(per_minute.headers["retry-after"])
    assert 0 < per_minute_wait <= _ONE_MINUTE_SECONDS


@pytest.mark.asyncio
async def test_rate_limit_response_includes_retry_after(async_client: AsyncClient) -> None:
    """429 responses include a Retry-After header, pinned at signup's 3/minute limit."""
    emails = iter(range(_LIMIT_3 + 1))

    async def send() -> Response:
        return await async_client.post(
            "/auth/signup",
            json={
                "email": f"retryafter{next(emails)}@example.com",
                "password": "secret12345",  # pragma: allowlist secret
            },
        )

    await _assert_limit_pinned(send, _LIMIT_3)


# ── Per-endpoint: POST /user/balance/add (5/minute) ─────────────────────


@pytest.mark.asyncio
async def test_add_balance_rate_limit_pinned_at_5_per_minute(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """POST /user/balance/add is pinned at exactly 5 requests/minute.

    The endpoint is admin-only, so promote before hammering to verify the
    rate-limit gate fires *after* authz.
    """
    headers = await _signup(async_client)
    await _promote_admin(db_session)

    async def send() -> Response:
        return await async_client.post(
            "/user/balance/add",
            json={"amount": 1},
            headers=headers,
        )

    await _assert_limit_pinned(send, _LIMIT_5)


async def _put_corpus_consent(client: AsyncClient, headers: dict[str, str]) -> Response:
    """Re-send one consent decision, the request that authorises a backfill sweep."""
    return await client.put("/corpus/consent/journal", json={"granted": True}, headers=headers)


# ── Per-endpoint limits pinned exactly ───────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("make_request", "limit"),
    [
        (_post_practice, _LIMIT_5),
        (_get_journal_list, _LIMIT_30),
        (_get_content_body, _LIMIT_30),
        (_get_site_resource_body, _LIMIT_30),
        (_put_corpus_consent, _LIMIT_5),
    ],
    ids=[
        "post-practices-pinned-at-5-per-minute",
        "get-journal-list-pinned-at-30-per-minute",
        "get-content-body-pinned-at-30-per-minute",
        "get-site-resource-body-pinned-at-30-per-minute",
        "put-corpus-consent-pinned-at-5-per-minute",
    ],
)
async def test_per_endpoint_rate_limit_pinned(
    async_client: AsyncClient,
    make_request: Callable[[AsyncClient, dict[str, str]], Awaitable[Response]],
    limit: int,
) -> None:
    """Each per-route limit is pinned at exactly its documented value."""
    headers = await _signup(async_client)

    async def send() -> Response:
        return await make_request(async_client, headers)

    await _assert_limit_pinned(send, limit)


# ── Auth rate limits unchanged ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_auth_signup_limit_unchanged_at_3_per_minute(async_client: AsyncClient) -> None:
    """Auth signup rate limit remains at 3/minute (not overridden by default)."""
    for i in range(_LIMIT_3 - 1):
        await async_client.post(
            "/auth/signup",
            json={
                "email": f"auth{i}@example.com",
                "password": "secret12345",  # pragma: allowlist secret
            },
        )

    third = await async_client.post(
        "/auth/signup",
        json={
            "email": "auth-third@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert third.status_code == HTTPStatus.OK

    fourth = await async_client.post(
        "/auth/signup",
        json={
            "email": "auth-fourth@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert fourth.status_code == HTTPStatus.TOO_MANY_REQUESTS


@pytest.mark.asyncio
async def test_auth_login_limit_unchanged_at_5_per_minute(async_client: AsyncClient) -> None:
    """Auth login rate limit remains at 5/minute (not overridden by default)."""
    await _signup(async_client)

    login_payload = {
        "email": "alice@example.com",
        "password": "secret12345",  # pragma: allowlist secret
    }

    for _ in range(_LIMIT_5 - 1):
        await async_client.post("/auth/login", json=login_payload)

    fifth = await async_client.post("/auth/login", json=login_payload)
    assert fifth.status_code == HTTPStatus.OK

    sixth = await async_client.post("/auth/login", json=login_payload)
    assert sixth.status_code == HTTPStatus.TOO_MANY_REQUESTS


# ── Feedback intake: both axes ───────────────────────────────────────────

_LIMIT_10 = 10

_FEEDBACK_PAYLOAD: dict[str, object] = {
    "category": "broken",
    "impact": "blocked",
    "summary": "The habit card vanished.",
    "context": {
        "screen": "journal.shelf",
        "platform": "ios",
        "app_build": "1.4.2",
        "viewport_class": "compact",
    },
}


@pytest.mark.asyncio
async def test_post_feedback_limit_pinned_at_10_per_hour(async_client: AsyncClient) -> None:
    """The per-account axis, pinned exactly.

    An intake endpoint is the most articulate denial-of-service primitive an
    application can offer -- every request writes a row carrying four
    encrypted text columns -- so the budget is deliberately far below what a
    person filing reports by hand would ever reach.
    """
    headers = await _signup(async_client, "feedback_rate_account")

    async def send() -> Response:
        return await async_client.post("/feedback/", json=_FEEDBACK_PAYLOAD, headers=headers)

    await _assert_limit_pinned(send, _LIMIT_10)


@pytest.mark.asyncio
async def test_the_feedback_budget_follows_the_account_not_the_address(
    async_client: AsyncClient,
) -> None:
    """A second account behind the same address still has its own budget.

    This is what the per-user key function buys, and the assertion that proves
    it is wired: under a naive IP-keyed limit two testers on one office network
    would throttle each other out of reporting anything.
    """
    exhausted = await _signup(async_client, "feedback_rate_first")
    for _ in range(_LIMIT_10 + 1):
        await async_client.post("/feedback/", json=_FEEDBACK_PAYLOAD, headers=exhausted)
    blocked = await async_client.post("/feedback/", json=_FEEDBACK_PAYLOAD, headers=exhausted)
    assert blocked.status_code == HTTPStatus.TOO_MANY_REQUESTS

    neighbour = await _signup(async_client, "feedback_rate_second")
    admitted = await async_client.post("/feedback/", json=_FEEDBACK_PAYLOAD, headers=neighbour)

    assert admitted.status_code == HTTPStatus.CREATED


@pytest.mark.asyncio
async def test_the_feedback_address_budget_stops_a_third_account_on_one_address(
    async_client: AsyncClient,
) -> None:
    """The per-address axis, pinned, and proven to bind independently of the account.

    Two accounts spend the whole address budget between them; a third, whose own
    account budget is untouched, is refused on its very first request. That is
    the only shape that distinguishes the address axis from the account one.

    The axis is declared on the route rather than inherited, and since #2909
    that is a choice rather than a necessity: the ambient floor now does reach
    this route, but inheriting 60/minute here would loosen this axis 180x, so
    the two compose -- floor underneath, 20/hour ceiling on top. The whole case
    spends 21 requests on ``/feedback/`` and 3 on ``/auth/signup``, both well
    under the per-path floor, so nothing below is measuring the floor by
    accident.
    """
    for index in range(2):
        headers = await _signup(async_client, f"feedback_addr_{index}")
        for _ in range(_LIMIT_10):
            spent = await async_client.post("/feedback/", json=_FEEDBACK_PAYLOAD, headers=headers)
            assert spent.status_code == HTTPStatus.CREATED

    third = await _signup(async_client, "feedback_addr_third")
    refused = await async_client.post("/feedback/", json=_FEEDBACK_PAYLOAD, headers=third)

    assert refused.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert refused.json()["detail"] == "rate_limit_exceeded"


@pytest.mark.asyncio
async def test_a_refused_retry_does_not_spend_the_shared_address_budget(
    async_client: AsyncClient,
) -> None:
    """One account's rejected retries must not lock out everybody behind its address.

    ``slowapi`` evaluates a route's limits in registration order, and
    ``__evaluate_limits`` calls ``hit()`` -- which *bills* the bucket -- on each
    one until a limit refuses, then breaks. So whichever axis is evaluated first
    is charged for every request, including the ones the second axis is about to
    reject. Registered address-first, an account that has exhausted its own
    budget goes on draining the budget it shares with everyone on that address,
    and a client looping on a failed submit takes the whole office offline:
    exactly the denial-of-service shape this endpoint is warned about.

    So the account axis is registered first. Here one account spends its ten and
    then retries ten more times in vain; a second account's first report must
    still be accepted, because those ten refusals cost the shared axis nothing.

    Since #2909 an ambient 60/minute floor sits underneath both axes. It cannot
    confuse this case: it is keyed per path, so a refused retry at ``/feedback/``
    bills no other route, and the 21 requests here stay well under it.
    """
    greedy = await _signup(async_client, "feedback_greedy")
    for _ in range(_LIMIT_10):
        spent = await async_client.post("/feedback/", json=_FEEDBACK_PAYLOAD, headers=greedy)
        assert spent.status_code == HTTPStatus.CREATED
    for _ in range(_LIMIT_10):
        refused = await async_client.post("/feedback/", json=_FEEDBACK_PAYLOAD, headers=greedy)
        assert refused.status_code == HTTPStatus.TOO_MANY_REQUESTS

    neighbour = await _signup(async_client, "feedback_neighbour")
    admitted = await async_client.post("/feedback/", json=_FEEDBACK_PAYLOAD, headers=neighbour)

    assert admitted.status_code == HTTPStatus.CREATED


# ── The ambient floor reaches every request (#2909) ──────────────────────
#
# Until #2909 these tests were impossible to write against anything but
# ``/health``: ``SlowAPIMiddleware`` resolved a request to its handler by
# walking ``app.routes`` for ``.endpoint``, FastAPI 0.141 puts
# ``_IncludedRouter`` wrappers there that expose none, and a handler-less
# request was treated as *exempt*. The mechanism failed open for 141 of the
# 144 mounted routes, and every one of the tests above stayed green while it
# did. Each test below fails at HEAD~ with the unthrottled status named in its
# docstring, which is what makes it coverage rather than decoration.

_UNMATCHED_PATH = "/nope-404"
_MALFORMED_JSON_BODY = b"{not json"
_LOGIN_PROBE_REQUESTS = 8


@pytest.mark.asyncio
async def test_the_ambient_default_reaches_a_router_mounted_route(
    async_client: AsyncClient,
) -> None:
    """A router-mounted, undecorated route is subject to the 60/minute floor.

    ``GET /practices/`` declares no limit of its own and is mounted through
    ``include_router``. Before #2909 it answered 401 seventy times over.
    """

    async def send() -> Response:
        return await async_client.get("/practices/")

    await _assert_limit_pinned(send, _LIMIT_60)


@pytest.mark.asyncio
async def test_an_unauthenticated_flood_at_a_decorated_route_is_still_throttled(
    async_client: AsyncClient,
) -> None:
    """A decorated route's own limit cannot see a flood that never reaches it.

    ``@limiter.limit`` wraps the *endpoint*, so it fires only after dependency
    resolution: an unauthenticated flood is refused by ``get_current_user``
    first and is charged to nothing. ``GET /journal/`` declares 30/minute and
    answered 401 seventy times over before #2909. The ambient floor is what
    gives it a bound, so this pins 60 rather than 30.
    """

    async def send() -> Response:
        return await async_client.get("/journal/")

    await _assert_limit_pinned(send, _LIMIT_60)


@pytest.mark.asyncio
async def test_a_malformed_body_flood_at_the_login_route_is_throttled(
    async_client: AsyncClient,
) -> None:
    """A body the framework rejects is still a request somebody has to pay for.

    ``POST /auth/login`` declares 5/minute, but a body Pydantic refuses never
    reaches the decorated endpoint: the 422 is raised during request parsing.
    This is the case no dependency-based design can cover either, because
    dependencies resolve on the same side of that refusal.
    """

    async def send() -> Response:
        return await async_client.post(
            "/auth/login",
            content=_MALFORMED_JSON_BODY,
            headers={"Content-Type": "application/json"},
        )

    await _assert_limit_pinned(send, _LIMIT_60)


@pytest.mark.asyncio
async def test_a_flood_at_an_unmatched_path_is_throttled(async_client: AsyncClient) -> None:
    """A path that matches no route is the cheapest flood to send and must cost.

    Enforcement that needs a route to point at cannot bound a 404 storm; this
    one answered 404 seventy times over before #2909.
    """

    async def send() -> Response:
        return await async_client.get(_UNMATCHED_PATH)

    await _assert_limit_pinned(send, _LIMIT_60)


@pytest.mark.asyncio
async def test_exhausting_one_path_does_not_lock_out_another(
    async_client: AsyncClient,
) -> None:
    """The ambient bucket is per path, so no client can shut itself out of the API.

    A floor charged per client alone would mean one runaway screen taking the
    whole application away from that client -- including the health probes an
    operator reads to find out why.
    """
    for _ in range(_LIMIT_60 + 1):
        await async_client.get("/practices/")
    spent = await async_client.get("/practices/")
    assert spent.status_code == HTTPStatus.TOO_MANY_REQUESTS

    neighbour = await async_client.get("/course/site-resources")
    assert neighbour.status_code == HTTPStatus.UNAUTHORIZED

    probe = await async_client.get("/health/live")
    assert probe.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_a_decorated_route_still_refuses_at_its_own_tighter_limit(
    async_client: AsyncClient,
) -> None:
    """The floor never becomes the binding constraint for traffic that lands.

    Every one of the 27 declared limits is tighter than 60/minute, so a
    well-formed request stream meets its route's own limit long before the
    ambient one. ``POST /auth/login`` declares 5/minute: the sixth request is
    refused, not the sixty-first.
    """
    responses = [
        await async_client.post(
            "/auth/login",
            json={
                "email": "floor@example.com",
                "password": "secret12345",  # pragma: allowlist secret
            },
        )
        for _ in range(_LOGIN_PROBE_REQUESTS)
    ]

    assert responses[_LIMIT_5 - 1].status_code != HTTPStatus.TOO_MANY_REQUESTS
    assert responses[_LIMIT_5].status_code == HTTPStatus.TOO_MANY_REQUESTS


# The 27 limits declared with ``@limiter.limit``, frozen. This table is the
# ratchet for #2909: the ambient floor was added *underneath* these, and the
# one way that change could do harm is by disturbing one of them. Reading it
# back from the limiter proves the decorators registered what the source says,
# which a grep over the router modules could not.
_DECLARED_ROUTE_LIMITS: dict[str, tuple[str, ...]] = {
    "routers.admin.grant_entitlement": ("10 per 1 minute",),
    "routers.admin.revoke_entitlement": ("10 per 1 minute",),
    "routers.auth.apple_oauth_signin": ("5 per 1 minute",),
    "routers.auth.cancel_password_reset": ("10 per 1 hour",),
    "routers.auth.confirm_password_reset": ("5 per 1 hour",),
    "routers.auth.google_oauth_signin": ("5 per 1 minute",),
    "routers.auth.login": ("5 per 1 minute",),
    "routers.auth.refresh_token": ("1 per 1 minute",),
    "routers.auth.request_password_reset": ("3 per 1 hour",),
    "routers.auth.signup": ("3 per 1 minute",),
    "routers.botmason.add_balance": ("5 per 1 minute",),
    "routers.corpus.import_corpus_document": ("20 per 1 minute",),
    "routers.corpus.put_corpus_consent": ("5 per 1 minute",),
    "routers.course.get_content_body": ("30 per 1 minute",),
    "routers.course.get_site_resource_body": ("30 per 1 minute",),
    "routers.course.get_stage_intro_body": ("30 per 1 minute",),
    "routers.feedback.submit_feedback": ("10 per 1 hour", "20 per 1 hour"),
    "routers.journal.detect_entry_suggestions": ("10 per 1 minute",),
    "routers.journal.expand_marginalia_essay": ("10 per 1 minute",),
    "routers.journal.list_journal_entries": ("30 per 1 minute",),
    "routers.journal.list_voice_drafts": ("30 per 1 minute",),
    "routers.journal.run_resonance": ("10 per 1 minute",),
    "routers.practice_share.create_share_link": ("10 per 1 hour",),
    "routers.practice_share.import_share_link": ("30 per 1 hour",),
    "routers.practice_share.preview_share_link": ("30 per 1 hour",),
    "routers.practices.submit_practice": ("5 per 1 minute",),
    "routers.transcription.transcribe_page": ("20 per 1 minute",),
}

# One sentinel for every ``{param}`` segment. The coverage guard below only
# needs the request to *arrive*; what it resolves to is irrelevant, because the
# ambient floor is charged before any handler or dependency runs.
_PATH_PARAM_SENTINEL = "1"
_PATH_PARAM = re.compile(r"\{[^}]+\}")

# 144 mounted ``APIRoute``s share 118 distinct paths. Pinned so a future router
# that collapses the walk (the failure mode #2909 itself was) fails here rather
# than quietly guarding fewer paths than it claims.
_DISTINCT_MOUNTED_PATHS = 118


def test_every_declared_route_limit_matches_the_frozen_table() -> None:
    """The 27 declared limits are exactly what they were before the ambient floor.

    Also a tripwire for the one regression the new layer could hide: slowapi's
    ``@limiter.exempt`` and ``request_filter`` escape hatches govern the
    *decorator* path only. Both registries are empty today; if one ever fills,
    the exemption would half-apply -- honoured by the decorators, ignored by the
    ambient floor -- and this assertion is what says so out loud.
    """
    assert limiter.declared_route_limits() == _DECLARED_ROUTE_LIMITS
    assert limiter.exempt_route_names() == frozenset()
    assert limiter.request_filter_count() == 0


@pytest.mark.asyncio
async def test_every_mounted_path_is_charged_to_the_ambient_budget(
    async_client: AsyncClient,
) -> None:
    """Every distinct mounted path is charged, not merely the three app-level ones.

    Deliberately iterates distinct *paths* with a reset between them rather than
    routes: 144 routes share 118 paths, the ambient bucket is keyed per path,
    and a per-route walk would see the second and third method on a shared path
    charged to a bucket the first already spent.
    """
    by_path: dict[str, str] = {}
    for method, path in route_index():
        by_path.setdefault(path, method)

    assert len(by_path) == _DISTINCT_MOUNTED_PATHS

    for path, method in sorted(by_path.items()):
        reset_ambient_limit()
        concrete = _PATH_PARAM.sub(_PATH_PARAM_SENTINEL, path)
        await async_client.request(method, concrete)
        assert concrete in ambient_tracked_paths(), f"{method} {concrete} was not charged"
