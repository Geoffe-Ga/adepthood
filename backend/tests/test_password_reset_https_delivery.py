"""The handler and the HTTPS adapter have to compose, and neither suite proves it.

Every other reset test overrides the email dependency with an in-memory
recorder, so what it pins is the body the handler builds. Every adapter test
constructs its payload by hand, so what it pins is what the adapter puts on the
wire. Between them sits the seam that actually ships: the real
``ResendEmailSender``, installed on the real endpoint, carrying a body the real
renderer produced. A payload the renderer emits and the adapter cannot
serialise, or a provider rejection that escapes the handler, passes both of
those suites and breaks in production.

The rejection case is a security property rather than a robustness one. The
endpoint answers 202 whether or not the address is registered, and that contract
is what stops it from being an account-existence oracle. If a provider rejection
turned the hit path into a 500 while the miss path stayed 202, the status code
would answer "is this address registered" for anyone who can make the provider
reject -- and an unverified ``from`` domain makes it reject every send at once,
which is the ordinary state of a half-finished deployment.

The network is stubbed at ``AsyncHTTPTransport.handle_async_request``, one call
above the socket, so URL construction, the credential header, JSON serialisation
and the status read all run for real. The test client reaches the app over
``ASGITransport``, a different class, so its own traffic is untouched by the
stub -- which is what makes it safe to patch the transport class rather than an
instance.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import httpx
import pytest

from main import app
from models.user import User
from routers.auth import _hash_password
from services.email import (
    ResendEmailSender,
    get_email_sender,
    reset_email_sender_for_tests,
)
from tests.helpers.resend_env import RESEND_ENV_VALUES

if TYPE_CHECKING:
    from collections.abc import Iterator

    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession

_PASSWORD = "correct-horse-battery-staple"  # pragma: allowlist secret

# The origin this deployment serves its web build from, and the path the app
# routes the reset action at. Asserted as a pair because the value the user has
# to be able to click is the whole URL, not either half.
WEB_BASE_URL_ENV_VAR = "APP_BASE_URL"
CONFIGURED_ORIGIN = "https://app.aptitude.guru"
RESET_PATH = "/reset-password?token="

# One address that exists and one that does not. The second is what makes the
# 202 assertions mean something: a status that is only ever observed on the hit
# path cannot show that the two paths are indistinguishable.
REGISTERED_ADDRESS = "https-delivery@example.com"
UNREGISTERED_ADDRESS = "no-such-account@example.com"

ACCEPTED_STATUS = 202

# What the provider answers when the sending domain is not verified -- the
# ordinary state of a deployment whose DNS records are still propagating, and
# therefore the realistic way every send starts failing at once.
PROVIDER_REJECTION_STATUS = 422


@pytest.fixture
def _https_sender(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Install the real HTTPS sender on the endpoint, built the way a deploy builds it.

    ``from_env`` rather than a hand-constructed instance: the production boot
    reaches this class through that classmethod, so wiring around it would leave
    the one path a deploy actually takes untested here as well.
    """
    for name, value in RESEND_ENV_VALUES.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv(WEB_BASE_URL_ENV_VAR, CONFIGURED_ORIGIN)
    reset_email_sender_for_tests()
    sender = ResendEmailSender.from_env()
    app.dependency_overrides[get_email_sender] = lambda: sender
    yield
    app.dependency_overrides.pop(get_email_sender, None)
    reset_email_sender_for_tests()


def _capture_https(
    monkeypatch: pytest.MonkeyPatch,
    status: int,
) -> list[httpx.Request]:
    """Answer the provider call with ``status`` and return what was transmitted."""
    recorded: list[httpx.Request] = []

    async def _handle(
        _transport: httpx.AsyncHTTPTransport,
        request: httpx.Request,
    ) -> httpx.Response:
        recorded.append(request)
        return httpx.Response(status, json={"id": "queued"}, request=request)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _handle)
    return recorded


async def _create_user(db_session: AsyncSession, address: str) -> None:
    """Insert an active user who can request a reset."""
    db_session.add(
        User(
            email=address,
            password_hash=await _hash_password(_PASSWORD),
            is_active=True,
            deleted_at=None,
        )
    )
    await db_session.commit()


async def _request_reset(client: AsyncClient, address: str) -> httpx.Response:
    """POST a reset request for ``address``."""
    return await client.post("/auth/password-reset/request", json={"email": address})


@pytest.mark.asyncio
@pytest.mark.usefixtures("_https_sender")
async def test_the_endpoint_puts_a_followable_reset_link_on_the_provider_wire(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The two halves of the fix, asserted where they meet.

    What the recorder-backed suites cannot see is that the rendered body
    survives the trip through the adapter: the handler's payload has to
    serialise onto the provider's JSON contract, and the link the user clicks
    has to arrive intact on the far side of it. Reading the assertion off the
    transmitted request rather than off a captured object is the point -- this
    is the last thing the process does before the socket.
    """
    recorded = _capture_https(monkeypatch, ACCEPTED_STATUS)
    await _create_user(db_session, REGISTERED_ADDRESS)

    response = await _request_reset(async_client, REGISTERED_ADDRESS)

    assert response.status_code == ACCEPTED_STATUS
    assert len(recorded) == 1, "the endpoint must have handed the mail to the provider"
    transmitted = json.loads(recorded[0].content)
    assert transmitted["to"] == [REGISTERED_ADDRESS]
    assert f"{CONFIGURED_ORIGIN}{RESET_PATH}" in transmitted["text"]


@pytest.mark.asyncio
@pytest.mark.usefixtures("_https_sender")
async def test_a_provider_rejection_leaves_the_two_paths_indistinguishable(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rejected send must not turn the hit path into an account-existence oracle.

    The adapter raises on a non-2xx, by design. Whether the handler still
    swallows that into the 202 contract once the sender is the real one is a
    different claim, and the only suite that could make it is this one: with the
    recorder installed there is nothing that can raise. A regression here is not
    a failed email, it is a 500 on exactly the addresses that exist.
    """
    _capture_https(monkeypatch, PROVIDER_REJECTION_STATUS)
    await _create_user(db_session, REGISTERED_ADDRESS)

    hit = await _request_reset(async_client, REGISTERED_ADDRESS)
    miss = await _request_reset(async_client, UNREGISTERED_ADDRESS)

    assert hit.status_code == ACCEPTED_STATUS
    assert miss.status_code == ACCEPTED_STATUS
    assert hit.json() == miss.json()
