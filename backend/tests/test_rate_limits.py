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

from collections.abc import Awaitable, Callable
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from models.user import User

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


@pytest.mark.asyncio
async def test_default_rate_limit_pinned_at_60_per_minute(async_client: AsyncClient) -> None:
    """A route with no ``@limiter.limit()`` override inherits the 60/minute default."""

    async def send() -> Response:
        return await async_client.get("/health")

    await _assert_limit_pinned(send, _LIMIT_60)


# ── Retry-After header ──────────────────────────────────────────────────


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
    the only shape that distinguishes the address axis from the account one --
    and it is declared on the route rather than inherited, because the ambient
    default the rest of this application relies on does not reach any route
    mounted through ``include_router`` under FastAPI 0.141 (``slowapi`` resolves
    a request to its handler by reading ``.endpoint`` off ``app.routes``, which
    now holds ``_IncludedRouter`` wrappers that do not expose one).
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
